import { CHANNEL_ALLOWLIST_MAX, OPTIONAL_CHANNEL_SCOPES, SEND_WORD, TRUSTED_MAX, VOICE_MAX } from './constants.js';
import { isChannelId, isUserId } from './routes.js';

const VOICE_STRIP = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const CHANNEL_ID_ERROR = 'Slack channel IDs look like C01ABCDEF2 or G01ABCDEF2 (letters and digits, starting with C or G).';
export const CHANNEL_SCOPE_ERROR = `Channels need extra Slack permissions (${OPTIONAL_CHANNEL_SCOPES.join(' and ')}). Re-authorize at /connect?channels=1 first. Nothing was saved and channels are still off.`;
const ID_ERROR = 'Slack user IDs look like U01ABCDEF2 (letters and digits, starting with U or W).';

export function effectiveCaps(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return { process: c.process !== false, draft: c.draft !== false, send: c.send === true };
}

export function effectiveTrusted(raw) {
  return Array.isArray(raw) ? raw.filter(isUserId).slice(0, TRUSTED_MAX) : [];
}

export function effectiveChannels(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled === true,
    mentions: c.mentions !== false,
    allowlist: Array.isArray(c.allowlist) ? c.allowlist.filter(isChannelId).slice(0, CHANNEL_ALLOWLIST_MAX) : []
  };
}

export function hasChannelScopes(scopes) {
  return Array.isArray(scopes) && OPTIONAL_CHANNEL_SCOPES.every((s) => scopes.includes(s));
}

export function effectiveVoice(raw) {
  return typeof raw === 'string' ? raw : '';
}

export function splitIds(text) {
  return String(text || '').split(/[\s,;]+/);
}

export function normalizeIds(parts, max) {
  const ids = [];
  for (const part of parts) {
    if (typeof part !== 'string') return { error: ID_ERROR };
    const id = part.trim().toUpperCase();
    if (id === '') continue;
    if (!isUserId(id)) return { error: ID_ERROR };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > max) return { error: `At most ${max} user IDs.` };
  return { ids };
}

export function normalizeChannelIds(parts, max = CHANNEL_ALLOWLIST_MAX) {
  const ids = [];
  for (const part of parts) {
    if (typeof part !== 'string') return { error: CHANNEL_ID_ERROR };
    const id = part.trim().toUpperCase();
    if (id === '') continue;
    if (!isChannelId(id)) return { error: CHANNEL_ID_ERROR };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > max) return { error: `At most ${max} channel IDs.` };
  return { ids };
}

export function cleanVoice(value) {
  if (typeof value !== 'string') return { error: 'Voice must be text.' };
  const voice = value.replace(/\r\n?/g, '\n').replace(VOICE_STRIP, '').trim();
  if ([...voice].length > VOICE_MAX) return { error: `Voice can be at most ${VOICE_MAX} characters.` };
  return { voice };
}

export function parseCapsForm(form, current) {
  const was = effectiveCaps(current);
  const caps = { process: form.get('process') === '1', draft: form.get('draft') === '1', send: form.get('send') === '1' };
  if (caps.send && !was.send && (form.get('confirm_send') !== '1' || form.get('send_word') !== SEND_WORD)) {
    return { error: `To turn send on, tick the confirmation box and type ${SEND_WORD} in capital letters. Nothing was saved and send is still off.` };
  }
  return { caps };
}

export function parseProfileForm(form) {
  const out = {};
  if (form.has('trusted_users') || !form.has('voice')) {
    const t = normalizeIds(splitIds(form.get('trusted_users')), TRUSTED_MAX);
    if (t.error) return { error: t.error };
    out.trusted_users = t.ids;
  }
  if (form.has('voice') || !form.has('trusted_users')) {
    const v = cleanVoice(form.get('voice') || '');
    if (v.error) return { error: v.error };
    out.voice = v.voice;
  }
  return out;
}

export function parseChannelsForm(form, route) {
  const was = effectiveChannels(route.channels);
  const a = normalizeChannelIds(splitIds(form.get('allowlist')));
  if (a.error) return { error: a.error };
  const channels = { enabled: form.get('enabled') === '1', mentions: form.get('mentions') === '1', allowlist: a.ids };
  if (channels.enabled && !was.enabled && !hasChannelScopes(route.scopes)) return { error: CHANNEL_SCOPE_ERROR };
  return { channels };
}
