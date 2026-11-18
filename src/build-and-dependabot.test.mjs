import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));

test('dependabot enforces conventional commit prefix, target branch and minor/patch grouping', () => {
  const config = YAML.parse(fs.readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8'));
  assert.equal(config.version, 2);
  assert.deepEqual(config.updates.map(entry => entry['package-ecosystem']).sort(), ['github-actions', 'npm']);
  for (const entry of config.updates) {
    assert.equal(entry['target-branch'], 'develop');
    assert.equal(entry['commit-message']?.prefix, 'build(deps)');
    assert.ok(entry['open-pull-requests-limit'] >= 1);
    const group = entry.groups?.['compatible-updates'];
    assert.deepEqual(group?.patterns, ['*']);
    assert.deepEqual([...(group?.['update-types'] ?? [])].sort(), ['minor', 'patch']);
  }
});

test('make build checks all .mjs and .sh syntax and verifies pnpm pack whitelist', t => {
  const ok = spawnSync('make', ['build'], { cwd: root, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PASS: build syntax and pack whitelist/);

  // Verify pack whitelist failure when an exported module is omitted from package.json files.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-pack-check-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'develop'], { cwd: fixture });
  fs.mkdirSync(path.join(fixture, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'extra'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'bin/cli.mjs'), '#!/usr/bin/env node\nconsole.log("ok");\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fixture, 'extra/missing.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({
      name: '@stuhelper/pack-fixture',
      version: '0.0.1',
      private: true,
      type: 'module',
      files: ['bin'],
      bin: { cli: 'bin/cli.mjs' },
      exports: { './missing': './extra/missing.mjs' },
    }, null, 2),
  );
  fs.copyFileSync(path.join(root, 'Makefile'), path.join(fixture, 'Makefile'));
  execFileSync('git', ['add', '.'], { cwd: fixture });

  const failed = spawnSync('make', ['build'], { cwd: fixture, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Missing from pnpm pack files whitelist: extra\/missing\.mjs/);
});
