import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const wrangler = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('wrangler.jsonc pins the required settings', () => {
  assert.equal(wrangler.name, 'dm-relay');
  assert.equal(wrangler.main, 'src/index.js');
  assert.equal(wrangler.compatibility_date, '2026-10-01');
  assert.deepEqual(wrangler.observability, { enabled: false });
  assert.equal(wrangler.kv_namespaces[0].binding, 'ROUTES');
  assert.deepEqual(wrangler.durable_objects.bindings, [
    { name: 'USER_DO', class_name: 'UserDO' },
    { name: 'EVENT_DEDUPE_DO', class_name: 'EventDedupeDO' }
  ]);
  assert.deepEqual(wrangler.migrations[0].new_sqlite_classes, ['UserDO']);
  assert.deepEqual(wrangler.migrations[1].new_sqlite_classes, ['EventDedupeDO']);
  assert.equal('new_classes' in wrangler.migrations[0], false);
});

test('wrangler vars hold only non-secret constants; secrets are never in files', () => {
  assert.deepEqual(Object.keys(wrangler.vars).sort(), ['BASE_URL', 'OPERATOR_HOSTS', 'PUBLIC_REPO_URL', 'SLACK_APP_ID', 'SLACK_TEAM_ID']);
  const secrets = [
    'SLACK_SIGNING_SECRET',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'SLACK_APP_TOKEN',
    'STATE_HMAC_KEY',
    'ROUTE_SECRET_ENCRYPTION_KEY',
    'ROUTE_SECRET_KEY_ID'
  ];
  for (const s of secrets) assert.equal(s in wrangler.vars, false);
  const files = [...readdirSync(join(ROOT, 'src')).map((f) => join(ROOT, 'src', f)), join(ROOT, 'wrangler.jsonc'), join(ROOT, 'README.md')];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.equal(/xox[bpaers]-[A-Za-z0-9-]{8,}/.test(text), false, f);
    assert.equal(/xapp-[A-Za-z0-9-]{8,}/.test(text), false, f);
  }
});

test('package.json: ES modules, zero dependencies, test script', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.match(pkg.scripts.test, /^node --test /);
});

test('required files exist and .gitignore excludes local secrets', () => {
  for (const f of ['src/index.js', 'src/slack-verify.js', 'src/filter.js', 'src/fanout.js', 'src/standard-webhooks.js', 'src/destinations.js', 'src/ssrf.js', 'src/oauth.js', 'src/user-do.js', 'src/pages.js', 'src/constants.js', 'wrangler.jsonc', 'README.md', '.gitignore']) {
    assert.ok(existsSync(join(ROOT, f)), f);
  }
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const p of ['.dev.vars', '.env', 'node_modules/']) assert.ok(gi.includes(p), p);
});

test('src has no runtime dependencies (only relative and cloudflare-free imports)', () => {
  for (const f of readdirSync(join(ROOT, 'src'))) {
    const code = readFileSync(join(ROOT, 'src', f), 'utf8');
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('./'), `${f}: ${m[1]}`);
  }
});
