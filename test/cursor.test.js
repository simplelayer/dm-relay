import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERIFY_TEXT } from '../src/constants.js';
import { forwardCursor, isValidCursorToken, verifyCursor } from '../src/destinations.js';
import {
  APP,
  CURSOR_TOKEN,
  CURSOR_URL,
  GROK_URL,
  TEAM,
  U1,
  U2,
  U3,
  USER_TOKEN,
  cookieHeaderFrom,
  makeFetch,
  makeWorld,
  msgPayload,
  respond,
  stripRouteMeta,
  timeoutError
} from './helpers.js';

const OTHER_URL = 'https://api2.cursor.sh/automations/webhook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const entry = { dest_type: 'cursor', url: CURSOR_URL, secret_or_bearer: CURSOR_TOKEN, mode: 'full' };
const fp = { event_id: 'Ev9', received_at: '2026-10-25T00:00:00.000Z', type: 'dm', channel_id: 'D1', sender_id: 'U1', text: 'héllo', ts: '1.2', thread_ts: null };
const base = (fetchImpl, clock) => ({
  entry,
  forwardPayload: fp,
  recipientId: U2,
  fetchImpl,
  now: () => clock.t,
  deadlineMs: clock.t + 30000,
  validateOpts: {}
});
const decode = (b) => JSON.parse(new TextDecoder().decode(b));

function captureConsole() {
  const seen = [];
  const saved = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[m] = console[m];
    console[m] = (...a) => seen.push(a);
  }
  return { seen, restore: () => Object.assign(console, saved) };
}

test('cursor token: accepted shapes', () => {
  assert.equal(isValidCursorToken(CURSOR_TOKEN), true);
  assert.equal(isValidCursorToken('crsr_' + 'a'.repeat(15)), true);
  assert.equal(isValidCursorToken('crsr_' + 'a'.repeat(195)), true);
  assert.equal(isValidCursorToken('crsr_-_-_-_-_-_-_-_-_-_'), true);
});

test('cursor token: rejected shapes', () => {
  const bad = [
    undefined,
    null,
    12345,
    '',
    'crsr_',
    'crsr_short',
    'crsr_' + 'a'.repeat(14),
    'crsr_' + 'a'.repeat(196),
    'CRSR_' + 'a'.repeat(30),
    'crsr' + 'a'.repeat(30),
    ' crsr_' + 'a'.repeat(30),
    'Bearer crsr_' + 'a'.repeat(30),
    'crsr_' + 'a'.repeat(30) + ' ',
    'crsr_' + 'a'.repeat(30) + '\n',
    'crsr_' + 'a'.repeat(15) + ' ' + 'b'.repeat(15),
    'crsr_' + 'a'.repeat(30) + '=',
    'crsr_' + 'a'.repeat(30) + '.x',
    'crsr_' + 'a'.repeat(30) + 'é',
    'crsr_' + 'a'.repeat(30) + '\r\nx: y',
    'whsec_' + 'a'.repeat(30),
    'xoxp-' + 'a'.repeat(30)
  ];
  for (const t of bad) assert.equal(isValidCursorToken(t), false, String(t).slice(0, 40));
});

test('cursor forward: bearer header, json header, redirect manual, body is the grok payload serialized once', async () => {
  const clock = { t: 1_800_000_000_000 };
  const f = makeFetch(() => respond(202));
  const r = await forwardCursor(base(f, clock));
  assert.equal(r.kind, 'ok');
  const { url, init } = f.calls[0];
  assert.equal(url, CURSOR_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, {
    'content-type': 'application/json',
    authorization: `Bearer ${CURSOR_TOKEN}`,
    'idempotency-key': `Ev9_${U2}`
  });
  assert.ok(init.body instanceof Uint8Array);
  assert.deepEqual(decode(init.body), fp);
});

test('cursor retry: one retry on 503 with identical bytes; none on 500, 4xx, redirect or timeout', async () => {
  const clock = { t: 1_800_000_000_000 };
  let n = 0;
  const f = makeFetch(() => (++n === 1 ? respond(503) : respond(200)));
  const r = await forwardCursor(base(f, clock));
  assert.equal(r.kind, 'ok');
  assert.equal(r.attempts, 2);
  assert.deepEqual([...f.calls[0].init.body], [...f.calls[1].init.body]);
  const g = makeFetch(() => respond(500));
  assert.equal((await forwardCursor(base(g, clock))).kind, 'http_error');
  assert.equal(g.calls.length, 1);
  const h = makeFetch(() => respond(400));
  await forwardCursor(base(h, clock));
  assert.equal(h.calls.length, 1);
  const i = makeFetch(() => new Response(null, { status: 307 }));
  assert.equal((await forwardCursor(base(i, clock))).kind, 'redirect');
  assert.equal(i.calls.length, 1);
  const j = makeFetch(() => {
    throw timeoutError();
  });
  assert.equal((await forwardCursor(base(j, clock))).kind, 'timeout');
  assert.equal(j.calls.length, 1);
  const k = makeFetch(() => respond(429));
  assert.equal((await forwardCursor(base(k, clock))).kind, 'rate_limited');
  assert.equal(k.calls.length, 2);
});

test('cursor retry: only responses that show the run did not start are retried (at-most-once)', async () => {
  const clock = { t: 1_800_000_000_000 };
  const step = (s) => {
    if (s === 'timeout') throw timeoutError();
    return respond(s);
  };
  const fetches = async (seq) => {
    let n = 0;
    const f = makeFetch(() => step(seq[n++]));
    await forwardCursor(base(f, clock));
    return f.calls.length;
  };
  assert.equal(await fetches(['timeout', 200]), 1);
  assert.equal(await fetches([502, 200]), 1);
  assert.equal(await fetches([429, 200]), 2);
  assert.equal(await fetches([503, 200]), 2);
  assert.equal(await fetches([408, 200]), 2);
});

test('cursor retry is bounded by the remaining budget and a spent budget sends nothing', async () => {
  const clock = { t: 1_800_000_000_000 };
  const f = makeFetch(() => {
    clock.t += 29000;
    return respond(500);
  });
  await forwardCursor(base(f, clock));
  assert.equal(f.calls.length, 1);
  const g = makeFetch(() => respond(202));
  const r = await forwardCursor({ ...base(g, clock), deadlineMs: clock.t - 1 });
  assert.equal(g.calls.length, 0);
  assert.equal(r.kind, 'timeout');
});

test('cursor forward re-validates the url and the token on every forward', async () => {
  const clock = { t: 1_800_000_000_000 };
  const f = makeFetch(() => respond(202));
  for (const bad of [
    { ...entry, url: GROK_URL },
    { ...entry, url: 'https://api.cursor.sh/automations/webhook/123e4567-e89b-12d3-a456-426614174000' },
    { ...entry, url: `${CURSOR_URL}?x=1` },
    { ...entry, secret_or_bearer: 'whsec_abcdefghijklmnopqrstuvwxyz' },
    { ...entry, secret_or_bearer: '' },
    { ...entry, secret_or_bearer: undefined }
  ]) {
    assert.equal((await forwardCursor({ ...base(f, clock), entry: bad })).kind, 'invalid');
  }
  assert.equal(f.calls.length, 0);
});

test('cursor failures never carry the response body or the token', async () => {
  const clock = { t: 1_800_000_000_000 };
  const f = makeFetch(() => respond(500, `echo Bearer ${CURSOR_TOKEN} secret-body`));
  const r = await forwardCursor(base(f, clock));
  assert.equal(JSON.stringify(r).includes(CURSOR_TOKEN), false);
  assert.equal(JSON.stringify(r).includes('secret-body'), false);
  const g = makeFetch(() => {
    throw new TypeError(`connect failed with Bearer ${CURSOR_TOKEN}`);
  });
  const r2 = await forwardCursor(base(g, clock));
  assert.equal(r2.kind, 'network');
  assert.equal(JSON.stringify(r2).includes(CURSOR_TOKEN), false);
});

test('cursor verification: relay.verification body with fixed text and random id, success = 2xx', async () => {
  const f = makeFetch(() => respond(200));
  const now = () => 1_800_000_000_000;
  assert.equal((await verifyCursor({ entry, fetchImpl: f, now, validateOpts: {} })).kind, 'ok');
  await verifyCursor({ entry, fetchImpl: f, now, validateOpts: {} });
  const [a, b] = f.calls.map((c) => c.init);
  const body = decode(a.body);
  assert.equal(body.type, 'relay.verification');
  assert.equal(body.text, VERIFY_TEXT);
  assert.equal(body.received_at, new Date(1_800_000_000_000).toISOString());
  assert.notEqual(body.event_id, decode(b.body).event_id);
  assert.equal(a.headers.authorization, `Bearer ${CURSOR_TOKEN}`);
  assert.equal(a.redirect, 'manual');
  for (const status of [301, 400, 401, 500]) {
    const g = makeFetch(() => new Response(null, { status }));
    assert.notEqual((await verifyCursor({ entry, fetchImpl: g, now, validateOpts: {} })).kind, 'ok');
  }
});

function oauthOk(userId) {
  return respond(200, {
    ok: true,
    app_id: APP,
    team: { id: TEAM },
    authed_user: { id: userId, scope: 'im:history,mpim:history', access_token: USER_TOKEN, token_type: 'user' }
  });
}

function world(ctl = {}) {
  const c = { oauth: () => oauthOk(U1), cursor: () => respond(202), ...ctl };
  const w = makeWorld({
    fetchHandler: (url, init) => {
      if (url.includes('oauth.v2.access')) return c.oauth(init);
      if (url.includes('apps.event.authorizations.list')) return respond(200, { ok: true, authorizations: [] });
      return c.cursor(init);
    }
  });
  w.ctl = c;
  return w;
}

async function startOauth(w, path) {
  const res = await w.request(path);
  const html = await res.text();
  const href = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize[^"]+)"/)[1].replaceAll('&amp;', '&');
  const state = new URL(href).searchParams.get('state');
  const stCookie = res.headers.getSetCookie().find((c) => c.startsWith('dmr_st_')).split(';')[0];
  return w.request(`/oauth/callback?code=c1&state=${encodeURIComponent(state)}`, { headers: { cookie: stCookie } });
}

async function login(w) {
  const res = await startOauth(w, '/connect');
  const html = await res.text();
  return { html, csrf: html.match(/name="csrf" value="([^"]+)"/)[1], cookie: cookieHeaderFrom(res) };
}

const post = (w, l, over = {}) =>
  w.request('/destination', {
    method: 'POST',
    headers: { cookie: l.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: l.csrf, dest_type: 'cursor', url: CURSOR_URL, secret: CURSOR_TOKEN, attest: '1', no_send: '1', ...over }).toString()
  });

test('POST /destination: cursor is verified (one POST with bearer), stored in the usual record shape, mode full', async () => {
  const w = world();
  const l = await login(w);
  const res = await post(w, l);
  assert.equal(res.status, 200);
  assert.deepEqual(stripRouteMeta(await w.routing.get(U1)), {
    dest_type: 'cursor',
    url: CURSOR_URL,
    secret_or_bearer: CURSOR_TOKEN,
    mode: 'ids_only'
  });
  const calls = w.fetchImpl.calls.filter((c) => c.url === CURSOR_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${CURSOR_TOKEN}`);
  assert.equal(decode(calls[0].init.body).type, 'relay.verification');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal((await (await post(w, l)).text()).includes(CURSOR_TOKEN), false);
});

test('POST /destination: cursor rejects non-allowlisted hosts and paths without any outbound call', async () => {
  const w = world();
  const l = await login(w);
  const urls = [
    GROK_URL,
    'https://api.cursor.sh/automations/webhook/123e4567-e89b-12d3-a456-426614174000',
    'https://api2.cursor.sh.evil.com/automations/webhook/123e4567-e89b-12d3-a456-426614174000',
    'https://evil.example/automations/webhook/123e4567-e89b-12d3-a456-426614174000',
    `${CURSOR_URL}?x=1`,
    `${CURSOR_URL}/x`,
    CURSOR_URL.replace('https', 'http')
  ];
  for (const url of urls) {
    const wi = world();
    const li = await login(wi);
    const res = await post(wi, li, { url });
    assert.equal(res.status, 400, url);
    assert.match(await res.text(), /That URL is not allowed/);
    assert.equal(wi.fetchImpl.calls.filter((c) => !c.url.includes('slack.com')).length, 0);
    assert.equal(await wi.routing.get(U1), null);
  }
  assert.equal(w.fetchImpl.calls.length, 1);
  assert.equal(l.csrf.length > 0, true);
});

test('POST /destination: cursor rejects a bad token shape without any outbound call, and never echoes it', async () => {
  const w = world();
  const l = await login(w);
  for (const secret of ['', 'crsr_short', 'plain-token-with-no-prefix-0123456789', `whsec_${'a'.repeat(30)}`, `crsr_${'a'.repeat(30)} x`, `crsr_${'a'.repeat(300)}`]) {
    const wi = world();
    const li = await login(wi);
    const res = await post(wi, li, { secret });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /crsr_/);
    if (secret) assert.equal(html.includes(secret), false);
    assert.equal(wi.fetchImpl.calls.filter((c) => !c.url.includes('slack.com')).length, 0);
    assert.equal(await wi.routing.get(U1), null);
  }
  assert.equal(w.fetchImpl.calls.length, 1);
  assert.equal(l.csrf.length > 0, true);
});

test('POST /destination: the attestation is enforced server-side for cursor and the old no_send box is no longer required', async () => {
  const w = world();
  const l = await login(w);
  assert.equal((await post(w, l, { attest: '' })).status, 400);
  assert.equal(w.fetchImpl.calls.filter((c) => c.url === CURSOR_URL).length, 0);
  assert.equal((await post(w, l, { no_send: '' })).status, 200);
});

test('POST /destination: failed or redirecting cursor verification is not stored and does not leak the token', async () => {
  for (const handler of [() => respond(401, `bad Bearer ${CURSOR_TOKEN}`), () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })]) {
    const w = world({ cursor: handler });
    const l = await login(w);
    const res = await post(w, l);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /Verification failed/);
    assert.equal(html.includes(CURSOR_TOKEN), false);
    assert.equal(await w.routing.get(U1), null);
  }
});

test('POST /destination: cursor registration shares the per-user rate limit', async () => {
  const w = world({ cursor: () => respond(500) });
  const l = await login(w);
  for (let i = 0; i < 5; i++) assert.equal((await post(w, l)).status, 400);
  assert.equal((await post(w, l)).status, 429);
});

test('the connect page and destination form disclose the cursor requirements', async () => {
  const w = world();
  const html = (await (await w.request('/connect')).text()).replace(/&quot;/g, '"');
  for (const re of [/sent to Cursor/, /privacy mode on/, /controlled by its own permissions/, /data, not instructions/, /Each verification attempt can trigger one automation run\./, /no retry after a timeout or a 5xx other than 503/, /trigger your automation with arbitrary content/]) {
    assert.match(html, re);
  }
  const l = await login(w);
  assert.match(l.html, /value="cursor"/);
  assert.match(l.html, /Each verification attempt can trigger one automation run\./);
  assert.match(l.html, /privacy mode is on/);
  assert.match(l.html, /the attestation covers the account that owns the token/);
  assert.match(l.html, /arbitrary content/);
});

const dm = (sender, recipient, over = {}) => msgPayload({ sender, authorizations: [{ user_id: recipient, is_bot: false }], ...over });
const nonSlack = (w) => w.fetchImpl.calls.filter((c) => !c.url.includes('slack.com'));

test('e2e: a DM to a user with a cursor route is forwarded with the bearer header and the grok-shaped body', async () => {
  const w = world();
  await w.addCursor(U2, CURSOR_URL, CURSOR_TOKEN, { full: true });
  await w.addCursor(U1, OTHER_URL, CURSOR_TOKEN, { full: true });
  await w.send(dm(U1, U2, { text: 'meeting at 3', extraEvent: { thread_ts: '1800000000.000050' } }));
  const calls = nonSlack(w);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, CURSOR_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.authorization, `Bearer ${CURSOR_TOKEN}`);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['webhook-signature'], undefined);
  assert.equal(init.headers['webhook-id'], undefined);
  assert.equal(init.headers['idempotency-key'], `Ev0001_${U2}`);
  const body = decode(init.body);
  assert.deepEqual(Object.keys(body).sort(), [
    'channel_id',
    'event_id',
    'mode',
    'received_at',
    'sender_id',
    'sender_trusted',
    'text',
    'thread_ts',
    'ts',
    'type'
  ]);
  assert.deepEqual(body.mode, { process: true, draft: true, send: false });
  assert.equal(body.sender_trusted, false);
  assert.equal(body.event_id, 'Ev0001');
  assert.equal(body.type, 'dm');
  assert.equal(body.channel_id, 'D0CHAN1');
  assert.equal(body.sender_id, U1);
  assert.equal(body.text, 'meeting at 3');
  assert.equal(body.ts, '1800000000.000100');
  assert.equal(body.thread_ts, '1800000000.000050');
  assert.equal((await w.entry(U2).core.status()).counters.forwarded, 1);
});

test('e2e: group DM type is forwarded as group_dm', async () => {
  const w = world();
  await w.addCursor(U2);
  await w.send(dm(U1, U2, { channelType: 'mpim', channel: 'G0GROUP1' }));
  assert.equal(decode(nonSlack(w)[0].init.body).type, 'group_dm');
});

test('e2e: a different user cursor route never receives the message', async () => {
  const w = world();
  await w.addCursor(U2);
  await w.addCursor(U3, OTHER_URL, 'crsr_OtherUsersToken_0123456789_xyz');
  await w.send(dm(U1, U2, { text: 'for U2 only' }));
  const calls = nonSlack(w);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CURSOR_URL);
  assert.equal(calls.some((c) => c.url === OTHER_URL), false);
  assert.equal(calls.some((c) => JSON.stringify(c.init.headers).includes('OtherUsersToken')), false);
  const st3 = await w.entry(U3).core.status();
  assert.deepEqual(st3.counters, { forwarded: 0, dropped: 0, errors: 0, fanout_degraded: 0, coalesced: 0, timeouts: 0 });
});

test('e2e: a failing cursor endpoint increments errors for that user only', async () => {
  const w = world({ cursor: (init) => (init.headers.authorization.includes('FailingUser') ? respond(500) : respond(202)) });
  await w.addCursor(U2, CURSOR_URL, 'crsr_FailingUser_0123456789_abcdef');
  await w.addCursor(U3, OTHER_URL);
  await w.send(dm(U1, U2));
  const st2 = (await w.entry(U2).core.status()).counters;
  assert.equal(st2.errors, 1);
  assert.equal(st2.forwarded, 0);
  assert.equal(nonSlack(w).length, 1);
  await w.send(dm(U1, U3, { eventId: 'Ev0002' }));
  const st3 = (await w.entry(U3).core.status()).counters;
  assert.equal(st3.forwarded, 1);
  assert.equal(st3.errors, 0);
  assert.equal((await w.entry(U2).core.status()).counters.errors, 1);
});

test('e2e: network errors and timeouts count as errors; success counts as forwarded', async () => {
  let mode = 'timeout';
  const w = world({
    cursor: () => {
      if (mode === 'timeout') throw timeoutError();
      if (mode === 'network') throw new TypeError('down');
      return respond(200);
    }
  });
  await w.addCursor(U2);
  await w.send(dm(U1, U2));
  mode = 'network';
  await w.send(dm(U1, U2, { eventId: 'Ev0002' }));
  mode = 'ok';
  await w.send(dm(U1, U2, { eventId: 'Ev0003' }));
  const c = (await w.entry(U2).core.status()).counters;
  assert.equal(c.errors, 2);
  assert.equal(c.forwarded, 1);
});

test('e2e: a redirect from the cursor endpoint is a failure and is never followed', async () => {
  const w = world({ cursor: () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }) });
  await w.addCursor(U2);
  await w.send(dm(U1, U2));
  assert.equal(nonSlack(w).length, 1);
  assert.equal(w.fetchImpl.calls.some((c) => c.url.includes('169.254')), false);
  const c = (await w.entry(U2).core.status()).counters;
  assert.equal(c.errors, 1);
  assert.equal(c.forwarded, 0);
});

test('e2e: a stored cursor entry with a bad url or token is dropped with no outbound call', async () => {
  const w = world();
  await w.addCursor(U2, 'https://evil.example/automations/webhook/123e4567-e89b-12d3-a456-426614174000');
  await w.addCursor(U3, CURSOR_URL, 'not-a-cursor-token');
  await w.send(dm(U1, U2));
  await w.send(dm(U1, U3, { eventId: 'Ev0002' }));
  assert.equal(nonSlack(w).length, 0);
  assert.equal((await w.entry(U2).core.status()).counters.dropped, 1);
  assert.equal((await w.entry(U3).core.status()).counters.dropped, 1);
});

test('e2e: a disconnected cursor user is dropped on the hot path', async () => {
  const w = world();
  await w.addCursor(U2);
  await w.entry(U2).core.markDisconnected();
  await w.send(dm(U1, U2));
  assert.equal(nonSlack(w).length, 0);
  assert.equal((await w.entry(U2).core.status()).counters.dropped, 1);
});

test('e2e: /status shows the cursor user counters only', async () => {
  const w = world();
  await w.addCursor(U1);
  await w.addCursor(U2);
  await w.send(dm(U1, U2));
  await w.send(dm(U1, U2, { eventId: 'Ev0002' }));
  w.ctl.oauth = () => oauthOk(U2);
  const res = await startOauth(w, '/status');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /forwarded: 2/);
  assert.match(html, /errors: 0/);
  assert.equal(html.includes(CURSOR_TOKEN), false);
  assert.equal(html.includes(CURSOR_URL), false);
  assert.equal(html.includes('Last nudge'), false);
});

test('e2e: /status shows the Last nudge line only for claude_routine users', async () => {
  const w = world();
  await w.addClaude(U1);
  await w.addGrok(U2);
  w.ctl.oauth = () => oauthOk(U1);
  assert.match(await (await startOauth(w, '/status')).text(), /Last nudge: never/);
  w.ctl.oauth = () => oauthOk(U2);
  assert.equal((await (await startOauth(w, '/status')).text()).includes('Last nudge'), false);
});

test('e2e: the bearer token never appears in console output, pages, error bodies or DO storage', async () => {
  const cap = captureConsole();
  const bodies = [];
  try {
    const w = world({ cursor: () => respond(500, `Bearer ${CURSOR_TOKEN}`) });
    const l = await login(w);
    bodies.push(l.html);
    bodies.push(await (await post(w, l)).text());
    bodies.push(await (await post(w, l, { secret: 'crsr_bad' })).text());
    bodies.push(await (await w.request('/connect')).text());
    bodies.push(await (await w.request('/nope')).text());
    await w.addCursor(U2);
    await w.addCursor(U3, OTHER_URL);
    bodies.push(await (await w.send(dm(U1, U2))).text());
    bodies.push(await (await w.send(dm(U1, U2), { signature: 'v0=bad' })).text());
    bodies.push(await (await w.send(null, { rawBody: new TextEncoder().encode('{nope') })).text());
    w.deps.fetchImpl = async () => {
      throw new TypeError(`boom ${CURSOR_TOKEN}`);
    };
    await w.send(dm(U1, U3, { eventId: 'Ev0009' }));
    for (const b of bodies) assert.equal(b.includes(CURSOR_TOKEN), false);
    for (const [uid, { storage }] of w.cores) {
      assert.equal(JSON.stringify([...storage.map]).includes('crsr_'), false, uid);
    }
    for (const [k, v] of w.kv.store) {
      if (!k.startsWith('route:')) assert.equal(v.includes('crsr_'), false, k);
    }
  } finally {
    cap.restore();
  }
  assert.equal(JSON.stringify(cap.seen).includes('crsr_'), false);
  for (const args of cap.seen) assert.ok(args.every((a) => typeof a === 'string' && /^E_[A-Z_]+$/.test(a)), JSON.stringify(args));
});

test('e2e: cursor does not alter grok delivery (signed, no bearer)', async () => {
  const w = world();
  await w.addGrok(U2);
  await w.send(dm(U1, U2, { text: 'to grok' }));
  const grokCall = nonSlack(w)[0];
  assert.match(grokCall.url, /hooks\.x\.ai/);
  assert.ok(grokCall.init.headers['webhook-signature']);
  assert.equal(grokCall.init.headers.authorization, undefined);
});
