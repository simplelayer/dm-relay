import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDestinationUrl } from '../src/ssrf.js';
import { CURSOR_URL } from './helpers.js';

const own = { ownHosts: ['relay.example.net', 'mine.workers.dev'], ownSuffixes: ['.operator-zone.com'] };
const cursor = (u) => validateDestinationUrl(u, { type: 'cursor', ...own });
const UUID = '123e4567-e89b-12d3-a456-426614174000';
const P = `/automations/webhook/${UUID}`;

test('valid cursor urls', () => {
  assert.equal(cursor(CURSOR_URL).ok, true);
  assert.equal(cursor(`https://API2.CURSOR.SH${P}`).ok, true);
  assert.equal(cursor(`https://api2.cursor.sh:443${P}`).ok, true);
  assert.equal(cursor(`https://api2.cursor.sh/automations/webhook/${UUID.toUpperCase()}`).ok, true);
  assert.equal(cursor(CURSOR_URL).url.href, CURSOR_URL);
});

const BAD = {
  http: `http://api2.cursor.sh${P}`,
  nonDefaultPort: `https://api2.cursor.sh:8443${P}`,
  port80: `https://api2.cursor.sh:80${P}`,
  userinfo: `https://user:pw@api2.cursor.sh${P}`,
  userinfoOnly: `https://user@api2.cursor.sh${P}`,
  trickyUserinfo: `https://api2.cursor.sh@evil.com${P}`,
  trickyUserinfo2: `https://evil.com@api2.cursor.sh${P}`,
  trailingDot: `https://api2.cursor.sh.${P}`,
  ideographicDot: `https://api2.cursor.sh。${P}`,
  lookalikeSuffix: `https://api2.cursor.sh.evil.com${P}`,
  lookalikePrefix: `https://evilapi2.cursor.sh${P}`,
  lookalikeSub: `https://x.api2.cursor.sh${P}`,
  lookalikeDash: `https://api2-cursor.sh${P}`,
  bareCursor: `https://cursor.sh${P}`,
  apiCursor: `https://api.cursor.sh${P}`,
  api3: `https://api3.cursor.sh${P}`,
  wwwCursor: `https://www.cursor.sh${P}`,
  cursorCom: `https://api2.cursor.com${P}`,
  encodedHostDot: `https://api2.cursor%2Esh${P}`,
  encodedHostLetter: `https://api2.cursor.s%68${P}`,
  encodedAt: `https://api2.cursor.sh%40evil.com${P}`,
  extraSegment: `${CURSOR_URL}/extra`,
  trailingSlash: `${CURSOR_URL}/`,
  prefixSegment: `https://api2.cursor.sh/x${P}`,
  missingUuid: 'https://api2.cursor.sh/automations/webhook/',
  shortUuid: 'https://api2.cursor.sh/automations/webhook/123e4567-e89b-12d3-a456-42661417400',
  longUuid: `${CURSOR_URL}0`,
  nonHexUuid: 'https://api2.cursor.sh/automations/webhook/123e4567-e89b-12d3-a456-42661417400g',
  noDashes: 'https://api2.cursor.sh/automations/webhook/123e4567e89b12d3a456426614174000',
  wrongPrefix: `https://api2.cursor.sh/automation/webhook/${UUID}`,
  upperPath: `https://api2.cursor.sh/Automations/webhook/${UUID}`,
  query: `${CURSOR_URL}?a=1`,
  emptyQuery: `${CURSOR_URL}?`,
  fragment: `${CURSOR_URL}#x`,
  emptyFragment: `${CURSOR_URL}#`,
  encodedSlash: `https://api2.cursor.sh/automations%2Fwebhook/${UUID}`,
  encodedUuid: `https://api2.cursor.sh/automations/webhook/%31%32%33e4567-e89b-12d3-a456-426614174000`,
  dotSegment: `https://api2.cursor.sh/automations/./webhook/${UUID}`,
  dotDotSegment: `https://api2.cursor.sh/automations/x/../webhook/${UUID}`,
  encodedDotDot: `https://api2.cursor.sh/automations/%2e%2e/automations/webhook/${UUID}`,
  doubleSlash: `https://api2.cursor.sh//automations/webhook/${UUID}`,
  semicolon: `${CURSOR_URL};x=1`,
  backslash: `https://api2.cursor.sh\@evil.com${P}`,
  backslashPath: `https://api2.cursor.sh\automations\webhook\${UUID}`,
  space: `${CURSOR_URL} `,
  newline: `${CURSOR_URL}\n`,
  tab: `https://api2.cursor.sh/auto\tmations/webhook/${UUID}`,
  ipv4: `https://1.2.3.4${P}`,
  ipv4Decimal: `https://2130706433${P}`,
  ipv6: `https://[::1]${P}`,
  localhost: `https://localhost${P}`,
  ownHost: `https://relay.example.net${P}`,
  noPath: 'https://api2.cursor.sh',
  rootPath: 'https://api2.cursor.sh/',
  tooLong: `https://api2.cursor.sh/${'a'.repeat(2100)}`,
  notString: 12345,
  empty: ''
};
assert.ok(Object.keys(BAD).length >= 25);
for (const [name, url] of Object.entries(BAD)) {
  test(`cursor rejected: ${name}`, () => {
    const r = cursor(url);
    assert.equal(r.ok, false, `${url}`.slice(0, 90));
    assert.equal(typeof r.reason, 'string');
  });
}

test('cursor rejection reason codes', () => {
  assert.equal(cursor(`https://api.cursor.sh${P}`).reason, 'cursor_host');
  assert.equal(cursor(`${CURSOR_URL}?a=1`).reason, 'cursor_path');
  assert.equal(cursor(`${CURSOR_URL}/x`).reason, 'cursor_path');
  assert.equal(cursor(`https://api2.cursor.sh.${P}`).reason, 'trailing_dot');
});

test('a cursor url is not valid for the other types and vice versa', () => {
  assert.equal(validateDestinationUrl(CURSOR_URL, { type: 'grok', ...own }).ok, false);
  assert.equal(validateDestinationUrl(CURSOR_URL, { type: 'claude_routine', ...own }).ok, false);
  assert.equal(cursor('https://hooks.x.ai/webhook/abc123').ok, false);
});

test('cursor host is never accepted when it is the relay own host', () => {
  const r = validateDestinationUrl(CURSOR_URL, { type: 'cursor', ownHosts: ['api2.cursor.sh'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'own_host');
});
