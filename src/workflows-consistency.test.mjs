import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import YAML from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readWorkflow = name => YAML.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));

test('shared workflows pin consistent actions/setup version tags and forbid SHA or branch references', () => {
  const reusable = ['go-checks.yml', 'node-checks.yml', 'release.yml'];
  const setupRefs = reusable.map(name => {
    const wf = readWorkflow(name);
    const job = Object.values(wf.jobs)[0];
    const step = job.steps.find(item => item.uses?.startsWith('StuHelper/stuhelper-tooling/actions/setup@'));
    assert.ok(step, `${name} must invoke StuHelper/stuhelper-tooling/actions/setup`);
    return step.uses.split('@')[1];
  });
  assert.equal(new Set(setupRefs).size, 1, `Mismatched actions/setup versions: ${setupRefs.join(', ')}`);
  const pinnedTag = setupRefs[0];
  assert.match(pinnedTag, /^v\d+\.\d+\.\d+$/);

  let currentTagReleased = false;
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', `refs/tags/v${pkg.version}`], { stdio: 'ignore' });
    currentTagReleased = true;
  } catch { /* Unreleased candidate version prior to tag creation. */ }
  if (currentTagReleased) {
    assert.equal(pinnedTag, `v${pkg.version}`, `Workflows must use released tag v${pkg.version}`);
  }

  const testWorkflow = readWorkflow('test.yml');
  assert.ok(testWorkflow.jobs.check.steps.some(step => step.uses === './actions/setup'));

  for (const file of fs.readdirSync(path.join(root, '.github/workflows')).filter(name => name.endsWith('.yml'))) {
    const wf = readWorkflow(file);
    for (const job of Object.values(wf.jobs)) {
      if (job.uses && !job.uses.startsWith('./')) assert.match(job.uses, /@v\d+\.\d+\.\d+$/);
      for (const step of job.steps ?? []) {
        if (!step.uses || step.uses.startsWith('./')) continue;
        assert.match(step.uses, /@v\d+\.\d+\.\d+$/, `${file}: external action ${step.uses} must use an explicit version tag`);
        if (step.uses.startsWith('actions/checkout@')) {
          assert.equal(step.with?.['persist-credentials'], false, `${file}: checkout must disable persist-credentials`);
        }
      }
    }
  }
});

test('public runner forced-downgrade and image release isolation guards stay intact', () => {
  const expectedRunsOn = "${{ fromJSON(github.event.repository.private && inputs.runs-on || '\"ubuntu-26.04\"') }}";
  for (const name of ['go-checks.yml', 'node-checks.yml', 'release.yml']) {
    const job = Object.values(readWorkflow(name).jobs)[0];
    assert.equal(job['runs-on'], expectedRunsOn, name);
  }
  const imagePublish = readWorkflow('image.yml').jobs.publish;
  assert.equal(imagePublish.if, "github.event_name != 'pull_request' && github.event_name != 'pull_request_target'");
  assert.equal(imagePublish.environment, 'release');
  assert.match(imagePublish['runs-on'].group, /stuhelper-arc-release/);
  assert.match(imagePublish['runs-on'].labels, /stuhelper-arc-sh-release/);

  const isolation = readWorkflow('runner-isolation.yml').jobs.guard;
  assert.equal(isolation.uses, './.github/workflows/node-checks.yml');
  assert.match(isolation.with['check-command'], /RUNNER_ENVIRONMENT.*github-hosted/);
});

test('reusable Node checks run optional setup before check command and propagate failures', t => {
  const job = readWorkflow('node-checks.yml').jobs.check;
  const setup = job.steps.find(step => step.name === 'Prepare the application');
  const check = job.steps.find(step => step.name === 'Check repository');
  assert.equal(setup.if, "inputs.setup-command != ''");
  assert(job.steps.indexOf(setup) < job.steps.indexOf(check));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-node-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const execStep = (step, command) => spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
    cwd: directory,
    env: { ...process.env, [Object.keys(step.env)[0]]: command },
    encoding: 'utf8',
  });
  assert.equal(execStep(setup, 'printf ready > marker').status, 0);
  assert.equal(execStep(check, 'test "$(cat marker)" = ready').status, 0);
  assert.notEqual(execStep(check, 'exit 7').status, 0);
});

test('workflows subcommand enables -color only for TTY or GitHub Actions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-wf-color-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const argsLog = path.join(directory, 'args.txt');
  fs.writeFileSync(path.join(bin, 'actionlint'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsLog}"\n`, { mode: 0o755 });
  const cli = path.join(root, 'bin/stuhelper-check.mjs');

  const plainEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete plainEnv.GITHUB_ACTIONS;
  delete plainEnv.GITHUB_STEP_SUMMARY;
  const plain = spawnSync(process.execPath, [cli, 'workflows'], { cwd: directory, env: plainEnv, encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(fs.readFileSync(argsLog, 'utf8').trim().split('\n'), ['-shellcheck=', '-pyflakes=']);

  const ci = spawnSync(process.execPath, [cli, 'workflows'], {
    cwd: directory,
    env: { ...plainEnv, GITHUB_ACTIONS: 'true' },
    encoding: 'utf8',
  });
  assert.equal(ci.status, 0, ci.stderr);
  assert.deepEqual(fs.readFileSync(argsLog, 'utf8').trim().split('\n'), ['-color', '-shellcheck=', '-pyflakes=']);
});
