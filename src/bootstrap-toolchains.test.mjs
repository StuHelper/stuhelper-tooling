import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const setupDir = fileURLToPath(new URL('../actions/setup', import.meta.url));
const toolchainsScript = path.join(setupDir, 'arc-toolchains.sh');
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

function archNames() {
  const machine = os.machine();
  if (machine === 'x86_64') return { nodeArch: 'x64', goArch: 'amd64' };
  if (machine === 'aarch64' || machine === 'arm64') return { nodeArch: 'arm64', goArch: 'arm64' };
  throw new Error(`Unsupported test architecture: ${machine}`);
}

test('arc-toolchains reuses preinstalled tools and records preinstalled summary rows', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-arc-pre-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(bin);
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(directory, '.node-version'), `${process.versions.node}\n`);
  fs.writeFileSync(path.join(directory, '.go-version'), '1.27.3\n');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.33.4' }));
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\necho 10.33.4\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'go'), '#!/usr/bin/env bash\necho "go version go1.27.3 linux/amd64"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gcc'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'make'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const githubEnv = path.join(directory, 'github.env');
  const githubPath = path.join(directory, 'github.path');
  const summaryFile = path.join(directory, 'summary.md');
  fs.writeFileSync(githubEnv, '');
  fs.writeFileSync(githubPath, '');

  const result = await runBash(toolchainsScript, {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      RUNNER_TEMP: runtime,
      GITHUB_ENV: githubEnv,
      GITHUB_PATH: githubPath,
      GITHUB_STEP_SUMMARY: summaryFile,
      STUHELPER_SETUP_RECORDS: '',
      GO_VERSION_FILE: '.go-version',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(githubPath, 'utf8'), '');
  const envOut = fs.readFileSync(githubEnv, 'utf8');
  assert.match(envOut, /^GOTOOLCHAIN=local$/m);
  assert.match(envOut, /^NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org$/m);
  const summary = fs.readFileSync(summaryFile, 'utf8');
  assert.match(summary, /\| Node\.js \| `v[^`]+` \| preinstalled \| \d+\.\d{2} s \|/);
  assert.match(summary, /\| pnpm \| `10\.33\.4` \| preinstalled \| \d+\.\d{2} s \|/);
  assert.match(summary, /\| Go \| `1\.27\.3` \| preinstalled \| \d+\.\d{2} s \|/);
});

test('arc-toolchains downloads missing Node, pnpm and Go via ranged HTTP with Go fallback and rejects corrupt digests', async t => {
  const { nodeArch, goArch } = archNames();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-arc-dl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const build = path.join(directory, 'build');
  fs.mkdirSync(build);

  const nodeVersion = '99.1.2';
  const pnpmVersion = '99.3.4';
  const goVersion = '99.5.6';
  const nodeArchive = `node-v${nodeVersion}-linux-${nodeArch}.tar.xz`;
  const goArchive = `go${goVersion}.linux-${goArch}.tar.gz`;

  const nodeDir = path.join(build, `node-v${nodeVersion}-linux-${nodeArch}/bin`);
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(nodeDir, 'node'),
    `#!/usr/bin/env bash\nif [[ "\${1:-}" == "--version" ]]; then echo "v${nodeVersion}"; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  execFileSync('tar', ['-cJf', path.join(build, nodeArchive), '-C', build, `node-v${nodeVersion}-linux-${nodeArch}`]);
  const nodeBytes = fs.readFileSync(path.join(build, nodeArchive));
  const nodeSha256 = crypto.createHash('sha256').update(nodeBytes).digest('hex');

  const pnpmPkgDir = path.join(build, 'package/bin');
  fs.mkdirSync(pnpmPkgDir, { recursive: true });
  fs.writeFileSync(path.join(pnpmPkgDir, 'pnpm.cjs'), `#!/usr/bin/env bash\necho "${pnpmVersion}"\n`, { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(build, 'pnpm.tgz'), '-C', build, 'package']);
  const pnpmBytes = fs.readFileSync(path.join(build, 'pnpm.tgz'));
  const pnpmIntegrity = `sha512-${crypto.createHash('sha512').update(pnpmBytes).digest('base64')}`;

  const goBinDir = path.join(build, 'go/bin');
  fs.mkdirSync(goBinDir, { recursive: true });
  fs.writeFileSync(path.join(goBinDir, 'go'), `#!/usr/bin/env bash\necho "go version go${goVersion} linux/${goArch}"\n`, { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(build, goArchive), '-C', build, 'go']);
  const goBytes = fs.readFileSync(path.join(build, goArchive));
  const goSha256 = crypto.createHash('sha256').update(goBytes).digest('hex');

  let corruptPnpm = false;
  let primaryGoAttempts = 0;
  const serveRange = (req, res, buf) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': buf.length });
      return res.end();
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (!match) {
      res.writeHead(200, { 'content-length': buf.length });
      return res.end(buf);
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const slice = buf.subarray(start, end + 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': slice.length });
    res.end(slice);
  };

  const server = http.createServer((req, res) => {
    if (req.url === `/nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`) {
      return res.end(`${nodeSha256}  ${nodeArchive}\n`);
    }
    if (req.url === `/nodejs.org/dist/v${nodeVersion}/${nodeArchive}`) {
      return serveRange(req, res, nodeBytes);
    }
    if (req.url === `/registry.npmjs.org/pnpm/${pnpmVersion}`) {
      return res.end(JSON.stringify({ dist: { integrity: pnpmIntegrity } }));
    }
    if (req.url === `/registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz`) {
      return res.end(corruptPnpm ? Buffer.from('corrupted-tgz') : pnpmBytes);
    }
    if (req.url === '/go.dev/dl/?mode=json&include=all') {
      return res.end(JSON.stringify([{ stable: true, files: [{ filename: goArchive, sha256: goSha256, size: goBytes.length }] }]));
    }
    if (req.url === `/dl.google.com/go/${goArchive}`) {
      primaryGoAttempts += 1;
      res.writeHead(503);
      return res.end();
    }
    if (req.url === `/golang.google.cn/dl/${goArchive}`) {
      return serveRange(req, res, goBytes);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const stubBin = path.join(directory, 'stub-bin');
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, 'gcc'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubBin, 'make'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  // Rewrite official HTTPS origins to the local HTTP fixture while running real /usr/bin/curl.
  fs.writeFileSync(
    path.join(stubBin, 'curl'),
    `#!/usr/bin/env bash
args=()
for arg in "$@"; do
  arg="\${arg/#https:\\/\\/nodejs.org\\//http://127.0.0.1:${port}/nodejs.org/}"
  arg="\${arg/#https:\\/\\/registry.npmjs.org\\//http://127.0.0.1:${port}/registry.npmjs.org/}"
  arg="\${arg/#https:\\/\\/go.dev\\//http://127.0.0.1:${port}/go.dev/}"
  arg="\${arg/#https:\\/\\/dl.google.com\\//http://127.0.0.1:${port}/dl.google.com/}"
  arg="\${arg/#https:\\/\\/golang.google.cn\\//http://127.0.0.1:${port}/golang.google.cn/}"
  if [[ "$arg" == "--speed-time" ]]; then args+=("--retry-delay" "0" "--speed-time"); else args+=("$arg"); fi
done
exec /usr/bin/curl "\${args[@]}"
`,
    { mode: 0o755 },
  );
  // Avoid waiting 3 seconds per failed ranged attempt when testing Go fallback.
  fs.writeFileSync(path.join(stubBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const work = path.join(directory, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, '.node-version'), `${nodeVersion}\n`);
  fs.writeFileSync(path.join(work, '.go-version'), `${goVersion}\n`);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ packageManager: `pnpm@${pnpmVersion}` }));

  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(runtime);
  const githubEnv = path.join(directory, 'github.env');
  const githubPath = path.join(directory, 'github.path');
  const summaryFile = path.join(directory, 'summary.md');
  fs.writeFileSync(githubEnv, '');
  fs.writeFileSync(githubPath, '');

  const ok = await runBash(toolchainsScript, {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${stubBin}:/usr/bin:/bin`,
      RUNNER_TEMP: runtime,
      GITHUB_ENV: githubEnv,
      GITHUB_PATH: githubPath,
      GITHUB_STEP_SUMMARY: summaryFile,
      STUHELPER_SETUP_RECORDS: '',
      GO_VERSION_FILE: '.go-version',
    },
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(primaryGoAttempts > 0, 'Expected primary Go endpoint attempt before fallback');
  assert.equal(fs.readFileSync(githubPath, 'utf8').trim().split('\n').length, 3);
  const summary = fs.readFileSync(summaryFile, 'utf8');
  assert.match(summary, new RegExp(`\\| Node\\.js \\| \`v${nodeVersion}\` \\| downloaded \\|`));
  assert.match(summary, new RegExp(`\\| pnpm \\| \`${pnpmVersion}\` \\| downloaded \\|`));
  assert.match(summary, new RegExp(`\\| Go \\| \`${goVersion}\` \\| downloaded \\|`));

  corruptPnpm = true;
  const badPath = path.join(directory, 'bad.path');
  fs.writeFileSync(badPath, '');
  const bad = await runBash(toolchainsScript, {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${stubBin}:/usr/bin:/bin`,
      RUNNER_TEMP: runtime,
      GITHUB_ENV: githubEnv,
      GITHUB_PATH: badPath,
    },
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /pnpm integrity mismatch/);
});

test('postgres.sh reuses preinstalled packages, rejects tampered PGDG keys and flushes unified setup summary', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-pg-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const pgRoot = path.join(directory, 'pgroot');
  const pgBin = path.join(pgRoot, '17/bin');
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(bin);
  fs.mkdirSync(pgBin, { recursive: true });
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(pgBin, 'initdb'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(pgBin, 'postgres'), '#!/usr/bin/env bash\necho "postgres (PostgreSQL) 17.4"\n', { mode: 0o755 });

  fs.writeFileSync(
    path.join(bin, 'dpkg-query'),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "-W" && "\${2:-}" == '-f=\${Status}' ]]; then
  printf 'install ok installed'
  exit 0
fi
if [[ "\${1:-}" == "-W" && "\${2:-}" == '-f=\${Depends}' ]]; then
  printf 'postgresql-17'
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );

  const githubEnv = path.join(directory, 'github.env');
  const summaryFile = path.join(directory, 'summary.md');
  fs.writeFileSync(githubEnv, '');

  const init = await runBash(summaryScript, { cwd: directory, env: { ...process.env, RUNNER_TEMP: runtime, GITHUB_ENV: githubEnv } });
  // summary.sh expects "init" or "flush"; invoke init explicitly via spawnSync:
  assert.notEqual(init.status, 0);
  execFileSync('bash', [summaryScript, 'init'], { env: { ...process.env, RUNNER_TEMP: runtime, GITHUB_ENV: githubEnv } });
  const recordsPath = fs.readFileSync(githubEnv, 'utf8').trim().split('=')[1];
  assert.ok(fs.existsSync(recordsPath));

  const pre = await runBash(postgresScript, {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      RUNNER_TEMP: runtime,
      GITHUB_ENV: githubEnv,
      STUHELPER_PG_ROOT: pgRoot,
      STUHELPER_SETUP_RECORDS: recordsPath,
    },
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.match(fs.readFileSync(githubEnv, 'utf8'), new RegExp(`^STUHELPER_TEST_PG_BIN=${pgBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));

  execFileSync('bash', [summaryScript, 'flush'], { env: { ...process.env, STUHELPER_SETUP_RECORDS: recordsPath, GITHUB_STEP_SUMMARY: summaryFile, GITHUB_ENV: githubEnv } });
  assert.ok(!fs.existsSync(recordsPath));
  assert.match(fs.readFileSync(githubEnv, 'utf8'), /^STUHELPER_SETUP_RECORDS=$/m);
  assert.match(fs.readFileSync(summaryFile, 'utf8'), /\| PostgreSQL \| `17\.4` \| preinstalled \| \d+\.\d{2} s \|/);

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
      ...process.env,
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
