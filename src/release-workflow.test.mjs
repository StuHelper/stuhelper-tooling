import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const build = workflow.jobs.publish.steps.find(step => step.name === 'Build fixed source');

test('release passes tag and actual commit to the source builder and refuses failed builds', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'runtime'));
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, 'scripts/prepare-oracle-driver.py'), 'from pathlib import Path\nPath("prepared").touch()\n');
  fs.writeFileSync(path.join(directory, 'scripts/build-oracle-sync.sh'), 'set -eu\ntest -f prepared\nprintf "%s\\n%s\\n" "$1" "$2" > "$RUNNER_TEMP/build-arguments"\nexit 23\n');
  fs.writeFileSync(path.join(directory, 'bin/gh'), '#!/bin/sh\ntouch "$RUNNER_TEMP/unverified-upload"\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', 'scripts'], { cwd: directory });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic source'], { cwd: directory });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  const runtime = path.join(directory, 'runtime');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', build.run], {
    cwd: directory,
    env: { ...process.env, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`, APPLICATION: 'campus-adapters', VERSION: 'v9.8.7', RUNNER_TEMP: runtime },
    encoding: 'utf8',
  });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(runtime, 'build-arguments'), 'utf8').trim().split('\n'), [path.join(runtime, 'release-payload/stuhelper-oracle-sync'), `v9.8.7@${revision}`]);
  assert(!fs.existsSync(path.join(runtime, 'unverified-upload')));
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'release-output')), []);
});
