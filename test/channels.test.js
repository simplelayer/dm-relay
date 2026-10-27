import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANGE_FIELDS, OPTIONAL_CHANNEL_SCOPES, REQUIRED_SCOPES } from '../src/constants.js';
import { effectiveChannels } from '../src/caps.js';
import { applyChannelPolicy, filterMessageEvent } from '../src/filter.js';
import { buildPrompt } from '../src/prompts.js';
import { isChannelId } from '../src/routes.js';
import { APP, TEAM, U1, U2, U3, USER_TOKEN, authListResponse, cookieHeaderFrom, isAuthList, makeWorld, msgPayload, respond, setCookies } from './helpers.js';

const CH = 'C0CHAN1';
const PRIV = 'G0PRIV1';
const BASE_SCOPE = 'im:history,mpim:history';
const CHANNEL_SCOPE = `${BASE_SCOPE},channels:history,groups:history`;

function world() {
  const c = { user: U1, scope: BASE_SCOPE };
  const w = makeWorld({
    fetchHandler: (url) => {
      if (url.includes('oauth.v2.access')) {
        return respond(200, { ok: true, app_id: APP, team: { id: TEAM }, authed_user: { id: c.user, scope: c.scope, access_token: USER_TOKEN, token_type: 'user' } });
      }
      if (url.includes('auth.revoke')) return respond(200, { ok: true });
      if (isAuthList(url)) return authListResponse([U1, U2]);
      return respond(202);
    }
  });
  w.ctl = c;
  return w;
}

async function login(w, { userId = U1, channels = false, scope } = {}) {
  w.ctl.user = userId;
  if (scope) w.ctl.scope = scope;
  const res = await w.request(channels ? '/connect?channels=1' : '/connect');
  const html = await res.text();
  const href = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize[^"]+)"/)[1].replaceAll('&amp;', '&');
  const url = new URL(href);
  const state = url.searchParams.get('state');
  const cookiePair = setCookies(res).find((c) => c.startsWith('dmr_st_')).split(';')[0];
  const cb = await w.request(`/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiePair } });
  const page = await cb.text();
  return { html: page, authorizeScopes: url.searchParams.get('user_scope'), connectHtml: html, csrf: page.match(/name="csrf" value="([^"]+)"/)?.[1], cookie: cookieHeaderFrom(cb) };
}

const post = (w, path, l, fields) =>
  w.request(path, {
    method: 'POST',
    headers: { cookie: l.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: l.csrf, ...fields }).toString()
  });

const api = (w, key, path, { method = 'GET', body } = {}) =>
  w.request(path, { method, headers: { authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });

async function mkKey(w, l) {
  const html = await (await post(w, '/keys/create', l, { label: 'a' })).text();
  return html.match(/value="(dmr_[A-Za-z0-9_-]+)"/)[1];
}

const destBodies = (w) => w.fetchImpl.calls.filter((c) => c.url.startsWith('https://hooks.x.ai/')).map((c) => JSON.parse(new TextDecoder().decode(c.init.body)));
const channelMsg = (o = {}) => msgPayload({ sender: U1, channel: CH, channelType: 'channel', text: `hello <@${U2}> please look`, ...o });

async function forwardWorld(channels, extra = {}) {
  const w = world();
  await w.addGrok(U2);
  const e = await w.routing.get(U2);
  await w.routing.put(U2, { ...e, ...(channels ? { channels } : {}), ...extra });
  return w;
}

async function userWorld(scope) {
  const w = world();
  await w.addGrok(U1);
  const l = await login(w, { channels: scope === CHANNEL_SCOPE, scope });
  const key = await mkKey(w, l);
  return { w, l, key };
}

test('REQUIRED_SCOPES is unchanged and the channel scopes are a separate optional list', () => {
  assert.deepEqual(REQUIRED_SCOPES, ['im:history', 'mpim:history']);
  assert.deepEqual(OPTIONAL_CHANNEL_SCOPES, ['channels:history', 'groups:history']);
});

test('DEFAULT OFF: a legacy route never receives channel or private-channel events, even with a mention', async () => {
  const w = await forwardWorld(undefined);
  await w.send(channelMsg({ eventId: 'E1' }));
  await w.send(channelMsg({ eventId: 'E2', channel: PRIV, channelType: 'group' }));
  assert.equal(destBodies(w).length, 0);
  assert.equal(w.fetchImpl.calls.length, 0);
  const w2 = await forwardWorld({ enabled: false, mentions: true, allowlist: [CH] });
  await w2.send(channelMsg());
  assert.equal(destBodies(w2).length, 0);
  assert.deepEqual(effectiveChannels(undefined), { enabled: false, mentions: true, allowlist: [] });
  assert.deepEqual(effectiveChannels('junk'), { enabled: false, mentions: true, allowlist: [] });
  assert.equal(filterMessageEvent(channelMsg()).reason, 'channel_type');
});

test('MENTION ONLY: an opted-in user gets channel messages that mention them and nothing else', async () => {
  const w = await forwardWorld({ enabled: true, mentions: true, allowlist: [] });
  await w.send(channelMsg({ eventId: 'E1' }));
  await w.send(channelMsg({ eventId: 'E2', text: 'no mention here' }));
  await w.send(channelMsg({ eventId: 'E3', text: `mentions someone else <@${U3}>` }));
  await w.send(channelMsg({ eventId: 'E4', text: `legacy form <@${U2}|bob> hi` }));
  const bodies = destBodies(w);
  assert.deepEqual(bodies.map((b) => b.event_id), ['E1', 'E4']);
  assert.equal(bodies[0].mentioned, true);
});

test('MENTIONS OFF: only the allowlist forwards when mentions is false', async () => {
  const w = await forwardWorld({ enabled: true, mentions: false, allowlist: [PRIV] });
  await w.send(channelMsg({ eventId: 'E1' }));
  await w.send(channelMsg({ eventId: 'E2', channel: PRIV, channelType: 'group', text: 'plain' }));
  assert.deepEqual(destBodies(w).map((b) => b.event_id), ['E2']);
});

test('ALLOWLIST: a listed channel forwards without a mention; unlisted channels do not', async () => {
  const w = await forwardWorld({ enabled: true, mentions: true, allowlist: [CH] });
  await w.send(channelMsg({ eventId: 'E1', text: 'plain message' }));
  await w.send(channelMsg({ eventId: 'E2', channel: 'C0OTHER', text: 'plain message' }));
  const bodies = destBodies(w);
  assert.deepEqual(bodies.map((b) => b.event_id), ['E1']);
  assert.equal(bodies[0].mentioned, false);
});

test('EXTERNAL: externally shared channels are never forwarded, even when allowlisted and mentioned', async () => {
  const w = await forwardWorld({ enabled: true, mentions: true, allowlist: [CH] });
  await w.send(channelMsg({ eventId: 'E1', extra: { is_ext_shared_channel: true } }));
  await w.send(channelMsg({ eventId: 'E2', extraEvent: { is_ext_shared_channel: true } }));
  await w.send(channelMsg({ eventId: 'E3', extraEvent: { user_team: 'T0OTHER' } }));
  await w.send(channelMsg({ eventId: 'E4', extraEvent: { source_team: 'T0OTHER' } }));
  assert.equal(destBodies(w).length, 0);
  assert.equal(applyChannelPolicy({ channel: CH, text: `<@${U2}>`, is_ext_shared_channel: true }, U2, { enabled: true, allowlist: [CH] }).forward, false);
});

test('FILTERS still apply to channel messages: bots, subtypes, hidden, user and keyword filters', async () => {
  const w = await forwardWorld({ enabled: true, mentions: true, allowlist: [] }, { filters: { skip_bots: true, skip_users: [U3], keywords: ['lunch'] } });
  await w.send(channelMsg({ eventId: 'B1', extraEvent: { bot_id: 'B0BOT' } }));
  await w.send(channelMsg({ eventId: 'S1', extraEvent: { subtype: 'message_changed' } }));
  await w.send(channelMsg({ eventId: 'H1', extraEvent: { hidden: true } }));
  await w.send(channelMsg({ eventId: 'U1', sender: U3, authorizations: [{ team_id: TEAM, user_id: U2, is_bot: false }] }));
  await w.send(channelMsg({ eventId: 'K1', text: `<@${U2}> lunch?` }));
  assert.equal(destBodies(w).length, 0);
  await w.send(channelMsg({ eventId: 'OK' }));
  assert.deepEqual(destBodies(w).map((b) => b.event_id), ['OK']);
});

test('PAYLOAD SHAPE: channel and private_channel payloads carry the documented fields', async () => {
  const w = await forwardWorld({ enabled: true, mentions: true, allowlist: [] }, { trusted_users: [U1], caps: { process: false, draft: true, send: false } });
  await w.send(channelMsg({ eventId: 'E1', extraEvent: { thread_ts: '1800000000.000050' } }));
  await w.send(channelMsg({ eventId: 'E2', channel: PRIV, channelType: 'group' }));
  const [pub, priv] = destBodies(w);
  assert.deepEqual(Object.keys(pub), ['event_id', 'received_at', 'type', 'channel_id', 'sender_id', 'text', 'ts', 'thread_ts', 'mode', 'sender_trusted', 'mentioned']);
  assert.equal(pub.type, 'channel');
  assert.equal(pub.channel_id, CH);
  assert.equal(pub.sender_id, U1);
  assert.equal(pub.thread_ts, '1800000000.000050');
  assert.deepEqual(pub.mode, { process: false, draft: true, send: false });
  assert.equal(pub.sender_trusted, true);
  assert.equal(pub.mentioned, true);
  assert.equal(priv.type, 'private_channel');
  assert.equal(priv.channel_id, PRIV);
  assert.equal(priv.thread_ts, null);
});

test('DM BEHAVIOR UNCHANGED: DMs and group DMs forward as before, with no mentioned field, whether or not channels are on', async () => {
  for (const channels of [undefined, { enabled: true, mentions: true, allowlist: [CH] }]) {
    const w = await forwardWorld(channels);
    await w.send(msgPayload({ sender: U1, eventId: 'D1' }));
    await w.send(msgPayload({ sender: U1, eventId: 'D2', channel: 'G0MPIM1', channelType: 'mpim' }));
    await w.send(msgPayload({ sender: U1, eventId: 'D3', channelType: 'app_home' }));
    const bodies = destBodies(w);
    assert.deepEqual(bodies.map((b) => [b.event_id, b.type]), [['D1', 'dm'], ['D2', 'group_dm']]);
    assert.deepEqual(Object.keys(bodies[0]), ['event_id', 'received_at', 'type', 'channel_id', 'sender_id', 'text', 'ts', 'thread_ts', 'mode', 'sender_trusted']);
  }
});

test('ALLOWLIST VALIDATION: channel ids need a C or G prefix, are normalized, deduplicated and capped at 10', async () => {
  assert.equal(isChannelId('C0123ABC'), true);
  assert.equal(isChannelId('G0123ABC'), true);
  for (const bad of ['D0123ABC', 'U0123ABC', 'c0123abc', 'C', 'C01-23', '', null, 5]) assert.equal(isChannelId(bad), false, String(bad));
  const { w, l } = await userWorld(CHANNEL_SCOPE);
  const save = async (fields) => (await post(w, '/channels', l, fields)).text();
  assert.match(await save({ enabled: '1', allowlist: 'D0123ABC' }), /Slack channel IDs look like/);
  assert.match(await save({ enabled: '1', allowlist: 'C0123ABC, bad!' }), /Slack channel IDs look like/);
  const eleven = Array.from({ length: 11 }, (_, i) => `C0000${String.fromCharCode(65 + i)}AA`).join(' ');
  assert.match(await save({ enabled: '1', allowlist: eleven }), /At most 10 channel IDs/);
  assert.equal((await w.routing.get(U1)).channels, undefined);
  assert.match(await save({ enabled: '1', mentions: '1', allowlist: 'c0123abc g0456def C0123ABC' }), /Channel settings saved/);
  assert.deepEqual((await w.routing.get(U1)).channels, { enabled: true, mentions: true, allowlist: ['C0123ABC', 'G0456DEF'] });
});

test('SCOPE MISSING: enabling channels in the browser is blocked with a clear message when the token lacks the scopes', async () => {
  const { w, l } = await userWorld(BASE_SCOPE);
  assert.match(l.html, /Re-authorize/);
  assert.match(l.html, /href="\/connect\?channels=1"/);
  const html = await (await post(w, '/channels', l, { enabled: '1', mentions: '1', allowlist: CH })).text();
  assert.match(html, /Channels need extra Slack permissions \(channels:history and groups:history\)/);
  assert.equal((await w.routing.get(U1)).channels, undefined);
  const off = await post(w, '/channels', l, { mentions: '1', allowlist: CH });
  assert.match(await off.text(), /Channel settings saved/);
  assert.equal((await w.routing.get(U1)).channels.enabled, false);
});

test('SCOPES: the default connect asks only for the required scopes; ?channels=1 adds the channel scopes and stores them', async () => {
  const plain = await userWorld(BASE_SCOPE);
  assert.equal(plain.l.authorizeScopes, 'im:history,mpim:history');
  assert.equal((await plain.w.routing.get(U1)).scopes, undefined);
  const w = world();
  await w.addGrok(U1);
  const l = await login(w, { channels: true, scope: CHANNEL_SCOPE });
  assert.equal(l.authorizeScopes, 'im:history,mpim:history,channels:history,groups:history');
  assert.match(l.connectHtml, /Channel access/);
  assert.deepEqual((await w.routing.get(U1)).scopes, CHANNEL_SCOPE.split(','));
  const saved = await (await post(w, '/channels', l, { enabled: '1', mentions: '1', allowlist: CH })).text();
  assert.match(saved, /Channel settings saved/);
  assert.equal((await w.routing.get(U1)).channels.enabled, true);
  assert.deepEqual((await w.entry(U1).core.call('status', {})).changes[0].fields.sort(), ['channels.allowlist', 'channels.enabled']);
  const again = await login(w, { scope: BASE_SCOPE });
  assert.equal((await w.routing.get(U1)).scopes, undefined);
  assert.ok(again.html.includes('Channels'));
});

test('SECURITY: the API cannot turn channels on, nor edit the allowlist while channels are off', async () => {
  const { w, key } = await userWorld(CHANNEL_SCOPE);
  for (const body of [{ channels: { enabled: true } }, { channels: { enabled: true, allowlist: [CH] } }, { channels: { allowlist: [CH] } }]) {
    const res = await api(w, key, '/api/v1/settings', { method: 'PATCH', body });
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal((await w.routing.get(U1)).channels, undefined);
  }
  assert.equal((await api(w, key, '/api/v1/settings', { method: 'PATCH', body: { channels: { enabled: 'yes' } } })).status, 400);
  assert.equal((await api(w, key, '/api/v1/settings', { method: 'PATCH', body: { channels: { bogus: 1 } } })).status, 400);
  const ok = await api(w, key, '/api/v1/settings', { method: 'PATCH', body: { channels: { mentions: false } } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).channels, { enabled: false, mentions: false, allowlist: [] });
});

test('API: when a human has enabled channels the API can edit the allowlist and turn channels off, with validation and logging', async () => {
  const { w, l, key } = await userWorld(CHANNEL_SCOPE);
  await post(w, '/channels', l, { enabled: '1', mentions: '1', allowlist: CH });
  const patch = (body) => api(w, key, '/api/v1/settings', { method: 'PATCH', body });
  const set = await patch({ channels: { allowlist: [PRIV, CH.toLowerCase()] } });
  assert.equal(set.status, 200);
  const view = await set.json();
  assert.deepEqual(view.channels, { enabled: true, mentions: true, allowlist: [PRIV, CH] });
  assert.equal(view.channel_scopes_granted, true);
  assert.equal((await patch({ channels: { enabled: true } })).status, 200);
  assert.equal((await patch({ channels: { allowlist: ['D0123ABC'] } })).status, 400);
  assert.equal((await patch({ channels: { allowlist: 'C0123ABC' } })).status, 400);
  assert.equal((await patch({ channels: { allowlist: Array.from({ length: 11 }, (_, i) => `C0000${String.fromCharCode(65 + i)}AA`) } })).status, 400);
  const off = await patch({ channels: { enabled: false } });
  assert.equal((await off.json()).channels.enabled, false);
  assert.equal((await w.routing.get(U1)).channels.enabled, false);
  const status = await (await api(w, key, '/api/v1/status')).json();
  assert.ok(status.settings_changes.some((c) => c.via === 'api' && c.fields.includes('channels.enabled')));
  assert.ok(status.settings_changes.some((c) => c.via === 'api' && c.fields.includes('channels.allowlist')));
  assert.ok(CHANGE_FIELDS.includes('request:enable_channels'));
});

test('APPROVAL: enable_channels is a request; nothing changes until a human approves it on /connect', async () => {
  const { w, l, key } = await userWorld(CHANNEL_SCOPE);
  const propose = (body) => api(w, key, '/api/v1/requests', { method: 'POST', body });
  assert.equal((await propose({ type: 'enable_channels', user_ids: [U2] })).status, 400);
  assert.equal((await propose({ type: 'enable_channels', allowlist: ['D0123ABC'] })).status, 400);
  const made = await propose({ type: 'enable_channels', allowlist: [CH] });
  assert.equal(made.status, 201);
  const { id } = await made.json();
  assert.equal((await w.routing.get(U1)).channels, undefined);
  const page = await (await post(w, '/channels', l, { mentions: '1' })).text();
  assert.match(page, /Approve and turn channels on/);
  assert.match(page, /Forward Slack channel messages/);
  const approved = await (await post(w, '/requests/approve', l, { id })).text();
  assert.match(approved, /Request approved and applied/);
  assert.deepEqual((await w.routing.get(U1)).channels, { enabled: true, mentions: true, allowlist: [CH] });
  const status = await (await api(w, key, '/api/v1/status')).json();
  assert.deepEqual(status.settings_changes[0].fields, ['request:enable_channels']);
  assert.equal((await propose({ type: 'enable_channels' })).status, 409);
});

test('APPROVAL: rejecting leaves channels off; a request without the scopes is refused at proposal and at approval', async () => {
  const { w, l, key } = await userWorld(CHANNEL_SCOPE);
  const { id } = await (await api(w, key, '/api/v1/requests', { method: 'POST', body: { type: 'enable_channels' } })).json();
  assert.match(await (await post(w, '/requests/reject', l, { id })).text(), /Request rejected/);
  assert.equal((await w.routing.get(U1)).channels, undefined);

  const legacy = await userWorld(BASE_SCOPE);
  const res = await api(legacy.w, legacy.key, '/api/v1/requests', { method: 'POST', body: { type: 'enable_channels' } });
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /Re-authorize/);

  const pend = await api(w, key, '/api/v1/requests', { method: 'POST', body: { type: 'enable_channels', allowlist: [PRIV] } });
  const pid = (await pend.json()).id;
  const e = await w.routing.get(U1);
  const { scopes: _s, ...stripped } = e;
  await w.routing.put(U1, stripped);
  const html = await (await post(w, '/requests/approve', l, { id: pid })).text();
  assert.match(html, /Channels need extra Slack permissions/);
  assert.equal((await w.routing.get(U1)).channels, undefined);
  assert.equal((await w.entry(U1).core.call('reqList', {})).requests.find((r) => r.id === pid).status, 'pending');
});

test('PROMPTS: channel guidance appears only when channels are on, says the draft is for review, and never allows sending', () => {
  const off = buildPrompt({ type: 'cursor' });
  assert.equal(off, buildPrompt({ type: 'cursor', channels: { enabled: false, allowlist: [CH] } }));
  assert.doesNotMatch(off, /channel message/);
  for (const type of ['cursor', 'grok', 'claude_routine']) {
    const on = buildPrompt({ type, caps: { process: true, draft: true, send: true }, trusted: [U1], channels: { enabled: true } });
    assert.match(on, /channel message/);
    assert.match(on, /the draft is for me to review/);
    assert.match(on, /Never send or post for a channel message/);
  }
  assert.match(buildPrompt({ type: 'grok', channels: { enabled: true } }), /mentioned is true/);
});

test('channels never turn on through any path other than the browser form or an approved request', async () => {
  const { w, l, key } = await userWorld(CHANNEL_SCOPE);
  await post(w, '/caps', l, { process: '1', draft: '1' });
  await post(w, '/profile', l, { trusted_users: U2 });
  await post(w, '/filters', l, { skip_bots: '1' });
  await api(w, key, '/api/v1/settings', { method: 'PATCH', body: { voice: 'hi', caps: { draft: false }, trusted_users: [] } });
  assert.equal(effectiveChannels((await w.routing.get(U1)).channels).enabled, false);
});
