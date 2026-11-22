import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = fs.readFileSync('actions/setup/postgres.sh', 'utf8');
test('only the installed PostgreSQL 18 server and client select the preinstalled path', () => {
  const probe = script.slice(script.indexOf('pg_major='), script.indexOf('\nelse\n')) + '\nelse echo install; fi';
  for (const [client, code, installed] of [['install ok installed', 0, true], ['deinstall ok config-files', 0, false], ['', 1, false]]) {
    const mock = `dpkg-query() {
      [[ "$3 $4" == 'postgresql-18 postgresql-client-18' ]] || return 2
      if [[ "$*" == *Status* ]]; then
        local format='%s'; [[ "$*" == *'\\n'* ]] && format='%s\\n'
        printf "$format" 'install ok installed' "$CLIENT"
      fi
      return "$CODE"
    }\n`;
    const r = spawnSync('bash', ['-c', mock + probe], { encoding: 'utf8', env: { CLIENT: client, CODE: String(code) } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.includes('Using preinstalled'), installed);
  }
});
test('PostgreSQL installation requests noninteractive mode after sudo and verifies the client', () => {
  const commands = script.split('\n').filter(line => line.includes('apt-get '));
  assert.equal(commands.length, 2);
  for (const line of commands) assert.match(line, /sudo -n env DEBIAN_FRONTEND=noninteractive apt-get/);
  assert.match(commands[1], /install .* "\$pg_server_package" "\$pg_client_package"$/);
  assert.match(script, /pg_bin=".*\/\$pg_major\/bin"/);
  assert.match(script, /"\$pg_bin\/psql" --version/);
});
