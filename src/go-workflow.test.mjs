import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/go-checks.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.check;
const setup = job.steps.find(step => step.name === 'Prepare the module');
const check = job.steps.find(step => step.name === 'Check standalone Go module');

function run(step, command, cwd) {
  const key = Object.keys(step.env)[0];
  return spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], { cwd, env: { ...process.env, GOWORK: job.env.GOWORK, [key]: command }, encoding: 'utf8' });
}

test('reusable Go checks preserve defaults and the stable named check', () => {
  assert.equal(workflow.on.workflow_call.inputs['setup-command'].default, '');
  assert.equal(workflow.on.workflow_call.inputs['check-command'].default, 'make check');
  assert.equal(job.name, '${{ inputs.name }}');
  assert.equal(job.env.GOWORK, 'off');
  assert.equal(setup.if, "inputs.setup-command != ''");
  assert.equal(setup.env.SETUP_COMMAND, '${{ inputs.setup-command }}');
  assert.equal(check.env.CHECK_COMMAND, '${{ inputs.check-command }}');
  assert(job.steps.indexOf(setup) < job.steps.indexOf(check));
});

test('setup and isolated check commands execute in order and propagate failures', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-go-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  assert.equal(run(setup, "printf prepared > prerequisite", directory).status, 0);
  assert.equal(run(check, 'test -f prerequisite && test "$GOWORK" = off', directory).status, 0);
  assert.notEqual(run(setup, 'false; touch should-not-exist', directory).status, 0);
  assert(!fs.existsSync(path.join(directory, 'should-not-exist')));
  assert.notEqual(run(check, 'false | true', directory).status, 0);
});
