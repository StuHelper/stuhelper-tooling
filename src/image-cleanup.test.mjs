import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

const steps = parse(fs.readFileSync('actions/publish-image/action.yml', 'utf8')).runs.steps;
test('image workflows build the caller source separately from the checked-out tooling', () => {
  for (const file of ['image.yml', 'image-private.yml']) {
    const job = parse(fs.readFileSync(path.join('.github/workflows', file), 'utf8')).jobs.publish;
    const action = job.steps.find(step => step.uses === './.stuhelper-release-tools/actions/publish-image');
    assert.equal(action.with['source-directory'], 'source');
  }
  assert.equal(steps.find(step => step.uses?.startsWith('actions/checkout@')).with.path, '${{ inputs.source-directory }}');
  for (const name of ['Verify tag and release ancestry', 'Build and publish fixed source']) {
    assert.equal(steps.find(step => step.name === name)['working-directory'], '${{ inputs.source-directory }}');
  }
});

test('cleanup removes job authentication while retaining builder state for post actions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, 'buildx/instances'), { recursive: true });
  fs.writeFileSync(path.join(root, 'buildx/instances/job'), 'owned builder');
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  const cleanup = steps.find(step => step.name === 'Remove temporary authentication');
  for (const directory of ['', root]) {
    const result = spawnSync('bash', ['-eu', '-c', cleanup.run], { env: { AUTH_DIRECTORY: directory, DOCKER_CONFIG: root } });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(fs.existsSync(path.join(root, 'config.json')), !directory);
    assert.equal(fs.readFileSync(path.join(root, 'buildx/instances/job'), 'utf8'), 'owned builder');
  }
});

test('an inconclusive registry lookup emits the cause and stops before building', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-lookup-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'docker'), '#!/bin/sh\nif [ "$2" = imagetools ]; then echo "service unavailable" >&2; exit 1; fi\ntouch "$RUNNER_TEMP/built"\n', { mode: 0o755 });
  const build = steps.find(step => step.name === 'Build and publish fixed source');
  const result = spawnSync('bash', ['-c', build.run], { encoding: 'utf8', env: {
    PATH: root + ':' + process.env.PATH, REGISTRY: 'registry.invalid', APPLICATION: 'backend', IMAGE_PATH: 'stuhelper-next/backend', VERSION: 'v1.2.3', RUNNER_TEMP: root,
  } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /service unavailable/);
  assert.ok(!fs.existsSync(path.join(root, 'built')));
});
