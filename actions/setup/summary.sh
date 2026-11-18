#!/usr/bin/env bash
# Record and render toolchain bootstrap observability metrics for CI Step Summary.
set -euo pipefail

now_ms() {
  local raw=${EPOCHREALTIME/./}
  printf '%s' "$(( 10#${raw:0:${#raw}-3} ))"
}

format_duration_ms() {
  local start=$1
  local finish=$2
  local elapsed=$(( finish >= start ? finish - start : 0 ))
  printf '%d.%02d s' "$(( elapsed / 1000 ))" "$(( (elapsed % 1000) / 10 ))"
}

write_summary_header() {
  local target=$1
  if [[ ! -f "$target" ]] || ! grep -qF '| Tool | Version | Source | Duration |' "$target"; then
    if [[ -s "$target" ]]; then printf '\n' >> "$target"; fi
    printf '### Toolchain setup\n\n| Tool | Version | Source | Duration |\n| --- | --- | --- | --- |\n' >> "$target"
  fi
}

record_toolchain_metric() {
  local tool=$1
  local version=$2
  local origin=$3
  local duration=$4
  if [[ -n "${STUHELPER_SETUP_RECORDS:-}" ]]; then
    printf '%s\t%s\t%s\t%s\n' "$tool" "$version" "$origin" "$duration" >> "$STUHELPER_SETUP_RECORDS"
  elif [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    write_summary_header "$GITHUB_STEP_SUMMARY"
    printf '| %s | `%s` | %s | %s |\n' "$tool" "$version" "$origin" "$duration" >> "$GITHUB_STEP_SUMMARY"
  fi
}

flush_toolchain_summary() {
  local records=${STUHELPER_SETUP_RECORDS:-}
  if [[ -n "$records" && -s "$records" && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    write_summary_header "$GITHUB_STEP_SUMMARY"
    while IFS=$'\t' read -r tool version origin duration; do
      [[ -n "$tool" ]] || continue
      printf '| %s | `%s` | %s | %s |\n' "$tool" "$version" "$origin" "$duration" >> "$GITHUB_STEP_SUMMARY"
    done < "$records"
  fi
  if [[ -n "$records" ]]; then
    rm -f -- "$records" "$records.start" "$records.before"
  fi
  if [[ -n "${GITHUB_ENV:-}" && -f "${GITHUB_ENV:-}" ]]; then
    printf 'STUHELPER_SETUP_RECORDS=\n' >> "$GITHUB_ENV"
  fi
}

tool_identity() {
  local binary
  binary=$(command -v "$1") || return 1
  printf '%s ' "$binary"
  stat -Lc '%d:%i:%s:%y' "$binary"
}

tool_version() {
  case "$1" in
    pnpm|node) "$1" --version ;;
    go) GOTOOLCHAIN=local go version | awk '{print $3}' ;;
    *) return 1 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    init)
      records=$(mktemp "${RUNNER_TEMP:?}/stuhelper-setup-records.XXXXXX")
      printf 'STUHELPER_SETUP_RECORDS=%s\n' "$records" >> "${GITHUB_ENV:?}"
      ;;
    start)
      [[ "$2" =~ ^(pnpm|node|go)$ ]]
      records=${STUHELPER_SETUP_RECORDS:?}
      now_ms > "$records.start"
      tool_identity "$2" > "$records.before" || :
      ;;
    record)
      [[ "$2" =~ ^(pnpm|node|go)$ ]]
      records=${STUHELPER_SETUP_RECORDS:?}
      version=$(tool_version "$2")
      origin=$3
      current=$(tool_identity "$2")
      if [[ "$current" == "$(cat "$records.before")" ]]; then origin=preinstalled; fi
      record_toolchain_metric "$2" "$version" "$origin" "$(format_duration_ms "$(cat "$records.start")" "$(now_ms)")"
      ;;
    flush)
      flush_toolchain_summary
      ;;
    *)
      echo 'Usage: summary.sh <init|flush>' >&2
      exit 1
      ;;
  esac
fi
