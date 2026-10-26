import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySlackSignature } from '../src/slack-verify.js';
import { SIGNING_SECRET, makeWorld, msgPayload, slackSignature } from './helpers.js';

const NOW = 1_800_000_000;
const body = new TextEncoder().encode('{"a":1}');
const args = (over = {}) => ({
  signingSecret: SIGNING_SECRET,
  timestamp: String(NOW),
  signature: slackSignature(SIGNING_SECRET, String(NOW), body),
  rawBody: body,
  nowSeconds: NOW,
  ...over
});

test('valid signature accepted', async () => {
  assert.equal(await verifySlackSignature(args()), true);
});

test('forged signature rejected', async () => {
  assert.equal(await verifySlackSignature(args({ signature: slackSignature('wrong-secret', String(NOW), body) })), false);
  assert.equal(await verifySlackSignature(args({ signature: 'v0=' + '0'.repeat(64) })), false);
  assert.equal(await verifySlackSignature(args({ signature: 'v0=abc' })), false);
  assert.equal(await verifySlackSignature(args({ signature: '' })), false);
});

test('tampered body rejected', async () => {
  assert.equal(await verifySlackSignature(args({ rawBody: new TextEncoder().encode('{"a":2}') })), false);
});

test('verifies raw bytes, including bytes that are not valid UTF-8', async () => {
  const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x80, 0x7d]);
  const sig = slackSignature(SIGNING_SECRET, String(NOW), raw);
  assert.equal(await verifySlackSignature(args({ rawBody: raw, signature: sig })), true);
});

test('timestamp window is 300 s on both sides', async () => {
  const at = (t) => args({ timestamp: String(t), signature: slackSignature(SIGNING_SECRET, String(t), body) });
  assert.equal(await verifySlackSignature(at(NOW - 300)), true);
  assert.equal(await verifySlackSignature(at(NOW - 301)), false);
  assert.equal(await verifySlackSignature(at(NOW + 300)), true);
  assert.equal(await verifySlackSignature(at(NOW + 301)), false);
});

test('missing or malformed inputs rejected', async () => {
  assert.equal(await verifySlackSignature(args({ timestamp: null })), false);
  assert.equal(await verifySlackSignature(args({ timestamp: 'abc' })), false);
  assert.equal(await verifySlackSignature(args({ signingSecret: '' })), false);
  assert.equal(await verifySlackSignature(args({ rawBody: 'string' })), false);
});

test('replayed (old timestamp) event request returns 401 and forwards nothing', async () => {
  const w = makeWorld();
  const old = Math.floor(w.clock.t / 1000) - 400;
  const res = await w.send(msgPayload(), { timestamp: old, signature: undefined });
  assert.equal(res.status, 401);
  assert.equal(w.fetchImpl.calls.length, 0);
});

test('forged signature on /slack/events returns 401', async () => {
  const w = makeWorld();
  const res = await w.send(msgPayload(), { signature: 'v0=' + 'a'.repeat(64) });
  assert.equal(res.status, 401);
});

test('url_verification (signed) echoes the challenge; unsigned does not', async () => {
  const w = makeWorld();
  const ok = await w.send({ type: 'url_verification', challenge: 'abc123' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { challenge: 'abc123' });
  const bad = await w.send({ type: 'url_verification', challenge: 'abc123' }, { signature: 'v0=00' });
  assert.equal(bad.status, 401);
});
