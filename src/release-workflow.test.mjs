import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const verifyTag = workflow.jobs.publish.steps.find(step => step.name === 'Verify source tag');
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

test('release verifies annotated tag ancestry, uploads verified assets, refuses duplicate assets and catches corrupt downloads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-release-full-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'tag.gpgSign', 'false');
  fs.mkdirSync(path.join(directory, 'cmd/backend'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'cmd/backend/main.go'), 'package main\nfunc main() {}\n');
  fs.writeFileSync(path.join(directory, 'LICENSE'), 'AGPL-3.0-only\n');
  git('add', '.');
  git('commit', '-qm', 'release source');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('tag', '-a', 'v1.2.0', '-m', 'annotated release');
  git('update-ref', 'refs/tags/v1.2.1', 'HEAD');

  assert.equal(spawnSync('bash', ['-c', verifyTag.run], { cwd: directory, env: { ...process.env, APPLICATION: 'backend', VERSION: 'v1.2.0' }, encoding: 'utf8' }).status, 0);
  assert.notEqual(spawnSync('bash', ['-c', verifyTag.run], { cwd: directory, env: { ...process.env, APPLICATION: 'backend', VERSION: 'v1.2.1' }, encoding: 'utf8' }).status, 0);

  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\necho 10.33.4\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'go'),
    `#!/usr/bin/env bash
set -eu
if [[ "$1" == "version" ]]; then echo "go version go1.27.3 linux/amd64"; exit 0; fi
if [[ "$1" == "build" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-o" ]]; then printf 'binary' > "$2"; chmod +x "$2"; exit 0; fi
    shift
  done
fi
exit 1
`,
    { mode: 0o755 },
  );
  const store = path.join(directory, 'gh-store');
  fs.mkdirSync(store);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -eu
if [[ "$1 $2" == "release view" ]]; then
  if [[ "\${MOCK_GH_MODE:-new}" == "duplicate" ]]; then
    printf '{"assets":[{"name":"SHA256SUMS"}]}\\n'
    exit 0
  fi
  if [[ "$*" == *"--json url,assets"* ]]; then
    printf '{"url":"https://github.com/StuHelper/example/releases/tag/%s","assets":[]}\\n' "$3"
    exit 0
  fi
  exit 1
fi
if [[ "$1 $2" == "release create" ]]; then exit 0; fi
if [[ "$1 $2" == "release upload" ]]; then
  shift 3
  cp -- "$@" "${store}/"
  exit 0
fi
if [[ "$1 $2" == "release download" ]]; then
  cp -- "${store}"/* "$5/"
  if [[ "\${MOCK_GH_MODE:-new}" == "corrupt-download" ]]; then
    printf 'tampered' > "$5/LICENSE"
  fi
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  const runBuild = mode => {
    const runtime = fs.mkdtempSync(path.join(directory, 'run-'));
    const summaryFile = path.join(runtime, 'summary.md');
    fs.writeFileSync(summaryFile, '');
    return spawnSync('bash', ['-euo', 'pipefail', '-c', build.run], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        APPLICATION: 'backend',
        VERSION: 'v1.2.0',
        RUNNER_TEMP: runtime,
        GITHUB_REPOSITORY: 'StuHelper/stuhelper-backend',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '42',
        GITHUB_STEP_SUMMARY: summaryFile,
        MOCK_GH_MODE: mode,
      },
      encoding: 'utf8',
    });
  };

  const ok = runBuild('new');
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(store, 'stuhelper-backend-v1.2.0-linux-amd64.tar.gz')));
  assert.ok(fs.existsSync(path.join(store, 'SHA256SUMS')));

  const duplicate = runBuild('duplicate');
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Asset already exists: SHA256SUMS/);

  const corrupted = runBuild('corrupt-download');
  assert.notEqual(corrupted.status, 0);
});
