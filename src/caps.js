import { SEND_WORD, TRUSTED_MAX, VOICE_MAX } from './constants.js';
import { isUserId } from './routes.js';

const VOICE_STRIP = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const ID_ERROR = 'Slack user IDs look like U01ABCDEF2 (letters and digits, starting with U or W).';

export function effectiveCaps(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return { process: c.process !== false, draft: c.draft !== false, send: c.send === true };
}

export function effectiveTrusted(raw) {
  return Array.isArray(raw) ? raw.filter(isUserId).slice(0, TRUSTED_MAX) : [];
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
