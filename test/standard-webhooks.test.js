import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { buildHeaders, isValidSecret, parseSecret, randomMessageId, sign } from '../src/standard-webhooks.js';

test('published Standard Webhooks / Svix example vector', async () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const sig = await sign({
    secret,
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    bodyBytes: new TextEncoder().encode('{"test": 2432232314}')
  });
  assert.equal(sig, 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
});

test('matches an independent node:crypto implementation (unicode body)', async () => {
  const secret = `whsec_${Buffer.from('k'.repeat(24)).toString('base64')}`;
  const bodyBytes = new TextEncoder().encode('{"text":"héllo 👋 \\n"}');
  const id = 'Ev1_U2BBBBBB';
  const expected = 'v1,' + createHmac('sha256', Buffer.from('k'.repeat(24))).update(`${id}.1800000000.`).update(bodyBytes).digest('base64');
  assert.equal(await sign({ secret, id, timestamp: '1800000000', bodyBytes }), expected);
});

test('headers: integer-second timestamp and signature over the same bytes', async () => {
  const secret = `whsec_${Buffer.from('s'.repeat(16)).toString('base64')}`;
  const bodyBytes = new TextEncoder().encode('{"a":1}');
  const h = await buildHeaders({ secret, id: 'x_y', timestampSeconds: 1800000000.987, bodyBytes });
  assert.equal(h['webhook-timestamp'], '1800000000');
  assert.equal(h['webhook-id'], 'x_y');
  assert.equal(h['webhook-signature'], await sign({ secret, id: 'x_y', timestamp: '1800000000', bodyBytes }));
});

test('secrets without whsec_ prefix or with bad base64 are rejected', () => {
  assert.throws(() => parseSecret('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'));
  assert.throws(() => parseSecret('whsec_not base64!'));
  assert.throws(() => parseSecret('whsec_'));
  assert.throws(() => parseSecret(undefined));
  assert.equal(isValidSecret('plain-secret'), false);
  assert.equal(isValidSecret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'), true);
});

test('verification message ids are random', () => {
  assert.notEqual(randomMessageId(), randomMessageId());
});

test('N2: padded and unpadded whsec_ secrets both parse to the same key; base64url characters stay rejected', () => {
  for (const len of [16, 17, 18, 24, 32]) {
    const raw = Buffer.alloc(len, 7);
    const padded = raw.toString('base64');
    const unpadded = padded.replace(/=+$/, '');
    assert.deepEqual([...parseSecret(`whsec_${padded}`)], [...raw], `padded ${len}`);
    assert.deepEqual([...parseSecret(`whsec_${unpadded}`)], [...raw], `unpadded ${len}`);
  }
  assert.equal(isValidSecret('whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), true);
  assert.equal(isValidSecret('whsec_ab-d'), false);
  assert.equal(isValidSecret('whsec_ab_d'), false);
  assert.equal(isValidSecret('whsec_A'), false);
  assert.equal(isValidSecret('whsec_AAAAA'), false);
  assert.equal(isValidSecret('whsec_AAA=A'), false);
  assert.equal(isValidSecret('whsec_AA='), false);
});
