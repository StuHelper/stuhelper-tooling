#!/usr/bin/env bash
set -euo pipefail
action_path=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
spec=$(jq -er '.packageManager' package.json)
[[ "$spec" =~ ^pnpm@([0-9]+\.[0-9]+\.[0-9]+)\+sha(224|256|384|512)\.[0-9a-f]+$ ]]
pnpm_version=${BASH_REMATCH[1]}
pnpm_spec=${spec#pnpm@}
directory=$(mktemp -d "${RUNNER_TEMP:?}/stuhelper-pinned-pnpm.XXXXXX")
trap 'if (( $? != 0 )); then rm -rf -- "$directory"; fi' EXIT
mkdir "$directory/bin"
# npm's integrity metadata is fetched from the official registry, independent
# of any runner-wide mirror. Verify it before executing package code.
bash "$action_path/download.sh" "https://registry.npmjs.org/pnpm/$pnpm_version" "$directory/pnpm.json"
bash "$action_path/download.sh" "https://registry.npmjs.org/pnpm/-/pnpm-$pnpm_version.tgz" "$directory/pnpm.tgz"
node --input-type=module - "$directory" "$pnpm_spec" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const root = process.argv[2];
const { dist } = JSON.parse(fs.readFileSync(`${root}/pnpm.json`, 'utf8'));
if (typeof dist?.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) throw new Error('Missing pnpm SHA-512');
const archive = fs.readFileSync(`${root}/pnpm.tgz`);
const actual = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
if (actual !== dist.integrity) throw new Error('pnpm integrity mismatch');
const pin = process.argv[3].split('+')[1];
if (pin) {
const [algorithm, expected] = pin.split('.');
if (createHash(algorithm).update(archive).digest('hex') !== expected) throw new Error('pnpm packageManager digest mismatch');
}
NODE
mkdir "$directory/pnpm"
tar -xzf "$directory/pnpm.tgz" --strip-components=1 -C "$directory/pnpm"
ln -s "$directory/pnpm/bin/pnpm.cjs" "$directory/bin/pnpm"
export PATH="$directory/bin:$PATH"
test "$(pnpm --version)" = "$pnpm_version"
printf '%s\n' "$directory/bin" >> "$GITHUB_PATH"
rm -- "$directory/pnpm.tgz"
