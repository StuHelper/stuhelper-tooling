import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const action = YAML.parse(fs.readFileSync(new URL('../actions/release-assets/action.yml', import.meta.url), 'utf8'));
const build = action.runs.steps.find(step => step.name === 'Build fixed source');

test('release passes tag and actual commit to the source builder and refuses failed builds', t => {
  const privateWorkflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release-private.yml', import.meta.url), 'utf8'));
  for (const value of [workflow, privateWorkflow]) {
    const { build, publish } = value.jobs;
    assert.equal(value.permissions.contents, 'read');
    assert.equal(build.permissions?.contents ?? value.permissions.contents, 'read');
    assert.match(build.if, /github.event_name != 'pull_request_target'/);
    assert.equal(publish.needs, 'build');
    assert.equal(publish.environment, 'release');
    assert.equal(publish.permissions.contents, 'write');
    const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.equal(upload.with['retention-days'], 1);
    const download = publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with['artifact-ids'], '${{ needs.build.outputs.artifact-id }}');
    assert.deepEqual(publish.steps.filter(step => step.uses?.startsWith('actions/checkout@')).map(step => step.with.repository), ['${{ steps.tooling.outputs.repository }}']);
    assert.ok(!build.steps.some(step => step.uses?.includes('/publish-release-assets')));
    assert.ok(publish.steps.some(step => step.uses === './.stuhelper-release-tools/actions/publish-release-assets'));
    const steps = build.steps;
    const checkout = steps.find(step => step.with?.path === '.stuhelper-release-tools');
    assert.equal(checkout.with.ref, '${{ steps.tooling.outputs.sha }}');
    const release = steps.find(step => step.uses === './.stuhelper-release-tools/actions/release-assets');
    assert.equal(release.with['source-checked-out'], 'true');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'runtime'));
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, 'scripts/prepare-oracle-driver.py'), 'from pathlib import Path\nPath("prepared").touch()\n');
  fs.writeFileSync(path.join(directory, 'scripts/build-oracle-sync.sh'), 'set -eu\ntest -f prepared\nprintf "%s\\n%s\\n" "$1" "$2" > "$RUNNER_TEMP/build-arguments"\nexit 23\n');
  fs.writeFileSync(path.join(directory, 'bin/gh'), '#!/bin/sh\ntouch "$RUNNER_TEMP/unverified-upload"\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', 'scripts'], { cwd: directory });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic source'], { cwd: directory });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  const runtime = path.join(directory, 'runtime');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', build.run], {
    cwd: directory,
    env: { ...process.env, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`, APPLICATION: 'campus-adapters', VERSION: 'v9.8.7', RUNNER_TEMP: runtime },
    encoding: 'utf8',
  });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(runtime, 'build-arguments'), 'utf8').trim().split('\n'), [path.join(runtime, 'release-payload/stuhelper-oracle-sync'), `v9.8.7@${revision}`]);
  assert(!fs.existsSync(path.join(runtime, 'unverified-upload')));
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'release-output')), []);
});

for (const [application, defect] of [
  ['backend', 'missing entry'], ['web', 'empty dist'], ['admin', 'empty dist'],
  ['web', 'directory as entry'], ['campus-adapters', 'incorrect version'], ['campus-adapters', 'multiple versions'],
]) {
  test(application + ' rejects ' + defect + ' before archiving', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-check-'));
    t.after(() => fs.rmSync(root, { recursive: true }));
    for (const dir of ['bin', 'scripts', 'dist', 'apps/web-antd/dist']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const name of ['pnpm', 'gh']) fs.writeFileSync(path.join(root, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'scripts/prepare-oracle-driver.py'), '');
    fs.writeFileSync(path.join(root, 'scripts/build-oracle-sync.sh'), `printf '%s\\n' '#!/bin/sh' 'echo "{\\"source_version\\":\\"wrong\\"}"' > "$1"\nchmod +x "$1"\n`);
    if (defect === 'directory as entry') fs.mkdirSync(path.join(root, 'dist/index.html'));
    if (defect === 'multiple versions') {
      fs.writeFileSync(path.join(root, 'scripts/build-oracle-sync.sh'), `#!/bin/bash
cat > "$1" <<EOF
#!/bin/sh
echo '{"source_version":"other"}'
echo '{"source_version":"$2"}'
EOF
chmod +x "$1"`);
    }
    fs.writeFileSync(path.join(root, 'LICENSE'), 'fixture');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
    const result = spawnSync('bash', ['-c', build.run], { cwd: root, encoding: 'utf8',
      env: { PATH: root + '/bin:' + process.env.PATH, APPLICATION: application, VERSION: 'v1.2.3', RUNNER_TEMP: root } });
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(path.join(root, 'release-output')), []);
  });
}

test('complete static entry reaches packaging with its original content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'valid-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  for (const dir of ['dist', 'bin']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'dist/index.html'), '<main>fixture</main>');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'fixture license');
  fs.writeFileSync(path.join(root, 'bin/pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin/gh'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
  const r = spawnSync('bash', ['-c', build.run], { cwd: root, encoding: 'utf8', env: {
    PATH: root + '/bin:' + process.env.PATH, APPLICATION: 'web', VERSION: 'v1.2.3', RUNNER_TEMP: root,
    GITHUB_REPOSITORY: 'fixture/web', GITHUB_SERVER_URL: 'https://example.invalid', GITHUB_RUN_ID: '1', GITHUB_WORKFLOW_REF: 'fixture/workflow',
  } });
  // Older workflows include the publish step in build.run, where the fixture gh stops it.
  assert.ok([0, 17].includes(r.status), r.stderr);
  const archive = path.join(root, 'release-output/stuhelper-web-v1.2.3.tar.gz');
  assert.equal(execFileSync('tar', ['-xOzf', archive, './index.html'], { encoding: 'utf8' }), '<main>fixture</main>');
});

test('release verifies annotated tag ancestry before packaging', t => {
  const verifyTag = action.runs.steps.find(step => step.name === 'Verify source tag');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stuhelper-release-full-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'tag.gpgSign', 'false');
  fs.mkdirSync(path.join(directory, 'cmd/backend'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'cmd/backend/main.go'), 'package main\nfunc main() {}\n');
  fs.writeFileSync(path.join(directory, 'LICENSE'), 'AGPL-3.0-only\n');
  git('add', '.');
  git('commit', '-qm', 'release source');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('tag', '-a', 'v1.2.0', '-m', 'annotated release');
  git('update-ref', 'refs/tags/v1.2.1', 'HEAD');

  assert.equal(spawnSync('bash', ['-c', verifyTag.run], { cwd: directory, env: { ...process.env, APPLICATION: 'backend', VERSION: 'v1.2.0' }, encoding: 'utf8' }).status, 0);
  assert.notEqual(spawnSync('bash', ['-c', verifyTag.run], { cwd: directory, env: { ...process.env, APPLICATION: 'backend', VERSION: 'v1.2.1' }, encoding: 'utf8' }).status, 0);

});
