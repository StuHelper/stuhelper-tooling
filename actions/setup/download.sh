#!/usr/bin/env bash
# Retry transport failures before publishing a complete bootstrap download.
set -euo pipefail
test "$#" -eq 2
url=$1
destination=$2
test ! -e "$destination"
partial=$(mktemp "${destination}.partial.XXXXXX")
trap 'rm -f -- "$partial"' EXIT
curl --fail --silent --show-error --location \
  --retry 3 --retry-all-errors --retry-delay 1 --retry-max-time 120 \
  --connect-timeout 10 --max-time 30 \
  "$url" --output "$partial"
# A failed or cancelled transfer must not look like a completed download.
ln -- "$partial" "$destination"
