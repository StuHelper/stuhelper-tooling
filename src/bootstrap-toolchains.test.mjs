import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const setupDir = fileURLToPath(new URL('../actions/setup', import.meta.url));
const postgresScript = path.join(setupDir, 'postgres.sh');
const summaryScript = path.join(setupDir, 'summary.sh');

function runBash(script, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', status => resolve({ status, stdout, stderr }));
  });
}

test('postgres.sh reuses preinstalled packages, rejects tampered PGDG keys and flushes unified setup summary', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-pg-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const pgRoot = path.join(directory, 'pgroot');
  const pgBin = path.join(pgRoot, '18/bin');
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(bin);
  fs.mkdirSync(pgBin, { recursive: true });
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(pgBin, 'initdb'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pgBin, 'postgres'), '#!/usr/bin/env bash\necho "postgres (PostgreSQL) 18.7"\n', { mode: 0o755 });

  fs.writeFileSync(path.join(pgBin, 'psql'), '#!/bin/sh\necho 18.7\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'dpkg-query'),
    `#!/usr/bin/env bash
if [[ "$1" == "-W" && "$2" == '-f=\${Status}\\n' && "$3" == postgresql-18 && "$4" == postgresql-client-18 ]]; then
  printf 'install ok installed\\ninstall ok installed\\n'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  const githubEnv = path.join(directory, 'github.env');
  const summaryFile = path.join(directory, 'summary.md');
  fs.writeFileSync(githubEnv, '');

  const init = await runBash(summaryScript, { cwd: directory, env: { ...process.env, STUHELPER_SETUP_RECORDS: '', RUNNER_TEMP: runtime, GITHUB_ENV: githubEnv } });
  // summary.sh expects "init" or "flush"; invoke init explicitly via spawnSync:
  assert.notEqual(init.status, 0);
  execFileSync('bash', [summaryScript, 'init'], { env: { ...process.env, STUHELPER_SETUP_RECORDS: '', RUNNER_TEMP: runtime, GITHUB_ENV: githubEnv } });
  const recordsPath = fs.readFileSync(githubEnv, 'utf8').trim().split('=')[1];
  assert.ok(fs.existsSync(recordsPath));

  const pre = await runBash(postgresScript, {
    cwd: directory,
    env: {
      ...process.env, STUHELPER_SETUP_RECORDS: '',
      PATH: `${bin}:/usr/bin:/bin`,
      RUNNER_TEMP: runtime,
      GITHUB_ENV: githubEnv,
      STUHELPER_PG_ROOT: pgRoot,
      STUHELPER_SETUP_RECORDS: recordsPath,
    },
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.match(fs.readFileSync(githubEnv, 'utf8'), new RegExp(`^STUHELPER_TEST_PG_BIN=${pgBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

  execFileSync('bash', [summaryScript, 'flush'], { env: { ...process.env, STUHELPER_SETUP_RECORDS: '', STUHELPER_SETUP_RECORDS: recordsPath, GITHUB_STEP_SUMMARY: summaryFile, GITHUB_ENV: githubEnv } });
  assert.ok(!fs.existsSync(recordsPath));
  assert.match(fs.readFileSync(githubEnv, 'utf8'), /^STUHELPER_SETUP_RECORDS=$/m);
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /\| PostgreSQL \| `18\.7` \| preinstalled \| \d+\.\d{2} s \|/);

  // Missing package + forged PGDG key must fail SHA-256 verification before sudo install.
  const osRelease = path.join(directory, 'os-release');
  fs.writeFileSync(osRelease, 'ID=ubuntu\nVERSION_CODENAME=resolute\n');
  fs.writeFileSync(path.join(bin, 'dpkg-query'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'curl'),
    '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == "--output" ]]; then printf "forged-key" > "$2"; exit 0; fi; shift; done\nexit 1\n',
    { mode: 0o755 },
  );
  const sudoMarker = path.join(directory, 'sudo-called');
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/usr/bin/env bash\ntouch "${sudoMarker}"\nexit 0\n`, { mode: 0o755 });

  const forged = await runBash(postgresScript, {
    cwd: directory,
    env: {
      ...process.env, STUHELPER_SETUP_RECORDS: '',
      PATH: `${bin}:/usr/bin:/bin`,
      RUNNER_TEMP: runtime,
      GITHUB_ENV: githubEnv,
      STUHELPER_OS_RELEASE: osRelease,
      STUHELPER_PG_ROOT: pgRoot,
    },
  });
  assert.notEqual(forged.status, 0);
  assert.ok(!fs.existsSync(sudoMarker));
});

test('tool metrics classify reuse without running the unverified preinstall', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-metrics-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const records = path.join(root, 'records');
  const binary = path.join(root, 'pnpm');
  const marker = path.join(root, 'started');
  fs.writeFileSync(binary, '#!/bin/sh\necho started >> "$MARKER"\necho 2.0.1\n', {mode: 0o755});
  const env = {...process.env, STUHELPER_SETUP_RECORDS: records, PATH: root + ':' + process.env.PATH, MARKER: marker};
  for (const replace of [false, true]) {
    execFileSync('bash', [summaryScript, 'start', 'pnpm'], {env});
    assert.ok(!fs.existsSync(marker));
    if (replace) fs.appendFileSync(binary, '# replaced\n');
    execFileSync('bash', [summaryScript, 'record', 'pnpm', 'verified npm archive'], {env});
    assert.ok(fs.existsSync(marker));
    fs.unlinkSync(marker);
  }
  const data = fs.readFileSync(records, 'utf8');
  assert.match(data, /pnpm\t2\.0\.1\tpreinstalled\t/);
  assert.match(data, /pnpm\t2\.0\.1\tverified npm archive\t/);
});
