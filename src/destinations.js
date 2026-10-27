import {
  ANTHROPIC_VERSION,
  CLAUDE_ROUTINE_BETA_HEADER,
  CURSOR_TOKEN_MAX_LENGTH,
  CURSOR_TOKEN_MIN_LENGTH,
  CURSOR_TOKEN_PATTERN,
  FORWARD_TIMEOUT_MS,
  MIN_RETRY_BUDGET_MS,
  NUDGE_TEXT_TEMPLATE,
  VERIFY_TEXT
} from './constants.js';
import { effectiveCaps } from './caps.js';
import { buildHeaders, randomMessageId } from './standard-webhooks.js';
import { validateDestinationUrl } from './ssrf.js';
import { isTimeoutError, randomBase64Url, utf8 } from './util.js';

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* body is never read */
  }
}

async function send(url, init, fetchImpl, timeoutMs) {
  try {
    const res = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const status = res.status;
    await discard(res);
    if (status >= 200 && status < 300) return { kind: 'ok', status };
    if (status >= 300 && status < 400) return { kind: 'redirect', status };
    if (status === 429) return { kind: 'rate_limited', status };
    return { kind: 'http_error', status };
  } catch (err) {
    return { kind: isTimeoutError(err) ? 'timeout' : 'network' };
  }
}

export function isRetryable(result) {
  if (result.kind === 'timeout' || result.kind === 'network' || result.kind === 'rate_limited') return true;
  return result.kind === 'http_error' && (result.status >= 500 || result.status === 408);
}

export function isDefiniteFailure(result) {
  return result.kind === 'http_error' && (result.status >= 500 || (result.status >= 400 && result.status !== 429));
}

export function nudgeText(channelId, ts) {
  if (typeof channelId !== 'string' || !/^[A-Z0-9]{1,32}$/.test(channelId)) return null;
  if (typeof ts !== 'string' || !/^\d{1,12}\.\d{1,10}$/.test(ts)) return null;
  return NUDGE_TEXT_TEMPLATE.replace('{C}', channelId).replace('{T}', ts);
}

async function sendGrokOnce({ entry, bodyBytes, webhookId, nowMs, fetchImpl, timeoutMs, validateOpts }) {
  const v = validateDestinationUrl(entry.url, { ...validateOpts, type: 'grok' });
  if (!v.ok) return { kind: 'invalid' };
  let headers;
  try {
    headers = await buildHeaders({
      secret: entry.secret_or_bearer,
      id: webhookId,
      timestampSeconds: nowMs / 1000,
      bodyBytes
    });
  } catch {
    return { kind: 'invalid' };
  }
  return send(v.url.href, { method: 'POST', headers, body: bodyBytes }, fetchImpl, timeoutMs);
}

async function forwardWithRetry(sendAttempt, { now, deadlineMs, retryable = isRetryable }) {
  let result = { kind: 'timeout' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadlineMs - now();
    if (attempt === 1 && remaining < MIN_RETRY_BUDGET_MS) break;
    if (attempt === 0 && remaining <= 0) return { kind: 'timeout', attempts: 0 };
    const timeoutMs = Math.min(FORWARD_TIMEOUT_MS, remaining);
    result = await sendAttempt(timeoutMs);
    result.attempts = attempt + 1;
    if (result.kind === 'ok' || !retryable(result)) break;
  }
  return result;
}

export async function forwardGrok({ entry, forwardPayload, recipientId, fetchImpl, now, deadlineMs, validateOpts }) {
  const bodyBytes = utf8(JSON.stringify(forwardPayload));
  const webhookId = `${forwardPayload.event_id}_${recipientId}`;
  return forwardWithRetry(
    (timeoutMs) => sendGrokOnce({ entry, bodyBytes, webhookId, nowMs: now(), fetchImpl, timeoutMs, validateOpts }),
    { now, deadlineMs }
  );
}

export async function verifyGrok({ entry, fetchImpl, now, validateOpts }) {
  const nowMs = now();
  const body = {
    type: 'relay.verification',
    event_id: `evt_verify_${randomBase64Url(12)}`,
    received_at: new Date(nowMs).toISOString()
  };
  return sendGrokOnce({
    entry,
    bodyBytes: utf8(JSON.stringify(body)),
    webhookId: randomMessageId(),
    nowMs,
    fetchImpl,
    timeoutMs: FORWARD_TIMEOUT_MS,
    validateOpts
  });
}

async function fireRoutine({ entry, text, fetchImpl, validateOpts }) {
  const v = validateDestinationUrl(entry.url, { ...validateOpts, type: 'claude_routine' });
  if (!v.ok || typeof entry.secret_or_bearer !== 'string' || entry.secret_or_bearer === '') return { kind: 'invalid' };
  const headers = {
    authorization: `Bearer ${entry.secret_or_bearer}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': CLAUDE_ROUTINE_BETA_HEADER,
    'content-type': 'application/json'
  };
  return send(v.url.href, { method: 'POST', headers, body: JSON.stringify({ text }) }, fetchImpl, FORWARD_TIMEOUT_MS);
}

export async function fireNudge({ entry, channelId, ts, fetchImpl, validateOpts }) {
  const text = nudgeText(channelId, ts);
  if (text === null) return { kind: 'invalid' };
  return fireRoutine({ entry, text, fetchImpl, validateOpts });
}

export async function verifyClaude({ entry, fetchImpl, validateOpts }) {
  return fireRoutine({ entry, text: VERIFY_TEXT, fetchImpl, validateOpts });
}

export function isValidCursorToken(token) {
  return (
    typeof token === 'string' &&
    token.length >= CURSOR_TOKEN_MIN_LENGTH &&
    token.length <= CURSOR_TOKEN_MAX_LENGTH &&
    CURSOR_TOKEN_PATTERN.test(token)
  );
}

async function sendCursorOnce({ entry, bodyBytes, fetchImpl, timeoutMs, validateOpts }) {
  const v = validateDestinationUrl(entry.url, { ...validateOpts, type: 'cursor' });
  if (!v.ok || !isValidCursorToken(entry.secret_or_bearer)) return { kind: 'invalid' };
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${entry.secret_or_bearer}`
  };
  return send(v.url.href, { method: 'POST', headers, body: bodyBytes }, fetchImpl, timeoutMs);
}

const cursorRetryable = (r) =>
  r.kind === 'rate_limited' || (r.kind === 'http_error' && (r.status === 408 || r.status === 503));

export async function forwardCursor({ entry, forwardPayload, fetchImpl, now, deadlineMs, validateOpts }) {
  const bodyBytes = utf8(JSON.stringify(forwardPayload));
  return forwardWithRetry((timeoutMs) => sendCursorOnce({ entry, bodyBytes, fetchImpl, timeoutMs, validateOpts }), {
    now,
    deadlineMs,
    retryable: cursorRetryable
  });
}

export async function verifyCursor({ entry, fetchImpl, now, validateOpts }) {
  const nowMs = now();
  const body = {
    type: 'relay.verification',
    event_id: `evt_verify_${randomBase64Url(12)}`,
    received_at: new Date(nowMs).toISOString(),
    text: VERIFY_TEXT
  };
  return sendCursorOnce({ entry, bodyBytes: utf8(JSON.stringify(body)), fetchImpl, timeoutMs: FORWARD_TIMEOUT_MS, validateOpts });
}

export async function fireTest({ entry, userId, fetchImpl, now, validateOpts }) {
  if (entry.dest_type === 'claude_routine') return verifyClaude({ entry, fetchImpl, validateOpts });
  const nowMs = now();
  const forwardPayload = {
    event_id: `evt_test_${randomBase64Url(12)}`,
    received_at: new Date(nowMs).toISOString(),
    type: 'dm',
    channel_id: 'DTESTCONN',
    sender_id: 'UTESTCONN',
    text: VERIFY_TEXT,
    ts: `${Math.floor(nowMs / 1000)}.000000`,
    thread_ts: null,
    mode: effectiveCaps(entry.caps),
    sender_trusted: false,
    relay_test: true
  };
  const bodyBytes = utf8(JSON.stringify(forwardPayload));
  if (entry.dest_type === 'cursor') return sendCursorOnce({ entry, bodyBytes, fetchImpl, timeoutMs: FORWARD_TIMEOUT_MS, validateOpts });
  if (entry.dest_type === 'grok') {
    return sendGrokOnce({
      entry,
      bodyBytes,
      webhookId: `${forwardPayload.event_id}_${userId}`,
      nowMs,
      fetchImpl,
      timeoutMs: FORWARD_TIMEOUT_MS,
      validateOpts
    });
  }
  return { kind: 'invalid' };
}
