import { destLabel, outcomeLabel } from './delivery-log.js';
import { fireTest } from './destinations.js';
import { effectiveCaps, effectiveChannels, effectiveTrusted, effectiveVoice } from './caps.js';
import { effectiveFilters } from './filter.js';

export function describeDestination(route, labels) {
  if (!route) return null;
  let host = '';
  try {
    host = new URL(route.url).hostname;
  } catch {
    host = '';
  }
  return { type: destLabel(route.dest_type), label: labels[route.dest_type] || 'Destination', host };
}

export function changedFields(route, next) {
  const out = [];
  if (next.caps) {
    const was = effectiveCaps(route.caps);
    for (const k of ['process', 'draft', 'send']) if (was[k] !== next.caps[k]) out.push(`caps.${k}`);
  }
  const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  if (next.filters && differs(effectiveFilters(route.filters), effectiveFilters(next.filters))) out.push('filters');
  if (next.trusted_users && differs(effectiveTrusted(route.trusted_users), next.trusted_users)) out.push('trusted_users');
  if (typeof next.voice === 'string' && effectiveVoice(route.voice) !== next.voice) out.push('voice');
  if (next.channels) {
    const was = effectiveChannels(route.channels);
    const now = effectiveChannels(next.channels);
    for (const k of ['enabled', 'mentions', 'allowlist']) if (differs(was[k], now[k])) out.push(`channels.${k}`);
  }
  return out;
}

export async function saveSettings(deps, userId, route, next, via) {
  const fields = changedFields(route, next);
  const entry = { ...route };
  if (next.caps) entry.caps = effectiveCaps(next.caps);
  if (next.filters) entry.filters = effectiveFilters(next.filters);
  if (next.trusted_users) entry.trusted_users = next.trusted_users;
  if (typeof next.voice === 'string') entry.voice = next.voice;
  if (next.channels) entry.channels = effectiveChannels(next.channels);
  await deps.routing.put(userId, entry);
  if (fields.length > 0) await deps.userDo(userId).logChange({ via, fields });
  return { entry, fields };
}

export function summaryFrom(st, route, labels) {
  const dest = describeDestination(route, labels);
  return {
    connected: Boolean(route) && !st.disconnected,
    destinations: dest ? [dest] : [],
    lastDelivery: st.deliveries.find((d) => !d.test) || null,
    last24h: st.last24h,
    filtered: st.filtered,
    deliveries: st.deliveries,
    changes: st.changes || [],
    hourly: st.hourly || [],
    pendingRequests: st.pending_requests || 0
  };
}

export async function runTestFire(deps, userId) {
  if (!(await deps.userDo(userId).consumeLimit({ name: 'test' })).allowed) return { limited: true };
  const route = await deps.routing.get(userId);
  if (!route) return { noRoute: true };
  const result = await fireTest({ entry: route, userId, fetchImpl: deps.fetchImpl, now: deps.now, validateOpts: deps.validateOpts });
  const outcome = outcomeLabel(result);
  await deps.userDo(userId).recordDelivery({ dest: destLabel(route.dest_type), outcome, test: true });
  return { ok: result.kind === 'ok', outcome, status: result.status ?? null };
}
