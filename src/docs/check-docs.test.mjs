import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { checkDocs, siteSlug } from './check-docs.mjs';
import { lintMarkdown } from './lint-markdown.mjs';

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-docs-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  files['.markdownlint-cli2.yaml'] = "globs: ['**/*.md']\nignores: ['**/node_modules/**']\n";
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}
const doc = (body, type = 'spec', date = '2026-10-23', status = 'InReview') =>
  `---\ntype: ${type}\nstatus: ${status}\nupdated: ${date}\n---\n\n${body}\n`;

test('valid reference links, Chinese headings and duplicate anchors resolve', (t) => {
  const root = fixture(t, {
    'docs/spec/README.md': doc('# 索引\n\n[主题][topic]\n\n[topic]: behavior.md#行为_1'),
    'docs/spec/behavior.md': doc('# 行为\n\n## 行为'),
  });
  assert.deepEqual(checkDocs(root).errors, []);
});

test('wrong location type, invalid date and status fail', (t) => {
  const root = fixture(t, { 'docs/spec/a.md': doc('# 内容', 'design', '2026-02-30', 'Done') });
  const errors = checkDocs(root).errors.join('\n');
  assert.match(errors, /type does not match/);
  assert.match(errors, /invalid updated date/);
  assert.match(errors, /invalid document status/);
});

test('a moved document or missing anchor is not accepted', (t) => {
  const root = fixture(t, {
    'docs/spec/a.md': doc('# 内容\n\n[旧文档](old.md) [锚点](b.md#不存在)'),
    'docs/spec/b.md': doc('# 存在'),
  });
  const errors = checkDocs(root).errors.join('\n');
  assert.match(errors, /missing or external local target/);
  assert.match(errors, /missing heading anchor/);
});

test('templates and code examples allow placeholders, ordinary prose does not', (t) => {
  const root = fixture(t, {
    'docs/spec/TEMPLATE.md': doc('# 模板\n\nTODO: 填写', 'spec', 'YYYY-MM-DD', 'Draft'),
    'docs/spec/a.md': doc('# 示例\n\n`TODO: literal`\n\n```text\nYYYY-MM-DD\n```'),
    'docs/spec/b.md': doc('# 未完成\n\nTODO: 填写'),
  });
  assert.deepEqual(checkDocs(root).errors, ['docs/spec/b.md: unfilled prose placeholder']);
});

test('ignored dependencies are not parsed and links cannot escape repository', (t) => {
  const root = fixture(t, {
    'node_modules/docs/broken.md': '[missing](absent.md)',
    'docs/spec/a.md': doc('# 内容\n\n[越界](../../../outside.md)'),
  });
  const result = checkDocs(root);
  assert.equal(result.count, 1);
  assert.match(result.errors[0], /missing or external local target/);
});

test('missing and duplicate YAML metadata fail without crashing', (t) => {
  const root = fixture(t, {
    'docs/spec/a.md': '# 没有元信息',
    'docs/spec/b.md': '---\ntype: spec\ntype: design\n---\n\n# 内容',
  });
  assert.match(checkDocs(root).errors.join('\n'), /missing frontmatter/);
  assert.match(checkDocs(root).errors.join('\n'), /invalid YAML metadata/);
});

test('format checks enforce rules while respecting the PR template exception', async (t) => {
  const root = fixture(t, {
    '.github/pull_request_template.md': '## Changes\n\nDescribe the changes.\n',
    'docs/spec/a.md': doc('# 标题\n\n$C_L$\n\n- item\n'),
    'README.md': '# Title\n\n##Missing space\n',
  });
  fs.appendFileSync(path.join(root, '.markdownlint-cli2.yaml'),
    "overrides:\n  - filter: ['.github/pull_request_template.md']\n    config: {MD041: false}\n    combine: merge\n");
  const errors = (await lintMarkdown(root)).join('\n');
  assert.match(errors, /MD018/);
  assert.doesNotMatch(errors, /MD041/);
});


test('site slugs match Unicode punctuation, empty and numbered duplicate headings', () => {
  const anchors = new Set();
  const headings = ['行为', '行为', '行为_1', '!!!', '!!!', 'A & B', 'Café', 'ＡＢＣ'];
  const actual = headings.map(text => { const id = siteSlug(text, anchors); anchors.add(id); return id; });
  assert.deepEqual(actual, ['行为', '行为_1', '行为_2', '_1', '_2', 'a-b', 'café', 'ａｂｃ']);
});

test('site duplicate anchors reject GitHub-only suffixes', (t) => {
  const root = fixture(t, {
    'docs/spec/a.md': doc('# 行为\n\n## 行为\n\n[错误](#行为-1)'),
  });
  assert.match(checkDocs(root).errors.join('\n'), /missing heading anchor/);
});

test('only the five categories are valid, including nested topics', (t) => {
  const root = fixture(t, {
    'docs/random/a.md': doc('# 内容', 'random'),
    'docs/spec/topic/a.md': doc('# 内容', 'topic'),
    'docs/spec/topic/b.md': doc('# 内容', 'spec'),
  });
  const errors = checkDocs(root).errors;
  assert.equal(errors.length, 2);
  assert(errors.every(error => error.includes('type does not match')));
});

test('only the first matching Markdown override is applied', async (t) => {
  const root = fixture(t, { 'README.md': '## Content\n' });
  fs.appendFileSync(path.join(root, '.markdownlint-cli2.yaml'),
    "overrides:\n  - filter: ['README.md']\n    config: {MD041: false}\n    combine: merge\n  - filter: ['**/*.md']\n    config: {MD041: true}\n    combine: merge\n");
  assert.doesNotMatch((await lintMarkdown(root)).join('\n'), /MD041/);
});


test('standard terminology rejects old aliases but accepts code identifiers', (t) => {
  const root = fixture(t, { 'docs/spec/a.md': doc('# 资格\n\n有效学生资格与 `学生认证通过`') });
  fs.writeFileSync(path.join(root, 'glossary.md'), '| 术语 | 定义 | 字段 | 范围 | 替代表述 |\n| 有效校园资格 | definition | field | scope | 有效学生资格 |\n');
  const errors = checkDocs(root, { glossary: 'glossary.md' }).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /use standard term/);
});

test('repository GitHub links validate files and GitHub anchors locally', (t) => {
  const root = fixture(t, {
    'mkdocs.yml': 'repo_url: https://github.com/StuHelper/example\nnav:\n  - Topic: spec/a.md\n',
    'docs/spec/a.md': doc('# 行为\n\n## 行为\n\n[有效](https://github.com/StuHelper/example/blob/develop/docs/spec/a.md#行为-1) [错误](https://github.com/StuHelper/example/blob/develop/gone.md)'),
  });
  const errors = checkDocs(root).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing or external local target/);
});

test('new topics must appear in both category index and site navigation', (t) => {
  const root = fixture(t, {
    'mkdocs.yml': 'nav:\n  - Index: spec/README.md\n',
    'docs/spec/README.md': doc('# 索引'),
    'docs/spec/a.md': doc('# 新主题'),
  });
  const errors = checkDocs(root).errors.join('\n');
  assert.match(errors, /missing topic a.md/);
  assert.match(errors, /missing navigation spec\/a.md/);
});


test('paragraph limits count rendered text, not URL bytes, and report source lines', t => {
  const root = fixture(t, { 'README.md': '# Title\n\n[Short label](https://example.org/' + 'a'.repeat(400) + ')\n\n' + '文'.repeat(201) + '\n' });
  const errors = checkDocs(root).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /第 5 行段落有 201 个可见字符/);
});

test('ADR numbers, scenario IDs and index descriptions reject copy errors', t => {
  const root = fixture(t, {
    'docs/adr/README.md': doc('# 索引\n\n| 主题 | 内容 |\n| --- | --- |\n| [0001：A](0001-a.md) | 0001：A |\n| [0001：B](0001-b.md) | Different |', 'adr'),
    'docs/adr/0001-a.md': doc('# 0002：A', 'adr'),
    'docs/adr/0001-b.md': doc('# 0001：B', 'adr'),
    'docs/spec/a.md': doc('# A\n\n| 场景 | 结果 |\n| --- | --- |\n| AE-01 | A |'),
    'docs/spec/b.md': doc('# B\n\n| 场景 | 结果 |\n| --- | --- |\n| AE-01 | B |'),
  });
  const errors = checkDocs(root).errors.join('\n');
  assert.match(errors, /四位编号一致/);
  assert.match(errors, /ADR 编号 0001.*重复/);
  assert.match(errors, /场景编号 AE-01.*重复/);
  assert.match(errors, /不能重复标题/);
});

test('topic descriptions reject empty and whitespace-only cells', t => {
  const root = fixture(t, {
    'docs/spec/README.md': doc('# 索引\n\n| 主题 | 内容 |\n| --- | --- |\n| [A](a.md) | |\n| [B](b.md) |    |'),
    'docs/spec/a.md': doc('# A'),
    'docs/spec/b.md': doc('# B'),
  });
  assert.equal(checkDocs(root).errors.filter(error => error.includes('主题描述不能为空')).length, 2);
  fs.writeFileSync(path.join(root, 'docs/spec/README.md'), doc('# 索引\n\n| 主题 | 内容 |\n| --- | --- |\n| [A](a.md) | A 的接口规则 |\n| [B](b.md) | B 的验证步骤 |'));
  assert.deepEqual(checkDocs(root).errors, []);
});

test('future dates fail even without Git history while template dates remain valid', t => {
  const root = fixture(t, {
    'docs/spec/a.md': doc('# A', 'spec', '2099-01-01'),
    'docs/spec/TEMPLATE.md': doc('# 模板', 'spec', 'YYYY-MM-DD', 'Draft'),
  });
  const errors = checkDocs(root, { now: Date.parse('2026-10-23T17:00:00Z') }).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0], /updated 不能晚于检查日期 2026-10-24/);
});

test('metadata-only date edits retain the content-date lower bound and the current-date upper bound', t => {
  const root = fixture(t, { 'docs/spec/a.md': doc('# A', 'spec', '2026-10-24') });
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-10-23T17:00:00Z', GIT_COMMITTER_DATE: '2026-10-23T17:00:00Z' };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'body');
  const file = path.join(root, 'docs/spec/a.md');
  const check = date => {
    fs.writeFileSync(file, doc('# A', 'spec', date));
    return checkDocs(root, { base: 'HEAD', now: Date.parse('2026-10-25T12:00:00Z') }).errors;
  };
  assert.match(check('2000-01-01').join('\n'), /不早于本次内容修改日期 2026-10-24/);
  assert.match(check('2099-01-01').join('\n'), /不能晚于检查日期 2026-10-25/);
  assert.deepEqual(check('2026-10-24'), []);
  assert.deepEqual(check('2026-10-25'), []);
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'metadata');
  assert.deepEqual(checkDocs(root, { base: 'HEAD', now: Date.parse('2026-10-26T12:00:00Z') }).errors, []);
});

test('modified document dates follow the content commit in Shanghai and remain stable on later CI runs', t => {
  const root = fixture(t, { 'docs/spec/a.md': doc('# A', 'spec', '2026-10-23') });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_AUTHOR_DATE: '2026-10-23T17:00:00Z', GIT_COMMITTER_DATE: '2026-10-23T17:00:00Z' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'docs/spec/a.md'), doc('# A\n\nNew content.', 'spec', '2026-10-23'));
  git('add', '.'); git('commit', '-qm', 'content');
  assert.match(checkDocs(root, { base, now: Date.parse('2026-10-25T12:00:00Z') }).errors.join('\n'), /修改日期 2026-10-24/);
  fs.writeFileSync(path.join(root, 'docs/spec/a.md'), doc('# A\n\nNew content.', 'spec', '2026-10-24'));
  assert.deepEqual(checkDocs(root, { base, now: Date.parse('2026-10-25T12:00:00Z') }).errors, []);
  git('add', '.');
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'metadata only'], { env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-25T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-25T12:00:00Z' } });
  assert.deepEqual(checkDocs(root, { base, now: Date.parse('2026-10-26T12:00:00Z') }).errors, []);
});

test('unchanged newline-terminated documents stay outside the changed-date history check', t => {
  const root = fixture(t, { 'docs/spec/a.md': doc('# A', 'spec', '2026-10-23') });
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-10-23T17:00:00Z', GIT_COMMITTER_DATE: '2026-10-23T17:00:00Z' };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'legacy metadata');
  const options = { base: 'HEAD', now: Date.parse('2026-10-25T12:00:00Z') };
  assert.deepEqual(checkDocs(root, options).errors, []);
  fs.writeFileSync(path.join(root, 'docs/spec/a.md'), doc('# A', 'spec', '2026-10-22'));
  assert.match(checkDocs(root, options).errors.join('\n'), /不早于本次内容修改日期 2026-10-24/);
});
