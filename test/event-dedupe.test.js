import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENT_DEDUPE_TTL_MS, EventDedupeCore, makeEventDedupeClient } from '../src/event-dedupe-do.js';
import { FakeStorage, GROK_SECRET, U1, U2, authListResponse, isAuthList, makeWorld, msgPayload, respond } from './helpers.js';

test('EventDedupeCore: duplicate within TTL, fresh after expiry, prune drops expired ids', () => {
  let t = 1_000_000;
  const storage = new FakeStorage();
  const core = new EventDedupeCore({ storage, now: () => t });
  assert.deepEqual(core.claim({ eventId: 'EvA', nowMs: t }), { duplicate: false });
  assert.deepEqual(core.claim({ eventId: 'EvA', nowMs: t + 1000 }), { duplicate: true });
  t += EVENT_DEDUPE_TTL_MS + 1;
  assert.deepEqual(core.claim({ eventId: 'EvA', nowMs: t }), { duplicate: false });
  storage.put('seen', { EvA: t - 1, EvB: t + EVENT_DEDUPE_TTL_MS });
  assert.deepEqual(core.claim({ eventId: 'EvC', nowMs: t }), { duplicate: false });
  const seen = storage.get('seen');
  assert.equal(seen.EvA, undefined);
  assert.ok(seen.EvB > t);
  assert.ok(seen.EvC > t);
});

test('makeEventDedupeClient without binding fails closed unless test flag set', async () => {
  const strict = makeEventDedupeClient(undefined);
  await assert.rejects(() => strict.claim('EvX', 0), /E_DEDUPE_UNCONFIGURED/);
  const mem = makeEventDedupeClient(undefined, { allowInMemoryFallback: true });
  assert.deepEqual(await mem.claim('EvX', 0), { duplicate: false });
  assert.deepEqual(await mem.claim('EvX', 0), { duplicate: true });
});

test('MF-N4: dedupe client failure means no forward', async () => {
  const w = makeWorld({
    bindEventDedupe: false,
    fetchHandler: (url) => (isAuthList(url) ? authListResponse([U1, U2]) : respond(202))
  });
  w.deps.eventDedupe = {
    async claim() {
      throw new Error('E_DEDUPE_CALL');
    }
  };
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U1, eventId: 'EvDEDUPEFAIL' }));
  assert.equal(w.fetchImpl.calls.filter((c) => c.url.startsWith('https://hooks.x.ai/')).length, 0);
});
