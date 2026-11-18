import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const action = path.resolve('actions/setup');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-pin-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const stub = (name, cmd) => fs.writeFileSync(path.join(bin, name), '#!/bin/bash\nset -eu\n' + cmd, { mode: 0o755 });
  const run = (name, args = []) => spawnSync('bash', [path.join(action, name), ...args], { cwd: dir, encoding: 'utf8',
    env: { PATH: bin + ':' + process.env.PATH, RUNNER_TEMP: dir, GITHUB_ENV: dir + '/env', GITHUB_PATH: dir + '/paths' } });
  return { dir, stub, run };
}
test('repository digest rejects even a registry-consistent archive and matching preinstalled version', t => {
  const { dir, stub, run } = fixture(t);
  fs.writeFileSync(path.join(dir, '.node-version'), process.versions.node);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@1.2.3+sha256.' + 'a'.repeat(64) }));
  const digest = createHash('sha512').update('archive').digest('base64');
  stub('pnpm', 'echo 1.2.3');
  stub('curl', `args="$*"; while [[ "$1" != --output ]]; do shift; done
    if [[ "$args" == *".tgz"* ]]; then printf archive > "$2"; else printf '%s' '{"dist":{"integrity":"sha512-${digest}"}}' > "$2"; fi`);
  const r = run('arc-toolchains.sh');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /packageManager.*mismatch/i);
  assert.ok(!fs.existsSync(path.join(dir, 'paths')));
});
test('every HTTPS request including parallel ranges restricts redirect protocols', t => {
  const { dir, stub, run } = fixture(t);
  stub('curl', `printf '%s\\n' "$@" > "$RUNNER_TEMP/args"; exit 1`);
  stub('sleep', ':');
  for (const [name, extra] of [['download.sh', []], ['download-ranged.sh', ['8']]]) {
    const r = run(name, ['https://example.invalid/tool', dir + '/out', ...extra]);
    assert.notEqual(r.status, 0);
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8').split('--next\n');
    for (const transfer of args) assert.match(transfer, /--proto-redir\n=https\n/);
    assert.ok(!fs.existsSync(path.join(dir, 'out')));
  }
});
test('HEAD length comes exclusively from the final HTTPS response', t => {
  const { dir, stub, run } = fixture(t);
  fs.writeFileSync(path.join(dir, '.node-version'), '0.0.1');
  stub('curl', `if [[ "$*" == *'--head'* ]]; then
      printf '%s\\n' "$@" > "$RUNNER_TEMP/head-args"
      printf 'HTTP/2 302\\r\\ncontent-length: 10\\r\\n\\r\\nHTTP/2 200\\r\\n\\r\\n'
    elif [[ "$*" == *'--range'* ]]; then touch "$RUNNER_TEMP/range-called"; exit 1
    else while [[ "$1" != --output ]]; do shift; done; touch "$2"; fi`);
  stub('sleep', ':');
  assert.notEqual(run('arc-toolchains.sh').status, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'range-called')));
  assert.match(fs.readFileSync(path.join(dir, 'head-args'), 'utf8'), /--proto-redir\n=https\n/);
});

test('a matching repository pin installs the verified archive', t => {
  const { dir, stub, run } = fixture(t);
  fs.writeFileSync(path.join(dir, '.node-version'), process.versions.node);
  const source = path.join(dir, 'package/bin');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'pnpm.cjs'), '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  const tar = spawnSync('tar', ['-czf', 'fixture.tgz', 'package'], { cwd: dir });
  assert.equal(tar.status, 0);
  const archive = fs.readFileSync(path.join(dir, 'fixture.tgz'));
  const pin = createHash('sha224').update(archive).digest('hex');
  fs.writeFileSync(path.join(dir, 'metadata'), JSON.stringify({ dist: { integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') } }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@1.2.3+sha224.' + pin }));
  stub('curl', `args="$*"; while [[ "$1" != --output ]]; do shift; done
    if [[ "$args" == *".tgz"* ]]; then cp fixture.tgz "$2"; else cp metadata "$2"; fi`);
  const r = run('arc-toolchains.sh');
  assert.equal(r.status, 0, r.stderr);
  const installed = fs.readFileSync(path.join(dir, 'paths'), 'utf8').trim();
  assert.equal(fs.readFileSync(path.join(installed, 'pnpm'), 'utf8'), fs.readFileSync(path.join(source, 'pnpm.cjs'), 'utf8'));
});
