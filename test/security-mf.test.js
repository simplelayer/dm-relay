import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildForwardPayload } from '../src/filter.js';
import { jsonHasPlaintextMarkers } from '../src/secret-crypto.js';
import {
  CURSOR_TOKEN,
  GROK_SECRET,
  ROUTE_ENC_KEY,
  U1,
  U2,
  USER_TOKEN,
  makeWorld,
  msgPayload,
  respond,
  authListResponse,
  isAuthList
} from './helpers.js';

const handler = (ids) => (url) => (isAuthList(url) ? authListResponse(ids) : respond(202));
const hookCalls = (w) => w.fetchImpl.calls.filter((c) => c.url.startsWith('https://hooks.x.ai/'));
const body = (c) => JSON.parse(new TextDecoder().decode(c.init.body));

test('MF7: default forward payload has no text key', () => {
  const p = msgPayload();
  const out = buildForwardPayload(p, 0, { mode: 'ids_only', caps: {} });
  assert.equal('text' in out, false);
  const full = buildForwardPayload(p, 0, { mode: 'full', caps: {} });
  assert.equal(typeof full.text, 'string');
});

test('MF4: replayed event_id forwards once', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2, undefined, { full: true });
  await w.send(msgPayload({ sender: U1, eventId: 'EvREPLAY1' }));
  await w.send(msgPayload({ sender: U1, eventId: 'EvREPLAY1' }));
  assert.equal(hookCalls(w).length, 1);
});

test('MF4: X-Slack-Retry-Num on a duplicate event_id does not double forward', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2, undefined, { full: true });
  const payload = msgPayload({ sender: U1, eventId: 'EvRETRY1' });
  await w.send(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const ts = String(Math.floor(w.clock.t / 1000));
  const { slackSignature, SIGNING_SECRET } = await import('./helpers.js');
  await w.request('/slack/events', {
    method: 'POST',
    headers: {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': slackSignature(SIGNING_SECRET, ts, bytes),
      'x-slack-retry-num': '1',
      'content-type': 'application/json'
    },
    body: bytes
  });
  await w.flush();
  assert.equal(hookCalls(w).length, 1);
});

test('MF1/MF2: KV writes contain no plaintext destination secrets or Slack user tokens', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2);
  const dump = [...w.kv.store.values()].join('\n');
  assert.equal(dump.includes(GROK_SECRET), false);
  assert.equal(dump.includes(USER_TOKEN), false);
  assert.equal(jsonHasPlaintextMarkers(dump), false);
});

test('MF5 loop guard: bot_id dropped when send is on', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2, undefined, { full: true });
  await w.routing.put(U2, {
    ...(await w.routing.get(U2)),
    caps: { process: true, draft: true, send: true },
    filters: { skip_bots: false, skip_users: [], keywords: [] }
  });
  await w.send(msgPayload({ sender: U1, eventId: 'EvBOT1', extraEvent: { bot_id: 'B1' } }));
  assert.equal(hookCalls(w).length, 0);
  assert.equal((await w.entry(U2).core.status()).filtered.loop, 1);
});

test('MF5 loop guard: app_id dropped when send is on', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2, undefined, { full: true });
  await w.routing.put(U2, {
    ...(await w.routing.get(U2)),
    caps: { process: true, draft: true, send: true }
  });
  await w.send(msgPayload({ sender: U1, eventId: 'EvAPP1', extraEvent: { app_id: 'A0BOT' } }));
  assert.equal(hookCalls(w).length, 0);
  assert.equal((await w.entry(U2).core.status()).filtered.loop, 1);
});

test('MF5 loop guard: forward cap limits bursts per channel', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2, undefined, { full: true });
  for (let i = 0; i < 6; i++) {
    await w.send(msgPayload({ sender: U1, eventId: `EvCAP${i}` }));
  }
  assert.equal(hookCalls(w).length, 5);
  assert.equal((await w.entry(U2).core.status()).filtered.rate, 1);
});
