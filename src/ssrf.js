import {
  CLAUDE_FIRE_PATH,
  CLAUDE_HOST,
  GROK_HOST_PATTERN,
  MAX_URL_LENGTH,
  OPERATOR_HOST_SUFFIXES
} from './constants.js';

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost'];

function fail(reason) {
  return { ok: false, reason };
}

function matchesOwnHost(host, ownHosts, suffixes) {
  for (const h of ownHosts) {
    if (host === h) return true;
  }
  for (const s of suffixes) {
    const suffix = s.startsWith('.') ? s : `.${s}`;
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  return false;
}

export function parseOwnHosts(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function validateDestinationUrl(input, { type, ownHosts = [], ownSuffixes = OPERATOR_HOST_SUFFIXES, grokHostPattern = GROK_HOST_PATTERN } = {}) {
  if (typeof input !== 'string' || input.length === 0) return fail('empty');
  if (input.length > MAX_URL_LENGTH) return fail('too_long');
  if (!/^https:\/\//i.test(input)) return fail('scheme');
  if (/[\s\\\u0000-\u001f\u007f]/.test(input)) return fail('chars');
  let url;
  try {
    url = new URL(input);
  } catch {
    return fail('parse');
  }
  if (url.protocol !== 'https:') return fail('scheme');
  if (url.username !== '' || url.password !== '') return fail('userinfo');
  if (url.port !== '') return fail('port');
  if (/^https:\/\/[^/?#]*@/i.test(input)) return fail('userinfo');

  if (url.hostname.endsWith('.')) return fail('trailing_dot');
  const host = url.hostname.toLowerCase();
  if (host === '' || host.startsWith('[') || host.includes(':')) return fail('ip_literal');
  if (/^\d+(\.\d+){0,3}$/.test(host)) return fail('ip_literal');
  const labels = host.split('.');
  const last = labels[labels.length - 1];
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last)) return fail('ip_literal');
  if (labels.some((l) => /^0x[0-9a-f]+$/i.test(l)) && labels.every((l) => /^(0x[0-9a-f]+|\d+)$/i.test(l))) {
    return fail('ip_literal');
  }
  if (labels.length < 2) return fail('single_label');
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return fail('blocked_host');
  if (matchesOwnHost(host, ownHosts, ownSuffixes)) return fail('own_host');

  if (type === 'claude_routine') {
    if (host !== CLAUDE_HOST) return fail('claude_host');
    if (!CLAUDE_FIRE_PATH.test(url.pathname) || url.search !== '' || url.hash !== '') return fail('claude_path');
  } else if (type === 'grok') {
    if (!grokHostPattern.test(host)) return fail('grok_host');
  } else {
    return fail('type');
  }
  return { ok: true, url };
}
