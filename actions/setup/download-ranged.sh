#!/usr/bin/env bash
# Bounded parallel transfers for official toolchains on the ARC network path.
set -euo pipefail
test "$#" -eq 3
url=$1
transport=(--proto '=https' --proto-redir '=https' --tlsv1.2)
if [[ "$url" == http://127.0.0.1:* ]]; then transport=(--proto '=http' --proto-redir '=https'); fi
destination=$2
size=$3
[[ "$size" =~ ^[0-9]+$ ]]
(( size > 0 && size <= 268435456 ))
test ! -e "$destination"
directory=$(mktemp -d "${destination}.parts.XXXXXX")
trap 'rm -rf -- "$directory"' EXIT
options=(--fail --silent --show-error --location "${transport[@]}" --connect-timeout 15)
arguments=()
chunk_size=$(( (size + 3) / 4 ))
for part in 0 1 2 3; do
  start=$(( part * chunk_size ))
  end=$(( start + chunk_size - 1 ))
  (( start < size )) || break
  (( end < size )) || end=$(( size - 1 ))
  (( part == 0 )) || arguments+=(--next)
  arguments+=("${options[@]}" --max-time 600 --max-filesize "$((end-start+1))" --speed-limit 16384 --speed-time 30 --range "$start-$end" --output "$directory/part-$part" "$url")
done
# Retry the transfer group explicitly. curl --parallel with --retry-all-errors
# can stall after a permanent range/size rejection on older runner versions.
# curl owns every transfer; cancellation cannot leave background children.
for attempt in 1 2 3; do
  if curl --parallel --parallel-immediate --parallel-max 4 "${arguments[@]}"; then break; fi
  (( attempt < 3 )) || exit 1
  rm -f -- "$directory"/part-*
  sleep 3
done
for part in 0 1 2 3; do
  start=$(( part * chunk_size ))
  (( start < size )) || break
  expected=$chunk_size
  (( start + expected <= size )) || expected=$((size-start))
  test "$(stat -c %s "$directory/part-$part")" = "$expected"
  cat "$directory/part-$part" >> "$directory/archive"
done
test "$(stat -c %s "$directory/archive")" = "$size"
ln -- "$directory/archive" "$destination"
