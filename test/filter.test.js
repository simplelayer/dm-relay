import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildForwardPayload, checkEnvelope, filterMessageEvent } from '../src/filter.js';
import { APP, TEAM, U1, msgPayload } from './helpers.js';

const verdict = (extraEvent = {}, extra = {}) => filterMessageEvent(msgPayload({ extraEvent, extra }));

test('plain im and mpim messages are forwarded', () => {
  assert.equal(verdict().forward, true);
  assert.equal(filterMessageEvent(msgPayload({ channelType: 'mpim' })).forward, true);
});

test('thread replies are forwarded and keep thread_ts', () => {
  const p = msgPayload({ extraEvent: { thread_ts: '1799999999.000001' } });
  assert.equal(filterMessageEvent(p).forward, true);
  assert.equal(buildForwardPayload(p, 0).thread_ts, '1799999999.000001');
});

const DROPS = {
  file_share: { subtype: 'file_share', files: [{ id: 'F1' }] },
  message_changed: { subtype: 'message_changed', previous_message: { text: 'old' } },
  message_deleted: { subtype: 'message_deleted', previous_message: { text: 'deleted text' } },
  thread_broadcast: { subtype: 'thread_broadcast' },
  bot_message: { subtype: 'bot_message' },
  bot_id: { bot_id: 'B1' },
  hidden: { hidden: true },
  slackbot: { user: 'USLACKBOT' },
  no_user: { user: undefined },
  channel_type_channel: { channel_type: 'channel' },
  channel_type_group: { channel_type: 'group' },
  not_message: { type: 'reaction_added' },
  ext_shared_event: { is_ext_shared_channel: true },
  foreign_user_team: { user_team: 'T0OTHER' },
  foreign_source_team: { source_team: 'T0OTHER' }
};
for (const [name, extraEvent] of Object.entries(DROPS)) {
  test(`dropped: ${name}`, () => {
    assert.equal(verdict(extraEvent).forward, false);
  });
}

test('dropped: top-level is_ext_shared_channel', () => {
  assert.equal(verdict({}, { is_ext_shared_channel: true }).forward, false);
});

test('matching user_team and source_team are accepted', () => {
  assert.equal(verdict({ user_team: TEAM, source_team: TEAM }).forward, true);
});

test('missing event is dropped', () => {
  assert.equal(filterMessageEvent({}).forward, false);
  assert.equal(filterMessageEvent(null).forward, false);
});

test('forward payload has exactly the specified fields and never previous_message', () => {
  const p = msgPayload({ sender: U1, channel: 'G0GROUP', channelType: 'mpim', extraEvent: { previous_message: { text: 'leak' } } });
  const out = buildForwardPayload(p, Date.UTC(2026, 9, 1));
  assert.deepEqual(Object.keys(out).sort(), ['channel_id', 'event_id', 'received_at', 'sender_id', 'text', 'thread_ts', 'ts', 'type']);
  assert.equal(out.type, 'group_dm');
  assert.equal(out.received_at, '2026-10-01T00:00:00.000Z');
  assert.equal(JSON.stringify(out).includes('leak'), false);
  assert.equal(buildForwardPayload(msgPayload(), 0).type, 'dm');
});

test('team_id and api_app_id envelope check', () => {
  const c = { teamId: TEAM, appId: APP };
  assert.equal(checkEnvelope({ team_id: TEAM, api_app_id: APP }, c), true);
  assert.equal(checkEnvelope({ team_id: 'T0X', api_app_id: APP }, c), false);
  assert.equal(checkEnvelope({ team_id: TEAM, api_app_id: 'A0X' }, c), false);
  assert.equal(checkEnvelope({}, c), false);
});
