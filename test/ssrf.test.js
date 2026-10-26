import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDestinationUrl } from '../src/ssrf.js';
import { ROUTINE_URL, makeWorld, respond, GROK_SECRET, GROK_URL, U1, U2, msgPayload } from './helpers.js';

const own = { ownHosts: ['relay.example.net', 'mine.workers.dev'], ownSuffixes: ['.operator-zone.com'] };
const grok = (u, o = {}) => validateDestinationUrl(u, { type: 'grok', ...own, ...o });
const claude = (u) => validateDestinationUrl(u, { type: 'claude_routine', ...own });

test('valid grok and claude urls', () => {
  assert.equal(grok(GROK_URL).ok, true);
  assert.equal(grok('https://a.b.x.ai/path?x=1').ok, true);
  assert.equal(grok('https://hooks.x.ai:443/p').ok, true);
  assert.equal(claude(ROUTINE_URL).ok, true);
});

const BAD = {
  http: 'http://hooks.x.ai/a',
  ftp: 'ftp://hooks.x.ai/a',
  nonDefaultPort: 'https://hooks.x.ai:8443/a',
  userinfo: 'https://user:pw@hooks.x.ai/a',
  userinfoOnly: 'https://user@hooks.x.ai/a',
  trickyUserinfo: 'https://hooks.x.ai@evil.com/a',
  ipv4: 'https://1.2.3.4/a',
  ipv4Loopback: 'https://127.0.0.1/a',
  ipv4Decimal: 'https://2130706433/a',
  ipv4Hex: 'https://0x7f000001/a',
  ipv4HexDotted: 'https://0x7f.0x0.0x0.0x1/a',
  ipv4Octal: 'https://0177.0.0.1/a',
  ipv4Short: 'https://127.1/a',
  ipv4Meta: 'https://169.254.169.254/latest',
  ipv6: 'https://[::1]/a',
  ipv6Mapped: 'https://[::ffff:127.0.0.1]/a',
  ipv6Full: 'https://[2001:db8::1]/a',
  localhost: 'https://localhost/a',
  localhostDot: 'https://localhost./a',
  subLocalhost: 'https://foo.localhost/a',
  dotLocal: 'https://printer.local/a',
  dotInternal: 'https://svc.internal/a',
  singleLabel: 'https://intranet/a',
  ownHost: 'https://relay.example.net/a',
  ownHostUpper: 'https://RELAY.Example.NET/a',
  ownWorkersDev: 'https://mine.workers.dev/a',
  ownSuffix: 'https://x.operator-zone.com/a',
  backslash: 'https://hooks.x.ai\\@evil.com/a',
  space: 'https://hooks.x.ai/a b',
  newline: 'https://hooks.x.ai/a\nb',
  tooLong: 'https://hooks.x.ai/' + 'a'.repeat(2100),
  notString: 12345,
  empty: '',
  notGrokHost: 'https://example.com/a',
  grokLookalike: 'https://x.ai.evil.com/a',
  grokLookalike2: 'https://evilx.ai/a'
};
for (const [name, url] of Object.entries(BAD)) {
  test(`rejected: ${name}`, () => {
    assert.equal(grok(url).ok, false, `${url}`.slice(0, 80));
  });
}

test('claude host is fixed to api.anthropic.com and a routine fire path', () => {
  assert.equal(claude('https://evil.com/v1/claude_code/routines/x/fire').ok, false);
  assert.equal(claude('https://api.anthropic.com.evil.com/v1/claude_code/routines/x/fire').ok, false);
  assert.equal(claude('https://api.anthropic.com/v1/messages').ok, false);
  assert.equal(claude('https://api.anthropic.com/v1/claude_code/routines/x/fire?a=1').ok, false);
  assert.equal(claude('https://api.anthropic.com/v1/claude_code/routines/../../x/fire').ok, false);
  assert.equal(claude('https://api.anthropic.com/v1/claude_code/routines/x/fire#f').ok, false);
});

test('grok host pattern is configurable', () => {
  assert.equal(grok('https://example.com/a', { grokHostPattern: /^example\.com$/ }).ok, true);
  assert.equal(grok('https://hooks.x.ai/a', { grokHostPattern: /^example\.com$/ }).ok, false);
});

test('unknown destination type rejected', () => {
  assert.equal(validateDestinationUrl(GROK_URL, { type: 'generic', ...own }).ok, false);
});

test('forward re-validates the stored url on every forward (no fetch for a bad entry)', async () => {
  const w = makeWorld({ fetchHandler: () => respond(202) });
  await w.routing.put(U2, { dest_type: 'grok', url: 'https://127.0.0.1/a', secret_or_bearer: GROK_SECRET, mode: 'full' });
  await w.routing.put(U1, { dest_type: 'grok', url: GROK_URL, secret_or_bearer: GROK_SECRET, mode: 'full' });
  await w.send(msgPayload({ sender: U1, authorizations: [{ user_id: U2, is_bot: false }] }));
  assert.equal(w.fetchImpl.calls.filter((c) => !c.url.includes('slack.com')).length, 0);
  assert.equal((await w.entry(U2).core.status()).counters.dropped, 1);
});

test('forwards use redirect manual and treat 3xx as failure, never following', async () => {
  const w = makeWorld({ fetchHandler: () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }) });
  await w.addGrok(U2);
  await w.routing.put(U1, { dest_type: 'grok', url: GROK_URL, secret_or_bearer: GROK_SECRET, mode: 'full' });
  await w.send(msgPayload({ sender: U1, authorizations: [{ user_id: U2, is_bot: false }] }));
  const hits = w.fetchImpl.calls.filter((c) => c.url.includes('hooks.x.ai'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].init.redirect, 'manual');
  assert.equal(w.fetchImpl.calls.some((c) => c.url.includes('169.254')), false);
  assert.equal((await w.entry(U2).core.status()).counters.errors, 1);
  assert.equal((await w.entry(U2).core.status()).counters.forwarded, 0);
});

test('N3: trailing-dot hosts are rejected for both types, including the ideographic full stop', () => {
  for (const u of ['https://hooks.x.ai./w', 'https://hooks.x.ai.../w', 'https://hooks.x.ai。/w']) {
    const r = grok(u);
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, 'trailing_dot', u);
  }
  assert.equal(claude('https://api.anthropic.com./v1/claude_code/routines/trig_ABC123/fire').ok, false);
  assert.equal(grok(GROK_URL).ok, true);
});
