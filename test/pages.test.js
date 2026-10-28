import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectPage, destinationFormPage, disconnectConfirmPage, disconnectedPage, messagePage, statusPage, successPage, esc } from '../src/pages.js';
import { makeWorld } from './helpers.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

const pages = {
  connect: () => connectPage({ intent: 'connect', authorizeUrl: 'https://slack.com/oauth/v2/authorize?x=1', cookie: 'c=1', publicRepoUrl: 'https://github.example/r' }),
  form: () => destinationFormPage({ csrf: 'abc' }),
  formError: () => destinationFormPage({ csrf: 'abc', error: 'bad' }),
  success: () => successPage(),
  status: () => statusPage({ counters: { forwarded: 1 }, lastNudge: null }),
  confirm: () => disconnectConfirmPage({ csrf: 'abc' }),
  disconnected: () => disconnectedPage({ revoked: true }),
  message: () => messagePage('T', 'm')
};

for (const [name, make] of Object.entries(pages)) {
  test(`required headers on ${name} page`, () => {
    const h = make().headers;
    assert.equal(h.get('cache-control'), 'no-store');
    assert.equal(h.get('referrer-policy'), 'no-referrer');
    assert.equal(h.get('content-security-policy'), CSP);
    assert.match(h.get('content-type'), /^text\/html/);
  });
}

test('pages served through the router carry the headers (incl. 404 and errors)', async () => {
  const w = makeWorld();
  for (const path of ['/connect', '/disconnect', '/status', '/nope', '/oauth/callback']) {
    const res = await w.request(path);
    assert.equal(res.headers.get('cache-control'), 'no-store', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    assert.equal(res.headers.get('content-security-policy'), CSP, path);
  }
});

test('/connect disclosures are all present', async () => {
  const w = makeWorld();
  const html = (await (await w.request('/connect')).text()).replace(/&quot;/g, '"');
  const must = [
    /owner can see who has opted in/,
    /visible to the operator/,
    /best-effort and at-most-once/,
    /type="checkbox" name="attest_preview"/,
    /model training on inputs is turned off/,
    /Attach only the Slack connector/,
    /disable every Slack write tool/,
    /fire <code>text<\/code> must be ignored/,
    /prompt injection/,
    /inject arbitrary instructions/,
    /controlled by your own automation permissions/,
    /hostile message/,
    /Do not put secrets in the voice text/,
    /Claude routines use nudge mode/,
    /not a technical guarantee/,
    /about 60 seconds/,
    /one real routine run/,
    /https:\/\/github\.example\/dm-relay/,
    /have not consented/
  ];
  for (const re of must) assert.match(html, re);
});

test('no external assets are referenced (only the Slack authorize link and the repo link)', async () => {
  const w = makeWorld();
  for (const path of ['/connect', '/status']) {
    const html = await (await w.request(path)).text();
    assert.equal(/<(script|img|link|iframe)\b/i.test(html), false);
    assert.equal(/url\(\s*['"]?https?:/i.test(html), false);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const h of hrefs) assert.ok(h.startsWith('https://slack.com/oauth/v2/authorize') || h === 'https://github.example/dm-relay', h);
  }
});

test('destination form requires only the training attestation and posts to itself', () => {
  return pages.form().text().then((html) => {
    assert.match(html, /<form method="post" action="\/destination">/);
    assert.match(html, /name="attest"[^>]*required/);
    assert.equal(html.includes('no_send'), false);
    assert.equal(/no autonomous send/i.test(html), false);
    assert.match(html, /autocomplete="off"/);
  });
});

test('output is HTML-escaped', async () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  const html = await destinationFormPage({ csrf: '"><script>x</script>', error: '<b>' }).text();
  assert.equal(html.includes('<script>x'), false);
  assert.equal(html.includes('<b>'), false);
});

test('a non-https repo URL is not rendered as a link', async () => {
  const res = connectPage({ intent: 'connect', authorizeUrl: 'https://slack.com/x', cookie: 'c=1', publicRepoUrl: 'javascript:alert(1)' });
  assert.equal((await res.text()).includes('href="javascript'), false);
});

test('S4: /connect states the disconnect-token exception instead of "never stores your Slack token"', async () => {
  const html = await connectPage({ intent: 'connect', authorizeUrl: 'https://slack.com/x', cookie: 'c=1', publicRepoUrl: 'https://github.example/r' }).text();
  assert.ok(html.includes('It never stores message text. Your Slack token is never stored, except for up to 10 minutes during a disconnect, until you confirm.'));
  assert.equal(html.includes('or your Slack token'), false);
});

test('S5: destination form warns that leaving without activating keeps Slack access until /disconnect', async () => {
  const html = await destinationFormPage({ csrf: 'abc' }).text();
  assert.match(html, /leaving without activating keeps Slack access until you run \/disconnect/i);
});
