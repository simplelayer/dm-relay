import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DISCONNECT_SESSION_TTL_S } from '../src/constants.js';
import { buildForwardPayload } from '../src/filter.js';
import { encryptSecret, jsonHasPlaintextMarkers, routeCryptoFromEnv } from '../src/secret-crypto.js';
import {
  auditPlaintextRouteEntries,
  sweepPlaintextRouteEntries
} from '../src/routes.js';
import {
  APP,
  GROK_SECRET,
  GROK_URL,
  ROUTE_ENC_KEY,
  ROUTE_ENC_KID,
  TEAM,
  U1,
  U2,
  USER_TOKEN,
  cookieHeaderFrom,
  makeWorld,
  msgPayload,
  respond,
  authListResponse,
  isAuthList,
  setCookies
} from './helpers.js';

const handler = (ids) => (url) => (isAuthList(url) ? authListResponse(ids) : respond(202));
const hookCalls = (w) => w.fetchImpl.calls.filter((c) => c.url.startsWith('https://hooks.x.ai/'));

function oauthPayload(userId) {
  return {
    ok: true,
    app_id: APP,
    team: { id: TEAM },
    authed_user: { id: userId, scope: 'im:history,mpim:history', access_token: USER_TOKEN, token_type: 'user' }
  };
}

async function oauthLogin(w, intent = 'connect', userId = U1) {
  const start = await w.request(`/${intent}`);
  const html = await start.text();
  const href = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize[^"]+)"/)[1].replaceAll('&amp;', '&');
  const state = new URL(href).searchParams.get('state');
  const cookiePair = setCookies(start).find((c) => c.startsWith('dmr_st_')).split(';')[0];
  const cb = await w.request(`/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiePair } });
  const page = await cb.text();
  return {
    res: cb,
    html: page,
    csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1],
    cookie: cookieHeaderFrom(cb)
  };
}

const oauthFetch =
  (ids = [U1, U2]) =>
  (url, init) => {
    if (url.includes('oauth.v2.access')) return respond(200, oauthPayload(init?.body?.includes?.('code') ? U1 : U1));
    if (isAuthList(url)) return authListResponse(ids);
    return respond(202);
  };

const postForm = (w, path, cookie, fields) =>
  w.request(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });

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

test('MF-N1: missing route key refuses destination save and writes no secret', async () => {
  const w = makeWorld({ routeEncryption: false, fetchHandler: oauthFetch() });
  const l = await oauthLogin(w, 'connect', U1);
  const res = await postForm(w, '/destination', l.cookie, {
    csrf: l.csrf,
    dest_type: 'grok',
    url: GROK_URL,
    secret: GROK_SECRET,
    attest: '1',
    no_send: '1'
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /cannot store secrets/i);
  const dump = [...w.kv.store.values()].join('\n');
  assert.equal(dump.includes(GROK_SECRET), false);
  assert.equal(jsonHasPlaintextMarkers(dump), false);
});

test('MF-N1: missing route key refuses disconnect session with plaintext token', async () => {
  const w = makeWorld({ routeEncryption: false, fetchHandler: oauthFetch() });
  const l = await oauthLogin(w, 'disconnect', U1);
  assert.equal(l.res.status, 503);
  const dump = [...w.kv.store.values()].join('\n');
  assert.equal(dump.includes(USER_TOKEN), false);
  assert.equal(jsonHasPlaintextMarkers(dump), false);
});

test('MF-N1: legacy plaintext route is not served or forwarded when encryption key is missing', async () => {
  const w = makeWorld({ routeEncryption: false, fetchHandler: handler([U1, U2]) });
  await w.kv.put(
    `route:${U2}`,
    JSON.stringify({ dest_type: 'grok', url: GROK_URL, secret_or_bearer: GROK_SECRET, mode: 'ids_only', secret_verified_at: w.clock.t })
  );
  assert.equal(await w.routing.get(U2), null);
  await w.send(msgPayload({ sender: U1, eventId: 'EvLEGACY1' }));
  assert.equal(hookCalls(w).length, 0);
});

test('MF-N1: kid mismatch yields no route secret and no forward', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  const otherCrypto = { kid: 'other-kid', keyBytes: Buffer.alloc(32, 9) };
  const secret_enc = await encryptSecret(otherCrypto, GROK_SECRET);
  await w.kv.put(
    `route:${U2}`,
    JSON.stringify({ dest_type: 'grok', url: GROK_URL, secret_enc, mode: 'ids_only', secret_verified_at: w.clock.t })
  );
  assert.equal(await w.routing.get(U2), null);
  await w.send(msgPayload({ sender: U1, eventId: 'EvKID1' }));
  assert.equal(hookCalls(w).length, 0);
});

test('MF-N2: sweep seals legacy plaintext and audit reports counts only', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.kv.put(
    `route:${U2}`,
    JSON.stringify({ dest_type: 'grok', url: GROK_URL, secret_or_bearer: GROK_SECRET, mode: 'ids_only' })
  );
  const before = await auditPlaintextRouteEntries(w.kv);
  assert.equal(before.plaintext_remaining, 1);
  const crypto = routeCryptoFromEnv({
    ROUTE_SECRET_ENCRYPTION_KEY: ROUTE_ENC_KEY,
    ROUTE_SECRET_KEY_ID: ROUTE_ENC_KID
  });
  const report = await sweepPlaintextRouteEntries(w.kv, crypto);
  assert.equal(report.plaintext_remaining, 0);
  assert.equal(report.sealed, 1);
  const entry = await w.routing.get(U2);
  assert.equal(typeof entry.secret_or_bearer, 'string');
  assert.equal(jsonHasPlaintextMarkers(JSON.stringify(Object.fromEntries(w.kv.store))), false);
});

test('MF-N2: lazy read migrates legacy plaintext when key is present', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.kv.put(
    `route:${U2}`,
    JSON.stringify({ dest_type: 'grok', url: GROK_URL, secret_or_bearer: GROK_SECRET, mode: 'ids_only', secret_verified_at: w.clock.t })
  );
  const entry = await w.routing.get(U2);
  assert.equal(typeof entry.secret_or_bearer, 'string');
  const raw = await w.kv.get(`route:${U2}`);
  assert.equal(raw.includes('secret_or_bearer'), false);
  assert.ok(raw.includes('secret_enc'));
});

test('MF-N3: disconnect callback stores token_enc with TTL at most 600s and no plaintext token', async () => {
  const w = makeWorld({ fetchHandler: oauthFetch() });
  const l = await oauthLogin(w, 'disconnect', U1);
  assert.equal(l.res.status, 200);
  const sessKey = [...w.kv.store.keys()].find((k) => k.startsWith('sess:'));
  assert.ok(sessKey);
  const raw = w.kv.store.get(sessKey);
  assert.equal(raw.includes(USER_TOKEN), false);
  assert.ok(raw.includes('token_enc'));
  assert.equal(jsonHasPlaintextMarkers(raw), false);
  assert.ok(w.kv.ttls.get(sessKey) <= DISCONNECT_SESSION_TTL_S);
});

test('SF-N4: events without event_id are dropped', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2);
  const payload = msgPayload({ sender: U1 });
  delete payload.event_id;
  await w.send(payload);
  assert.equal(hookCalls(w).length, 0);
});

test('SF-N7: bot_profile blocked by loop guard when send is on', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U2, undefined, { full: true });
  await w.routing.put(U2, {
    ...(await w.routing.get(U2)),
    caps: { process: true, draft: true, send: true }
  });
  await w.send(msgPayload({ sender: U1, eventId: 'EvBPROF1', extraEvent: { bot_profile: { id: 'BPROF' } } }));
  assert.equal(hookCalls(w).length, 0);
  assert.equal((await w.entry(U2).core.status()).filtered.loop, 1);
});

test('MF-N1: API destination proposal returns 503 when route crypto is unavailable', async () => {
  const w = makeWorld({ fetchHandler: oauthFetch() });
  await w.addGrok(U1);
  const l = await oauthLogin(w, 'connect', U1);
  const keyRes = await postForm(w, '/keys/bootstrap', l.cookie, { csrf: l.csrf });
  const html = await keyRes.text();
  const key = html.match(/value="(dmr_[A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(key);
  w.deps.routeCrypto = null;
  const res = await w.request('/api/v1/requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'destination',
      dest_type: 'grok',
      url: GROK_URL,
      secret: GROK_SECRET
    })
  });
  assert.equal(res.status, 503);
  const dump = dumpDoAndKv(w);
  assert.equal(dump.includes(GROK_SECRET), false);
});

function dumpDoAndKv(w) {
  return JSON.stringify([[...w.kv.store], ...[...w.cores.values()].map((c) => [...c.storage.map])]);
}
