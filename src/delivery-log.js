const DEST_LABELS = { cursor: 'cursor', grok: 'grok', claude_routine: 'claude', claude: 'claude' };
const ERROR_CLASSES = new Set(['network', 'invalid']);
const OUTCOME = /^(ok|timeout|http_[1-5][0-9]{2}|error_(network|invalid|other))$/;

export function destLabel(destType) {
  return DEST_LABELS[destType] ?? null;
}

export function outcomeLabel(result) {
  const kind = result && result.kind;
  if (kind === 'ok') return 'ok';
  if (kind === 'timeout') return 'timeout';
  const status = result && result.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `http_${status}`;
  return `error_${ERROR_CLASSES.has(kind) ? kind : 'other'}`;
}

export function sanitizeDelivery({ dest, outcome, test }, nowMs) {
  const d = destLabel(dest);
  if (d === null || typeof outcome !== 'string' || !OUTCOME.test(outcome)) return null;
  const entry = { t: nowMs, d, o: outcome };
  if (test === true) entry.test = true;
  return entry;
}
