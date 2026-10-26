import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { UserDO, makeDoClient } from '../src/user-do.js';
import { FakeKV, ROUTINE_TOKEN, ROUTINE_URL, U1, U2 } from './helpers.js';

function fakeNamespace(env) {
  const objects = new Map();
  const alarms = new Map();
  const ns = {
    idFromName: (name) => `id:${name}`,
    get(id) {
      if (!objects.has(id)) {
        const kvMap = new Map();
        const ctx = {
          storage: {
            kv: { get: (k) => kvMap.get(k), put: (k, v) => kvMap.set(k, v), delete: (k) => kvMap.delete(k) },
            deleteAll: async () => kvMap.clear(),
            setAlarm: async (t) => alarms.set(id, t),
            deleteAlarm: async () => alarms.delete(id)
          }
        };
        objects.set(id, new UserDO(ctx, env));
      }
      const obj = objects.get(id);
      return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
    }
  };
  return { ns, alarms };
}

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

async function setup() {
  const routes = new FakeKV();
  await routes.put(`route:${U1}`, JSON.stringify({ dest_type: 'claude_routine', url: ROUTINE_URL, secret_or_bearer: ROUTINE_TOKEN, mode: 'nudge' }));
  const env = { ROUTES: routes, BASE_URL: 'https://relay.example.net', OPERATOR_HOSTS: '' };
  const { ns, alarms } = fakeNamespace(env);
  env.USER_DO = ns;
  return { env, client: makeDoClient(ns), alarms };
}

test('DO client round trip: noteActivity arguments are serialized through UserDO.fetch into the core and fire', async () => {
  const { client, alarms } = await setup();
  await withFetch(
    () => new Response('', { status: 200 }),
    async (calls) => {
      const r1 = await client(U1).noteActivity({ userId: U1, channelId: 'D0CHAN1', ts: '1800000000.000100' });
      assert.deepEqual(r1, { action: 'fired', kind: 'ok' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, ROUTINE_URL);
      assert.equal(calls[0].init.headers.authorization, `Bearer ${ROUTINE_TOKEN}`);
      assert.ok(calls[0].init.body.includes('D0CHAN1'));
      assert.ok(calls[0].init.body.includes('1800000000.000100'));
      const r2 = await client(U1).noteActivity({ userId: U1, channelId: 'D0CHAN1', ts: '1800000000.000200' });
      assert.deepEqual(r2, { action: 'pending' });
      assert.equal(calls.length, 1);
    }
  );
  assert.ok(alarms.get('id:' + U1) > Date.now());
  const st = await client(U1).status();
  assert.equal(st.counters.forwarded, 1);
  assert.equal(st.counters.coalesced, 1);
  assert.equal((await client(U2).status()).counters.forwarded, 0);
});

test('DO client: every core method is reachable and a non-2xx response becomes a throw', async () => {
  const { client } = await setup();
  assert.deepEqual(await client(U1).check(), { disconnected: false });
  assert.deepEqual(await client(U1).increment({ name: 'errors' }), { ok: true });
  assert.deepEqual(await client(U1).check(), { disconnected: false });
  assert.deepEqual(await client(U1).wipe(), { ok: true });
  assert.deepEqual(await client(U1).check(), { disconnected: true });
  await assert.rejects(() => client(U1).bogus(), /E_DO_CALL/);
  await assert.rejects(() => client(U1).increment({ name: 'not_a_counter' }), /E_DO_CALL/);
});

test('default export returns 500 with only E_UNHANDLED when the handler throws', async () => {
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const res = await worker.fetch(new Request('https://relay.example.net/connect'), {}, { waitUntil() {} });
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'error');
  } finally {
    console.error = realError;
  }
  assert.deepEqual(logged, [['E_UNHANDLED']]);
});

test('SF1: markConnecting is reachable through UserDO.fetch and surfaces as status().connecting, cleared by wipe', async () => {
  const { client } = await setup();
  assert.equal((await client(U1).status()).connecting, false);
  assert.deepEqual(await client(U1).markConnecting(), { ok: true });
  assert.equal((await client(U1).status()).connecting, true);
  assert.equal((await client(U2).status()).connecting, false);
  await client(U1).wipe();
  assert.equal((await client(U1).status()).connecting, false);
});
