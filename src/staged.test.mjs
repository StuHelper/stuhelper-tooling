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

test('deleting a document revalidates references left in the index', async t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, '.markdownlint-cli2.yaml'), "globs: ['**/*.md']\nignores: ['.git/**']\n");
  fs.writeFileSync(path.join(root, 'README.md'), '# Index\n\n[Topic](topic.md)\n');
  fs.writeFileSync(path.join(root, 'topic.md'), '# Topic\n');
  git('add', '.'); git('commit', '-m', 'documents'); git('rm', 'topic.md');
  await assert.rejects(checkStaged(root), /missing or external local target: topic.md/);
  assert.equal(git('status', '--porcelain').trimEnd(), 'D  topic.md');
});
test('private names on dangling links fail before their targets are inspected', async t => {
  const { root, git } = repository(t);
  fs.symlinkSync('missing-fixture', path.join(root, '.env'));
  git('add', '-f', '.env');
  const { checkRepository } = await import('./repository.mjs');
  assert.throws(() => checkRepository(root), /\.env: runtime/);
  await assert.rejects(checkStaged(root), /\.env: runtime/);
  assert.equal(fs.readlinkSync(path.join(root, '.env')), 'missing-fixture');
});
test('hook Git environment does not override snapshot history for doc dates', async t => {
  const { root, git } = repository(t);
  fs.mkdirSync(path.join(root, 'docs/spec'), { recursive: true });
  fs.writeFileSync(path.join(root, '.markdownlint-cli2.yaml'), "globs: ['**/*.md']\nignores: ['.git/**']\n");
  fs.writeFileSync(path.join(root, 'docs/spec/topic.md'), '---\ntype: spec\nstatus: Accepted\nupdated: 2000-01-01\n---\n\n# Topic\n');
  git('add', '.');
  const { spawnSync } = await import('node:child_process');
  const cli = new URL('../bin/stuhelper-check.mjs', import.meta.url);
  const r = spawnSync(process.execPath, [cli.pathname, 'staged'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: root } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /updated 必须不早于/);
});

test('a deleted topic cannot remain solely in the site navigation', async t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, '.markdownlint-cli2.yaml'), "globs: ['**/*.md']\nignores: ['.git/**']\n");
  fs.mkdirSync(path.join(root, 'docs/spec'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/spec/topic.md'), '# Topic\n');
  fs.writeFileSync(path.join(root, 'mkdocs.yml'), 'nav:\n  - Topic: spec/topic.md\n');
  git('add', '.'); git('commit', '-m', 'site navigation'); git('rm', 'docs/spec/topic.md');
  await assert.rejects(checkStaged(root), /mkdocs.yml: missing navigation target spec\/topic.md/);
  fs.writeFileSync(path.join(root, 'mkdocs.yml'), 'nav: []\n');
  git('add', 'mkdocs.yml'); await checkStaged(root);
});
