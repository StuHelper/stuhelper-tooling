import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { checkRepository } from './repository.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-io-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  execFileSync('git', ['init', '-q', root]);
  return root;
}
test('large unignored opaque files do not need a file-sized buffer', t => {
  const root = fixture(t);
  const asset = path.join(root, 'video.bin');
  fs.closeSync(fs.openSync(asset, 'w'));
  fs.truncateSync(asset, 2 ** 31 + 1);
  assert.equal(checkRepository(root), 1);
  assert.equal(fs.statSync(asset).size, 2 ** 31 + 1);
});
test('large Git index output is inspected through its final entry', t => {
  const root = fixture(t);
  const git = (args, options) => execFileSync('git', args, { cwd: root, ...options });
  const oid = git(['hash-object', '-w', '--stdin'], { input: 'x', encoding: 'utf8' }).trim();
  const records = Array.from({ length: 6500 }, (_, i) => '100644 ' + oid + '\t' + 'a'.repeat(125) + i + '\n');
  git(['update-index', '--index-info'], { input: records.join('') });
  fs.writeFileSync(path.join(root, 'z.json'), '{');
  assert.throws(() => checkRepository(root), /z.json:/);
});
