#!/usr/bin/env bash
# Prefer image tools; otherwise install verified tools into this job's directory.
set -euo pipefail
action_path=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
directory=$(mktemp -d "${RUNNER_TEMP:?}/stuhelper-toolchains.XXXXXX")
trap 'rm -rf -- "$directory"' ERR
mkdir "$directory/bin"
case "$(uname -m)" in
  x86_64) node_arch=x64; go_arch=amd64 ;;
  aarch64|arm64) node_arch=arm64; go_arch=arm64 ;;
  *) echo 'Unsupported toolchain architecture' >&2; exit 1 ;;
esac
add_path() { export PATH="$1:$PATH"; printf '%s\n' "$1" >> "$GITHUB_PATH"; }
version_file() {
  local value
  value=$(tr -d '\r\n' < "$1")
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s' "$value"
}
node_version=$(version_file "${NODE_VERSION_FILE:-.node-version}")
if ! command -v node >/dev/null || [[ "$(node --version)" != "v$node_version" ]]; then
  archive="node-v$node_version-linux-$node_arch.tar.xz"
  source="https://nodejs.org/dist/v$node_version"
  bash "$action_path/download.sh" "$source/SHASUMS256.txt" "$directory/node-checksums.txt"
  curl --fail --silent --show-error --location --retry 3 --retry-all-errors --connect-timeout 15 --max-time 30 --head "$source/$archive" > "$directory/node-headers"
  size=$(awk 'tolower($1) == "content-length:" {gsub("\r", "", $2); value=$2} END {print value}' "$directory/node-headers")
  bash "$action_path/download-ranged.sh" "$source/$archive" "$directory/$archive" "$size"
  (cd "$directory" && awk -v archive="$archive" '$2 == archive {print; found++} END {if (found != 1) exit 1}' node-checksums.txt > node.sha256 && sha256sum --check node.sha256)
  tar -xJf "$directory/$archive" -C "$directory"
  add_path "$directory/node-v$node_version-linux-$node_arch/bin"
  rm -- "$directory/$archive"
fi
test "$(node --version)" = "v$node_version"

pnpm_version=$(node --input-type=module -e 'import fs from "node:fs"; const value = JSON.parse(fs.readFileSync("package.json", "utf8")).packageManager; const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.exec(value); if (!match) process.exit(1); console.log(match[1]);')
if ! command -v pnpm >/dev/null || [[ "$(pnpm --version)" != "$pnpm_version" ]]; then
  # npm's integrity metadata is fetched from the official registry, independent
  # of any runner-wide mirror. Verify it before executing package code.
  bash "$action_path/download.sh" "https://registry.npmjs.org/pnpm/$pnpm_version" "$directory/pnpm.json"
  bash "$action_path/download.sh" "https://registry.npmjs.org/pnpm/-/pnpm-$pnpm_version.tgz" "$directory/pnpm.tgz"
  node --input-type=module - "$directory" <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const root = process.argv[2];
const { dist } = JSON.parse(fs.readFileSync(`${root}/pnpm.json`, 'utf8'));
if (typeof dist?.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) throw new Error('Missing pnpm SHA-512');
const actual = `sha512-${createHash('sha512').update(fs.readFileSync(`${root}/pnpm.tgz`)).digest('base64')}`;
if (actual !== dist.integrity) throw new Error('pnpm integrity mismatch');
NODE
  mkdir "$directory/pnpm"
  tar -xzf "$directory/pnpm.tgz" --strip-components=1 -C "$directory/pnpm"
  ln -s "$directory/pnpm/bin/pnpm.cjs" "$directory/bin/pnpm"
  add_path "$directory/bin"
  rm -- "$directory/pnpm.tgz"
fi
test "$(pnpm --version)" = "$pnpm_version"

if [[ -n "${GO_VERSION_FILE:-}" ]]; then
  go_version=$(version_file "$GO_VERSION_FILE")
  if ! command -v go >/dev/null || [[ "$(GOTOOLCHAIN=local go version)" != "go version go$go_version "* ]]; then
    archive="go$go_version.linux-$go_arch.tar.gz"
    bash "$action_path/download.sh" 'https://go.dev/dl/?mode=json&include=all' "$directory/go.json"
    read -r checksum size < <(node --input-type=module - "$directory/go.json" "$archive" <<'NODE'
import fs from 'node:fs';
const entries = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const files = entries.filter(entry => entry.stable === true).flatMap(entry => entry.files).filter(file => file.filename === process.argv[3]);
if (files.length !== 1 || !/^[a-f0-9]{64}$/.test(files[0].sha256) || !Number.isSafeInteger(files[0].size)) process.exit(1);
console.log(files[0].sha256, files[0].size);
NODE
    )
    # Both URLs are official Go distribution endpoints. The checksum comes from
    # go.dev metadata and is applied after either transport succeeds.
    if ! bash "$action_path/download-ranged.sh" "https://dl.google.com/go/$archive" "$directory/$archive" "$size"; then
      bash "$action_path/download-ranged.sh" "https://golang.google.cn/dl/$archive" "$directory/$archive" "$size"
    fi
    printf '%s  %s\n' "$checksum" "$directory/$archive" | sha256sum --check
    tar -xzf "$directory/$archive" -C "$directory"
    add_path "$directory/go/bin"
    rm -- "$directory/$archive"
  fi
  [[ "$(GOTOOLCHAIN=local go version)" == "go version go$go_version "* ]]
  printf 'GOTOOLCHAIN=local\n' >> "$GITHUB_ENV"
  if ! command -v gcc >/dev/null || ! command -v make >/dev/null; then
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120 update -qq
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120 install -y --no-install-recommends build-essential
  fi
fi
printf 'NPM_CONFIG_REGISTRY=https://registry.npmjs.org\npnpm_config_registry=https://registry.npmjs.org\n' >> "$GITHUB_ENV"
printf 'Node: %s; pnpm: %s\n' "$(node --version)" "$(pnpm --version)"
if [[ -n "${GO_VERSION_FILE:-}" ]]; then GOTOOLCHAIN=local go version; fi
