import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkStaged, withIndex } from './staged.mjs';

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-stage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'develop'); git('config', 'user.email', 'tests@example.com'); git('config', 'user.name', 'Tests');
  fs.writeFileSync(path.join(root, 'data.json'), '{"initial":true}\n'); git('add', '.'); git('commit', '-m', 'initial');
  return { root, git };
}
test('validation reads the index and preserves partially staged content', async t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, 'data.json'), '{"staged":true}\n'); git('add', 'data.json');
  fs.writeFileSync(path.join(root, 'data.json'), '{invalid worktree}\n');
  const before = git('status', '--porcelain');
  await checkStaged(root);
  assert.equal(git('status', '--porcelain'), before);
  assert.equal(fs.readFileSync(path.join(root, 'data.json'), 'utf8'), '{invalid worktree}\n');
});
test('invalid staged content is rejected even when the worktree is repaired', async t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, 'data.json'), '{invalid index}\n'); git('add', 'data.json');
  fs.writeFileSync(path.join(root, 'data.json'), '{}\n');
  await assert.rejects(checkStaged(root), /data.json/);
});
test('snapshot cleanup runs after a failed check and force-added files remain visible', async t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'forced.json\n'); git('add', '.gitignore');
  fs.writeFileSync(path.join(root, 'forced.json'), '{}'); git('add', '-f', 'forced.json');
  let snapshot;
  await assert.rejects(withIndex(root, target => { snapshot = target; assert(fs.existsSync(path.join(target, 'forced.json'))); throw new Error('failed'); }), /failed/);
  assert(!fs.existsSync(snapshot));
});
test('linked worktrees inspect their own index', async t => {
  const { root, git } = repository(t);
  const linked = path.join(root, 'linked');
  git('worktree', 'add', '-b', 'feature', linked);
  fs.writeFileSync(path.join(linked, 'data.json'), '{broken}\n');
  execFileSync('git', ['add', 'data.json'], { cwd: linked });
  await assert.rejects(checkStaged(linked), /data.json/);
  await checkStaged(root);
});
test('first commit can validate staged files without HEAD', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-first-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'develop'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'data.json'), '{}\n');
  execFileSync('git', ['add', 'data.json'], { cwd: root });
  await checkStaged(root);
});
