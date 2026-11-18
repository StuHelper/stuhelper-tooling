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

  // Appending check results after a preceding toolchain table keeps both Markdown tables valid.
  const combined = path.join(root, 'combined.md');
  fs.writeFileSync(combined, '### Toolchain setup\n\n| Tool | Version | Source | Duration |\n| --- | --- | --- | --- |\n| Node.js | `v24.22.1` | preinstalled | 0.01 s |\n');
  const second = spawnSync(process.execPath, [cli, 'repository'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: combined } });
  assert.equal(second.status, 1);
  const rendered = fs.readFileSync(combined, 'utf8');
  assert.match(rendered, /### Toolchain setup/);
  assert.match(rendered, /\| Check \| Result \| Details \|\n\| --- \| --- \| --- \|\n\| repository \| Failed \|/);
});

test('one multiline failure has one annotation and only paths have file properties', t => {
  const module = new URL('./report.mjs', import.meta.url).href;
  const code = `import { diagnostic, reported } from ${JSON.stringify(module)};
    diagnostic('ENOENT: synthetic file error');
    diagnostic('docs/a.md: 第 5 行过长');
    await reported('test', () => { throw new Error('Interpolation mismatch: en-US/title\\n+ actual\\n- expected'); });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.match(/^::error/gm).length, 3);
  assert.match(r.stdout, /::error::ENOENT:/);
  assert.match(r.stdout, /::error file=docs\/a.md,line=5::/);
  assert.match(r.stdout, /::error::Interpolation mismatch: en-US\/title%0A\+ actual%0A- expected/);
});

test('workflow violations use actual actionlint file locations without wrapper annotations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-annotation-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  execFileSync('git', ['init', '-q', root]);
  const folder = path.join(root, '.github/workflows');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'invalid.yml'), "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        misspelt: value\n");
  const cli = fileURLToPath(new URL('../bin/stuhelper-check.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'workflows'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error file=\.github\/workflows\/invalid.yml,line=7::/);
  assert.equal(r.stdout.match(/^::error/gm).length, 1);
});
