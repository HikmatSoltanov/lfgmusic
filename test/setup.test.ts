import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('Environment initializer generates a key once and preserves existing configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-init-'));
  try {
    copyFileSync('.env.example', join(dir, '.env.example'));
    const script = resolve('scripts/init-env.mjs');
    const invoke = () => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(invoke().status, 0);
    const first = readFileSync(join(dir, '.env'), 'utf8');
    assert.match(first, /^TOKEN_ENCRYPTION_KEY=[a-f0-9]{64}$/m);
    assert.equal(invoke().status, 0); assert.equal(readFileSync(join(dir, '.env'), 'utf8'), first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
