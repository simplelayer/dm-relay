import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROK_SECRET, GROK_URL, ROUTINE_URL, U1, U2, U3, U4, authListResponse, isAuthList, makeWorld, msgPayload, respond, slackSignature, SIGNING_SECRET } from './helpers.js';

const hookCalls = (w) => w.fetchImpl.calls.filter((c) => c.url.startsWith('https://hooks.x.ai/'));
const handler = (ids) => (url) => (isAuthList(url) ? authListResponse(ids) : respond(202));
const body = (c) => JSON.parse(new TextDecoder().decode(c.init.body));

test('shared DM between two opted-in users: one copy to the other user, none back to the sender', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  const res = await w.send(msgPayload({ sender: U1, authorizations: [{ user_id: U1, is_bot: false }] }));
  assert.equal(res.status, 200);
  const calls = hookCalls(w);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://hooks.x.ai/w/${U2}`);
  assert.equal(body(calls[0]).sender_id, U1);
  assert.equal(calls[0].init.headers['webhook-id'], 'Ev0001_' + U2);
});

test('group DM with a non-opted-in sender: one copy to each opted-in recipient', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U3, channelType: 'mpim', channel: 'G0GRP', authorizations: [{ user_id: U1, is_bot: false }] }));
  const urls = hookCalls(w).map((c) => c.url).sort();
  assert.deepEqual(urls, [`https://hooks.x.ai/w/${U1}`, `https://hooks.x.ai/w/${U2}`]);
  assert.equal(body(hookCalls(w)[0]).type, 'group_dm');
});

test('sender never receives their own message (even when only authorizations names them)', async () => {
  const w = makeWorld({ fetchHandler: handler([U1]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U1, authorizations: [{ user_id: U1, is_bot: false }] }));
  assert.equal(hookCalls(w).some((c) => c.url.endsWith(U1)), false);
});

test('a recipient who is not opted in produces no forward', async () => {
  const w = makeWorld({ fetchHandler: handler([U4]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U3, authorizations: [{ user_id: U4, is_bot: false }] }));
  assert.equal(hookCalls(w).length, 0);
});

test('only one opted-in user: no authorizations.list call, still forwarded from authorizations[]', async () => {
  const w = makeWorld({ fetchHandler: handler([]) });
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U3, authorizations: [{ user_id: U2, is_bot: false }] }));
  assert.equal(w.fetchImpl.calls.filter((c) => isAuthList(c.url)).length, 0);
  assert.equal(hookCalls(w).length, 1);
  assert.equal((await w.entry(U2).core.status()).counters.forwarded, 1);
});

test('dropped event classes never reach any destination', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  const variants = [
    { subtype: 'file_share', files: [{ id: 'F' }] },
    { subtype: 'message_changed', previous_message: { text: 'old' } },
    { subtype: 'message_deleted', previous_message: { text: 'gone' } },
    { bot_id: 'B1' },
    { hidden: true },
    { user: 'USLACKBOT' },
    { is_ext_shared_channel: true },
    { user_team: 'T0OTHER' }
  ];
  for (const [i, v] of variants.entries()) {
    const res = await w.send(msgPayload({ sender: U3, eventId: `EvD${i}`, extraEvent: v }));
    assert.equal(res.status, 200);
  }
  assert.equal(hookCalls(w).length, 0);
});

test('response is 200 immediately, before slow destinations finish (processing happens in waitUntil)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const w = makeWorld({ fetchHandler: async (url) => (isAuthList(url) ? authListResponse([U1, U2]) : (await gate, respond(202))) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  const bytes = new TextEncoder().encode(JSON.stringify(msgPayload({ sender: U1 })));
  const ts = String(Math.floor(w.clock.t / 1000));
  const res = await w.request('/slack/events', {
    method: 'POST',
    headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(SIGNING_SECRET, ts, bytes) },
    body: bytes
  });
  assert.equal(res.status, 200);
  assert.equal((await w.entry(U2).core.status()).counters.forwarded, 0);
  release();
  await w.flush();
  assert.equal((await w.entry(U2).core.status()).counters.forwarded, 1);
});

test('wrong team_id or api_app_id: 200, nothing processed', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  assert.equal((await w.send(msgPayload({ sender: U1, extra: { team_id: 'T0EVIL' } }))).status, 200);
  assert.equal((await w.send(msgPayload({ sender: U1, extra: { api_app_id: 'A0EVIL' } }))).status, 200);
  assert.equal(w.fetchImpl.calls.length, 0);
});

test('app_rate_limited is acknowledged with 200 and nothing else', async () => {
  const w = makeWorld();
  const res = await w.send({ type: 'app_rate_limited', team_id: 'T0TEAM', api_app_id: 'A0APP', minute_rate_limited: 1, token: 'x' });
  assert.equal(res.status, 200);
  assert.equal(w.fetchImpl.calls.length, 0);
});

test('malformed JSON with a valid signature: 400 and no throw', async () => {
  const w = makeWorld();
  const res = await w.send(null, { rawBody: new TextEncoder().encode('{not json') });
  assert.equal(res.status, 400);
});

test('failed destination is counted as an error for that user only, other recipients unaffected', async () => {
  const w = makeWorld({
    fetchHandler: (url) => (isAuthList(url) ? authListResponse([U1, U2]) : url.endsWith(U1) ? respond(400) : respond(202))
  });
  await w.addGrok(U1);
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U3 }));
  assert.equal((await w.entry(U1).core.status()).counters.errors, 1);
  assert.equal((await w.entry(U2).core.status()).counters.forwarded, 1);
});

test('claude_routine recipient gets a metadata-only nudge; DM text is never forwarded', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addClaude(U2);
  await w.addGrok(U1);
  await w.send(msgPayload({ sender: U1, text: 'TOP SECRET DM BODY' }));
  const fire = w.fetchImpl.calls.find((c) => c.url === ROUTINE_URL);
  assert.ok(fire);
  assert.equal(fire.init.body.includes('TOP SECRET'), false);
  assert.match(JSON.parse(fire.init.body).text, /channel_id D0CHAN1 at ts 1800000000\.000100/);
  assert.equal((await w.entry(U2).core.status()).counters.forwarded, 1);
});

test('claude_routine: a burst is coalesced to one immediate fire plus a pending trailing nudge', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addClaude(U2);
  await w.addGrok(U1);
  for (let i = 0; i < 3; i++) await w.send(msgPayload({ sender: U1, eventId: `EvB${i}` }));
  assert.equal(w.fetchImpl.calls.filter((c) => c.url === ROUTINE_URL).length, 1);
  assert.equal(w.entry(U2).alarm.at, w.clock.t + 300000);
});

test('disconnected flag stops forwarding on the hot path even while the (stale) route still exists', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  await w.entry(U2).core.markDisconnected();
  await w.send(msgPayload({ sender: U1 }));
  assert.equal(hookCalls(w).length, 0);
  assert.equal((await w.entry(U2).core.status()).counters.dropped, 1);
});

test('tokens_revoked deletes routing entries for tokens.oauth user ids and sets the flag', async () => {
  const w = makeWorld();
  await w.addGrok(U1);
  await w.addGrok(U2);
  const res = await w.send({
    type: 'event_callback', team_id: 'T0TEAM', api_app_id: 'A0APP', event_id: 'EvR',
    event: { type: 'tokens_revoked', tokens: { oauth: [U1], bot: [] } }
  });
  assert.equal(res.status, 200);
  assert.equal(await w.routing.get(U1), null);
  assert.notEqual(await w.routing.get(U2), null);
  assert.equal((await w.entry(U1).core.check()).disconnected, true);
});

test('app_uninstalled wipes all routing entries and all DOs', async () => {
  const w = makeWorld();
  for (const u of [U1, U2, U3]) {
    await w.addGrok(u);
    await w.entry(u).core.increment({ name: 'forwarded' });
  }
  await w.send({ type: 'event_callback', team_id: 'T0TEAM', api_app_id: 'A0APP', event_id: 'EvU', event: { type: 'app_uninstalled' } });
  assert.equal((await w.routing.listUpTo(10)).length, 0);
  for (const u of [U1, U2, U3]) {
    const st = await w.entry(u).core.status();
    assert.equal(st.counters.forwarded, 0);
    assert.equal(st.disconnected, true);
  }
});

test('unsigned revocation events are ignored', async () => {
  const w = makeWorld();
  await w.addGrok(U1);
  await w.send({ type: 'event_callback', team_id: 'T0TEAM', api_app_id: 'A0APP', event: { type: 'app_uninstalled' } }, { signature: 'v0=00' });
  assert.notEqual(await w.routing.get(U1), null);
});

test('relay stores no message text: DO storage and KV contain no DM text after processing', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addClaude(U2);
  await w.send(msgPayload({ sender: U3, text: 'NEEDLE-TEXT-123' }));
  await w.send(msgPayload({ sender: U3, text: 'NEEDLE-TEXT-123', eventId: 'Ev2' }));
  const dump = JSON.stringify([...w.kv.store]) + JSON.stringify([...w.cores.values()].map((c) => [...c.storage.map]));
  assert.equal(dump.includes('NEEDLE-TEXT'), false);
});

test('unknown routes return 404 with page headers; GET /slack/events is not served', async () => {
  const w = makeWorld();
  assert.equal((await w.request('/nope')).status, 404);
  assert.equal((await w.request('/slack/events')).status, 404);
});

test('B1: KV list failure fails toward delivery (API called, recipients still forwarded)', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  w.kv.list = async () => {
    throw new Error('kv list quota');
  };
  await w.send(msgPayload({ sender: U3, authorizations: [] }));
  assert.equal(w.fetchImpl.calls.filter((c) => isAuthList(c.url)).length, 1);
  for (const u of [U1, U2]) assert.equal((await w.entry(u).core.status()).counters.forwarded, 1);
});

test('B1: routed-id sample is cached for 60 s, so KV list runs once per minute not once per event', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  const realList = w.kv.list.bind(w.kv);
  let lists = 0;
  w.kv.list = (...a) => {
    lists++;
    return realList(...a);
  };
  await w.send(msgPayload({ sender: U3, authorizations: [], eventId: 'Ev1' }));
  await w.send(msgPayload({ sender: U3, authorizations: [], eventId: 'Ev2' }));
  assert.equal(lists, 1);
  w.clock.t += 61_000;
  await w.send(msgPayload({ sender: U3, authorizations: [], eventId: 'Ev3' }));
  assert.equal(lists, 2);
});

test('B1: the routed-sample cache holds routed user ids only', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.addGrok(U2);
  await w.send(msgPayload({ sender: U3, text: 'NEEDLE-TEXT-CACHE', authorizations: [] }));
  assert.deepEqual([...w.deps.routedSample.ids].sort(), [U1, U2]);
  assert.equal(JSON.stringify(w.deps.routedSample).includes('NEEDLE-TEXT'), false);
});

test('S1: one routed user, Slack authorizations[] names an installed-but-unrouted user: routed user still receives', async () => {
  const w = makeWorld({ fetchHandler: handler([U1, U2]) });
  await w.addGrok(U1);
  await w.send(msgPayload({ sender: U3, channel: 'G0MPIM', channelType: 'mpim', authorizations: [{ team_id: 'T0TEAM', user_id: U2, is_bot: false }] }));
  assert.equal(w.fetchImpl.calls.filter((c) => isAuthList(c.url)).length, 1);
  assert.equal((await w.entry(U1).core.status()).counters.forwarded, 1);
});

test('S1: one routed user who is already a candidate still skips the API call', async () => {
  const w = makeWorld({ fetchHandler: handler([U1]) });
  await w.addGrok(U1);
  await w.send(msgPayload({ sender: U3, authorizations: [{ team_id: 'T0TEAM', user_id: U1, is_bot: false }] }));
  assert.equal(w.fetchImpl.calls.filter((c) => isAuthList(c.url)).length, 0);
  assert.equal((await w.entry(U1).core.status()).counters.forwarded, 1);
});

const onlyDisconnectedFlag = (w, uid) => [...w.entry(uid).storage.map.entries()];

test('S3: tokens_revoked leaves the DO holding only the disconnected flag', async () => {
  const w = makeWorld();
  await w.addGrok(U1);
  await w.entry(U1).core.increment({ name: 'forwarded' });
  await w.entry(U1).core.noteActivity({ userId: U1, channelId: 'D0SECRETPAIR', ts: '1.1' }).catch(() => {});
  await w.send({ type: 'event_callback', team_id: 'T0TEAM', api_app_id: 'A0APP', event_id: 'EvR2', event: { type: 'tokens_revoked', tokens: { oauth: [U1], bot: [] } } });
  assert.deepEqual(onlyDisconnectedFlag(w, U1), [['disconnected', true]]);
});

test('S3: after app_uninstalled every DO holds only the disconnected flag', async () => {
  const w = makeWorld();
  for (const u of [U1, U2]) {
    await w.addClaude(u);
    await w.entry(u).core.increment({ name: 'forwarded' });
    await w.entry(u).core.noteActivity({ userId: u, channelId: 'D0SECRETPAIR', ts: '1.1' });
    await w.entry(u).core.noteActivity({ userId: u, channelId: 'D0SECRETPAIR', ts: '1.2' });
  }
  await w.send({ type: 'event_callback', team_id: 'T0TEAM', api_app_id: 'A0APP', event_id: 'EvU2', event: { type: 'app_uninstalled' } });
  for (const u of [U1, U2]) assert.deepEqual(onlyDisconnectedFlag(w, u), [['disconnected', true]]);
});
