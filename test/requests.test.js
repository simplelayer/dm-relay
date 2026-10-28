import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_BODY_MAX, HOUR_MS, REQUEST_TTL_MS } from '../src/constants.js';
import {
  APP,
  CURSOR_TOKEN,
  CURSOR_URL,
  GROK_SECRET,
  ROUTINE_TOKEN,
  ROUTINE_URL,
  TEAM,
  U1,
  U2,
  U3,
  U4,
  USER_TOKEN,
  authListResponse,
  cookieHeaderFrom,
  isAuthList,
  makeWorld,
  respond,
  setCookies
} from './helpers.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
const GROK_URL2 = 'https://grok.com/webhook/automation/abc123';

function oauthData(userId) {
  return { ok: true, app_id: APP, team: { id: TEAM }, authed_user: { id: userId, scope: 'im:history,mpim:history', access_token: USER_TOKEN, token_type: 'user' } };
}

function world() {
  const c = { user: U1, failDest: false };
  const w = makeWorld({
    fetchHandler: (url) => {
      if (url.includes('oauth.v2.access')) return respond(200, oauthData(c.user));
      if (url.includes('auth.revoke')) return respond(200, { ok: true });
      if (isAuthList(url)) return authListResponse([U1, U2]);
      return c.failDest ? respond(500) : respond(202);
    }
  });
  w.ctl = c;
  return w;
}

async function login(w, intent = 'connect', userId = U1) {
  w.ctl.user = userId;
  const res = await w.request(`/${intent}`);
  const html = await res.text();
  const href = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize[^"]+)"/)[1].replaceAll('&amp;', '&');
  const state = new URL(href).searchParams.get('state');
  const cookiePair = setCookies(res).find((c) => c.startsWith('dmr_st_')).split(';')[0];
  const cb = await w.request(`/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiePair } });
  const page = await cb.text();
  return { res: cb, html: page, csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1], cookie: cookieHeaderFrom(cb) };
}

const post = (w, path, l, fields, headers = {}) =>
  w.request(path, {
    method: 'POST',
    headers: { cookie: l.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ csrf: l.csrf, ...fields }).toString()
  });

const api = (w, key, path, { method = 'GET', body, headers = {} } = {}) =>
  w.request(path, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });

async function bootKey(w, l) {
  const res = await post(w, '/keys/bootstrap', l, {});
  const html = await res.text();
  return { res, html, key: html.match(/value="(dmr_[A-Za-z0-9_-]+)"/)?.[1] };
}

const rawPropose = (w, key, body) => api(w, key, '/api/v1/requests', { method: 'POST', body });
const propose = (w, key, body) => {
  w.clock.t += 7000;
  return rawPropose(w, key, body);
};
const cursorBody = (extra = {}) => ({ type: 'destination', dest_type: 'cursor', url: CURSOR_URL, secret: CURSOR_TOKEN, ...extra });
const approve = (w, l, id, fields = {}, headers = {}) => post(w, '/requests/approve', l, { id, ...fields }, headers);
const reject = (w, l, id) => post(w, '/requests/reject', l, { id });
const doDump = (w, uid = U1) => JSON.stringify([...w.entry(uid).storage.map]);
const doDumpWithoutReqs = (w, uid = U1) => JSON.stringify([...w.entry(uid).storage.map].filter(([k]) => k !== 'reqs'));
const kvDump = (w) => JSON.stringify([...w.kv.store]);
const destCalls = (w) => w.fetchImpl.calls.filter((c) => /cursor\.sh|x\.ai|grok\.com|anthropic\.com/.test(c.url)).length;
const reqs = async (w, uid = U1) => (await w.entry(uid).core.call('reqList', {})).requests;

async function ready(uid = U1) {
  const w = world();
  await w.addGrok(uid);
  const l = await login(w, 'connect', uid);
  const k = await bootKey(w, l);
  return { w, l, key: k.key };
}

async function fresh() {
  const w = world();
  const l = await login(w);
  const k = await bootKey(w, l);
  return { w, l, key: k.key };
}

test('setup: reports real state step by step, never marks the prompt done, and ends at null', async () => {
  const { w, l, key } = await fresh();
  let s = await (await api(w, key, '/api/v1/setup')).json();
  assert.deepEqual(s.steps.map((x) => x.id), ['slack_sign_in', 'destination', 'test', 'prompt', 'first_delivery', 'voice', 'trusted_senders']);
  assert.equal(s.next_step, 'destination');
  assert.equal(s.steps.find((x) => x.id === 'destination').actor, 'assistant');
  assert.ok(s.steps.every((x) => ['assistant', 'human'].includes(x.actor) && typeof x.how === 'string' && typeof x.title === 'string'));
  assert.equal(s.steps.find((x) => x.id === 'slack_sign_in').url, 'https://relay.example.net/connect');

  const id = (await (await propose(w, key, cursorBody())).json()).id;
  s = await (await api(w, key, '/api/v1/setup')).json();
  const dest = s.steps.find((x) => x.id === 'destination');
  assert.equal(dest.actor, 'human');
  assert.equal(dest.done, false);
  assert.match(dest.how, /Approve/);

  assert.equal((await approve(w, l, id, { attest: '1' })).status, 200);
  s = await (await api(w, key, '/api/v1/setup')).json();
  assert.equal(s.steps.find((x) => x.id === 'slack_sign_in').done, true);
  assert.equal(s.steps.find((x) => x.id === 'destination').done, true);
  assert.equal(s.next_step, 'test');

  assert.equal((await api(w, key, '/api/v1/test', { method: 'POST' })).status, 200);
  s = await (await api(w, key, '/api/v1/setup')).json();
  assert.equal(s.steps.find((x) => x.id === 'test').done, true);
  assert.equal(s.next_step, 'prompt');
  assert.equal(s.steps.find((x) => x.id === 'prompt').done, false);

  await w.entry(U1).core.call('recordDelivery', { dest: 'cursor', outcome: 'ok' });
  s = await (await api(w, key, '/api/v1/setup')).json();
  assert.equal(s.steps.find((x) => x.id === 'first_delivery').done, true);
  assert.equal(s.steps.find((x) => x.id === 'prompt').done, false);
  assert.equal(s.next_step, null);

  await api(w, key, '/api/v1/settings', { method: 'PATCH', body: { voice: 'warm' } });
  s = await (await api(w, key, '/api/v1/setup')).json();
  assert.equal(s.steps.find((x) => x.id === 'voice').done, true);
  assert.equal(s.steps.find((x) => x.id === 'trusted_senders').done, false);
  assert.equal((await api(w, undefined, '/api/v1/setup')).status, 401);
  assert.equal((await api(w, key, '/api/v1/setup', { method: 'POST' })).status, 405);
});

test('SECURITY: no API route can approve, reject or apply a request', async () => {
  const { w, key } = await ready();
  const id = (await (await propose(w, key, { type: 'enable_send' })).json()).id;
  const before = JSON.stringify(await w.routing.get(U1));
  const attempts = [];
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of [`/api/v1/requests/${id}/approve`, `/api/v1/requests/${id}/apply`, '/api/v1/requests/approve', '/api/v1/approve', `/api/v1/requests/${id}/status`]) {
      attempts.push([method, path]);
    }
  }
  for (const [method, path] of attempts) {
    const res = await api(w, key, path, { method, body: method === 'GET' ? undefined : { id, status: 'approved' } });
    assert.ok([404, 405].includes(res.status), `${method} ${path} -> ${res.status}`);
  }
  const viaBrowser = await w.request('/requests/approve', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id, confirm_send: '1', send_word: 'SEND' }).toString() });
  assert.equal(viaBrowser.status, 401, 'an API key is not a browser session');
  for (const method of ['POST', 'PUT', 'PATCH']) assert.equal((await api(w, key, `/api/v1/requests/${id}`, { method, body: { status: 'approved' } })).status, 405);
  assert.equal((await propose(w, key, { type: 'enable_send', status: 'approved' })).status, 400);
  assert.equal((await propose(w, key, { type: 'enable_send', approve: true })).status, 400);
  assert.equal(JSON.stringify(await w.routing.get(U1)), before);
  assert.equal((await reqs(w))[0].status, 'pending');
  const spec = await (await api(w, undefined, '/api/v1/spec')).json();
  assert.ok(spec.cannot.some((c) => /approve, reject or apply a request/.test(c)));
});

test('SECURITY: the destination secret never leaves the pending request store', async () => {
  const { w, l, key } = await fresh();
  const created = await propose(w, key, cursorBody());
  assert.equal(created.status, 201);
  const createdText = await created.text();
  const id = JSON.parse(createdText).id;
  const outputs = [createdText];
  for (const p of ['/api/v1/requests', '/api/v1/setup', '/api/v1/settings', '/api/v1/status', '/api/v1/spec']) outputs.push(await (await api(w, key, p)).text());
  outputs.push(await (await api(w, key, '/api/v1/requests', { method: 'POST', body: cursorBody() })).text());
  outputs.push(await (await api(w, key, '/api/v1/requests', { method: 'POST', body: { type: 'destination', dest_type: 'cursor', url: CURSOR_URL, secret: 'bad' } })).text());
  outputs.push(await (await api(w, key, '/api/v1/requests', { method: 'POST', body: '{"type":"destination","secret":' })).text());
  const page = await login(w);
  outputs.push(page.html);
  outputs.push(await (await w.request('/connect')).text());
  outputs.push((await login(w, 'status')).html);
  for (const text of outputs) {
    assert.equal(text.includes(CURSOR_TOKEN), false);
    assert.equal(text.includes('123e4567-e89b-12d3'), false, 'path hidden');
  }
  assert.ok(page.html.includes('api2.cursor.sh'));
  const pendingDump = doDump(w);
  assert.equal(pendingDump.includes(CURSOR_TOKEN), false, 'pending secret is encrypted at rest');
  assert.ok(pendingDump.includes('secret_enc'), 'the encrypted secret exists only in the pending request');
  assert.equal(doDumpWithoutReqs(w).includes(CURSOR_TOKEN), false);
  assert.equal(kvDump(w).includes(CURSOR_TOKEN), false);

  const failing = await (async () => {
    w.ctl.failDest = true;
    const res = await approve(w, l, id, { attest: '1' });
    w.ctl.failDest = false;
    return res;
  })();
  assert.equal(failing.status, 400);
  assert.equal((await failing.text()).includes(CURSOR_TOKEN), false);

  const ok = await approve(w, page, id, { attest: '1' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.text()).includes(CURSOR_TOKEN), false);
  assert.equal(doDump(w).includes(CURSOR_TOKEN), false, 'wiped from the Durable Object after approval');
  assert.equal(JSON.stringify((await w.entry(U1).core.status()).changes).includes(CURSOR_TOKEN), false);
  assert.equal(JSON.stringify((await w.entry(U1).core.status()).deliveries).includes(CURSOR_TOKEN), false);
  assert.equal((await w.routing.get(U1)).secret_or_bearer, CURSOR_TOKEN);
  assert.equal([...w.kv.store.keys()].some((k) => k.startsWith('req:')), false);
});

test('SECURITY: private, internal and metadata hosts and bad secret shapes are rejected at proposal, with no contact', async () => {
  const { w, key } = await fresh();
  const calls = destCalls(w);
  const bad = [
    { dest_type: 'cursor', url: 'https://169.254.169.254/automations/webhook/123e4567-e89b-12d3-a456-426614174000', secret: CURSOR_TOKEN },
    { dest_type: 'cursor', url: 'http://api2.cursor.sh/automations/webhook/123e4567-e89b-12d3-a456-426614174000', secret: CURSOR_TOKEN },
    { dest_type: 'grok', url: 'https://localhost/webhook/x', secret: GROK_SECRET },
    { dest_type: 'grok', url: 'https://127.0.0.1/webhook/x', secret: GROK_SECRET },
    { dest_type: 'grok', url: 'https://10.0.0.5/webhook/x', secret: GROK_SECRET },
    { dest_type: 'grok', url: 'https://[::1]/webhook/x', secret: GROK_SECRET },
    { dest_type: 'grok', url: 'https://metadata.google.internal/webhook/x', secret: GROK_SECRET },
    { dest_type: 'grok', url: 'https://relay.example.net/webhook/x', secret: GROK_SECRET },
    { dest_type: 'claude_routine', url: 'https://192.168.1.10/v1/claude_code/routines/x/fire', secret: ROUTINE_TOKEN },
    { dest_type: 'claude_routine', url: 'https://api.anthropic.com/v1/messages', secret: ROUTINE_TOKEN },
    { dest_type: 'grok', url: GROK_URL2, secret: 'whsec_***' },
    { dest_type: 'cursor', url: CURSOR_URL, secret: 'not-a-cursor-token' },
    { dest_type: 'claude_routine', url: ROUTINE_URL, secret: '   ' },
    { dest_type: 'other', url: CURSOR_URL, secret: CURSOR_TOKEN }
  ];
  for (const b of bad) {
    const res = await propose(w, key, { type: 'destination', ...b });
    assert.equal(res.status, 400, JSON.stringify(b.url));
  }
  assert.equal(destCalls(w), calls);
  assert.equal((await reqs(w)).length, 0);
  assert.equal((await propose(w, key, { type: 'destination', dest_type: 'grok', url: GROK_URL2, secret: GROK_SECRET })).status, 201);
  assert.equal((await propose(w, key, { type: 'destination', dest_type: 'claude_routine', url: ROUTINE_URL, secret: ROUTINE_TOKEN })).status, 201);
  assert.equal(destCalls(w), calls, 'valid proposals are not contacted either');
});

test('requests: ids are 16 random bytes, max 5 pending, dedupe, unknown fields 400, body and rate limits', async () => {
  const { w, key } = await ready();
  const seen = new Set();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const res = await propose(w, key, { type: 'add_trusted', user_ids: [`U${i}AAAAAA`] });
    assert.equal(res.status, 201);
    const j = await res.json();
    assert.match(j.id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(j.id, 'base64url').length, 16);
    assert.equal(j.status, 'pending');
    assert.equal(j.type, 'add_trusted');
    assert.ok(Date.parse(j.expires) > w.clock.t);
    seen.add(j.id);
    ids.push(j.id);
  }
  assert.equal(seen.size, 5);
  const over = await propose(w, key, { type: 'add_trusted', user_ids: [U4] });
  assert.equal(over.status, 409);
  const dup = await propose(w, key, { type: 'add_trusted', user_ids: ['u0aaaaaa'] });
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).id, ids[0]);
  assert.equal((await reqs(w)).length, 5);
  assert.equal((await api(w, key, `/api/v1/requests/${ids[0]}`, { method: 'DELETE' })).status, 200);
  assert.equal((await propose(w, key, { type: 'add_trusted', user_ids: [U4] })).status, 201);

  for (const body of [
    { type: 'add_trusted', user_ids: [U2], extra: 1 },
    { type: 'destination', dest_type: 'cursor', url: CURSOR_URL, secret: CURSOR_TOKEN, caps: {} },
    { type: 'enable_send', user_ids: [U2] },
    { type: 'nope' },
    {},
    [],
    { type: 'add_trusted', user_ids: [] },
    { type: 'add_trusted', user_ids: ['bad id'] },
    { type: 'add_trusted', user_ids: Array.from({ length: 11 }, (_, i) => `U${i}ZZZZZZ`) }
  ]) {
    assert.equal((await propose(w, key, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await propose(w, key, 'not json')).status, 400);
  assert.equal((await propose(w, key, 'x'.repeat(API_BODY_MAX + 1))).status, 413);
});

test('requests: proposals are rate limited per minute and need a saved destination for send and trusted', async () => {
  const { w, key } = await ready();
  for (let i = 0; i < 10; i++) assert.equal((await rawPropose(w, key, { type: 'enable_send' })).status, i === 0 ? 201 : 200);
  const limited = await rawPropose(w, key, { type: 'enable_send' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  w.clock.t += 61000;
  assert.equal((await rawPropose(w, key, { type: 'enable_send' })).status, 200);

  const f = await fresh();
  assert.equal((await propose(f.w, f.key, { type: 'enable_send' })).status, 409);
  assert.equal((await propose(f.w, f.key, { type: 'add_trusted', user_ids: [U2] })).status, 409);
  const sendOn = await ready(U3);
  await sendOn.w.routing.put(U3, { ...(await sendOn.w.routing.get(U3)), caps: { process: true, draft: true, send: true } });
  assert.equal((await propose(sendOn.w, sendOn.key, { type: 'enable_send' })).status, 409);
});

test('requests: list shows own requests without secrets; DELETE cancels only the owner\'s pending request', async () => {
  const a = await ready(U1);
  const idA = (await (await propose(a.w, a.key, cursorBody())).json()).id;
  const list = await (await api(a.w, a.key, '/api/v1/requests')).json();
  assert.deepEqual(Object.keys(list.requests[0]).sort(), ['created', 'expires', 'id', 'status', 'summary', 'type']);
  assert.equal(list.requests[0].summary, 'Save a Cursor automation webhook destination at api2.cursor.sh');
  assert.equal(list.requests[0].id, idA);

  const b = await ready(U2);
  assert.equal((await api(b.w, b.key, `/api/v1/requests/${idA}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await (await api(b.w, b.key, '/api/v1/requests')).json()).requests, []);

  const stolen = world();
  await stolen.addGrok(U1);
  await stolen.addGrok(U2);
  const l1 = await login(stolen, 'connect', U1);
  const k1 = await bootKey(stolen, l1);
  const idOwn = (await (await propose(stolen, k1.key, { type: 'enable_send' })).json()).id;
  const l2 = await login(stolen, 'connect', U2);
  const k2 = await bootKey(stolen, l2);
  assert.equal((await api(stolen, k2.key, `/api/v1/requests/${idOwn}`, { method: 'DELETE' })).status, 404);
  const hijack = await approve(stolen, l2, idOwn, { confirm_send: '1', send_word: 'SEND' });
  assert.equal(hijack.status, 400);
  assert.equal((await stolen.routing.get(U1)).caps, undefined);
  assert.equal((await stolen.routing.get(U2)).caps, undefined);
  assert.equal((await reqs(stolen, U1))[0].status, 'pending');
  assert.equal((await reject(stolen, l2, idOwn)).status, 400);
  assert.equal((await reqs(stolen, U1))[0].status, 'pending');

  assert.equal((await api(stolen, k1.key, `/api/v1/requests/${idOwn}`, { method: 'DELETE' })).status, 200);
  assert.equal((await reqs(stolen, U1))[0].status, 'cancelled');
  assert.equal((await api(stolen, k1.key, `/api/v1/requests/${idOwn}`, { method: 'DELETE' })).status, 404);
  const gone = await approve(stolen, l1, idOwn, { confirm_send: '1', send_word: 'SEND' });
  assert.equal(gone.status, 400);
  assert.equal((await stolen.routing.get(U1)).caps, undefined);
  assert.equal((await api(stolen, k1.key, '/api/v1/requests/short', { method: 'DELETE' })).status, 404);
});

test('SECURITY: approval needs a session, the CSRF token, a same-origin request and a connect session', async () => {
  const { w, l, key } = await ready();
  const id = (await (await propose(w, key, { type: 'add_trusted', user_ids: [U2] })).json()).id;
  const body = new URLSearchParams({ csrf: l.csrf, id }).toString();
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const noCookie = await w.request('/requests/approve', { method: 'POST', headers: form, body });
  assert.equal(noCookie.status, 401);
  const badCsrf = await post(w, '/requests/approve', { ...l, csrf: 'nope' }, { id });
  assert.equal(badCsrf.status, 403);
  const noCsrf = await w.request('/requests/approve', { method: 'POST', headers: { ...form, cookie: l.cookie }, body: new URLSearchParams({ id }).toString() });
  assert.equal(noCsrf.status, 403);
  assert.equal((await approve(w, l, id, {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await approve(w, l, id, {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await reject(w, { ...l, csrf: 'nope' }, id)).status, 403);
  assert.equal((await w.request('/requests/approve', { method: 'GET', headers: { cookie: l.cookie } })).status, 404);
  const dis = await login(w, 'disconnect');
  assert.equal((await approve(w, dis, id)).status, 403);
  assert.equal((await reqs(w))[0].status, 'pending');
  assert.equal((await w.routing.get(U1)).trusted_users, undefined);
  assert.equal((await approve(w, l, id, {}, { origin: 'https://relay.example.net' })).status, 200);
  assert.deepEqual((await w.routing.get(U1)).trusted_users, [U2]);
});

test('SECURITY: an expired request cannot be approved and its secret is dropped', async () => {
  const w = world();
  const l0 = await login(w);
  const k = await bootKey(w, l0);
  const id = (await (await propose(w, k.key, cursorBody())).json()).id;
  w.clock.t += REQUEST_TTL_MS - 1000;
  assert.equal((await reqs(w))[0].status, 'pending');
  w.clock.t += 2000;
  const l = await login(w);
  const res = await approve(w, l, id, { attest: '1' });
  assert.equal(res.status, 400);
  assert.equal(await w.routing.get(U1), null);
  assert.equal(destCalls(w), 0);
  assert.equal((await reqs(w))[0].status, 'expired');
  assert.equal(doDump(w).includes(CURSOR_TOKEN), false);
  const list = await (await api(w, k.key, '/api/v1/requests')).json();
  assert.equal(list.requests[0].status, 'expired');
  assert.equal((await api(w, k.key, `/api/v1/requests/${id}`, { method: 'DELETE' })).status, 404);
});

test('SECURITY: enabling send by approval needs confirm_send and the exact word SEND, and keeps the other settings', async () => {
  const { w, l, key } = await ready();
  const route = await w.routing.get(U1);
  await w.routing.put(U1, { ...route, caps: { process: false, draft: true, send: false }, filters: { skip_bots: false, skip_users: [], keywords: ['kw'] }, trusted_users: [U2], voice: 'VOICEKEEP' });
  const id = (await (await propose(w, key, { type: 'enable_send' })).json()).id;
  for (const f of [{}, { confirm_send: '1' }, { send_word: 'SEND' }, { confirm_send: '1', send_word: 'send' }, { confirm_send: '1', send_word: 'SEND ' }, { confirm_send: '1', send_word: 'SENDS' }]) {
    const res = await approve(w, l, id, f);
    assert.equal(res.status, 400, JSON.stringify(f));
    assert.match(await res.text(), /type SEND in capital letters/);
    assert.equal((await w.routing.get(U1)).caps.send, false);
    assert.equal((await reqs(w))[0].status, 'pending');
  }
  const ok = await approve(w, l, id, { confirm_send: '1', send_word: 'SEND' });
  assert.equal(ok.status, 200);
  const after = await w.routing.get(U1);
  assert.deepEqual(after.caps, { process: false, draft: true, send: true });
  assert.deepEqual(after.trusted_users, [U2]);
  assert.equal(after.voice, 'VOICEKEEP');
  assert.deepEqual(after.filters.keywords, ['kw']);
  assert.equal((await reqs(w))[0].status, 'approved');
  assert.equal((await approve(w, l, id, { confirm_send: '1', send_word: 'SEND' })).status, 400);
});

test('SECURITY: destination approval needs the attestation, runs verification, and a failure leaves it pending', async () => {
  const { w, l, key } = await ready();
  const route = await w.routing.get(U1);
  await w.routing.put(U1, { ...route, caps: { process: true, draft: false, send: false }, filters: { skip_bots: false, skip_users: [U3], keywords: [] }, trusted_users: [U2], voice: 'KEEPVOICE' });
  const id = (await (await propose(w, key, cursorBody())).json()).id;
  const grokBefore = JSON.stringify(await w.routing.get(U1));

  const noAttest = await approve(w, l, id, {});
  assert.equal(noAttest.status, 400);
  assert.match(await noAttest.text(), /training attestation is required/);
  assert.equal(destCalls(w), 0, 'no contact before the attestation');
  assert.equal(JSON.stringify(await w.routing.get(U1)), grokBefore);

  w.ctl.failDest = true;
  const failed = await approve(w, l, id, { attest: '1' });
  assert.equal(failed.status, 400);
  assert.match(await failed.text(), /Verification failed[^<]*still pending/);
  assert.ok(destCalls(w) >= 1, 'verification ran');
  w.ctl.failDest = false;
  assert.equal(JSON.stringify(await w.routing.get(U1)), grokBefore);
  assert.equal((await reqs(w))[0].status, 'pending');
  assert.deepEqual((await w.entry(U1).core.status()).changes, []);

  const ok = await approve(w, l, id, { attest: '1' });
  assert.equal(ok.status, 200);
  const after = await w.routing.get(U1);
  assert.equal(after.dest_type, 'cursor');
  assert.equal(after.url, CURSOR_URL);
  assert.equal(after.mode, 'ids_only');
  assert.deepEqual(after.caps, { process: true, draft: false, send: false });
  assert.deepEqual(after.filters.skip_users, [U3]);
  assert.deepEqual(after.trusted_users, [U2]);
  assert.equal(after.voice, 'KEEPVOICE');
  assert.equal((await reqs(w))[0].status, 'approved');
  assert.deepEqual((await w.entry(U1).core.status()).changes.map((c) => [c.via, c.fields]), [['approval', ['request:destination']]]);
});

test('add_trusted approval merges with normalizeIds and the cap; a full list leaves the request pending', async () => {
  const { w, l, key } = await ready();
  const route = await w.routing.get(U1);
  await w.routing.put(U1, { ...route, trusted_users: [U2] });
  const id = (await (await propose(w, key, { type: 'add_trusted', user_ids: [U3.toLowerCase(), U4, U2] })).json()).id;
  assert.equal((await approve(w, l, id)).status, 200);
  assert.deepEqual((await w.routing.get(U1)).trusted_users, [U2, U3, U4]);

  const many = Array.from({ length: 49 }, (_, i) => `U${String(i).padStart(2, '0')}ZZZZZ`);
  await w.routing.put(U1, { ...(await w.routing.get(U1)), trusted_users: many });
  const over = (await (await propose(w, key, { type: 'add_trusted', user_ids: ['UAAAAAAA', 'UBBBBBBB'] })).json()).id;
  const res = await approve(w, l, over);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /At most 50 user IDs/);
  assert.equal((await w.routing.get(U1)).trusted_users.length, 49);
  assert.equal((await reqs(w)).find((r) => r.id === over).status, 'pending');
});

test('reject records the decision, changes nothing and logs names only', async () => {
  const { w, l, key } = await ready();
  const before = JSON.stringify(await w.routing.get(U1));
  const id = (await (await propose(w, key, { type: 'enable_send' })).json()).id;
  const res = await reject(w, l, id);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Request rejected/);
  assert.equal(JSON.stringify(await w.routing.get(U1)), before);
  assert.equal((await reqs(w))[0].status, 'rejected');
  assert.equal((await reject(w, l, id)).status, 400);
  const log = (await w.entry(U1).core.status()).changes;
  assert.deepEqual(log.map((c) => [c.via, c.fields]), [['approval', ['request:enable_send:rejected']]]);
});

test('SECURITY: the change log never contains values after approvals and rejections', async () => {
  const { w, l, key } = await ready();
  const a = (await (await propose(w, key, cursorBody())).json()).id;
  const b = (await (await propose(w, key, { type: 'add_trusted', user_ids: [U3] })).json()).id;
  const c = (await (await propose(w, key, { type: 'enable_send' })).json()).id;
  await approve(w, l, a, { attest: '1' });
  await approve(w, l, b);
  await reject(w, l, c);
  const log = JSON.stringify((await w.entry(U1).core.status()).changes);
  for (const v of [CURSOR_TOKEN, CURSOR_URL, 'api2.cursor.sh', U3, 'SEND']) assert.equal(log.includes(v), false, v);
  assert.match(log, /request:destination/);
  assert.match(log, /request:add_trusted/);
  await assert.rejects(() => w.entry(U1).core.call('logChange', { via: 'approval', fields: [`request:${CURSOR_TOKEN}`] }));
  await assert.rejects(() => w.entry(U1).core.call('logChange', { via: 'approval', fields: ['request:destination:SEND'] }));
});

test('SECURITY: all requests are wiped on disconnect, tokens_revoked and app_uninstalled', async () => {
  for (const mode of ['disconnect', 'tokens_revoked', 'app_uninstalled']) {
    const { w, key } = await ready();
    await propose(w, key, cursorBody());
    await propose(w, key, { type: 'enable_send' });
    assert.equal((await reqs(w)).length, 2);
    assert.ok(doDump(w).includes('secret_enc'));
    if (mode === 'disconnect') {
      const d = await login(w, 'disconnect');
      assert.equal((await post(w, '/disconnect/confirm', d, {})).status, 200);
    } else {
      const payload = { token: 'legacy', team_id: TEAM, api_app_id: APP, type: 'event_callback', event_id: 'Ev9', event_time: 1800000000, event: { type: mode, tokens: { oauth: [U1] } } };
      const res = await w.send(payload);
      assert.equal(res.status, 200);
    }
    assert.deepEqual((await reqs(w)), [], mode);
    assert.equal(doDump(w).includes(CURSOR_TOKEN), false, mode);
    assert.deepEqual([...w.entry(U1).storage.map.keys()], ['disconnected'], mode);
    assert.equal((await api(w, key, '/api/v1/requests')).status, 401, mode);
  }
});

test('/connect: pending requests show the exact change (host only), a banner, and warnings', async () => {
  const { w, key } = await ready();
  await propose(w, key, cursorBody());
  await propose(w, key, { type: 'enable_send' });
  await propose(w, key, { type: 'add_trusted', user_ids: [U3, U4] });
  const l = await login(w);
  assert.match(l.html, /3 requests from your assistant are waiting for your approval/);
  assert.match(l.html, /Save a Cursor automation webhook destination at api2\.cursor\.sh/);
  assert.equal(l.html.includes('123e4567-e89b-12d3'), false);
  assert.equal(l.html.includes(CURSOR_TOKEN), false);
  assert.match(l.html, /Strong warning/);
  assert.match(l.html, /<code>U3CCCCCC<\/code> <code>U4DDDDDD<\/code>/);
  assert.equal((l.html.match(/action="\/requests\/approve"/g) || []).length, 3);
  assert.equal((l.html.match(/action="\/requests\/reject"/g) || []).length, 3);
  assert.match(l.html, /name="attest" value="1" required/);
  assert.match(l.html, /name="send_word"/);
  assert.match(l.html, /<details class="card" id="requests" open>/);
  const status = await login(w, 'status');
  assert.match(status.html, /3 requests from your assistant are waiting/);
  const quiet = await login(world(), 'connect');
  assert.equal(/waiting for your approval/.test(quiet.html), false);
  assert.match(quiet.html, /<details class="card" id="requests">/);
});

test('bootstrap: the button appears with fewer than 2 keys, works without a destination, and shows the one-time copy block', async () => {
  const w = world();
  const l = await login(w);
  assert.match(l.html, /action="\/keys\/bootstrap"/);
  assert.match(l.html, /Set up with my assistant/);
  assert.match(l.html, /id="spec-url"[^>]*value="https:\/\/relay\.example\.net\/api\/v1\/spec"/);
  assert.match(l.html, /data-copy="spec-url"/);
  assert.equal((await w.request('/keys/bootstrap', { method: 'POST', headers: { cookie: l.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=nope' })).status, 403);
  assert.equal((await w.request('/keys/bootstrap', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${l.csrf}` })).status, 401);
  assert.equal((await post(w, '/keys/bootstrap', l, {}, { origin: 'https://evil.example' })).status, 403);

  const res = await post(w, '/keys/bootstrap', l, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  const key = html.match(/value="(dmr_[A-Za-z0-9_-]+)"/)[1];
  assert.match(html, /shown once/);
  assert.ok(html.includes(`DM Relay assistant key: ${key}`));
  assert.ok(html.includes('Spec URL: https://relay.example.net/api/v1/spec'));
  assert.ok(html.includes('Fetch the spec URL, then call GET /api/v1/setup with this key and follow next_step. Never post or send anything unless the user has approved Send.'));
  const keys = (await w.entry(U1).core.call('listKeys', {})).keys;
  assert.deepEqual(keys.map((k) => k.label), ['assistant']);
  assert.equal(kvDump(w).includes(key), false);
  assert.equal(doDump(w).includes(key), false);
  assert.equal((await api(w, key, '/api/v1/setup')).status, 200);

  const second = await login(w);
  assert.equal((await post(w, '/keys/bootstrap', second, {})).status, 200);
  const third = await login(w);
  assert.equal(third.html.includes('action="/keys/bootstrap"'), false);
  assert.match(third.html, /already have 2 active keys/);
  const refused = await post(w, '/keys/bootstrap', third, {});
  assert.equal(refused.status, 400);
  assert.equal((await w.entry(U1).core.call('listKeys', {})).keys.length, 2);

  const again = await login(w);
  assert.equal(again.html.includes(key), false);
  assert.equal(again.html.includes('Fetch the spec URL'), false, 'the combined block exists only on the key page');
});

test('/connect checklist and capability banner are computed from real state', async () => {
  const w = world();
  const fresh0 = await login(w);
  assert.match(fresh0.html, /1 of 4 done/);
  assert.match(fresh0.html, /Your assistant can: process, draft\. It cannot send\./);
  assert.equal(/id="capabilities"/.test(fresh0.html), false);

  await w.addGrok(U1);
  let l = await login(w);
  assert.match(l.html, /2 of 4 done/);
  assert.match(l.html, /id="capabilities"/);
  assert.match(l.html, /<details class="card" id="capabilities" open>/);
  assert.match(l.html, /<details class="card" id="connection" open>/);
  assert.match(l.html, /Press Send test/);

  assert.equal((await post(w, '/destination/test', l, {})).status, 200);
  l = await login(w);
  assert.match(l.html, /3 of 4 done/);
  assert.match(l.html, /The relay reached your destination/);

  w.entry(U1).core.s.put('c:forwarded', 1);
  l = await login(w);
  assert.match(l.html, /4 of 4 done/);

  const caps = await post(w, '/caps', l, { process: '1', draft: '1', send: '1', confirm_send: '1', send_word: 'SEND' });
  const text = await caps.text();
  assert.match(text, /Your assistant can: process, draft, send\./);
  assert.match(text, /reply on your behalf/);
  assert.match(text, /class="send-box"/);
  const off = await (await post(w, '/caps', l, { process: '1' })).text();
  assert.match(off, /Your assistant can: process\. It cannot send\./);
});

test('/connect destination form shows per-type hints with CSS only and example formats', async () => {
  const w = world();
  const l = await login(w);
  for (const t of ['grok', 'cursor', 'claude_routine']) assert.match(l.html, new RegExp(`id="t-${t}"`));
  assert.match(l.html, /@supports selector\(:has\(\*\)\)/);
  assert.match(l.html, /:has\(#t-cursor:checked\) \.only\.cursor/);
  assert.match(l.html, /https:\/\/grok\.com\/webhook\/automation\/&lt;id&gt;/);
  assert.match(l.html, /https:\/\/api2\.cursor\.sh\/automations\/webhook\/&lt;uuid&gt;/);
  assert.match(l.html, /https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/&lt;trigger_id&gt;\/fire/);
  assert.match(l.html, /<fieldset><legend>Destination type<\/legend>/);
  assert.match(l.html, /<label for="f-url">/);
  assert.match(l.html, /role="status"|role="alert"|<form/);
  await w.addCursor(U1);
  const saved = await login(w);
  assert.match(saved.html, /id="t-cursor" type="radio" name="dest_type" value="cursor" checked/);
});

test('/status: accessible 24 hour chart, delivery table and approval banner', async () => {
  const { w, key } = await ready();
  for (let i = 0; i < 3; i++) await w.entry(U1).core.call('recordDelivery', { dest: 'grok', outcome: 'ok' });
  w.clock.t += 3 * HOUR_MS;
  await w.entry(U1).core.call('recordDelivery', { dest: 'grok', outcome: 'http_500' });
  await w.entry(U1).core.call('recordFiltered', { reason: 'bot' });
  await propose(w, key, { type: 'enable_send' });
  const s = await login(w, 'status');
  assert.match(s.html, /<svg class="chart" viewBox="0 0 720 166" role="img" aria-label="Deliveries per hour for the last 24 hours\. Last 24 hours: 3 delivered, 1 filtered, 1 failed\./);
  assert.equal((s.html.match(/<rect /g) || []).length, 3);
  assert.match(s.html, /Show the data as a table/);
  assert.match(s.html, /<th scope="col">Hour \(UTC\)<\/th>/);
  assert.match(s.html, /Last 24 hours: 3 delivered, 1 filtered, 1 failed/);
  assert.match(s.html, /<th scope="col">Outcome<\/th>/);
  assert.match(s.html, /<span class="badge ok">ok<\/span>/);
  assert.match(s.html, /1 request from your assistant is waiting/);
  const hourly = (await w.entry(U1).core.status()).hourly;
  assert.equal(hourly.length, 24);
  assert.equal(hourly.reduce((a, h) => a + h.delivered, 0), 3);
  assert.ok(hourly.every((h, i) => i === 0 || h.t - hourly[i - 1].t === HOUR_MS));
});

test('friendly error, expired-session and message pages say what to do and link to start again', async () => {
  const w = world();
  const expired = await w.request('/filters', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'csrf=x' });
  assert.equal(expired.status, 401);
  const html = await expired.text();
  assert.match(html, /Session expired/);
  assert.match(html, /<a class="btn btn-primary" href="\/connect">Start again<\/a>/);
  const bad = await (await w.request('/oauth/callback?state=bad')).text();
  assert.match(bad, /Start again/);
  const nf = await w.request('/nope');
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /Go to DM Relay/);
});

test('the pre-OAuth page explains DM Relay in plain language and keeps the disclosures', async () => {
  const w = world();
  const html = await (await w.request('/connect')).text();
  assert.match(html, /What is DM Relay\?/);
  assert.match(html, /turns your Slack direct messages into draft replies from your own AI assistant/);
  assert.match(html, /The relay never sends anything itself/);
  assert.match(html, /disconnect at any time/);
  assert.match(html, /best-effort and at-most-once/);
});

test('SECURITY: every page keeps the strict CSP, only copy-button pages add a nonce script, and no page has inline handlers', async () => {
  const { w, l, key } = await ready();
  await propose(w, key, cursorBody());
  await propose(w, key, { type: 'enable_send' });
  const nonceCsp = /^default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; script-src 'nonce-[A-Za-z0-9_-]+'$/;
  const pages = [];
  const grab = async (name, res, copy, html) => pages.push({ name, copy, res, html: html ?? (await res.text()) });
  await grab('pre-oauth', await w.request('/connect'), false);
  await grab('pre-oauth status', await w.request('/status'), false);
  await grab('pre-oauth disconnect', await w.request('/disconnect'), false);
  const c1 = await login(w);
  await grab('connect', c1.res, true, c1.html);
  const c2 = await login(w, 'status');
  await grab('status', c2.res, false, c2.html);
  const c3 = await login(w, 'disconnect');
  await grab('disconnect confirm', c3.res, false, c3.html);
  await grab('test fire', await post(w, '/destination/test', l, {}), true);
  await grab('caps error', await post(w, '/caps', l, { send: '1' }), true);
  await grab('approve error', await approve(w, l, 'x'.repeat(22)), true);
  await grab('bootstrap key page', await post(w, '/keys/bootstrap', l, {}), false);
  await grab('key limit error', await post(w, '/keys/create', l, {}), true);
  await grab('forbidden', await post(w, '/filters', { ...l, csrf: 'bad' }, {}), false);
  await grab('not found', await w.request('/nope'), false);
  await grab('expired', await w.request('/filters', { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), false);
  for (const p of pages) {
    const csp = p.res.headers.get('content-security-policy');
    if (p.copy) {
      assert.match(csp, nonceCsp, p.name);
      assert.match(p.html, new RegExp(`<script nonce="${csp.match(/nonce-([A-Za-z0-9_-]+)/)[1]}">`), p.name);
      assert.equal((p.html.match(/<script/g) || []).length, 1, p.name);
    } else {
      assert.equal(csp, CSP, p.name);
      assert.equal(/<script/i.test(p.html), false, p.name);
    }
    assert.equal(/<[^>]+\son[a-z]+\s*=/i.test(p.html), false, `${p.name} has an inline handler`);
    assert.equal(/<(img|iframe|link|object|embed)\b/i.test(p.html), false, p.name);
    assert.equal(/(src|href)="https?:\/\/(?!slack\.com\/oauth\/v2\/authorize|github\.example\/dm-relay)/.test(p.html), false, p.name);
    assert.equal(/url\(|@import|@font-face/i.test(p.html), false, p.name);
    assert.equal(p.res.headers.get('cache-control'), 'no-store', p.name);
  }
  const nonces = pages.filter((p) => p.copy).map((p) => p.res.headers.get('content-security-policy'));
  assert.equal(new Set(nonces).size, nonces.length, 'a fresh nonce per response');
});

test('the spec documents the request flow, the new endpoints and what the API cannot do', async () => {
  const w = world();
  const spec = await (await api(w, undefined, '/api/v1/spec')).json();
  const text = JSON.stringify(spec);
  for (const p of ['/api/v1/setup', '/api/v1/requests', '/api/v1/requests/<id>']) assert.ok(text.includes(p), p);
  assert.ok(spec.request_flow.length >= 3);
  assert.equal(spec.limits.pending_requests_max, 5);
  assert.equal(spec.limits.request_lifetime_hours, 24);
  assert.ok(spec.cannot.some((c) => /approve, reject or apply a request/.test(c)));
  assert.equal(text.includes(CURSOR_TOKEN), false);
});
