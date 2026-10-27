import { DISCONNECT_SESSION_TTL_S, OPTIONAL_CHANNEL_SCOPES, REQUIRED_SCOPES, SESSION_TTL_S, SLACK_API, SLACK_AUTHORIZE_URL, STATE_TTL_S } from './constants.js';
import { API_KEY_LABEL_MAX, TRUSTED_MAX } from './constants.js';
import { CHANNEL_SCOPE_ERROR, effectiveCaps, effectiveChannels, effectiveTrusted, effectiveVoice, hasChannelScopes, normalizeIds, parseCapsForm, parseChannelsForm, parseProfileForm } from './caps.js';
import { hashKey, newKeyMaterial } from './apikeys.js';
import { destLabel } from './delivery-log.js';
import { verifyClaude, verifyCursor, verifyGrok } from './destinations.js';
import { effectiveFilters, parseFilterForm } from './filter.js';
import { allPromptsFor } from './prompts.js';
import { REQUEST_ID, checkDestinationInput } from './requests.js';
import { describeDestination as describe, runTestFire, saveSettings, summaryFrom } from './settings.js';
import {
  connectPage,
  destinationFormPage,
  disconnectConfirmPage,
  disconnectedPage,
  keyCreatedPage,
  messagePage,
  statusPage,
  successPage
} from './pages.js';
import { b64urlEncode, hmacSha256, parseCookies, randomBase64Url, timingSafeEqualStr, utf8 } from './util.js';
import { wipeUser } from './wipe.js';

const STATE_COOKIE_PREFIX = 'dmr_st_';
const SESSION_COOKIE = 'dmr_sess';
const INTENTS = ['connect', 'disconnect', 'status'];
const TOKEN_ID = /^[A-Za-z0-9_-]{43}$/;
const ATTRS = 'HttpOnly; Secure; SameSite=Lax';

const DEST_NAMES = { grok: 'Grok automation webhook', cursor: 'Cursor automation webhook', claude_routine: 'Claude routine' };

const describeDestination = (route) => describe(route, DEST_NAMES);

async function manageFor(userId, deps, extra = {}) {
  const [route, st, keys, requests] = await Promise.all([
    deps.routing.get(userId),
    deps.userDo(userId).status(),
    deps.userDo(userId).listKeys(),
    deps.userDo(userId).reqList()
  ]);
  const deliveries = st.deliveries || [];
  return {
    destination: describeDestination(route),
    filters: effectiveFilters(route && route.filters),
    caps: effectiveCaps(route && route.caps),
    trusted_users: effectiveTrusted(route && route.trusted_users),
    voice: effectiveVoice(route && route.voice),
    channels: effectiveChannels(route && route.channels),
    channelScopes: hasChannelScopes(route && route.scopes),
    keys: keys.keys,
    specUrl: `${deps.config.baseUrl}/api/v1/spec`,
    prompts: allPromptsFor(route),
    requests: requests.requests,
    progress: {
      destination: Boolean(route),
      testPassed: deliveries.some((d) => d.test === true && d.o === 'ok'),
      delivered: deliveries.some((d) => !d.test && d.o === 'ok') || (st.counters && st.counters.forwarded > 0)
    },
    ...extra
  };
}

async function mac(deps, message) {
  return b64urlEncode(await hmacSha256(utf8(deps.config.stateKey), utf8(message)));
}

export function csrfFor(deps, sessionId) {
  return mac(deps, `csrf|${sessionId}`);
}

export async function startFlow(intent, deps, { channels = false } = {}) {
  const state = randomBase64Url(32);
  const sig = await mac(deps, `state|${state}|${intent}`);
  const cookie = `${STATE_COOKIE_PREFIX}${state.slice(0, 10)}=${state}.${intent}.${sig}; ${ATTRS}; Path=/oauth/callback; Max-Age=${STATE_TTL_S}`;
  const params = new URLSearchParams({
    client_id: deps.config.clientId,
    user_scope: (channels && intent === 'connect' ? [...REQUIRED_SCOPES, ...OPTIONAL_CHANNEL_SCOPES] : REQUIRED_SCOPES).join(','),
    redirect_uri: `${deps.config.baseUrl}/oauth/callback`,
    state,
    team: deps.config.teamId
  });
  return connectPage({
    intent,
    authorizeUrl: `${SLACK_AUTHORIZE_URL}?${params}`,
    cookie,
    publicRepoUrl: deps.config.publicRepoUrl,
    channels: channels && intent === 'connect'
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
    return { userId: au.id, token: au.access_token, scopes: hasChannelScopes(scopes) ? scopes : undefined };
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

// A disconnect session holds a Slack token, so it stays short. Connect sessions hold none.
const sessionTtlS = (intent) => (intent === 'connect' ? SESSION_TTL_S : DISCONNECT_SESSION_TTL_S);

async function mintSession(record, deps) {
  const sid = randomBase64Url(32);
  const ttl = sessionTtlS(record.intent);
  await deps.kv.put(`sess:${sid}`, JSON.stringify({ ...record, created: deps.now() }), { expirationTtl: ttl });
  return { sid, cookie: `${SESSION_COOKIE}=${sid}; ${ATTRS}; Path=/; Max-Age=${ttl}` };
}

async function getSession(request, deps) {
  const sid = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!sid || !TOKEN_ID.test(sid)) return null;
  const raw = await deps.kv.get(`sess:${sid}`);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (deps.now() - rec.created > sessionTtlS(rec.intent) * 1000) return null;
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
  const { userId, token, scopes } = result;

  if (intent === 'status') {
    const st = await deps.userDo(userId).status();
    const route = await deps.routing.get(userId);
    if (!st.connecting && !route) await revokeToken(token, deps);
    const res = statusPage({
      counters: st.counters,
      lastNudge: st.last_nudge,
      showNudge: route?.dest_type === 'claude_routine',
      summary: summaryFrom(st, route, DEST_NAMES)
    });
    res.headers.append('set-cookie', clear);
    return res;
  }
  if (intent === 'connect') {
    await deps.userDo(userId).markConnecting();
    const existing = await deps.routing.get(userId);
    if (existing && JSON.stringify(existing.scopes) !== JSON.stringify(scopes)) {
      const { scopes: _old, ...rest } = existing;
      await deps.routing.put(userId, scopes ? { ...rest, scopes } : rest);
    }
  }
  const record = intent === 'disconnect' ? { uid: userId, intent, token } : intent === 'connect' && scopes ? { uid: userId, intent, scopes } : { uid: userId, intent };
  const { sid, cookie } = await mintSession(record, deps);
  const csrf = await csrfFor(deps, sid);
  const res = intent === 'connect' ? destinationFormPage({ csrf, manage: await manageFor(userId, deps) }) : disconnectConfirmPage({ csrf });
  res.headers.append('set-cookie', clear);
  res.headers.append('set-cookie', cookie);
  return res;
}

function originAllowed(request, deps) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (origin === null || origin === '') return true;
  if (origin === 'null') return true;
  return origin === new URL(deps.config.baseUrl).origin;
}

async function readForm(request, deps) {
  if (!originAllowed(request, deps)) return { error: messagePage('Forbidden', 'This request did not come from this site, so it was refused. Please start again from /connect.', 403) };
  const session = await getSession(request, deps);
  if (!session) return { error: messagePage('Session expired', 'Your session timed out or was not found. Sessions end after an hour for your security. Please start again from /connect.', 401) };
  const form = new URLSearchParams(await request.text());
  if (!timingSafeEqualStr(form.get('csrf') || '', await csrfFor(deps, session.sid))) {
    return { error: messagePage('Forbidden', 'This page is out of date or was not opened from DM Relay, so the request was refused. Please start again from /connect.', 403) };
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
  const retry = async (msg) => destinationFormPage({ csrf, error: msg, manage: await manageFor(userId, deps) });

  if (!(await deps.userDo(userId).consumeRegistration()).allowed) {
    return messagePage('Too many attempts', 'Too many registration attempts. Please try again later.', 429);
  }
  const destType = form.get('dest_type');
  if (destType !== 'grok' && destType !== 'claude_routine' && destType !== 'cursor') return await retry('Choose a destination type.');
  if (form.get('attest') !== '1') return await retry('The training attestation is required.');
  const checked = checkDestinationInput({ destType, url: form.get('url'), secret: form.get('secret') }, deps.validateOpts);
  if (checked.error) return await retry(checked.error);

  const previous = await deps.routing.get(userId);
  const entry = {
    dest_type: destType,
    url: checked.url,
    secret_or_bearer: checked.secret,
    mode: destType === 'claude_routine' ? 'nudge' : 'full'
  };
  for (const k of ['filters', 'caps', 'trusted_users', 'voice', 'channels', 'scopes']) if (previous && previous[k] !== undefined) entry[k] = previous[k];
  if (!entry.scopes && Array.isArray(session.rec.scopes)) entry.scopes = session.rec.scopes;
  const verifiers = {
    grok: () => verifyGrok({ entry, fetchImpl: deps.fetchImpl, now: deps.now, validateOpts: deps.validateOpts }),
    cursor: () => verifyCursor({ entry, fetchImpl: deps.fetchImpl, now: deps.now, validateOpts: deps.validateOpts }),
    claude_routine: () => verifyClaude({ entry, fetchImpl: deps.fetchImpl, validateOpts: deps.validateOpts })
  };
  const verified = await verifiers[destType]();
  if (verified.kind !== 'ok') return await retry(`Verification failed (${verified.kind}${verified.status ? ` ${verified.status}` : ''}). You can try again.`);

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
  await wipeUser(deps, userId);
  await deps.kv.delete(`sess:${session.sid}`);
  const res = disconnectedPage({ revoked });
  res.headers.append('set-cookie', clearSession);
  return res;
}

export async function handleTestFire(request, deps) {
  const read = await readForm(request, deps);
  if (read.error) return read.error;
  const { session } = read;
  if (session.rec.intent !== 'connect') return messagePage('Forbidden', 'This session cannot send a test.', 403);
  const userId = session.rec.uid;
  const csrf = await csrfFor(deps, session.sid);
  const page = async (extra, error) => destinationFormPage({ csrf, error, manage: await manageFor(userId, deps, extra) });

  const r = await runTestFire(deps, userId);
  if (r.limited) return messagePage('Too many tests', 'Too many tests. Please wait a minute and try again.', 429);
  if (r.noRoute) return page({}, 'Save a destination first.');
  const text = r.ok ? `HTTP ${r.status}` : `${r.outcome}${r.status ? ` (HTTP ${r.status})` : ''}`;
  return page({ testResult: { ok: r.ok, text } });
}

export async function handleFilters(request, deps) {
  const read = await readForm(request, deps);
  if (read.error) return read.error;
  const { session, form } = read;
  if (session.rec.intent !== 'connect') return messagePage('Forbidden', 'This session cannot change filters.', 403);
  const userId = session.rec.uid;
  const csrf = await csrfFor(deps, session.sid);

  if (!(await deps.userDo(userId).consumeLimit({ name: 'filters' })).allowed) {
    return messagePage('Too many changes', 'Too many filter changes. Please wait a minute and try again.', 429);
  }
  const route = await deps.routing.get(userId);
  if (!route) return destinationFormPage({ csrf, error: 'Save a destination before setting filters.', manage: await manageFor(userId, deps) });
  const parsed = parseFilterForm(form);
  if (parsed.error) return destinationFormPage({ csrf, error: parsed.error, manage: await manageFor(userId, deps) });
  await saveSettings(deps, userId, route, { filters: parsed.filters }, 'browser');
  return destinationFormPage({ csrf, manage: await manageFor(userId, deps, { filterMsg: { text: 'Filters saved.' } }) });
}

async function settingsAction(request, deps, { limit, forbidden, noRoute, apply }) {
  const read = await readForm(request, deps);
  if (read.error) return read.error;
  const { session, form } = read;
  if (session.rec.intent !== 'connect') return messagePage('Forbidden', forbidden, 403);
  const userId = session.rec.uid;
  const csrf = await csrfFor(deps, session.sid);
  const page = async (error, extra) => destinationFormPage({ csrf, error, manage: await manageFor(userId, deps, extra) });
  if (!(await deps.userDo(userId).consumeLimit({ name: limit })).allowed) {
    return messagePage('Too many changes', 'Too many changes. Please wait a minute and try again.', 429);
  }
  const route = await deps.routing.get(userId);
  if (!route) return page(noRoute);
  return apply({ form, route, userId, page });
}

export function handleCaps(request, deps) {
  return settingsAction(request, deps, {
    limit: 'caps',
    forbidden: 'This session cannot change capabilities.',
    noRoute: 'Save a destination before setting capabilities.',
    async apply({ form, route, userId, page }) {
      const parsed = parseCapsForm(form, route.caps);
      if (parsed.error) return page(parsed.error);
      await saveSettings(deps, userId, route, { caps: parsed.caps }, 'browser');
      return page(undefined, { capsMsg: { text: 'Capabilities saved.' } });
    }
  });
}

export function handleProfile(request, deps) {
  return settingsAction(request, deps, {
    limit: 'profile',
    forbidden: 'This session cannot change trusted senders or voice.',
    noRoute: 'Save a destination before setting trusted senders or voice.',
    async apply({ form, route, userId, page }) {
      const parsed = parseProfileForm(form);
      if (parsed.error) return page(parsed.error);
      await saveSettings(deps, userId, route, { trusted_users: parsed.trusted_users, voice: parsed.voice }, 'browser');
      return page(undefined, form.has('trusted_users') ? { trustedMsg: { text: 'Trusted senders saved.' } } : { profileMsg: { text: 'Voice saved.' } });
    }
  });
}

export function handleChannels(request, deps) {
  return settingsAction(request, deps, {
    limit: 'channels',
    forbidden: 'This session cannot change channel settings.',
    noRoute: 'Save a destination before setting channels.',
    async apply({ form, route, userId, page }) {
      const parsed = parseChannelsForm(form, route);
      if (parsed.error) return page(parsed.error);
      await saveSettings(deps, userId, route, { channels: parsed.channels }, 'browser');
      return page(undefined, { channelsMsg: { text: 'Channel settings saved.' } });
    }
  });
}

async function issueKey(deps, userId, label) {
  const { key, kid } = newKeyMaterial();
  const hash = await hashKey(key);
  const added = await deps.userDo(userId).addKey({ kid, hash, label });
  if (!added.ok) return null;
  await deps.kv.put(`apikey:${hash}`, JSON.stringify({ uid: userId, kid, created: deps.now(), label }));
  return key;
}

export async function handleBootstrap(request, deps) {
  const read = await readForm(request, deps);
  if (read.error) return read.error;
  const { session } = read;
  if (session.rec.intent !== 'connect') return messagePage('Forbidden', 'This session cannot manage assistant keys.', 403);
  const userId = session.rec.uid;
  if (!(await deps.userDo(userId).consumeLimit({ name: 'keys' })).allowed) {
    return messagePage('Too many changes', 'Too many changes. Please wait a minute and try again.', 429);
  }
  const key = await issueKey(deps, userId, 'assistant');
  if (!key) {
    const csrf = await csrfFor(deps, session.sid);
    return destinationFormPage({ csrf, error: 'You already have the maximum number of active keys. Revoke one first.', manage: await manageFor(userId, deps) });
  }
  return keyCreatedPage({ key, specUrl: `${deps.config.baseUrl}/api/v1/spec` });
}

export function handleKeyCreate(request, deps) {
  return settingsAction(request, deps, {
    limit: 'keys',
    forbidden: 'This session cannot manage assistant keys.',
    noRoute: 'Save a destination before creating an assistant key.',
    async apply({ form, userId, page }) {
      const label = String(form.get('label') || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
      if ([...label].length > API_KEY_LABEL_MAX) return page(`The label can be at most ${API_KEY_LABEL_MAX} characters.`);
      const key = await issueKey(deps, userId, label);
      if (!key) return page('You already have the maximum number of active keys. Revoke one first.');
      return keyCreatedPage({ key, specUrl: `${deps.config.baseUrl}/api/v1/spec` });
    }
  });
}

export function handleKeyRevoke(request, deps) {
  return settingsAction(request, deps, {
    limit: 'keys',
    forbidden: 'This session cannot manage assistant keys.',
    noRoute: 'Save a destination first.',
    async apply({ form, userId, page }) {
      const res = await deps.userDo(userId).revokeKey({ kid: String(form.get('kid') || '') });
      if (!res.ok) return page('That key was not found.');
      await deps.kv.delete(`apikey:${res.hash}`);
      return page(undefined, { keysMsg: { text: 'Key revoked.' } });
    }
  });
}

const VERIFIERS = {
  grok: (entry, deps) => verifyGrok({ entry, fetchImpl: deps.fetchImpl, now: deps.now, validateOpts: deps.validateOpts }),
  cursor: (entry, deps) => verifyCursor({ entry, fetchImpl: deps.fetchImpl, now: deps.now, validateOpts: deps.validateOpts }),
  claude_routine: (entry, deps) => verifyClaude({ entry, fetchImpl: deps.fetchImpl, validateOpts: deps.validateOpts })
};

async function applyRequest(deps, userId, rec, form) {
  const doc = deps.userDo(userId);
  const route = await deps.routing.get(userId);
  const claim = async () => ((await doc.reqResolve({ id: rec.id, status: 'approved' })).ok ? null : 'That request is no longer pending.');
  const p = rec.payload;
  if (rec.type === 'destination') {
    if (form.get('attest') !== '1') return 'The training attestation is required.';
    const checked = checkDestinationInput({ destType: p.dest_type, url: p.url, secret: p.secret }, deps.validateOpts);
    if (checked.error) return checked.error;
    if (!(await doc.consumeRegistration()).allowed) return 'Too many registration attempts. Please try again later.';
    const entry = { dest_type: p.dest_type, url: checked.url, secret_or_bearer: checked.secret, mode: p.dest_type === 'claude_routine' ? 'nudge' : 'full' };
    for (const k of ['filters', 'caps', 'trusted_users', 'voice', 'channels', 'scopes']) if (route && route[k] !== undefined) entry[k] = route[k];
    const verified = await VERIFIERS[p.dest_type](entry, deps);
    if (verified.kind !== 'ok') return `Verification failed (${verified.kind}${verified.status ? ` ${verified.status}` : ''}). The request is still pending; you can try again.`;
    const lost = await claim();
    if (lost) return lost;
    await deps.routing.put(userId, entry);
    await doc.markConnected();
    return null;
  }
  if (!route) return 'Save a destination first. The request is still pending.';
  if (rec.type === 'enable_send') {
    const was = effectiveCaps(route.caps);
    const sent = new URLSearchParams({
      process: was.process ? '1' : '',
      draft: was.draft ? '1' : '',
      send: '1',
      confirm_send: form.get('confirm_send') || '',
      send_word: form.get('send_word') || ''
    });
    const parsed = parseCapsForm(sent, { ...was, send: false });
    if (parsed.error) return parsed.error;
    const lost = await claim();
    if (lost) return lost;
    await deps.routing.put(userId, { ...route, caps: parsed.caps });
    return null;
  }
  if (rec.type === 'enable_channels') {
    if (!hasChannelScopes(route.scopes)) return `${CHANNEL_SCOPE_ERROR} The request is still pending.`;
    const lost = await claim();
    if (lost) return lost;
    const was = effectiveChannels(route.channels);
    await deps.routing.put(userId, { ...route, channels: { ...was, enabled: true, allowlist: Array.isArray(p.allowlist) ? p.allowlist : was.allowlist } });
    return null;
  }
  const merged = normalizeIds([...effectiveTrusted(route.trusted_users), ...p.user_ids], TRUSTED_MAX);
  if (merged.error) return `${merged.error} The request is still pending.`;
  const lost = await claim();
  if (lost) return lost;
  await deps.routing.put(userId, { ...route, trusted_users: merged.ids });
  return null;
}

async function decideRequest(request, deps, approve) {
  const read = await readForm(request, deps);
  if (read.error) return read.error;
  const { session, form } = read;
  if (session.rec.intent !== 'connect') return messagePage('Forbidden', 'This session cannot decide requests.', 403);
  const userId = session.rec.uid;
  const csrf = await csrfFor(deps, session.sid);
  const page = async (error, extra) => destinationFormPage({ csrf, error, manage: await manageFor(userId, deps, extra) });
  if (!(await deps.userDo(userId).consumeLimit({ name: 'decide' })).allowed) {
    return messagePage('Too many changes', 'Too many changes. Please wait a minute and try again.', 429);
  }
  const id = String(form.get('id') || '');
  const rec = REQUEST_ID.test(id) ? (await deps.userDo(userId).reqGet({ id })).request : null;
  if (!rec || rec.status !== 'pending' || !rec.payload) {
    return page('That request was not found or is no longer pending. It may have expired or already been handled.');
  }
  if (!approve) {
    if (!(await deps.userDo(userId).reqResolve({ id, status: 'rejected' })).ok) return page('That request is no longer pending.');
    await deps.userDo(userId).logChange({ via: 'approval', fields: [`request:${rec.type}:rejected`] });
    return page(undefined, { requestMsg: { ok: true, text: 'Request rejected. Nothing was changed.' } });
  }
  const failure = await applyRequest(deps, userId, rec, form);
  if (failure) return page(failure);
  await deps.userDo(userId).logChange({ via: 'approval', fields: [`request:${rec.type}`] });
  return page(undefined, { requestMsg: { ok: true, text: 'Request approved and applied.' } });
}

export const handleRequestApprove = (request, deps) => decideRequest(request, deps, true);
export const handleRequestReject = (request, deps) => decideRequest(request, deps, false);
