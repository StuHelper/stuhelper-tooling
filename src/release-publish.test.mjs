import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const steps = parse(fs.readFileSync('actions/release-assets/action.yml', 'utf8')).runs.steps;
const script = steps.find(step => step.name === 'Publish verified assets').run;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const output = path.join(root, 'release-output');
  fs.mkdirSync(output);
  for (const name of ['archive.tgz', 'BUILD-INFO.txt', 'LICENSE']) fs.writeFileSync(path.join(output, name), name);
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), execFileSync('sha256sum', ['archive.tgz', 'LICENSE', 'BUILD-INFO.txt'], { cwd: output }));
  // Only the fixture directory represents remote state. No GitHub client is called.
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env python3
import sys, os, json, shutil
from pathlib import Path
root=Path(os.environ['RUNNER_TEMP'])
args=sys.argv[1:]
op=args[1]
state=root/'state'
remote=root/'assets'
marker=root/'notes'
def option(key): return args[args.index(key)+1]
if op=='view':
    if os.environ.get('FAULT')=='network': sys.exit('network unavailable')
    if not state.exists(): sys.exit('release not found')
    print(json.dumps(dict(isDraft=state.read_text()=='draft',body=marker.read_text(),assets=[dict(name=f.name) for f in remote.iterdir()])))
elif op=='create':
    (root/'create-attempt').touch()
    remote.mkdir()
    marker.write_text(option('--notes') if '--notes' in args else Path(option('--notes-file')).read_text())
    state.write_text('draft' if '--draft' in args else 'public')
elif op=='upload':
    for f in args[3:]:
        if os.environ.get('FAULT')=='partial' and any(remote.iterdir()): sys.exit(19)
        assert not (remote/Path(f).name).exists()
        shutil.copy(f,remote)
elif op=='download':
    folder=Path(option('--dir'))
    for f in remote.iterdir():
        if '--pattern' not in args or f.name==option('--pattern'): shutil.copy(f,folder)
elif op=='edit':
    assert '--draft=false' in args
    state.write_text('public')
else: sys.exit(90)
`, { mode: 0o755 });
  const run = fault => spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', script], { cwd: root, encoding: 'utf8',
    env: { RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: root + '/summary', GITHUB_REPOSITORY: 'fixture/app', APPLICATION: 'backend',
      VERSION: 'v1.2.3', PATH: root + ':' + process.env.PATH, FAULT: fault ?? '' } });
  return { root, run };
}
test('unavailable release metadata leaves remote state untouched', t => {
  const { root, run } = fixture(t);
  const r = run('network');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /network unavailable/);
  assert.ok(!fs.existsSync(path.join(root, 'create-attempt')));
  assert.ok(!fs.existsSync(path.join(root, 'state')));
});
test('interrupted draft resumes, verifies bytes and publishes the complete set once', t => {
  const { root, run } = fixture(t);
  assert.notEqual(run('partial').status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'state'), 'utf8'), 'draft');
  assert.equal(fs.readdirSync(path.join(root, 'assets')).length, 1);
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'state'), 'utf8'), 'public');
    assert.equal(fs.readdirSync(path.join(root, 'assets')).length, 4);
  }
  fs.writeFileSync(path.join(root, 'assets/LICENSE'), 'different');
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'assets/LICENSE'), 'utf8'), 'different');
});
