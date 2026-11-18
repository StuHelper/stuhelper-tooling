#!/usr/bin/env bash
set -euo pipefail
action_path=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=actions/setup/summary.sh
. "$action_path/summary.sh"
start=$(now_ms)
version=1.7.12
if command -v actionlint >/dev/null && [[ "$(actionlint --version | head -n 1)" == "$version" ]]; then
  printf 'Using preinstalled actionlint %s\n' "$version"
  record_toolchain_metric "actionlint" "$version" "preinstalled" "$(format_duration_ms "$start" "$(now_ms)")"
  exit 0
fi
case "$(uname -m)" in
  x86_64) architecture=amd64; checksum=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  aarch64|arm64) architecture=arm64; checksum=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
  *) echo 'Unsupported actionlint architecture' >&2; exit 1 ;;
esac
# Digests are from the official v1.7.12 release asset metadata and checksum file.
directory=$(mktemp -d "${RUNNER_TEMP:?}/actionlint.XXXXXX")
trap 'rm -rf -- "$directory"' ERR
archive="actionlint_${version}_linux_${architecture}.tar.gz"
bash "$action_path/download.sh" "https://github.com/rhysd/actionlint/releases/download/v$version/$archive" "$directory/$archive"
printf '%s  %s\n' "$checksum" "$directory/$archive" | sha256sum --check
tar -xzf "$directory/$archive" -C "$directory" actionlint
test "$("$directory/actionlint" --version | head -n 1)" = "$version"
rm -- "$directory/$archive"
printf '%s\n' "$directory" >> "$GITHUB_PATH"
record_toolchain_metric "actionlint" "$version" "downloaded" "$(format_duration_ms "$start" "$(now_ms)")"
