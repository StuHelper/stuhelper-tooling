#!/usr/bin/env bash
# APT validates signed repository metadata and each package's checksum.
set -euo pipefail
action_path=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=actions/setup/summary.sh
. "$action_path/summary.sh"
start=$(now_ms)
# Synchronized from architecture/toolchains.yaml by the StuHelper workspace.
pg_major=18
pg_server_package="postgresql-$pg_major"
pg_client_package="postgresql-client-$pg_major"
pg_source=preinstalled
if statuses=$(dpkg-query -W -f='${Status}\n' "$pg_server_package" "$pg_client_package" 2>/dev/null) &&
   [[ "$statuses" == $'install ok installed\ninstall ok installed' ]]; then
  printf 'Using preinstalled PostgreSQL %s packages\n' "$pg_major"
else
  pg_source=downloaded
  # Use the upstream stable repository when the requested packages are missing.
  # shellcheck disable=SC1090
  . "${STUHELPER_OS_RELEASE:-/etc/os-release}"
  [[ "${ID:-}" == ubuntu && "${VERSION_CODENAME:-}" =~ ^[a-z]+$ ]]
  directory=$(mktemp -d "${RUNNER_TEMP:?}/stuhelper-pgdg.XXXXXX")
  trap 'rm -rf -- "$directory"' EXIT
  keyring="${STUHELPER_PG_KEYRING:-/usr/share/keyrings/stuhelper-pgdg.asc}"
  sources="${STUHELPER_PG_SOURCES:-/etc/apt/sources.list.d/stuhelper-pgdg.sources}"
  bash "$action_path/download.sh" 'https://www.postgresql.org/media/keys/ACCC4CF8.asc' "$directory/pgdg.asc"
  printf '0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76  %s\n' "$directory/pgdg.asc" | sha256sum --check
  sudo -n install -m 0644 "$directory/pgdg.asc" "$keyring"
  printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: %s\n' "$VERSION_CODENAME" "$keyring" > "$directory/pgdg.sources"
  sudo -n install -m 0644 "$directory/pgdg.sources" "$sources"
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120 update -qq
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120 install -y --no-install-recommends "$pg_server_package" "$pg_client_package"
fi
pg_bin="${STUHELPER_PG_ROOT:-/usr/lib/postgresql}/$pg_major/bin"
test -x "$pg_bin/initdb"
"$pg_bin/psql" --version
pg_version_raw=$("$pg_bin/postgres" --version)
printf '%s\n' "$pg_version_raw"
printf 'STUHELPER_TEST_PG_BIN=%s\n' "$pg_bin" >> "$GITHUB_ENV"
pg_version=${pg_version_raw##* }
record_toolchain_metric "PostgreSQL" "$pg_version" "$pg_source" "$(format_duration_ms "$start" "$(now_ms)")"
