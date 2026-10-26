import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

export function findBadConsoleUses(code) {
  const src = stripComments(code);
  const bad = [];
  const call = /\bconsole\s*\.\s*([A-Za-z]+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = call.exec(src))) {
    if (!/^\s*(?:'[A-Za-z0-9_ .:-]*'|"[A-Za-z0-9_ .:-]*")\s*$/.test(m[2])) bad.push(m[0]);
  }
  const total = (src.match(/\bconsole\b/g) || []).length;
  const checked = (src.match(/\bconsole\s*\.\s*[A-Za-z]+\s*\(/g) || []).length;
  if (total !== checked) bad.push('console used other than as a direct call');
  return bad;
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('src/ has no console.* call with a non-constant argument', () => {
  const files = walk(SRC);
  assert.ok(files.length >= 10);
  for (const f of files) {
    const bad = findBadConsoleUses(readFileSync(f, 'utf8'));
    assert.deepEqual(bad, [], `${f}: ${bad.join(' | ')}`);
  }
});

test('scanner flags non-constant arguments (self-test)', () => {
  assert.equal(findBadConsoleUses("console.error('E_SIG');").length, 0);
  assert.equal(findBadConsoleUses('console.error("E_SIG")').length, 0);
  assert.ok(findBadConsoleUses('console.log(err.message)').length > 0);
  assert.ok(findBadConsoleUses('console.error(`E_${code}`)').length > 0);
  assert.ok(findBadConsoleUses("console.error('E_' + x)").length > 0);
  assert.ok(findBadConsoleUses("console.error('E_A', err)").length > 0);
  assert.ok(findBadConsoleUses('console.log()').length > 0);
  assert.ok(findBadConsoleUses('const c = console; c.log(x)').length > 0);
  assert.ok(findBadConsoleUses("console['log'](x)").length > 0);
  assert.ok(findBadConsoleUses('console.error(request.url)').length > 0);
});

test('src/ never logs err.message or similar, and error codes are fixed literals', () => {
  for (const f of walk(SRC)) {
    const code = stripComments(readFileSync(f, 'utf8'));
    assert.equal(/console[^;]*\.(message|stack)/.test(code), false, f);
  }
});
