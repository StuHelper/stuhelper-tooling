import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('CLI failure emits an annotation, a summary and a nonzero status', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'develop'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'invalid.json'), '{broken}\n');
  const summary = path.join(root, 'summary.md');
  const cli = fileURLToPath(new URL('../bin/stuhelper-check.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'repository'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error file=invalid.json::/);
  assert.match(result.stdout, /::endgroup::/);
  assert.match(fs.readFileSync(summary, 'utf8'), /\| repository \| Failed \|/);
});
