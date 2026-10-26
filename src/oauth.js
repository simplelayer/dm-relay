import { REQUIRED_SCOPES, SESSION_TTL_S, SLACK_API, SLACK_AUTHORIZE_URL, STATE_TTL_S } from './constants.js';
import { isValidCursorToken, verifyClaude, verifyCursor, verifyGrok } from './destinations.js';
import {
  connectPage,
  destinationFormPage,
  disconnectConfirmPage,
  disconnectedPage,
  messagePage,
  statusPage,
  successPage
} from './pages.js';
import { isValidSecret } from './standard-webhooks.js';
import { validateDestinationUrl } from './ssrf.js';
import { b64urlEncode, hmacSha256, parseCookies, randomBase64Url, timingSafeEqualStr, utf8 } from './util.js';

const STATE_COOKIE_PREFIX = 'dmr_st_';
const SESSION_COOKIE = 'dmr_sess';
const INTENTS = ['connect', 'disconnect', 'status'];
const TOKEN_ID = /^[A-Za-z0-9_-]{43}$/;
const ATTRS = 'HttpOnly; Secure; SameSite=Lax';

async function mac(deps, message) {
  return b64urlEncode(await hmacSha256(utf8(deps.config.stateKey), utf8(message)));
}

export function csrfFor(deps, sessionId) {
  return mac(deps, `csrf|${sessionId}`);
}

export async function startFlow(intent, deps) {
  const state = randomBase64Url(32);
  const sig = await mac(deps, `state|${state}|${intent}`);
  const cookie = `${STATE_COOKIE_PREFIX}${state.slice(0, 10)}=${state}.${intent}.${sig}; ${ATTRS}; Path=/oauth/callback; Max-Age=${STATE_TTL_S}`;
  const params = new URLSearchParams({
    client_id: deps.config.clientId,
    user_scope: REQUIRED_SCOPES.join(','),
    redirect_uri: `${deps.config.baseUrl}/oauth/callback`,
    state,
    team: deps.config.teamId
  });
  return connectPage({
    intent,
    authorizeUrl: `${SLACK_AUTHORIZE_URL}?${params}`,
    cookie,
    publicRepoUrl: deps.config.publicRepoUrl
  });
}

async function exchangeCode(code, deps) {
  try {
    const res = await deps.fetchImpl(`${SLACK_API}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: deps.config.clientId,
        client_secret: deps.config.clientSecret,
        code,
        redirect_uri: `${deps.config.baseUrl}/oauth/callback`
      }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    if (!data.team || data.team.id !== deps.config.teamId) return null;
    if (data.app_id !== undefined && data.app_id !== deps.config.appId) return null;
    const au = data.authed_user;
    if (!au || typeof au.id !== 'string' || au.token_type !== 'user' || typeof au.access_token !== 'string') return null;
    const scopes = String(au.scope || '').split(',');
    if (!REQUIRED_SCOPES.every((s) => scopes.includes(s))) return null;
    return { userId: au.id, token: au.access_token };
  } catch {
    return null;
  }
}

async function revokeToken(token, deps) {
  try {
    const res = await deps.fetchImpl(`${SLACK_API}/auth.revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    });
    return (await res.json()).ok === true;
  } catch {
    return false;
  }
}

async function mintSession(record, deps) {
  const sid = randomBase64Url(32);
  await deps.kv.put(`sess:${sid}`, JSON.stringify({ ...record, created: deps.now() }), { expirationTtl: SESSION_TTL_S });
  return { sid, cookie: `${SESSION_COOKIE}=${sid}; ${ATTRS}; Path=/; Max-Age=${SESSION_TTL_S}` };
}

async function getSession(request, deps) {
  const sid = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!sid || !TOKEN_ID.test(sid)) return null;
  const raw = await deps.kv.get(`sess:${sid}`);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (deps.now() - rec.created > SESSION_TTL_S * 1000) return null;
    return { sid, rec };
  } catch {
    return null;
  }
}

const clearSession = `${SESSION_COOKIE}=; ${ATTRS}; Path=/; Max-Age=0`;

export async function handleCallback(request, deps) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state || !TOKEN_ID.test(state)) return messagePage('Start again', 'This sign-in link is not valid. Please start again from /connect.');
  const name = STATE_COOKIE_PREFIX + state.slice(0, 10);
  const clear = `${name}=; ${ATTRS}; Path=/oauth/callback; Max-Age=0`;
  const raw = parseCookies(request.headers.get('cookie'))[name];
  if (!raw) return messagePage('Start again', 'Your sign-in session was not found or expired. Please start again.', 400);

  const parts = raw.split('.');
  const [cState, intent, sig] = parts;
  const valid =
    parts.length === 3 &&
    INTENTS.includes(intent) &&
    timingSafeEqualStr(cState, state) &&
    timingSafeEqualStr(sig, await mac(deps, `state|${cState}|${intent}`));
  if (!valid) return messagePage('Start again', 'Sign-in could not be verified. Please start again.', 400, [clear]);

  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) return messagePage('Cancelled', 'Authorization was not completed.', 400, [clear]);

  const result = await exchangeCode(code, deps);
  if (!result) return messagePage('Sign-in failed', 'Slack sign-in failed. Please start again.', 400, [clear]);
  const { userId, token } = result;

  if (intent === 'status') {
    const st = await deps.userDo(userId).status();
    const route = await deps.routing.get(userId);
    if (!st.connecting && !route) await revokeToken(token, deps);
    const res = statusPage({ counters: st.counters, lastNudge: st.last_nudge, showNudge: route?.dest_type === 'claude_routine' });
    res.headers.append('set-cookie', clear);
    return res;
  }
  if (intent === 'connect') await deps.userDo(userId).markConnecting();
  const record = intent === 'disconnect' ? { uid: userId, intent, token } : { uid: userId, intent };
  const { sid, cookie } = await mintSession(record, deps);
  const csrf = await csrfFor(deps, sid);
  const res = intent === 'connect' ? destinationFormPage({ csrf }) : disconnectConfirmPage({ csrf });
  res.headers.append('set-cookie', clear);
  res.headers.append('set-cookie', cookie);
  return res;
}

async function readForm(request, deps) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(deps.config.baseUrl).origin) return { error: messagePage('Forbidden', 'Cross-origin request refused.', 403) };
  const session = await getSession(request, deps);
  if (!session) return { error: messagePage('Session expired', 'Please start again from /connect.', 401) };
  const form = new URLSearchParams(await request.text());
  if (!timingSafeEqualStr(form.get('csrf') || '', await csrfFor(deps, session.sid))) {
    return { error: messagePage('Forbidden', 'Invalid request token.', 403) };
  }
  return { session, form };
}

export async function handleDestination(request, deps) {
  const read = await readForm(request, deps);
  if (read.error) return read.error;
  const { session, form } = read;
  if (session.rec.intent !== 'connect') return messagePage('Forbidden', 'This session cannot register a destination.', 403);
  const userId = session.rec.uid;
  const csrf = await csrfFor(deps, session.sid);
  const retry = (msg) => destinationFormPage({ csrf, error: msg });

  if (!(await deps.userDo(userId).consumeRegistration()).allowed) {
    return messagePage('Too many attempts', 'Too many registration attempts. Please try again later.', 429);
  }
  const destType = form.get('dest_type');
  if (destType !== 'grok' && destType !== 'claude_routine' && destType !== 'cursor') return retry('Choose a destination type.');
  if (form.get('attest') !== '1' || form.get('no_send') !== '1') return retry('Both confirmations are required.');
  const secret = (form.get('secret') || '').trim();
  const v = validateDestinationUrl((form.get('url') || '').trim(), { type: destType, ...deps.validateOpts });
  if (!v.ok) return retry('That URL is not allowed.');
  if (destType === 'grok' && !isValidSecret(secret)) return retry('The signing secret must start with whsec_ and be valid base64.');
  if (destType === 'claude_routine' && secret === '') return retry('A bearer token is required.');
  if (destType === 'cursor' && !isValidCursorToken(secret)) return retry('The bearer token must start with crsr_ and contain only letters, digits, hyphens and underscores (20 to 200 characters).');

  const entry = {
    dest_type: destType,
    url: v.url.href,
    secret_or_bearer: secret,
    mode: destType === 'claude_routine' ? 'nudge' : 'full'
  };
  const verifiers = {
    grok: () => verifyGrok({ entry, fetchImpl: deps.fetchImpl, now: deps.now, validateOpts: deps.validateOpts }),
    cursor: () => verifyCursor({ entry, fetchImpl: deps.fetchImpl, now: deps.now, validateOpts: deps.validateOpts }),
    claude_routine: () => verifyClaude({ entry, fetchImpl: deps.fetchImpl, validateOpts: deps.validateOpts })
  };
  const verified = await verifiers[destType]();
  if (verified.kind !== 'ok') return retry(`Verification failed (${verified.kind}${verified.status ? ` ${verified.status}` : ''}). You can try again.`);

  await deps.routing.put(userId, entry);
  await deps.userDo(userId).markConnected();
  await deps.kv.delete(`sess:${session.sid}`);
  const res = successPage();
  res.headers.append('set-cookie', clearSession);
  return res;
}

export async function handleDisconnectConfirm(request, deps) {
  const read = await readForm(request, deps);
  if (read.error) return read.error;
  const { session } = read;
  if (session.rec.intent !== 'disconnect' || typeof session.rec.token !== 'string') {
    return messagePage('Forbidden', 'This session cannot disconnect.', 403);
  }
  const userId = session.rec.uid;
  const revoked = await revokeToken(session.rec.token, deps);
  await deps.userDo(userId).wipe();
  await deps.routing.delete(userId);
  await deps.kv.delete(`sess:${session.sid}`);
  const res = disconnectedPage({ revoked });
  res.headers.append('set-cookie', clearSession);
  return res;
}
