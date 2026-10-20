#!/usr/bin/env bash
# Offline `gh` stand-in for the V2 recovery regression suite.
# Serves canned run metadata and "downloads" a fixture artifact tree, so the
# recovery script's fail-closed metadata checks are exercised without network.
#
# Fixtures in $STUB_DIR:
#   run.json     -> `gh api repos/<owner>/<repo>/actions/runs/<id>`
#   jobs.json    -> `gh api repos/<owner>/<repo>/actions/runs/<id>/jobs`
#   artifact/    -> copied to the -D destination of `gh run download`
set -u

printf '%s\n' "gh $*" >>"${STUB_LOG:?STUB_LOG required}"
STATE="${STUB_DIR:?STUB_DIR required}"

if [ "${1:-}" = "api" ]; then
  path="${2:-}"
  case "$path" in
    */jobs|*/jobs\?*) src="$STATE/jobs.json" ;;
    *) src="$STATE/run.json" ;;
  esac
  [ -f "$src" ] || { echo "gh stub: missing fixture $src" >&2; exit 1; }
  cat "$src"
  exit 0
fi

if [ "${1:-}" = "run" ] && [ "${2:-}" = "download" ]; then
  dest=""
  i=3
  while [ "$i" -le "$#" ]; do
    eval "a=\${$i}"
    if [ "$a" = "-D" ]; then
      j=$((i + 1))
      eval "dest=\${$j}"
    fi
    i=$((i + 1))
  done
  [ -n "$dest" ] || { echo "gh stub: download without -D" >&2; exit 2; }
  mkdir -p "$dest"
  cp -R "$STATE/artifact/." "$dest/"
  exit 0
fi

echo "gh stub: unexpected invocation: $*" >&2
exit 2
