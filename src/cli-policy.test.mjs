import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { checkSource, privateMaterialErrors } from './repository.mjs';
import { parse } from 'yaml';

test('CLI validates every argument before running its command', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const cli = new URL('../bin/stuhelper-check.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  for (const args of [['docs', 'README.md'], ['repository', '--eslint'], ['staged', '--glossary', 'missing']]) {
    const r = run(...args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /argument|option|only supported/i);
  }
  fs.writeFileSync(path.join(root, 'locale-policy.yaml'), 'default: zh-CN\n');
  const r = run('--write', 'locale-policy');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASS: locale-policy/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'locale-policy.json'))), { default: 'zh-CN' });
});
test('private material names and text headers fail without echoing content', () => {
  for (const name of ['prod.dump.gz', 'db.BACKUP.zst', 'cache.sqlite3-wal', 'a/secrets/file', 'private/file']) assert.ok(privateMaterialErrors(name).length, name);
  const header = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
  const errors = checkSource('id_fixture', '\n' + header);
  assert.ok(errors.length);
  assert.ok(errors.every(line => !line.includes(header)));
  assert.deepEqual(checkSource('guide.md', 'Document the format in prose.'), []);
});
test('entry modes and the public release runner label are checked', () => {
  assert.ok(checkSource('bin/run', '#!/bin/sh\n', false).length);
  assert.ok(checkSource('bin/run', 'echo fixture', false).length);
  assert.ok(checkSource('readme.md', '# Guide', true).length);
  assert.deepEqual(checkSource('bin/run', '#!/bin/sh\n', true), []);
  assert.deepEqual(checkSource('module.wasm', '\0asm', true), []);
  const config = parse(fs.readFileSync('.github/actionlint.yaml', 'utf8'));
  assert.ok(config['self-hosted-runner'].labels.includes('stuhelper-arc-sh-release'));
});

test('repository rejects key material in an otherwise ordinary filename', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'material-file-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const cli = new URL('../bin/stuhelper-check.mjs', import.meta.url).pathname;
  const file = path.join(root, 'fixture-data');
  const run = () => spawnSync(process.execPath, [cli, 'repository'], { cwd: root, encoding: 'utf8' });
  fs.writeFileSync(file, 'fixture text\n');
  assert.equal(run().status, 0);
  const label = '-----BEGIN ' + 'PRIVATE KEY-----';
  fs.appendFileSync(file, label + '\n');
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixture-data: private key material/);
  assert.ok(!r.stderr.includes(label));
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture text\n' + label + '\n');
});

test('sensitive text is never passed to diagnostic formatters that quote input', () => {
  const header = '-----BEGIN ' + 'PRIVATE KEY-----';
  const errors = checkSource('fixture.json', header + '\nfixture payload');
  assert.deepEqual(errors, ['fixture.json: private key material']);
});
