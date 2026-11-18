import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { checkStaged, withIndex } from './staged.mjs';

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-stage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'develop'); git('config', 'user.email', 'tests@example.com'); git('config', 'user.name', 'Tests');
  git('config', 'commit.gpgSign', 'false');
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

test('staged checks run i18n snapshot validation when locale-policy.yaml is present', async t => {
  const { root, git } = repository(t);
  const policy = { default: 'zh-CN', default_time_zone: 'Asia/Shanghai', languages: { 'zh-CN': { name: '简体中文', direction: 'ltr' }, 'en-US': { name: 'English', direction: 'ltr' } } };
  fs.writeFileSync(path.join(root, 'locale-policy.yaml'), stringifyYaml(policy));
  fs.writeFileSync(path.join(root, 'locale-policy.json'), `${JSON.stringify(policy, null, 2)}\n`);
  fs.mkdirSync(path.join(root, 'src/locales'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/locales/zh-CN.json'), '{"title":"课程"}\n');
  fs.writeFileSync(path.join(root, 'src/locales/en-US.json'), '{"title":"Courses"}\n');
  fs.writeFileSync(path.join(root, 'src/App.vue'), `<template><h1>{{ t('title') }}</h1></template>\n`);
  git('add', '.');
  await checkStaged(root);
  git('commit', '-m', 'i18n baseline');

  // Staging a missing translation key in zh-CN without updating en-US fails in pre-commit.
  fs.writeFileSync(path.join(root, 'src/locales/zh-CN.json'), '{"title":"课程","extra":"新增"}\n');
  git('add', 'src/locales/zh-CN.json');
  await assert.rejects(checkStaged(root), /Missing or extra message in en-US/);

  // Unstaged broken translation in worktree does not block valid staged changes.
  git('checkout', 'HEAD', '--', 'src/locales/zh-CN.json');
  fs.writeFileSync(path.join(root, 'src/App.vue'), `<template><main><h1>{{ t('title') }}</h1></main></template>\n`);
  git('add', 'src/App.vue');
  fs.writeFileSync(path.join(root, 'src/locales/en-US.json'), '{broken unstaged}\n');
  await checkStaged(root);
});

test('withIndex maps monorepo subpackage node_modules symlinks and tolerates force-staged node_modules files', async t => {
  const { root, git } = repository(t);
  fs.mkdirSync(path.join(root, 'node_modules/root-pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps/web-antd/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps/web-antd/node_modules/sub-pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/locales/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/locales/node_modules/loc-pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps/web-antd/src/index.ts'), 'export const ok = 1;\n');
  fs.writeFileSync(path.join(root, 'packages/locales/src/index.ts'), 'export const locale = "zh-CN";\n');
  git('add', 'apps/web-antd/src/index.ts', 'packages/locales/src/index.ts');

  await withIndex(root, target => {
    assert.ok(fs.lstatSync(path.join(target, 'node_modules')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(target, 'apps/web-antd/node_modules')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(target, 'packages/locales/node_modules')).isSymbolicLink());
  });

  // Force-staging a file inside node_modules must not crash symlinkSync with EEXIST.
  fs.writeFileSync(path.join(root, 'apps/web-antd/node_modules/forced.json'), '{"ok":true}\n');
  git('add', '-f', 'apps/web-antd/node_modules/forced.json');
  await checkStaged(root);
});

test('staged command forwards --glossary and blocks isolated manual edits to generated SDKs', async t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, '.markdownlint-cli2.yaml'), "globs: ['**/*.md']\nignores: ['**/node_modules/**']\n");
  fs.mkdirSync(path.join(root, 'docs/spec'), { recursive: true });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' }).format(new Date());
  fs.writeFileSync(path.join(root, 'docs/spec/a.md'), `---\ntype: spec\nstatus: InReview\nupdated: ${today}\n---\n\n# 资格\n\n使用旧词有效学生资格。\n`);
  const glossary = path.join(root, 'external-glossary.md');
  fs.writeFileSync(glossary, '| 术语 | 定义 | 字段 | 范围 | 替代表述 |\n| 有效校园资格 | definition | field | scope | 有效学生资格 |\n');
  git('add', '.markdownlint-cli2.yaml', 'docs/spec/a.md');

  const cli = fileURLToPath(new URL('../bin/stuhelper-check.mjs', import.meta.url));
  const termFail = spawnSync(process.execPath, [cli, 'staged', '--glossary', glossary], { cwd: root, encoding: 'utf8' });
  assert.equal(termFail.status, 1);
  assert.match(termFail.stderr, /use standard term "有效校园资格"/);

  // Clean docs, commit generated SDK, then stage a manual edit to *.gen.go alone.
  fs.writeFileSync(path.join(root, 'docs/spec/a.md'), `---\ntype: spec\nstatus: InReview\nupdated: ${today}\n---\n\n# 资格\n\n使用有效校园资格。\n`);
  fs.mkdirSync(path.join(root, 'sdk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sdk/api.gen.go'), '// Code generated by oapi-codegen DO NOT EDIT.\npackage sdk\n');
  git('add', '.markdownlint-cli2.yaml', 'docs/spec/a.md', 'sdk/api.gen.go');
  git('commit', '-m', 'docs and sdk');

  fs.writeFileSync(path.join(root, 'sdk/api.gen.go'), '// Code generated by oapi-codegen DO NOT EDIT.\npackage sdk\n\nvar Bad = 1\n');
  git('add', 'sdk/api.gen.go');
  await assert.rejects(checkStaged(root), /generated file modified without corresponding contract or generator update/);
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

test('staged executable binary and renamed armored private material are distinguished', async t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, 'module.wasm'), Buffer.from([0, 97, 115, 109]), { mode: 0o755 });
  git('add', 'module.wasm');
  await checkStaged(root);
  const header = '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----';
  const content = 'x'.repeat(65525) + '\n' + header + '\n';
  fs.writeFileSync(path.join(root, 'fixture-data'), content);
  git('add', 'fixture-data');
  await assert.rejects(checkStaged(root), /fixture-data: private key material/);
});

test('staged snapshots map linked node_modules and skip unrelated directory links', async t => {
  const { root, git } = repository(t);
  const modules = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-dependencies-'));
  t.after(() => fs.rmSync(modules, { recursive: true, force: true }));
  fs.writeFileSync(path.join(modules, 'installed'), 'ok');
  fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir');
  fs.symlinkSync(root, path.join(root, 'loop'), 'dir');
  fs.writeFileSync(path.join(root, 'file'), 'tracked');
  git('add', 'file');
  await withIndex(root, target => {
    assert.equal(fs.readFileSync(path.join(target, 'node_modules/installed'), 'utf8'), 'ok');
    assert.equal(fs.existsSync(path.join(target, 'loop')), false);
  });
});
