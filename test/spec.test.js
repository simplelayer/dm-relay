import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_BODY_MAX } from '../src/constants.js';
import { APP, TEAM, U1, U2, USER_TOKEN, authListResponse, cookieHeaderFrom, isAuthList, makeWorld, msgPayload, respond, setCookies } from './helpers.js';

const SECRET_PATTERNS = [
  /crsr_[A-Za-z0-9_-]{16,}/,
  /dmr_[A-Za-z0-9_-]{20,}/,
  /whsec_[A-Za-z0-9+/=]{16,}/,
  /xox[bpa]-[A-Za-z0-9-]{10,}/,
  /xapp-[A-Za-z0-9-]{10,}/,
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /(token|secret|password|passwd|api_?key|private_?key)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{32,}["']/i
];
const CHANNEL_SCOPE = 'im:history,mpim:history,channels:history,groups:history';

function world() {
  const w = makeWorld({
    fetchHandler: (url) => {
      if (url.includes('oauth.v2.access')) {
        return respond(200, { ok: true, app_id: APP, team: { id: TEAM }, authed_user: { id: U1, scope: 'im:history,mpim:history', access_token: USER_TOKEN, token_type: 'user' } });
      }
      if (url.includes('auth.revoke')) return respond(200, { ok: true });
      if (isAuthList(url)) return authListResponse([U1, U2]);
      return respond(202);
    }
  });
  return w;
}

async function login(w) {
  const res = await w.request('/connect');
  const html = await res.text();
  const href = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize[^"]+)"/)[1].replaceAll('&amp;', '&');
  const state = new URL(href).searchParams.get('state');
  const cookiePair = setCookies(res).find((c) => c.startsWith('dmr_st_')).split(';')[0];
  const cb = await w.request(`/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiePair } });
  const page = await cb.text();
  return { csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1], cookie: cookieHeaderFrom(cb) };
}

async function ready({ scopes } = {}) {
  const w = world();
  await w.addGrok(U1);
  const l = await login(w);
  const res = await w.request('/keys/create', {
    method: 'POST',
    headers: { cookie: l.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: l.csrf, label: 'assistant' }).toString()
  });
  const key = (await res.text()).match(/value="(dmr_[A-Za-z0-9_-]+)"/)[1];
  if (scopes) await w.routing.put(U1, { ...(await w.routing.get(U1)), scopes });
  return { w, key };
}

const call = (w, key, path, { method = 'GET', body } = {}) =>
  w.request(path, { method, headers: key ? { authorization: `Bearer ${key}` } : {}, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

const getSpec = async () => (await call(world(), null, '/api/v1/spec')).json();

test('spec: has errors, examples and forwarded_payload, keeps its old keys and stays compact', async () => {
  const w = world();
  const res = await call(w, null, '/api/v1/spec');
  const text = await res.text();
  const spec = JSON.parse(text);
  for (const k of ['name', 'version', 'base_url', 'auth', 'notes', 'limits', 'endpoints', 'request_flow', 'cannot', 'errors', 'examples', 'forwarded_payload']) assert.ok(k in spec, k);
  assert.ok(Buffer.byteLength(text) < 13312, `spec is ${Buffer.byteLength(text)} bytes`);
  for (const re of SECRET_PATTERNS) assert.equal(re.test(text), false, String(re));
  assert.deepEqual(Object.keys(spec.examples.post_requests), ['destination', 'enable_send', 'add_trusted', 'enable_channels']);
  assert.match(spec.forwarded_payload.delivery, /GET \/api\/v1\/prompt/);
});

test('spec: PATCH fields are nested objects and dotted keys are documented and really rejected', async () => {
  const spec = await getSpec();
  const p = spec.endpoints.find((e) => e.method === 'PATCH');
  assert.deepEqual(Object.keys(p.fields), ['caps', 'filters', 'trusted_users', 'voice', 'channels']);
  assert.deepEqual(Object.keys(p.fields.caps), ['process', 'draft', 'send']);
  assert.match(p.description, /Dotted keys like .* are rejected: 400 bad_request "Unknown field: caps\.process"/);
  const { w, key } = await ready();
  const res = await call(w, key, '/api/v1/settings', { method: 'PATCH', body: { 'caps.process': false } });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request', message: 'Unknown field: caps.process' });
  assert.equal((await w.routing.get(U1)).caps, undefined);
});

test('spec: the example PATCH body is accepted and the example response has the real shape and values', async () => {
  const spec = await getSpec();
  const ex = spec.examples.patch_settings;
  const { w, key } = await ready();
  const res = await call(w, key, ex.request.path, { method: ex.request.method, body: ex.request.body });
  assert.equal(res.status, ex.response.status);
  const real = await res.json();
  const { api_keys: realKeys, ...realRest } = real;
  const { api_keys: exKeys, ...exRest } = ex.response.body;
  assert.deepEqual(realRest, exRest);
  assert.deepEqual(Object.keys(realKeys[0]), Object.keys(exKeys[0]));
});

test('spec: each example POST /requests body is accepted and the response matches the documented one', async () => {
  const spec = await getSpec();
  const { w, key } = await ready({ scopes: CHANNEL_SCOPE.split(',') });
  for (const type of ['destination', 'enable_send', 'add_trusted', 'enable_channels']) {
    const ex = spec.examples.post_requests[type];
    const res = await call(w, key, '/api/v1/requests', { method: 'POST', body: ex.body });
    assert.equal(res.status, ex.response.status, type);
    const real = await res.json();
    assert.deepEqual(Object.keys(real), Object.keys(ex.response.body), type);
    assert.match(real.id, /^[A-Za-z0-9_-]{22}$/);
    assert.match(ex.response.body.id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(real.type, ex.response.body.type);
    assert.equal(real.status, 'pending');
  }
  const dup = await call(w, key, '/api/v1/requests', { method: 'POST', body: spec.examples.post_requests.enable_send.body });
  assert.equal(dup.status, 200);
  const list = await (await call(w, key, '/api/v1/requests')).json();
  assert.equal(list.requests.length, 4);
});

test('spec: the GET /setup sample has the real step ids, keys and top-level shape', async () => {
  const spec = await getSpec();
  const { w, key } = await ready();
  const real = await (await call(w, key, '/api/v1/setup')).json();
  const ex = spec.examples.get_setup.response.body;
  assert.deepEqual(Object.keys(real), Object.keys(ex));
  assert.deepEqual(real.steps.map((s) => s.id).slice(0, ex.steps.length), ex.steps.map((s) => s.id));
  for (let i = 0; i < ex.steps.length; i++) {
    assert.deepEqual(Object.keys(real.steps[i]).sort(), Object.keys(ex.steps[i]).sort(), real.steps[i].id);
    assert.equal(real.steps[i].actor, ex.steps[i].actor);
  }
  assert.ok(real.steps.some((s) => s.id === ex.next_step));
});

test('spec: enable_channels without channel scopes is 409 scopes_missing and the docs say to open /connect?channels=1', async () => {
  const spec = await getSpec();
  const type = spec.endpoints.find((e) => e.method === 'POST' && e.path === '/api/v1/requests').types.enable_channels;
  assert.match(type.allowlist, /409 scopes_missing.*\/connect\?channels=1.*propose again/);
  assert.ok(spec.request_flow.some((s) => /scopes_missing/.test(s) && /\/connect\?channels=1/.test(s) && /POST the enable_channels proposal again/.test(s)));
  const err = spec.errors.list.find((e) => e.error === 'scopes_missing');
  assert.match(err.action, /\/connect\?channels=1/);
  const { w, key } = await ready();
  const res = await call(w, key, '/api/v1/requests', { method: 'POST', body: spec.examples.post_requests.enable_channels.body });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'scopes_missing');
  assert.match(body.message, /\/connect\?channels=1/);
});

test('spec: every documented error status and code is what the API really returns, with the documented shape', async () => {
  const spec = await getSpec();
  const documented = spec.errors.list.map((e) => `${e.status} ${e.error}`);
  assert.deepEqual(documented, ['400 bad_request', '401 unauthorized', '403 forbidden', '404 not_found', '405 method_not_allowed', '409 not_connected', '409 already_enabled', '409 scopes_missing', '409 too_many_pending', '413 too_large', '429 rate_limited']);
  for (const e of spec.errors.list) assert.ok(e.when && e.action, e.error);

  const seen = new Set();
  const expectErr = async (res, status, error, { hasMessage = true } = {}) => {
    assert.equal(res.status, status);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    const body = await res.json();
    assert.equal(body.error, error);
    assert.equal(typeof body.message === 'string', hasMessage, error);
    assert.deepEqual(Object.keys(body), hasMessage ? ['error', 'message'] : ['error']);
    seen.add(`${status} ${error}`);
    return res;
  };

  const { w, key } = await ready();
  const patch = (body) => call(w, key, '/api/v1/settings', { method: 'PATCH', body });
  await expectErr(await patch({ bogus: 1 }), 400, 'bad_request');
  await expectErr(await patch('{'), 400, 'bad_request');
  await expectErr(await call(w, key, '/api/v1/prompt?type=nope'), 400, 'bad_request');
  const un = await expectErr(await call(w, null, '/api/v1/settings'), 401, 'unauthorized', { hasMessage: false });
  assert.equal(un.headers.get('www-authenticate'), 'Bearer');
  await expectErr(await patch({ caps: { send: true } }), 403, 'forbidden');
  await expectErr(await patch({ trusted_users: [U2] }), 403, 'forbidden');
  await expectErr(await patch({ channels: { enabled: true } }), 403, 'forbidden');
  await expectErr(await call(w, key, '/api/v1/nope'), 404, 'not_found');
  await expectErr(await call(w, key, '/api/v1/requests/EXAMPLEreq0000000000id', { method: 'DELETE' }), 404, 'not_found');
  const m = await expectErr(await call(w, key, '/api/v1/spec', { method: 'POST' }), 405, 'method_not_allowed', { hasMessage: false });
  assert.equal(m.headers.get('allow'), 'GET');
  await expectErr(await call(w, key, '/api/v1/requests', { method: 'POST', body: { type: 'enable_channels' } }), 409, 'scopes_missing');
  await expectErr(await call(w, key, '/api/v1/settings', { method: 'PATCH', body: 'x'.repeat(API_BODY_MAX + 1) }), 413, 'too_large');

  const sendOn = await ready();
  await sendOn.w.routing.put(U1, { ...(await sendOn.w.routing.get(U1)), caps: { process: true, draft: true, send: true }, channels: { enabled: true }, scopes: CHANNEL_SCOPE.split(',') });
  await expectErr(await call(sendOn.w, sendOn.key, '/api/v1/requests', { method: 'POST', body: { type: 'enable_send' } }), 409, 'already_enabled');
  await expectErr(await call(sendOn.w, sendOn.key, '/api/v1/requests', { method: 'POST', body: { type: 'enable_channels' } }), 409, 'already_enabled');

  const pend = await ready();
  for (let i = 0; i < 5; i++) assert.equal((await call(pend.w, pend.key, '/api/v1/requests', { method: 'POST', body: { type: 'add_trusted', user_ids: [`U${i}AAAAAA`] } })).status, 201);
  await expectErr(await call(pend.w, pend.key, '/api/v1/requests', { method: 'POST', body: { type: 'add_trusted', user_ids: ['U9ZZZZZZ'] } }), 409, 'too_many_pending');

  const lim = await ready();
  let limited;
  for (let i = 0; i < 11; i++) limited = await call(lim.w, lim.key, '/api/v1/requests', { method: 'POST', body: { type: 'enable_send' } });
  assert.equal((await expectErr(limited, 429, 'rate_limited')).headers.get('retry-after'), '60');
  for (let i = 0; i < 60; i++) limited = await call(lim.w, lim.key, '/api/v1/status');
  assert.equal((await expectErr(limited, 429, 'rate_limited')).headers.get('retry-after'), '60');

  const none = world();
  const l = await login(none);
  const k = (await (await none.request('/keys/bootstrap', { method: 'POST', headers: { cookie: l.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: l.csrf }).toString() })).text()).match(/value="(dmr_[A-Za-z0-9_-]+)"/)[1];
  await expectErr(await call(none, k, '/api/v1/settings', { method: 'PATCH', body: { voice: 'x' } }), 409, 'not_connected');
  await expectErr(await call(none, k, '/api/v1/test', { method: 'POST' }), 409, 'not_connected');
  await expectErr(await call(none, k, '/api/v1/requests', { method: 'POST', body: { type: 'enable_send' } }), 409, 'not_connected');

  assert.deepEqual([...seen].sort(), [...documented].sort());
});

const destBodies = (w) => w.fetchImpl.calls.filter((c) => c.url.startsWith('https://hooks.x.ai/')).map((c) => JSON.parse(new TextDecoder().decode(c.init.body)));

test('spec: forwarded_payload fields, order and enums match what grok and cursor destinations receive', async () => {
  const spec = await getSpec();
  const fp = spec.forwarded_payload;
  const order = Object.keys(fp.fields_in_order);
  assert.deepEqual(Object.keys(fp.example), order);
  assert.deepEqual(fp.fields_in_order.type.split(' | ').map((t) => t.split(' ')[0]), ['dm', 'group_dm', 'channel', 'private_channel']);

  const w = world();
  await w.addGrok(U2, undefined, { full: true });
  const e = await w.routing.get(U2);
  await w.routing.put(U2, { ...e, voice: 'VOICEMARKER', channels: { enabled: true, mentions: true, allowlist: [] } });
  await w.send(msgPayload({ sender: U1, channel: 'D0CHAN1', channelType: 'im', eventId: 'E1' }));
  await w.send(msgPayload({ sender: U1, channel: 'G0GROUP1', channelType: 'mpim', eventId: 'E2' }));
  await w.send(msgPayload({ sender: U1, channel: 'C01ABCDEF2', channelType: 'channel', text: `hi <@${U2}>`, eventId: 'E3' }));
  await w.send(msgPayload({ sender: U1, channel: 'G01ABCDEF2', channelType: 'group', text: `hi <@${U2}>`, eventId: 'E4' }));
  const bodies = destBodies(w);
  assert.deepEqual(bodies.map((b) => b.type), ['dm', 'group_dm', 'channel', 'private_channel']);
  const withoutMentioned = order.filter((f) => f !== 'mentioned');
  const sortKeys = (o) => Object.keys(o).sort();
  assert.deepEqual(sortKeys(bodies[0]), sortKeys(Object.fromEntries(withoutMentioned.map((k) => [k, 1]))));
  assert.deepEqual(sortKeys(bodies[1]), sortKeys(Object.fromEntries(withoutMentioned.map((k) => [k, 1]))));
  assert.deepEqual(sortKeys(bodies[2]), sortKeys(Object.fromEntries(order.map((k) => [k, 1]))));
  assert.deepEqual(sortKeys(bodies[3]), sortKeys(Object.fromEntries(order.map((k) => [k, 1]))));
  assert.equal(bodies[2].mentioned, true);
  for (const b of bodies) assert.equal(JSON.stringify(b).includes('VOICEMARKER'), false);
  assert.match(fp.not_included, /voice is never in the payload/);
});

test('spec: the test payload documentation matches POST /api/v1/test', async () => {
  const spec = await getSpec();
  const { w, key } = await ready();
  const res = await call(w, key, '/api/v1/test', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()), ['ok', 'outcome', 'http_status']);
  const sent = destBodies(w).at(-1);
  assert.equal(sent.relay_test, true);
  assert.equal(sent.channel_id, 'DTESTCONN');
  assert.match(sent.event_id, /^evt_test_/);
  assert.match(spec.forwarded_payload.test_payloads, /"relay_test": true.*DTESTCONN/);
});
