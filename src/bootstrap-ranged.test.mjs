import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../actions/setup/download-ranged.sh', import.meta.url));
const payload = Buffer.from('verified toolchain archive bytes; four ranges with uneven sizes');

async function fixture(t, mode = 'ranges') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-ranges-'));
  const ranges = [];
  const server = http.createServer((request, response) => {
    ranges.push(request.headers.range);
    if (mode === 'ignore') {
      response.writeHead(200, { 'content-length': payload.length });
      return response.end(payload);
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) { response.writeHead(400); return response.end(); }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const chunk = payload.subarray(start, end + 1);
    const body = mode === 'truncated' ? chunk.subarray(1) : chunk;
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}`, 'content-length': body.length });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true });
  });
  return { directory, ranges, url: `http://127.0.0.1:${server.address().port}/toolchain` };
}

function download(f, size = payload.length) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, f.url, path.join(f.directory, 'asset'), String(size)], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}

test('ranged download reassembles the complete archive in byte order and removes temporary parts', async t => {
  const f = await fixture(t);
  assert.equal(await download(f), 0);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'asset')), payload);
  assert.equal(new Set(f.ranges).size, 4);
  assert.deepEqual(fs.readdirSync(f.directory), ['asset']);
});

for (const mode of ['ignore', 'truncated']) {
  test(`ranged download rejects ${mode} ranges without publishing a partial archive`, async t => {
    const f = await fixture(t, mode);
    assert.notEqual(await download(f), 0);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  });
}

test('ranged download rejects invalid sizes before making requests and preserves existing destinations', async t => {
  const f = await fixture(t);
  for (const size of [0, -1, 'invalid', 268435457]) assert.notEqual(await download(f, size), 0);
  fs.writeFileSync(path.join(f.directory, 'asset'), 'existing');
  assert.notEqual(await download(f), 0);
  assert.equal(f.ranges.length, 0);
  assert.equal(fs.readFileSync(path.join(f.directory, 'asset'), 'utf8'), 'existing');
});

test('actionlint checksum mismatch fails before extracting or publishing a tool path', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-corrupt-tool-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, 'bin', 'curl'), '#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == --output ]]; then printf corrupt > "$2"; exit 0; fi; shift; done\nexit 1\n', { mode: 0o755 });
  const action = fileURLToPath(new URL('../actions/setup/actionlint.sh', import.meta.url));
  const code = await new Promise((resolve, reject) => {
    const child = spawn('bash', [action], { stdio: 'ignore', env: { ...process.env, PATH: `${directory}/bin:/usr/bin:/bin`, RUNNER_TEMP: directory, GITHUB_PATH: `${directory}/paths` } });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  assert.notEqual(code, 0);
  assert.deepEqual(fs.readdirSync(directory), ['bin']);
});
