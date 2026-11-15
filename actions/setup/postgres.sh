#!/usr/bin/env bash
# APT validates signed repository metadata and each package's checksum.
set -euo pipefail
if ! dpkg-query -W -f='${Status}' postgresql postgresql-client 2>/dev/null | grep -qv 'install ok installed' &&
   dpkg-query -W postgresql postgresql-client >/dev/null 2>&1; then
  printf 'Using preinstalled PostgreSQL meta-packages\n'
else
  # An older Ubuntu base may only offer an older PostgreSQL major. Use the
  # upstream stable repository, whose signed metadata selects the meta-package.
  . /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_CODENAME:-}" =~ ^[a-z]+$ ]]
  action_path=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  directory=$(mktemp -d "${RUNNER_TEMP:?}/stuhelper-pgdg.XXXXXX")
  trap 'rm -rf -- "$directory"' EXIT
  bash "$action_path/download.sh" 'https://www.postgresql.org/media/keys/ACCC4CF8.asc' "$directory/pgdg.asc"
  printf '0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76  %s\n' "$directory/pgdg.asc" | sha256sum --check
  sudo -n install -m 0644 "$directory/pgdg.asc" /usr/share/keyrings/stuhelper-pgdg.asc
  printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: /usr/share/keyrings/stuhelper-pgdg.asc\n' "$VERSION_CODENAME" > "$directory/pgdg.sources"
  sudo -n install -m 0644 "$directory/pgdg.sources" /etc/apt/sources.list.d/stuhelper-pgdg.sources
  sudo -n apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120 update -qq
  sudo -n apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::http::Timeout=30 -o DPkg::Lock::Timeout=120 install -y --no-install-recommends postgresql postgresql-client
fi
pg_package=$(dpkg-query -W -f='${Depends}' postgresql | grep -oE 'postgresql-[0-9]+' | head -n 1)
test -n "$pg_package"
pg_bin="/usr/lib/postgresql/${pg_package#postgresql-}/bin"
test -x "$pg_bin/initdb"
"$pg_bin/postgres" --version
printf 'STUHELPER_TEST_PG_BIN=%s\n' "$pg_bin" >> "$GITHUB_ENV"
