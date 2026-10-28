import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAuthorizedUserIds, resolveRecipients } from '../src/fanout.js';
import { kvRouting } from '../src/routes.js';
import { routeCryptoFromEnv } from '../src/secret-crypto.js';
import { APP_TOKEN, FakeKV, GROK_SECRET, ROUTE_ENC_KEY, ROUTE_ENC_KID, U1, U2, U3, U4, authListResponse, makeFetch, makeWorld, msgPayload, respond, timeoutError } from './helpers.js';

const fresh = () => ({ routedSample: { at: -Infinity, ids: null }, nowMs: 1_800_000_000_000 });

async function routingWith(...uids) {
  const kv = new FakeKV();
  const routing = kvRouting(kv, routeCryptoFromEnv({ ROUTE_SECRET_ENCRYPTION_KEY: ROUTE_ENC_KEY, ROUTE_SECRET_KEY_ID: ROUTE_ENC_KID }));
  for (const u of uids) await routing.put(u, { dest_type: 'grok', url: `https://hooks.x.ai/${u}`, secret_or_bearer: GROK_SECRET, mode: 'full' });
  return routing;
}

test('union of authorizations[] and the API list, minus sender, intersected with routing table', async () => {
  const routing = await routingWith(U1, U2, U3);
  const f = makeFetch(() => authListResponse([U1, U2, U4]));
  const payload = msgPayload({ sender: U1, authorizations: [{ user_id: U3, is_bot: false }] });
  const { recipients, degraded } = await resolveRecipients({ payload, routing, ...fresh(), appToken: APP_TOKEN, fetchImpl: f });
  assert.deepEqual(recipients.map((r) => r.userId).sort(), [U2, U3]);
  assert.equal(degraded, false);
});

test('authorizations.list call: app token, event_context, 3 s timeout signal', async () => {
  const routing = await routingWith(U1, U2);
  const f = makeFetch(() => authListResponse([U1, U2]));
  await resolveRecipients({ payload: msgPayload({ sender: U1 }), routing, ...fresh(), appToken: APP_TOKEN, fetchImpl: f });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://slack.com/api/apps.event.authorizations.list');
  assert.equal(init.headers.authorization, `Bearer ${APP_TOKEN}`);
  assert.equal(JSON.parse(init.body).event_context, 'ctx-1');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.redirect, 'manual');
});

test('API call skipped when the routing table has 0 or 1 entries', async () => {
  for (const uids of [[], [U2]]) {
    const routing = await routingWith(...uids);
    const f = makeFetch(() => authListResponse([U2]));
    const { recipients, degraded } = await resolveRecipients({ payload: msgPayload({ sender: U1 }), routing, ...fresh(), appToken: APP_TOKEN, fetchImpl: f });
    assert.equal(f.calls.length, 0);
    assert.equal(degraded, false);
    assert.equal(recipients.length, uids.length);
  }
});

test('API call is made when the routing table has 2 entries', async () => {
  const routing = await routingWith(U1, U2);
  const f = makeFetch(() => authListResponse([U2]));
  await resolveRecipients({ payload: msgPayload({ sender: U1 }), routing, ...fresh(), appToken: APP_TOKEN, fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

test('pagination follows next_cursor', async () => {
  let page = 0;
  const f = makeFetch((_u, init) => {
    page++;
    const body = JSON.parse(init.body);
    if (page === 1) {
      assert.equal(body.cursor, undefined);
      return respond(200, { ok: true, authorizations: [{ user_id: U1 }], response_metadata: { next_cursor: 'c2' } });
    }
    assert.equal(body.cursor, 'c2');
    return respond(200, { ok: true, authorizations: [{ user_id: U2 }], response_metadata: { next_cursor: '' } });
  });
  const r = await listAuthorizedUserIds({ eventContext: 'x', appToken: APP_TOKEN, fetchImpl: f });
  assert.deepEqual(r, { ok: true, ids: [U1, U2] });
  assert.equal(f.calls.length, 2);
});

test('one retry: first failure then success is not degraded', async () => {
  const routing = await routingWith(U1, U2);
  let n = 0;
  const f = makeFetch(() => {
    n++;
    if (n === 1) throw timeoutError();
    return authListResponse([U1, U2]);
  });
  const { recipients, degraded } = await resolveRecipients({ payload: msgPayload({ sender: U1, authorizations: [] }), routing, ...fresh(), appToken: APP_TOKEN, fetchImpl: f });
  assert.equal(f.calls.length, 2);
  assert.equal(degraded, false);
  assert.deepEqual(recipients.map((r) => r.userId), [U2]);
});

test('failure after retry falls back to authorizations[] and reports degraded', async () => {
  const routing = await routingWith(U1, U2);
  const f = makeFetch(() => respond(500));
  const payload = msgPayload({ sender: U1, authorizations: [{ user_id: U2, is_bot: false }] });
  const { recipients, degraded } = await resolveRecipients({ payload, routing, ...fresh(), appToken: APP_TOKEN, fetchImpl: f });
  assert.equal(f.calls.length, 2);
  assert.equal(degraded, true);
  assert.deepEqual(recipients.map((r) => r.userId), [U2]);
});

test('ok:false and malformed responses count as failures', async () => {
  const f = makeFetch(() => respond(200, { ok: false, error: 'ratelimited' }));
  assert.equal((await listAuthorizedUserIds({ eventContext: 'x', appToken: 't', fetchImpl: f })).ok, false);
  const g = makeFetch(() => respond(200, 'not json'));
  assert.equal((await listAuthorizedUserIds({ eventContext: 'x', appToken: 't', fetchImpl: g })).ok, false);
});

test('sender is excluded even if present in both lists; duplicates collapse to one recipient', async () => {
  const routing = await routingWith(U1, U2);
  const f = makeFetch(() => authListResponse([U1, U2, U2]));
  const payload = msgPayload({ sender: U1, authorizations: [{ user_id: U1 }, { user_id: U2 }] });
  const { recipients } = await resolveRecipients({ payload, routing, ...fresh(), appToken: APP_TOKEN, fetchImpl: f });
  assert.deepEqual(recipients.map((r) => r.userId), [U2]);
});

test('degraded fan-out increments the fanout_degraded counter of each affected recipient', async () => {
  const w = makeWorld({ fetchHandler: (url) => (url.includes('slack.com') ? respond(500) : respond(202)) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U1, authorizations: [{ user_id: U2, is_bot: false }] }));
  const st = await w.entry(U2).core.status();
  assert.equal(st.counters.fanout_degraded, 1);
  assert.equal(st.counters.forwarded, 1);
});
