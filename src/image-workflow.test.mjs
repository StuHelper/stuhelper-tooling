import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const steps = YAML.parse(fs.readFileSync(new URL('../actions/publish-image/action.yml', import.meta.url), 'utf8')).runs.steps;
const validateStep = steps.find(step => step.name === 'Validate release selection');
const ancestryStep = steps.find(step => step.name === 'Verify tag and release ancestry');
const buildStep = steps.find(step => step.name === 'Build and publish fixed source');
const cleanupStep = steps.find(step => step.name === 'Remove temporary authentication');

test('image.yml validates release inputs, creates isolated auth directory and cleans it up', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-image-val-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(runtime);
  const output = path.join(directory, 'output.txt');
  const envFile = path.join(directory, 'env.txt');
  fs.writeFileSync(output, '');
  fs.writeFileSync(envFile, '');

  const valid = spawnSync('bash', ['-c', validateStep.run], {
    cwd: directory,
    env: {
      ...process.env,
      RUNNER_TEMP: runtime,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: envFile,
      APPLICATION: 'web',
      VERSION: 'v1.2.3',
      RUNNER_ENVIRONMENT: 'self-hosted', STUHELPER_OCI_REGISTRY: 'registry.stuhelper.example:5000',
      BUILDKIT_HOST: 'tcp://buildkitd.arc.svc:1234',
    },
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  const authDir = /^auth-directory=(.+)$/m.exec(fs.readFileSync(output, 'utf8'))?.[1];
  assert.ok(authDir && fs.existsSync(authDir));
  assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp(`^DOCKER_CONFIG=${authDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

  for (const override of [
    { APPLICATION: 'unknown' },
    { VERSION: 'main' },
    { STUHELPER_OCI_REGISTRY: 'https://bad-scheme' },
    { BUILDKIT_HOST: 'unix:///var/run/buildkitd.sock' },
  ]) {
    const failed = spawnSync('bash', ['-c', validateStep.run], {
      cwd: directory,
      env: {
        ...process.env,
        RUNNER_TEMP: runtime,
        GITHUB_OUTPUT: output,
        GITHUB_ENV: envFile,
        APPLICATION: 'backend',
        VERSION: 'v1.0.0',
        RUNNER_ENVIRONMENT: 'self-hosted', STUHELPER_OCI_REGISTRY: 'registry.example.com', REGISTRY: 'registry.example.com', IMAGE_PATH: 'stuhelper-next/backend',
        BUILDKIT_HOST: 'tcp://buildkitd:1234',
        ...override,
      },
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
  }

  const cleaned = spawnSync('bash', ['-c', cleanupStep.run], {
    cwd: directory,
    env: { ...process.env, AUTH_DIRECTORY: authDir },
    encoding: 'utf8',
  });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.ok(!fs.existsSync(path.join(authDir, 'config.json')));
});

test('image.yml enforces annotated tag ancestry on origin/main and verifies digest publication', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-image-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'tag.gpgSign', 'false');
  fs.writeFileSync(path.join(directory, '.node-version'), '24.22.1\n');
  fs.writeFileSync(path.join(directory, '.go-version'), '1.27.3\n');
  git('add', '.');
  git('commit', '-qm', 'release commit');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('tag', '-a', 'v1.0.0', '-m', 'annotated v1.0.0');
  git('update-ref', 'refs/tags/v1.0.1', 'HEAD');

  const okAncestry = spawnSync('bash', ['-c', ancestryStep.run], { cwd: directory, env: { ...process.env, VERSION: 'v1.0.0' }, encoding: 'utf8' });
  assert.equal(okAncestry.status, 0, okAncestry.stderr);
  const badLightweight = spawnSync('bash', ['-c', ancestryStep.run], { cwd: directory, env: { ...process.env, VERSION: 'v1.0.1' }, encoding: 'utf8' });
  assert.notEqual(badLightweight.status, 0);

  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const summaryFile = path.join(directory, 'summary.md');
  fs.mkdirSync(bin);
  fs.mkdirSync(runtime);
  const digest = `sha256:${'a'.repeat(64)}`;
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/usr/bin/env bash
set -eu
if [[ "$1 $2 $3" == "buildx imagetools inspect" ]]; then
  case "\${MOCK_INSPECT:-missing}" in
    exists) exit 0 ;;
    auth-error) echo "unauthorized: authentication required" >&2; exit 1 ;;
    *) echo "ERROR: not found" >&2; exit 1 ;;
  esac
fi
if [[ "$1 $2" == "buildx build" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--metadata-file" ]]; then
      printf '{"containerimage.digest":"${digest}"}\\n' > "$2"
      exit 0
    fi
    shift
  done
fi
exit 1
`,
    { mode: 0o755 },
  );

  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: runtime,
    GITHUB_STEP_SUMMARY: summaryFile,
    RUNNER_ENVIRONMENT: 'self-hosted', STUHELPER_OCI_REGISTRY: 'registry.example.com', REGISTRY: 'registry.example.com', IMAGE_PATH: 'stuhelper-next/backend',
    APPLICATION: 'backend',
    VERSION: 'v1.0.0',
    BUILDER: 'builder-0',
  };

  const existing = spawnSync('bash', ['-c', buildStep.run], { cwd: directory, env: { ...baseEnv, MOCK_INSPECT: 'exists' }, encoding: 'utf8' });
  assert.notEqual(existing.status, 0);
  assert.match(existing.stderr, /Release image already exists/);

  const authError = spawnSync('bash', ['-c', buildStep.run], { cwd: directory, env: { ...baseEnv, MOCK_INSPECT: 'auth-error' }, encoding: 'utf8' });
  assert.notEqual(authError.status, 0);
  assert.match(authError.stderr, /Cannot confirm that the release image is absent/);

  const published = spawnSync('bash', ['-c', buildStep.run], { cwd: directory, env: { ...baseEnv, MOCK_INSPECT: 'missing' }, encoding: 'utf8' });
  assert.equal(published.status, 0, published.stderr);
  const summary = fs.readFileSync(summaryFile, 'utf8');
  assert.match(summary, new RegExp(`registry\\.example\\.com/stuhelper-next/backend:v1\\.0\\.0@${digest}`));
});
