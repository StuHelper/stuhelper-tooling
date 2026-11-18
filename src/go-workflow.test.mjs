import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/go-checks.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.check;
const action = YAML.parse(fs.readFileSync(new URL('../actions/repository-check/action.yml', import.meta.url), 'utf8'));
const setup = action.runs.steps.find(step => step.name === 'Prepare repository checks');
const check = action.runs.steps.find(step => step.name === 'Check repository');

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
  assert.equal(setup.env.COMMAND, '${{ inputs.setup-command }}');
  assert.equal(check.env.COMMAND, '${{ inputs.check-command }}');
  assert.match(job.steps[0].uses, /\/actions\/repository-check@v/);
  assert.equal(job.steps[0].with['go-version-file'], '.go-version');
  assert(action.runs.steps.indexOf(setup) < action.runs.steps.indexOf(check));
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
