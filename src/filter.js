import { FILTER_KEYWORD_MAX_LENGTH, FILTER_MAX_KEYWORDS, FILTER_MAX_USERS } from './constants.js';
import { effectiveCaps, effectiveTrusted, normalizeIds, splitIds } from './caps.js';
import { isUserId } from './routes.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function checkEnvelope(payload, { teamId, appId }) {
  return Boolean(payload) && payload.team_id === teamId && payload.api_app_id === appId;
}

export function filterMessageEvent(payload, { allowBots = false } = {}) {
  const ev = payload && payload.event;
  if (!ev || typeof ev !== 'object') return { forward: false, reason: 'no_event' };
  if (ev.type !== 'message') return { forward: false, reason: 'type' };
  if (ev.subtype !== undefined) return { forward: false, reason: 'subtype' };
  if (ev.bot_id !== undefined && !allowBots) return { forward: false, reason: 'bot' };
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

export function buildForwardPayload(payload, nowMs, entry = {}) {
  const ev = payload.event;
  return {
    event_id: payload.event_id,
    received_at: new Date(nowMs).toISOString(),
    type: ev.channel_type === 'im' ? 'dm' : 'group_dm',
    channel_id: ev.channel,
    sender_id: ev.user,
    text: typeof ev.text === 'string' ? ev.text : '',
    ts: ev.ts,
    thread_ts: typeof ev.thread_ts === 'string' ? ev.thread_ts : null,
    mode: effectiveCaps(entry.caps),
    sender_trusted: effectiveTrusted(entry.trusted_users).includes(ev.user)
  };
}

export function effectiveFilters(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    skip_bots: f.skip_bots !== false,
    skip_users: Array.isArray(f.skip_users) ? f.skip_users.filter(isUserId) : [],
    keywords: Array.isArray(f.keywords) ? f.keywords.filter((k) => typeof k === 'string' && k !== '') : []
  };
}

export function applyUserFilters(ev, rawFilters) {
  const f = effectiveFilters(rawFilters);
  if (f.skip_bots && ev.bot_id !== undefined) return { forward: false, reason: 'bot' };
  if (f.skip_users.includes(ev.user)) return { forward: false, reason: 'sender' };
  if (f.keywords.length > 0 && typeof ev.text === 'string') {
    const text = ev.text.toLowerCase();
    if (f.keywords.some((k) => text.includes(k.toLowerCase()))) return { forward: false, reason: 'keyword' };
  }
  return { forward: true, reason: 'ok' };
}

export function validateFilters({ skip_bots, skip_users, keywords: rawKeywords }) {
  const u = normalizeIds(skip_users, FILTER_MAX_USERS);
  if (u.error) return { error: u.error };

  const keywords = [];
  const seen = new Set();
  for (const line of rawKeywords) {
    if (typeof line !== 'string') return { error: 'Keywords must be text.' };
    const k = line.replace(CONTROL_CHARS, '').trim();
    if (k === '') continue;
    if ([...k].length > FILTER_KEYWORD_MAX_LENGTH) return { error: `Each keyword can be at most ${FILTER_KEYWORD_MAX_LENGTH} characters.` };
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(k);
  }
  if (keywords.length > FILTER_MAX_KEYWORDS) return { error: `At most ${FILTER_MAX_KEYWORDS} keywords.` };

  return { filters: { skip_bots: skip_bots === true, skip_users: u.ids, keywords } };
}

export function parseFilterForm(form) {
  return validateFilters({
    skip_bots: form.get('skip_bots') === '1',
    skip_users: splitIds(form.get('skip_users')),
    keywords: String(form.get('keywords') || '').split(/\r?\n/)
  });
}
