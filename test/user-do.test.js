import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NUDGE_INTERVAL_MS, NUDGE_RETRY_DELAY_MS, REGISTRATION_LIMIT, REGISTRATION_WINDOW_MS } from '../src/constants.js';
import { UserDO, UserDOCore } from '../src/user-do.js';
import { FakeStorage } from './helpers.js';

function setup(outcomes = []) {
  const clock = { t: 1_800_000_000_000 };
  const storage = new FakeStorage();
  const alarm = { at: null, sets: 0 };
  const fired = [];
  const core = new UserDOCore({
    storage,
    now: () => clock.t,
    setAlarm: async (t) => {
      alarm.at = t;
      alarm.sets++;
    },
    deleteAlarm: async () => {
      alarm.at = null;
    },
    fire: async (args) => {
      fired.push({ ...args, lastNudgeAtFire: storage.get('last_nudge') });
      await new Promise((r) => setImmediate(r));
      const o = outcomes.shift();
      return o ?? { kind: 'ok', status: 200 };
    }
  });
  const run = async () => {
    assert.ok(alarm.at !== null, 'alarm expected');
    clock.t = Math.max(clock.t, alarm.at);
    alarm.at = null;
    await core.alarm();
  };
  return { clock, storage, alarm, fired, core, run };
}
const note = (core, n = 1) => core.noteActivity({ userId: 'U1AAAAAA', channelId: 'D0CHAN1', ts: `1800000000.00010${n}` });

test('first activity fires immediately; last_nudge is set before the fire', async () => {
  const s = setup();
  const r = await note(s.core);
  assert.equal(r.action, 'fired');
  assert.equal(s.fired.length, 1);
  assert.equal(s.fired[0].lastNudgeAtFire, s.clock.t);
  assert.equal((await s.core.status()).counters.forwarded, 1);
});

test('activity within 5 min is coalesced: pending=true and one alarm at last_nudge+300s, no fire', async () => {
  const s = setup();
  const t0 = s.clock.t;
  await note(s.core, 1);
  s.clock.t += 60000;
  assert.equal((await note(s.core, 2)).action, 'pending');
  assert.equal(s.fired.length, 1);
  assert.equal(s.alarm.at, t0 + NUDGE_INTERVAL_MS);
  s.clock.t += 1000;
  await note(s.core, 3);
  assert.equal(s.alarm.sets, 1);
  assert.equal(s.storage.get('pending'), true);
  assert.equal((await s.core.status()).counters.coalesced, 2);
});

test('trailing edge: alarm fires once with the latest pending metadata', async () => {
  const s = setup();
  await note(s.core, 1);
  s.clock.t += 60000;
  await note(s.core, 2);
  await note(s.core, 3);
  await s.run();
  assert.equal(s.fired.length, 2);
  assert.equal(s.fired[1].ts, '1800000000.000103');
  assert.equal(s.storage.get('pending'), undefined);
  await s.core.alarm();
  assert.equal(s.fired.length, 2);
});

test('alarm with nothing pending does nothing', async () => {
  const s = setup();
  await s.core.alarm();
  assert.equal(s.fired.length, 0);
});

test('after the window passes, the next activity fires immediately again', async () => {
  const s = setup();
  await note(s.core, 1);
  s.clock.t += NUDGE_INTERVAL_MS;
  assert.equal((await note(s.core, 2)).action, 'fired');
  assert.equal(s.fired.length, 2);
});

test('atomic check-and-set: concurrent events produce exactly one fire and one alarm', async () => {
  const s = setup();
  await Promise.all([1, 2, 3, 4, 5, 6].map((n) => note(s.core, n)));
  assert.equal(s.fired.length, 1);
  assert.equal(s.alarm.sets, 1);
  assert.equal((await s.core.status()).counters.coalesced, 5);
});

test('definite 5xx: last_nudge cleared, alarm retries once, second failure gives up', async () => {
  const s = setup([{ kind: 'http_error', status: 500 }, { kind: 'http_error', status: 502 }]);
  const t0 = s.clock.t;
  await note(s.core, 1);
  assert.equal(s.storage.get('last_nudge'), undefined);
  assert.equal(s.alarm.at, t0 + NUDGE_RETRY_DELAY_MS);
  assert.equal(s.storage.get('pending'), true);
  await s.run();
  assert.equal(s.fired.length, 2);
  assert.equal(s.storage.get('pending'), undefined);
  assert.equal(s.alarm.at, null);
  await s.core.alarm();
  assert.equal(s.fired.length, 2);
  const st = await s.core.status();
  assert.equal(st.counters.errors, 2);
  assert.equal(st.counters.forwarded, 0);
});

test('definite 4xx (not 429) also clears last_nudge and retries once; retry can succeed', async () => {
  const s = setup([{ kind: 'http_error', status: 401 }]);
  await note(s.core, 1);
  assert.equal(s.storage.get('last_nudge'), undefined);
  await s.run();
  assert.equal(s.fired.length, 2);
  const st = await s.core.status();
  assert.equal(st.counters.errors, 1);
  assert.equal(st.counters.forwarded, 1);
  assert.notEqual(s.storage.get('last_nudge'), undefined);
});

test('a new event while a retry is pending fires immediately and supersedes the retry', async () => {
  const s = setup([{ kind: 'http_error', status: 500 }]);
  await note(s.core, 1);
  assert.equal((await note(s.core, 2)).action, 'fired');
  assert.equal(s.storage.get('pending'), undefined);
  await s.core.alarm();
  assert.equal(s.fired.length, 2);
});

test('timeout: no retry, last_nudge stays set, counted as error and timeout', async () => {
  const s = setup([{ kind: 'timeout' }]);
  await note(s.core, 1);
  assert.notEqual(s.storage.get('last_nudge'), undefined);
  assert.equal(s.alarm.at, null);
  assert.equal(s.storage.get('pending'), undefined);
  const st = await s.core.status();
  assert.equal(st.counters.timeouts, 1);
  assert.equal(st.counters.errors, 1);
  assert.equal(s.fired.length, 1);
});

test('429 and network errors are not retried and keep the mute window', async () => {
  for (const o of [{ kind: 'rate_limited', status: 429 }, { kind: 'network' }, { kind: 'redirect', status: 302 }]) {
    const s = setup([o]);
    await note(s.core, 1);
    assert.notEqual(s.storage.get('last_nudge'), undefined);
    assert.equal(s.alarm.at, null);
    assert.equal((await s.core.status()).counters.errors, 1);
  }
});

test('a throwing fire function is treated as a non-retried error', async () => {
  const s = setup();
  s.core.fire = async () => {
    throw new Error('boom');
  };
  const r = await note(s.core, 1);
  assert.equal(r.kind, 'network');
  assert.equal((await s.core.status()).counters.errors, 1);
});

test('disconnected flag: no fire, counted as dropped; pending alarm does nothing; reconnect clears it', async () => {
  const s = setup();
  await note(s.core, 1);
  await note(s.core, 2);
  await s.core.markDisconnected();
  assert.equal(s.alarm.at, null);
  assert.deepEqual(await s.core.check(), { disconnected: true });
  assert.equal((await note(s.core, 3)).action, 'dropped');
  assert.equal(s.fired.length, 1);
  s.storage.put('pending', true);
  await s.core.alarm();
  assert.equal(s.fired.length, 1);
  assert.equal((await s.core.status()).counters.dropped, 1);
  await s.core.markConnected();
  assert.deepEqual(await s.core.check(), { disconnected: false });
});

test('counters: only known names accepted; stored as counts only', async () => {
  const s = setup();
  for (const name of ['forwarded', 'dropped', 'errors', 'fanout_degraded']) await s.core.call('increment', { name });
  await assert.rejects(() => s.core.call('increment', { name: 'text' }));
  await assert.rejects(() => s.core.call('nope', {}));
  const st = await s.core.status();
  assert.deepEqual([st.counters.forwarded, st.counters.dropped, st.counters.errors, st.counters.fanout_degraded], [1, 1, 1, 1]);
});

test('per-user registration rate limit with window reset', async () => {
  const s = setup();
  for (let i = 0; i < REGISTRATION_LIMIT; i++) assert.equal((await s.core.consumeRegistration()).allowed, true);
  assert.equal((await s.core.consumeRegistration()).allowed, false);
  s.clock.t += REGISTRATION_WINDOW_MS;
  assert.equal((await s.core.consumeRegistration()).allowed, true);
});

test('wipe clears counters and leaves the disconnected flag set', async () => {
  const s = setup();
  await note(s.core, 1);
  await s.core.wipe();
  const st = await s.core.status();
  assert.equal(st.counters.forwarded, 0);
  assert.equal(st.disconnected, true);
});

test('UserDO class wires storage.kv and dispatches fetch methods', async () => {
  const kvMap = new Map();
  const ctx = {
    storage: {
      kv: { get: (k) => kvMap.get(k), put: (k, v) => kvMap.set(k, v), delete: (k) => kvMap.delete(k) },
      deleteAll: async () => kvMap.clear(),
      setAlarm: async () => {},
      deleteAlarm: async () => {}
    }
  };
  const d = new UserDO(ctx, {});
  const post = (m, body) => d.fetch(new Request(`https://do/${m}`, { method: 'POST', body: JSON.stringify(body) }));
  assert.deepEqual(await (await post('check', {})).json(), { disconnected: false });
  await post('increment', { name: 'errors' });
  assert.equal((await (await post('status', {})).json()).counters.errors, 1);
  assert.equal((await post('bogus', {})).status, 400);
  await d.alarm();
});

const pendingKeys = (s) => [...s.storage.map.keys()].filter((k) => k === 'pending_channel' || k === 'pending_ts');

test('S2: no pending_channel or pending_ts key remains after a trailing fire', async () => {
  const s = setup();
  await note(s.core, 1);
  s.clock.t += 60000;
  await note(s.core, 2);
  assert.deepEqual(pendingKeys(s).sort(), ['pending_channel', 'pending_ts']);
  await s.run();
  assert.equal(s.fired.length, 2);
  assert.deepEqual(pendingKeys(s), []);
});

test('S2: no pending_channel or pending_ts key remains after disconnect', async () => {
  const s = setup();
  await note(s.core, 1);
  s.clock.t += 60000;
  await note(s.core, 2);
  await s.core.markDisconnected();
  assert.deepEqual(pendingKeys(s), []);
});

test('S2: alarm that finds the user disconnected, and a superseding immediate fire, leave no pending ids', async () => {
  const s = setup();
  await note(s.core, 1);
  s.clock.t += 60000;
  await note(s.core, 2);
  s.clock.t += NUDGE_INTERVAL_MS;
  await note(s.core, 3);
  assert.deepEqual(pendingKeys(s), []);
  s.storage.put('pending', true);
  s.storage.put('pending_channel', 'D0X');
  s.storage.put('pending_ts', '1.1');
  s.storage.put('disconnected', true);
  await s.core.alarm();
  assert.deepEqual(pendingKeys(s), []);
});

test('S2: the retry branch may re-put the ids, and the next alarm deletes them', async () => {
  const s = setup([{ kind: 'http_error', status: 500 }]);
  await note(s.core, 1);
  assert.deepEqual(pendingKeys(s).sort(), ['pending_channel', 'pending_ts']);
  await s.run();
  assert.deepEqual(pendingKeys(s), []);
});

test('SF1: connecting expires after ten minutes', async () => {
  const s = setup();
  await s.core.markConnecting();
  assert.equal((await s.core.status()).connecting, true);
  s.clock.t += 600000 - 1;
  assert.equal((await s.core.status()).connecting, true);
  s.clock.t += 1;
  assert.equal((await s.core.status()).connecting, false);
});

test('R2: a wipe interleaved with an in-flight failing fire leaves only the disconnected flag plus counters', async () => {
  const s = setup([{ kind: 'http_error', status: 500 }]);
  const inflight = note(s.core, 1);
  await s.core.wipe();
  await inflight;
  const keys = [...s.storage.map.keys()];
  for (const k of ['pending', 'pending_channel', 'pending_ts', 'alarm_at']) assert.equal(keys.includes(k), false, k);
  assert.equal(s.alarm.at, null);
  assert.equal(s.storage.get('disconnected'), true);
});
