import { REQUEST_TRUSTED_MAX, REQUEST_TYPES } from './constants.js';
import { normalizeIds } from './caps.js';
import { isValidCursorToken } from './destinations.js';
import { isValidSecret } from './standard-webhooks.js';
import { validateDestinationUrl } from './ssrf.js';
import { randomBase64Url } from './util.js';

export const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
export const DEST_TYPES = ['grok', 'cursor', 'claude_routine'];
export const DEST_NAMES = { grok: 'Grok automation webhook', cursor: 'Cursor automation webhook', claude_routine: 'Claude routine' };

export const newRequestId = () => randomBase64Url(16);

export function checkDestinationInput({ destType, url, secret }, validateOpts) {
  const v = validateDestinationUrl(String(url || '').trim(), { type: destType, ...validateOpts });
  if (!v.ok) return { error: 'That URL is not allowed.' };
  const s = String(secret || '').trim();
  if (destType === 'grok' && !isValidSecret(s)) return { error: 'The signing secret must start with whsec_ and be valid base64.' };
  if (destType === 'claude_routine' && s === '') return { error: 'A bearer token is required.' };
  if (destType === 'cursor' && !isValidCursorToken(s)) {
    return { error: 'The bearer token must start with crsr_ and contain only letters, digits, hyphens and underscores (20 to 200 characters).' };
  }
  return { ok: true, url: v.url.href, secret: s };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const FIELDS = { destination: ['type', 'dest_type', 'url', 'secret'], enable_send: ['type'], add_trusted: ['type', 'user_ids'] };

export function parseRequestBody(body, validateOpts) {
  if (!isObject(body)) return { error: 'The body must be a JSON object.' };
  if (!REQUEST_TYPES.includes(body.type)) return { error: 'type must be destination, enable_send or add_trusted.' };
  const unknown = Object.keys(body).find((k) => !FIELDS[body.type].includes(k));
  if (unknown !== undefined) return { error: `Unknown field: ${unknown.slice(0, 40)}` };
  if (body.type === 'enable_send') {
    return { type: 'enable_send', payload: {}, detail: {}, summary: 'Allow your assistant to send replies on your behalf (turn Send on).' };
  }
  if (body.type === 'add_trusted') {
    if (!Array.isArray(body.user_ids) || body.user_ids.length === 0) return { error: 'user_ids must be a non-empty array.' };
    if (body.user_ids.length > REQUEST_TRUSTED_MAX) return { error: `At most ${REQUEST_TRUSTED_MAX} user IDs per request.` };
    const t = normalizeIds(body.user_ids, REQUEST_TRUSTED_MAX);
    if (t.error) return { error: t.error };
    if (t.ids.length === 0) return { error: 'user_ids must be a non-empty array.' };
    return { type: 'add_trusted', payload: { user_ids: t.ids }, detail: { user_ids: t.ids }, summary: `Add trusted senders: ${t.ids.join(', ')}` };
  }
  if (!DEST_TYPES.includes(body.dest_type)) return { error: 'dest_type must be grok, cursor or claude_routine.' };
  if (typeof body.url !== 'string' || typeof body.secret !== 'string') return { error: 'url and secret must be strings.' };
  const checked = checkDestinationInput({ destType: body.dest_type, url: body.url, secret: body.secret }, validateOpts);
  if (checked.error) return { error: checked.error };
  const host = new URL(checked.url).hostname;
  return {
    type: 'destination',
    payload: { dest_type: body.dest_type, url: checked.url, secret: checked.secret },
    detail: { dest_type: body.dest_type, host },
    summary: `Save a ${DEST_NAMES[body.dest_type]} destination at ${host}`
  };
}
