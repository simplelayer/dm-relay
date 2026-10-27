import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP, BASE, GROK_SECRET, GROK_URL, ROUTINE_TOKEN, ROUTINE_URL, TEAM, U1, U2, USER_TOKEN, cookieHeaderFrom, makeWorld, respond, setCookies } from './helpers.js';

function oauthData(userId = U1, over = {}) {
  return {
    ok: true,
    app_id: APP,
    team: { id: TEAM },
    authed_user: { id: userId, scope: 'im:history,mpim:history', access_token: USER_TOKEN, token_type: 'user', ...(over.authed_user || {}) },
    ...(over.top || {})
  };
}

function world(ctl = {}) {
  const c = { oauth: () => respond(200, oauthData()), grok: () => respond(202), claude: () => respond(200), revoke: () => respond(200, { ok: true }), ...ctl };
  const w = makeWorld({
    fetchHandler: (url, init) => {
      if (url.includes('oauth.v2.access')) return c.oauth(init);
      if (url.includes('auth.revoke')) return c.revoke(init);
      if (url.includes('anthropic.com')) return c.claude(init);
      return c.grok(init);
    }
  });
  w.ctl = c;
  return w;
}

async function start(w, path = '/connect') {
  const res = await w.request(path);
  const html = await res.text();
  const href = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize[^"]+)"/)[1].replaceAll('&amp;', '&');
  const state = new URL(href).searchParams.get('state');
  const setCookie = setCookies(res).find((c) => c.startsWith('dmr_st_'));
  return { res, html, href, state, setCookie, cookiePair: setCookie.split(';')[0] };
}

const cb = (w, state, cookie, code = 'code1') =>
  w.request(`/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: cookie ? { cookie } : {} });

async function login(w, intent = 'connect', userId = U1) {
  w.ctl.oauth = () => respond(200, oauthData(userId));
  const s = await start(w, `/${intent}`);
  const res = await cb(w, s.state, s.cookiePair);
  const html = await res.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  return { res, html, csrf, cookie: cookieHeaderFrom(res), s };
}

const post = (w, path, cookie, fields, headers = {}) =>
  w.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });

const grokFields = (csrf, over = {}) => ({ csrf, dest_type: 'grok', url: GROK_URL, secret: GROK_SECRET, attest: '1', no_send: '1', ...over });

test('/connect sets a signed Lax state cookie scoped to /oauth/callback with intent inside the signed value', async () => {
  const w = world();
  const s = await start(w, '/connect');
  assert.match(s.setCookie, /^dmr_st_[A-Za-z0-9_-]{10}=/);
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/oauth/callback', 'Max-Age=600']) assert.ok(s.setCookie.includes(a), a);
  assert.equal(s.setCookie.includes('SameSite=Strict'), false);
  const [state, intent, sig] = s.setCookie.split(';')[0].split('=')[1].split('.');
  assert.equal(state, s.state);
  assert.equal(intent, 'connect');
  assert.ok(sig.length > 20);
  assert.equal(state.length, 43);
  for (const i of ['disconnect', 'status']) assert.equal((await start(w, `/${i}`)).setCookie.split('=')[1].split('.')[1], i);
});

test('authorize link is a plain <a href> to slack.com with minimal user scopes; no form posts to slack.com', async () => {
  const w = world();
  const s = await start(w);
  const u = new URL(s.href);
  assert.equal(u.origin + u.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(u.searchParams.get('user_scope'), 'im:history,mpim:history');
  assert.equal(u.searchParams.get('redirect_uri'), `${BASE}/oauth/callback`);
  assert.equal(u.searchParams.has('scope'), false);
  assert.equal(/<form[^>]*slack\.com/i.test(s.html), false);
  assert.equal(/<form/i.test(s.html), false);
});

test('full connect flow: session cookie, CSRF, destination verified and stored; token never displayed or stored', async () => {
  const w = world();
  const l = await login(w);
  assert.equal(l.res.status, 200);
  const sess = setCookies(l.res).find((c) => c.startsWith('dmr_sess='));
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=3600']) assert.ok(sess.includes(a), a);
  assert.ok(setCookies(l.res).some((c) => c.startsWith('dmr_st_') && c.includes('Max-Age=0') && c.includes('Path=/oauth/callback')));
  assert.equal(l.html.includes(USER_TOKEN), false);
  assert.ok(l.csrf);
  assert.ok([...w.kv.store.values()].every((v) => !v.includes(USER_TOKEN)));
  assert.ok([...w.kv.ttls.values()].every((t) => t === 600 || t === 3600));

  const res = await post(w, '/destination', l.cookie, grokFields(l.csrf));
  assert.equal(res.status, 200);
  const entry = await w.routing.get(U1);
  assert.deepEqual(entry, { dest_type: 'grok', url: GROK_URL, secret_or_bearer: GROK_SECRET, mode: 'full' });
  const ver = w.fetchImpl.calls.find((c) => c.url === GROK_URL);
  assert.equal(JSON.parse(new TextDecoder().decode(ver.init.body)).type, 'relay.verification');
  assert.match(ver.init.headers['webhook-signature'], /^v1,/);
  assert.equal(JSON.stringify([...w.kv.store]).includes(USER_TOKEN), false);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 401);
});

test('claude_routine connect: fixed host, verification fires a run, entry in nudge mode', async () => {
  const w = world();
  const l = await login(w);
  const res = await post(w, '/destination', l.cookie, grokFields(l.csrf, { dest_type: 'claude_routine', url: ROUTINE_URL, secret: ROUTINE_TOKEN }));
  assert.equal(res.status, 200);
  assert.deepEqual(await w.routing.get(U1), { dest_type: 'claude_routine', url: ROUTINE_URL, secret_or_bearer: ROUTINE_TOKEN, mode: 'nudge' });
  assert.ok(w.fetchImpl.calls.some((c) => c.url === ROUTINE_URL));
});

test('state mismatch rejected (cookie belongs to a different flow)', async () => {
  const w = world();
  const a = await start(w);
  const b = await start(w);
  const forged = b.cookiePair.replace(/^[^=]+/, a.cookiePair.split('=')[0]);
  const res = await cb(w, a.state, forged);
  assert.equal(res.status, 400);
  assert.equal(setCookies(res).some((c) => c.startsWith('dmr_sess=')), false);
  assert.equal(w.fetchImpl.calls.length, 0);
});

test('missing state cookie, missing/garbage state param rejected before any token exchange', async () => {
  const w = world();
  const a = await start(w);
  assert.equal((await cb(w, a.state, '')).status, 400);
  assert.equal((await cb(w, 'short', a.cookiePair)).status, 400);
  assert.equal((await w.request('/oauth/callback?code=x', { headers: { cookie: a.cookiePair } })).status, 400);
  assert.equal(w.fetchImpl.calls.length, 0);
});

test('tampered state cookie (bad signature, or intent swapped) rejected', async () => {
  const w = world();
  const a = await start(w, '/connect');
  const [name, val] = a.cookiePair.split('=');
  const [st, , sig] = val.split('.');
  assert.equal((await cb(w, a.state, `${name}=${st}.disconnect.${sig}`)).status, 400);
  assert.equal((await cb(w, a.state, `${name}=${st}.connect.${sig.slice(0, -2)}xx`)).status, 400);
  assert.equal((await cb(w, a.state, `${name}=${st}.connect`)).status, 400);
  assert.equal(w.fetchImpl.calls.length, 0);
});

test('callback replay is harmless: state cookie cleared; a replayed code fails at Slack and mints nothing', async () => {
  const w = world();
  const a = await start(w);
  const first = await cb(w, a.state, a.cookiePair);
  assert.equal(first.status, 200);
  assert.equal((await cb(w, a.state, '')).status, 400);
  w.ctl.oauth = () => respond(200, { ok: false, error: 'invalid_code' });
  const replay = await cb(w, a.state, a.cookiePair);
  assert.equal(replay.status, 400);
  assert.equal(setCookies(replay).some((c) => c.startsWith('dmr_sess=')), false);
});

test('callback validations: team, scopes, token_type, app id, ok flag, Slack error param', async () => {
  const cases = {
    team: oauthData(U1, { top: { team: { id: 'T0OTHER' } } }),
    scope: oauthData(U1, { authed_user: { scope: 'im:history' } }),
    tokenType: oauthData(U1, { authed_user: { token_type: 'bot' } }),
    app: oauthData(U1, { top: { app_id: 'A0OTHER' } }),
    notOk: { ok: false, error: 'bad' },
    noUser: { ok: true, team: { id: TEAM }, authed_user: {} }
  };
  for (const [name, data] of Object.entries(cases)) {
    const w = world({ oauth: () => respond(200, data) });
    const a = await start(w);
    const res = await cb(w, a.state, a.cookiePair);
    assert.equal(res.status, 400, name);
    assert.equal(setCookies(res).some((c) => c.startsWith('dmr_sess=')), false, name);
  }
  const w = world();
  const a = await start(w);
  const res = await w.request(`/oauth/callback?error=access_denied&state=${a.state}`, { headers: { cookie: a.cookiePair } });
  assert.equal(res.status, 400);
});

test('exchange network failure shows a generic failure', async () => {
  const w = world({ oauth: () => { throw new TypeError('net'); } });
  const a = await start(w);
  assert.equal((await cb(w, a.state, a.cookiePair)).status, 400);
});

test('two tabs: separate state cookie names, both flows complete', async () => {
  const w = world();
  const a = await start(w);
  const b = await start(w);
  assert.notEqual(a.cookiePair.split('=')[0], b.cookiePair.split('=')[0]);
  const both = `${a.cookiePair}; ${b.cookiePair}`;
  assert.equal((await cb(w, a.state, both)).status, 200);
  assert.equal((await cb(w, b.state, both)).status, 200);
});

test('POST /destination without a session is rejected', async () => {
  const w = world();
  assert.equal((await post(w, '/destination', '', grokFields('x'))).status, 401);
  assert.equal((await post(w, '/destination', 'dmr_sess=' + 'a'.repeat(43), grokFields('x'))).status, 401);
  assert.equal(await w.routing.get(U1), null);
});

const BASE_ORIGIN = 'https://relay.example.net';
const ORIGIN_CASES = [
  ['a: Origin null + same-origin', { origin: 'null', 'sec-fetch-site': 'same-origin' }, true],
  ['b: Origin null + cross-site', { origin: 'null', 'sec-fetch-site': 'cross-site' }, false],
  ['c1: evil Origin + same-origin', { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }, false],
  ['c2: evil Origin + cross-site', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, false],
  ['c3: evil Origin, no sec-fetch-site', { origin: 'https://evil.example' }, false],
  ['d: base Origin + same-origin', { origin: BASE_ORIGIN, 'sec-fetch-site': 'same-origin' }, true],
  ['e: no Origin, no sec-fetch-site', {}, true],
  ['f: base Origin + cross-site', { origin: BASE_ORIGIN, 'sec-fetch-site': 'cross-site' }, false],
  ['h: Origin null, no sec-fetch-site (older browsers)', { origin: 'null' }, true],
  ['i: no Origin + same-site', { 'sec-fetch-site': 'same-site' }, false],
  ['j: no Origin + none', { 'sec-fetch-site': 'none' }, false],
];

for (const [name, headers, ok] of ORIGIN_CASES) {
  test(`origin policy POST /destination ${name}`, async () => {
    const w = world();
    const l = await login(w);
    const res = await post(w, '/destination', l.cookie, grokFields(l.csrf), headers);
    if (ok) {
      assert.equal(res.status, 200);
      assert.notEqual(await w.routing.get(U1), null);
    } else {
      assert.equal(res.status, 403);
      assert.match(await res.text(), /did not come from this site/);
      assert.equal(await w.routing.get(U1), null);
    }
  });

  test(`origin policy POST /disconnect/confirm ${name}`, async () => {
    const w = world();
    await w.addGrok(U1);
    const d = await login(w, 'disconnect', U1);
    const res = await post(w, '/disconnect/confirm', d.cookie, { csrf: d.csrf }, headers);
    if (ok) {
      assert.equal(res.status, 200);
      assert.equal((await w.entry(U1).core.check()).disconnected, true);
    } else {
      assert.equal(res.status, 403);
      assert.match(await res.text(), /did not come from this site/);
      assert.equal((await w.entry(U1).core.check()).disconnected, false);
    }
  });
}

test('origin policy g: bad CSRF token is still 403 with a good origin (both endpoints)', async () => {
  const good = { origin: BASE_ORIGIN, 'sec-fetch-site': 'same-origin' };
  for (const headers of [good, { origin: 'null', 'sec-fetch-site': 'same-origin' }]) {
    const w = world();
    const l = await login(w);
    const r1 = await post(w, '/destination', l.cookie, grokFields('A'.repeat(43)), headers);
    assert.equal(r1.status, 403);
    assert.match(await r1.text(), /out of date or was not opened from DM Relay/);
    assert.equal(await w.routing.get(U1), null);
    const w2 = world();
    await w2.addGrok(U1);
    const d = await login(w2, 'disconnect', U1);
    const r2 = await post(w2, '/disconnect/confirm', d.cookie, { csrf: 'bad' }, headers);
    assert.equal(r2.status, 403);
    assert.match(await r2.text(), /out of date or was not opened from DM Relay/);
    assert.equal((await w2.entry(U1).core.check()).disconnected, false);
  }
});

test('POST /destination without or with wrong CSRF is rejected and writes nothing', async () => {
  const w = world();
  const l = await login(w);
  const { csrf: _omit, ...noCsrf } = grokFields('x');
  assert.equal((await post(w, '/destination', l.cookie, noCsrf)).status, 403);
  assert.equal((await post(w, '/destination', l.cookie, grokFields('A'.repeat(43)))).status, 403);
  assert.equal(await w.routing.get(U1), null);
  const other = await login(w, 'connect', U2);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(other.csrf))).status, 403);
});

test('cross-origin POST is rejected', async () => {
  const w = world();
  const l = await login(w);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf), { origin: 'https://evil.example' })).status, 403);
  assert.equal(await w.routing.get(U1), null);
});

test('user id in body or query is ignored: identity comes only from the session', async () => {
  const w = world();
  const l = await login(w, 'connect', U1);
  const res = await post(w, '/destination?user_id=' + U2 + '&uid=' + U2, l.cookie, grokFields(l.csrf, { user_id: U2, uid: U2, authed_user: U2 }));
  assert.equal(res.status, 200);
  assert.notEqual(await w.routing.get(U1), null);
  assert.equal(await w.routing.get(U2), null);
});

test('SSRF-unsafe destination URLs are refused at registration (no fetch made)', async () => {
  const w = world();
  const l = await login(w);
  const before = w.fetchImpl.calls.length;
  for (const url of ['http://hooks.x.ai/a', 'https://127.0.0.1/a', 'https://169.254.169.254/', 'https://relay.example.net/slack/events', 'https://u:p@hooks.x.ai/']) {
    assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf, { url }))).status, 400);
  }
  assert.equal(w.fetchImpl.calls.length, before);
  assert.equal(await w.routing.get(U1), null);
});

test('registration validation: secret prefix, attestations, claude token, dest type', async () => {
  const w = world();
  const l = await login(w);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf, { secret: 'plain' }))).status, 400);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf, { attest: '' }))).status, 400);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf, { dest_type: 'claude_routine', url: ROUTINE_URL, secret: '' }))).status, 400);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf, { dest_type: 'webhook' }))).status, 400);
  assert.equal(await w.routing.get(U1), null);
});

test('failed verification can be retried within the same session; success revokes the session', async () => {
  const w = world({ grok: () => respond(500) });
  const l = await login(w);
  const bad = await post(w, '/destination', l.cookie, grokFields(l.csrf));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Verification failed/);
  assert.equal(await w.routing.get(U1), null);
  w.ctl.grok = () => respond(202);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 200);
  assert.notEqual(await w.routing.get(U1), null);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 401);
});

test('verification that redirects (3xx) fails', async () => {
  const w = world({ grok: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) });
  const l = await login(w);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 400);
  assert.equal(w.fetchImpl.calls.filter((c) => c.url.includes('evil.example')).length, 0);
});

test('per-user registration rate limit', async () => {
  const w = world({ grok: () => respond(500) });
  const l = await login(w);
  for (let i = 0; i < 5; i++) assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 400);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 429);
  const calls = w.fetchImpl.calls.length;
  await post(w, '/destination', l.cookie, grokFields(l.csrf));
  assert.equal(w.fetchImpl.calls.length, calls);
});

test('connect session lasts one hour and is rejected after that', async () => {
  const w = world();
  const l = await login(w);
  w.clock.t += 3599000;
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 200);
  const l2 = await login(w);
  w.clock.t += 3601000;
  assert.equal((await post(w, '/destination', l2.cookie, grokFields(l2.csrf))).status, 401);
});

test('a disconnect session (which holds a Slack token) still expires after 10 minutes', async () => {
  const w = world();
  const d = await login(w, 'disconnect');
  const sess = setCookies(d.res).find((c) => c.startsWith('dmr_sess='));
  assert.ok(sess.includes('Max-Age=600'));
  w.clock.t += 601000;
  assert.equal((await post(w, '/disconnect/confirm', d.cookie, { csrf: d.csrf })).status, 401);
});

test('a status or disconnect session cannot register a destination', async () => {
  const w = world();
  const d = await login(w, 'disconnect');
  assert.equal((await post(w, '/destination', d.cookie, grokFields(d.csrf))).status, 403);
});

test('bare GET /disconnect revokes nothing and changes nothing', async () => {
  const w = world();
  await w.addGrok(U1);
  const res = await w.request('/disconnect');
  assert.equal(res.status, 200);
  assert.equal(w.fetchImpl.calls.length, 0);
  assert.notEqual(await w.routing.get(U1), null);
  assert.equal((await w.entry(U1).core.check()).disconnected, false);
  const callbackOnly = await login(w, 'disconnect', U1);
  assert.equal(w.fetchImpl.calls.some((c) => c.url.includes('auth.revoke')), false);
  assert.match(callbackOnly.html, /Confirm disconnect/);
  assert.notEqual(await w.routing.get(U1), null);
});

test('confirm POST: auth.revoke with the fresh token, disconnected flag set, route deleted, session gone', async () => {
  const w = world();
  await w.addGrok(U1);
  const d = await login(w, 'disconnect', U1);
  const res = await post(w, '/disconnect/confirm', d.cookie, { csrf: d.csrf });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Slack access was revoked/);
  const revoke = w.fetchImpl.calls.find((c) => c.url.includes('auth.revoke'));
  assert.equal(revoke.init.headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(await w.routing.get(U1), null);
  assert.equal((await w.entry(U1).core.check()).disconnected, true);
  assert.equal([...w.kv.store.keys()].some((k) => k.startsWith('sess:')), false);
  assert.equal(JSON.stringify([...w.kv.store]).includes(USER_TOKEN), false);
  assert.equal((await post(w, '/disconnect/confirm', d.cookie, { csrf: d.csrf })).status, 401);
});

test('confirm POST requires session and CSRF; connect sessions cannot disconnect', async () => {
  const w = world();
  await w.addGrok(U1);
  const d = await login(w, 'disconnect', U1);
  assert.equal((await post(w, '/disconnect/confirm', '', { csrf: d.csrf })).status, 401);
  assert.equal((await post(w, '/disconnect/confirm', d.cookie, {})).status, 403);
  assert.equal((await post(w, '/disconnect/confirm', d.cookie, { csrf: 'bad' })).status, 403);
  const c = await login(w, 'connect', U1);
  assert.equal((await post(w, '/disconnect/confirm', c.cookie, { csrf: c.csrf })).status, 403);
  assert.equal(w.fetchImpl.calls.some((c2) => c2.url.includes('auth.revoke')), false);
  assert.notEqual(await w.routing.get(U1), null);
});

test('disconnect still removes the route and flags the DO when Slack revoke fails, and says so', async () => {
  const w = world({ revoke: () => respond(500, 'x') });
  await w.addGrok(U1);
  const d = await login(w, 'disconnect', U1);
  const res = await post(w, '/disconnect/confirm', d.cookie, { csrf: d.csrf });
  assert.match(await res.text(), /could not be revoked/);
  assert.equal(await w.routing.get(U1), null);
  assert.equal((await w.entry(U1).core.check()).disconnected, true);
});

test('reconnecting after disconnect clears the disconnected flag', async () => {
  const w = world();
  await w.entry(U1).core.markDisconnected();
  const l = await login(w);
  assert.equal((await post(w, '/destination', l.cookie, grokFields(l.csrf))).status, 200);
  assert.equal((await w.entry(U1).core.check()).disconnected, false);
});

test('/status: its own OAuth round trip, shows only that user counters, mints no session', async () => {
  const w = world();
  await w.entry(U1).core.increment({ name: 'forwarded' });
  await w.entry(U1).core.increment({ name: 'forwarded' });
  await w.entry(U2).core.increment({ name: 'errors' });
  const st = await login(w, 'status', U1);
  assert.equal(st.res.status, 200);
  assert.match(st.html, /forwarded: 2/);
  assert.match(st.html, /errors: 0/);
  assert.equal(setCookies(st.res).some((c) => c.startsWith('dmr_sess=')), false);
  assert.equal(st.html.includes(USER_TOKEN), false);
  const bare = await w.request('/status');
  assert.equal(/forwarded: \d/.test(await bare.text()), false);
});

test('S3: after a confirmed disconnect the DO holds only the disconnected flag', async () => {
  const w = world();
  await w.addGrok(U1);
  await w.entry(U1).core.increment({ name: 'forwarded' });
  await w.entry(U1).core.noteActivity({ userId: U1, channelId: 'D0SECRETPAIR', ts: '1.1' });
  const d = await login(w, 'disconnect', U1);
  await post(w, '/disconnect/confirm', d.cookie, { csrf: d.csrf });
  assert.deepEqual([...w.entry(U1).storage.map.entries()], [['disconnected', true]]);
});

test('S5: /status for an unrouted user revokes their token; for a routed user it does not', async () => {
  const w = world();
  const s = await start(w, '/status');
  w.ctl.oauth = () => respond(200, oauthData(U2));
  assert.equal((await cb(w, s.state, s.cookiePair)).status, 200);
  const revokes = w.fetchImpl.calls.filter((c) => c.url.includes('auth.revoke'));
  assert.equal(revokes.length, 1);
  assert.equal(revokes[0].init.method, 'POST');
  assert.equal(revokes[0].init.headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.equal(revokes[0].init.redirect, 'manual');
  assert.ok(revokes[0].init.signal instanceof AbortSignal);

  const w2 = world();
  await w2.addGrok(U1);
  const s2 = await start(w2, '/status');
  assert.equal((await cb(w2, s2.state, s2.cookiePair)).status, 200);
  assert.equal(w2.fetchImpl.calls.some((c) => c.url.includes('auth.revoke')), false);
});

test('S5: a failing revoke on unrouted /status is tolerated and the status page still renders', async () => {
  for (const revoke of [() => respond(500, 'x'), () => { throw new Error('net'); }]) {
    const w = world({ revoke });
    const s = await start(w, '/status');
    const res = await cb(w, s.state, s.cookiePair);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Your status/);
  }
});

test('SF1: a status callback while the same user is mid-connect does not revoke their token', async () => {
  const w = world();
  const c = await login(w, 'connect', U1);
  assert.equal(c.res.status, 200);
  assert.ok(c.csrf);
  const s = await start(w, '/status');
  assert.equal((await cb(w, s.state, s.cookiePair)).status, 200);
  assert.equal(w.fetchImpl.calls.filter((x) => x.url.includes('auth.revoke')).length, 0);
  assert.equal((await post(w, '/destination', c.cookie, grokFields(c.csrf))).status, 200);
  assert.equal(w.fetchImpl.calls.filter((x) => x.url.includes('auth.revoke')).length, 0);
});

test('SF1: a status callback for an unrouted user who is not connecting still revokes; a connecting user is not shielded after wipe', async () => {
  const w = world();
  const s = await start(w, '/status');
  assert.equal((await cb(w, s.state, s.cookiePair)).status, 200);
  assert.equal(w.fetchImpl.calls.filter((x) => x.url.includes('auth.revoke')).length, 1);

  const w2 = world();
  await login(w2, 'connect', U1);
  await w2.entry(U1).core.wipe();
  assert.equal(w2.entry(U1).storage.get('connecting_until'), undefined);
  const s2 = await start(w2, '/status');
  assert.equal((await cb(w2, s2.state, s2.cookiePair)).status, 200);
  assert.equal(w2.fetchImpl.calls.filter((x) => x.url.includes('auth.revoke')).length, 1);
});
