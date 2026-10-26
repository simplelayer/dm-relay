import { FANOUT_MAX_PAGES, FANOUT_TIMEOUT_MS, SLACK_API } from './constants.js';

async function callOnce(body, appToken, fetchImpl) {
  const res = await fetchImpl(`${SLACK_API}/apps.event.authorizations.list`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS)
  });
  if (res.status !== 200) throw new Error('E_FANOUT_HTTP');
  const data = await res.json();
  if (!data || data.ok !== true || !Array.isArray(data.authorizations)) throw new Error('E_FANOUT_BODY');
  return data;
}

async function callWithRetry(body, appToken, fetchImpl) {
  try {
    return await callOnce(body, appToken, fetchImpl);
  } catch {
    return await callOnce(body, appToken, fetchImpl);
  }
}

export async function listAuthorizedUserIds({ eventContext, appToken, fetchImpl }) {
  const ids = [];
  let cursor;
  try {
    for (let page = 0; page < FANOUT_MAX_PAGES; page++) {
      const body = { event_context: eventContext, limit: 100 };
      if (cursor) body.cursor = cursor;
      const data = await callWithRetry(body, appToken, fetchImpl);
      for (const a of data.authorizations) {
        if (a && a.is_bot !== true && typeof a.user_id === 'string') ids.push(a.user_id);
      }
      cursor = data.response_metadata && data.response_metadata.next_cursor;
      if (!cursor) return { ok: true, ids };
    }
    return { ok: true, ids };
  } catch {
    return { ok: false, ids: [] };
  }
}

async function sampleRoutedIds(routing, cache, nowMs) {
  if (nowMs - cache.at < 60000) return cache.ids;
  cache.at = nowMs;
  try {
    cache.ids = await routing.listUpTo(2);
  } catch {
    cache.ids = null;
  }
  return cache.ids;
}

export async function resolveRecipients({ payload, routing, routedSample, nowMs, appToken, fetchImpl }) {
  const sender = payload.event.user;
  const candidates = new Set();
  for (const a of Array.isArray(payload.authorizations) ? payload.authorizations : []) {
    if (a && a.is_bot !== true && typeof a.user_id === 'string') candidates.add(a.user_id);
  }

  let degraded = false;
  const routed = await sampleRoutedIds(routing, routedSample, nowMs);
  const skipList = routed !== null && (routed.length === 0 || (routed.length === 1 && candidates.has(routed[0])));
  if (!skipList) {
    const listed = await listAuthorizedUserIds({ eventContext: payload.event_context, appToken, fetchImpl });
    if (listed.ok) for (const id of listed.ids) candidates.add(id);
    else degraded = true;
  }

  const recipients = [];
  for (const userId of candidates) {
    if (userId === sender) continue;
    const entry = await routing.get(userId);
    if (entry) recipients.push({ userId, entry });
  }
  return { recipients, degraded };
}
