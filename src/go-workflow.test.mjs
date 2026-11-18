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
const validatePostgres = action.runs.steps.find(step => step.name === 'Validate PostgreSQL option and process identity');
const privateModules = action.runs.steps.find(step => step.name === 'Download private Go dependencies');
const cleanup = action.runs.steps.find(step => step.name === 'Remove temporary credential helper');
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
  const invoke = job.steps.find(step => step.uses === './.tools/stuhelper-workflow/actions/repository-check');
  assert.equal(invoke.with['go-version-file'], '.go-version');
  assert.equal(invoke.with.postgres, '${{ inputs.postgres }}');
  assert.equal(workflow.on.workflow_call.inputs.postgres.default, 'false');
  assert.equal(invoke.with['modules-read-token'], undefined);
  const privateWorkflow = YAML.parse(fs.readFileSync('.github/workflows/go-checks-private.yml', 'utf8'));
  assert.equal(privateWorkflow.jobs.check.if, 'github.event.repository.private');
  assert.equal(privateWorkflow.jobs.check.steps.at(-1).with['modules-read-token'], '${{ secrets.modules-read-token }}');
  assert.equal(privateModules.env.GH_TOKEN, '${{ inputs.modules-read-token }}');
  assert.match(cleanup.if, /always\(\)/);
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

test('postgres option validates boolean strings and populates container identity when missing', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-go-pg-opt-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const envFile = path.join(directory, 'github.env');
  fs.writeFileSync(envFile, '');
  const baseEnv = { ...process.env, GITHUB_ENV: envFile };
  delete baseEnv.USER;
  delete baseEnv.LOGNAME;

  const enabled = spawnSync('bash', ['-c', validatePostgres.run], { cwd: directory, env: { ...baseEnv, POSTGRES_INPUT: 'true' }, encoding: 'utf8' });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(fs.readFileSync(envFile, 'utf8'), /^USER=.+\nLOGNAME=.+\n$/);

  const disabled = spawnSync('bash', ['-c', validatePostgres.run], { cwd: directory, env: { ...baseEnv, POSTGRES_INPUT: 'false' }, encoding: 'utf8' });
  assert.equal(disabled.status, 0, disabled.stderr);

  const invalid = spawnSync('bash', ['-c', validatePostgres.run], { cwd: directory, env: { ...baseEnv, POSTGRES_INPUT: 'yes' }, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
});

test('private Go module step skips when token is absent, isolates gitconfig when provided, rejects public callers and always cleans up', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-go-private-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  const envFile = path.join(directory, 'github.env');
  fs.mkdirSync(bin);
  fs.mkdirSync(runtime);
  fs.writeFileSync(envFile, '');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/usr/bin/env bash\nset -eu\ntest "$1 $2 $3 $4" = "auth setup-git --hostname github.com"\nprintf "[credential]\\n\\thelper = stub\\n" > "$GIT_CONFIG_GLOBAL"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'go'),
    '#!/usr/bin/env bash\nset -eu\ntest "$1 $2" = "mod download"\ntest -f "$GIT_CONFIG_GLOBAL"\ntest "$GOPRIVATE" = "github.com/StuHelper/*"\nprintf downloaded > "$RUNNER_TEMP/downloaded"\n',
    { mode: 0o755 },
  );
  const gitconfig = path.join(runtime, 'go-modules.gitconfig');
  const execEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runtime, GITHUB_ENV: envFile, GIT_CONFIG_GLOBAL: gitconfig, GOPRIVATE: 'github.com/StuHelper/*' };

  const skipped = spawnSync('bash', ['-c', privateModules.run], { cwd: directory, env: { ...execEnv, GH_TOKEN: '', REPOSITORY_PRIVATE: 'false' }, encoding: 'utf8' });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert(!fs.existsSync(path.join(runtime, 'downloaded')));
  assert(!fs.existsSync(gitconfig));

  const rejectedPublic = spawnSync('bash', ['-c', privateModules.run], { cwd: directory, env: { ...execEnv, GH_TOKEN: 'stub-token', REPOSITORY_PRIVATE: 'false' }, encoding: 'utf8' });
  assert.notEqual(rejectedPublic.status, 0);
  assert.match(rejectedPublic.stderr, /Public repositories must not use modules-read-token/);
  assert(!fs.existsSync(gitconfig));

  const downloaded = spawnSync('bash', ['-c', privateModules.run], { cwd: directory, env: { ...execEnv, GH_TOKEN: 'stub-token', REPOSITORY_PRIVATE: 'true' }, encoding: 'utf8' });
  assert.equal(downloaded.status, 0, downloaded.stderr);
  assert.equal(fs.readFileSync(path.join(runtime, 'downloaded'), 'utf8'), 'downloaded');
  assert.match(fs.readFileSync(envFile, 'utf8'), /^GOPRIVATE=github\.com\/StuHelper\/\*\n$/);
  assert(fs.existsSync(gitconfig));

  const cleaned = spawnSync('bash', ['-c', cleanup.run], { cwd: directory, env: { ...process.env, RUNNER_TEMP: runtime }, encoding: 'utf8' });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert(!fs.existsSync(gitconfig));
});
