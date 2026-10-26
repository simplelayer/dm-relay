export function checkEnvelope(payload, { teamId, appId }) {
  return Boolean(payload) && payload.team_id === teamId && payload.api_app_id === appId;
}

export function filterMessageEvent(payload) {
  const ev = payload && payload.event;
  if (!ev || typeof ev !== 'object') return { forward: false, reason: 'no_event' };
  if (ev.type !== 'message') return { forward: false, reason: 'type' };
  if (ev.subtype !== undefined) return { forward: false, reason: 'subtype' };
  if (ev.bot_id !== undefined) return { forward: false, reason: 'bot' };
  if (ev.hidden === true) return { forward: false, reason: 'hidden' };
  if (typeof ev.user !== 'string' || ev.user === '' || ev.user === 'USLACKBOT') {
    return { forward: false, reason: 'user' };
  }
  if (ev.channel_type !== 'im' && ev.channel_type !== 'mpim') return { forward: false, reason: 'channel_type' };
  if (payload.is_ext_shared_channel === true || ev.is_ext_shared_channel === true) {
    return { forward: false, reason: 'external' };
  }
  for (const f of ['user_team', 'source_team']) {
    if (ev[f] !== undefined && ev[f] !== payload.team_id) return { forward: false, reason: 'external' };
  }
  if (typeof ev.channel !== 'string' || typeof ev.ts !== 'string') return { forward: false, reason: 'shape' };
  return { forward: true, reason: 'ok' };
}

export function buildForwardPayload(payload, nowMs) {
  const ev = payload.event;
  return {
    event_id: payload.event_id,
    received_at: new Date(nowMs).toISOString(),
    type: ev.channel_type === 'im' ? 'dm' : 'group_dm',
    channel_id: ev.channel,
    sender_id: ev.user,
    text: typeof ev.text === 'string' ? ev.text : '',
    ts: ev.ts,
    thread_ts: typeof ev.thread_ts === 'string' ? ev.thread_ts : null
  };
}
