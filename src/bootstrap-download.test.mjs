import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../actions/setup/download.sh', import.meta.url));

async function fixture(t, failures) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-download-'));
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    if (requests <= failures) request.socket.destroy();
    else response.end('complete pinned bootstrap payload');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true });
  });
  return { directory, url: `http://127.0.0.1:${server.address().port}/payload`, requests: () => requests };
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const process = spawn('bash', [script, url, destination], { stdio: 'ignore' });
    process.on('error', reject);
    process.on('exit', code => resolve(code));
  });
}

test('bootstrap retries reset connections and publishes only the complete payload', async t => {
  const f = await fixture(t, 2);
  const destination = path.join(f.directory, 'asset');
  assert.equal(await download(f.url, destination), 0);
  assert.equal(f.requests(), 3);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'complete pinned bootstrap payload');
  assert.deepEqual(fs.readdirSync(f.directory), ['asset']);
});

test('persistent transport failures stop after four requests and leave no partial file', async t => {
  const f = await fixture(t, Infinity);
  assert.notEqual(await download(f.url, path.join(f.directory, 'asset')), 0);
  assert.equal(f.requests(), 4);
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('bootstrap preserves an existing destination without issuing a request', async t => {
  const f = await fixture(t, 0);
  const destination = path.join(f.directory, 'asset');
  fs.writeFileSync(destination, 'existing verified payload');
  assert.notEqual(await download(f.url, destination), 0);
  assert.equal(f.requests(), 0);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'existing verified payload');
});
