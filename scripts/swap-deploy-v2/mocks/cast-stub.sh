#!/usr/bin/env bash
# Offline `cast` stand-in for the V2 finalize/recovery regression suites.
# Never touches a network. Behaviour is driven entirely by files in $STUB_DIR
# and by per-call counters, so propagation delay, retry exhaustion, cross-RPC
# disagreement and receipt/address mismatch are all reproducible deterministically.
#
# Fixture files (all optional unless noted):
#   chainid-<role>            chain id (default 8453)
#   codesize-<role>           runtime code size once visible (default 24576)
#   code-empty-<role>         first N codesize polls return 0 (propagation delay)
#   receipt-<role>.json       eth_getTransactionReceipt JSON (required for receipt reads)
#   receipt-fail-<role>       first N receipt reads fail (retry-exhaustion tests)
#   txobj-<role>.json         eth_getTransactionByHash JSON (required for tx reads)
#   proof-<role>.json         eth_getProof JSON
#   proof-missing-<role>      file present => eth_getProof unsupported on that role
#   pins-<role>.tsv           `key<TAB>value` pin/call table
#   call-nocode-<role>        first N call reads fail with "does not have any code"
#   computed-address          `cast compute-address` output
# role is "primary" for $STUB_PRIMARY_URL (or any non-alt URL) and "alt" for
# $STUB_ALT_URL; an unexpected URL fails loudly instead of silently passing.
set -u

printf '%s\n' "$*" >>"${STUB_LOG:?STUB_LOG required}"

args=("$@")
url=""
clean=()
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  if [ "${args[$i]}" = "--rpc-url" ]; then
    url="${args[$((i + 1))]:-}"
    i=$((i + 2))
    continue
  fi
  clean+=("${args[$i]}")
  i=$((i + 1))
done

role=primary
if [ -n "${STUB_ALT_URL:-}" ] && [ "$url" = "$STUB_ALT_URL" ]; then
  role=alt
elif [ -n "$url" ] && [ -n "${STUB_PRIMARY_URL:-}" ] && [ "$url" != "$STUB_PRIMARY_URL" ]; then
  echo "stub cast: unexpected rpc url" >&2
  exit 3
fi

STATE="${STUB_DIR:?STUB_DIR required}"

bump() {
  local f="$STATE/cnt-$1" n
  n="$(cat "$f" 2>/dev/null || echo 0)"
  n=$((n + 1))
  printf '%s' "$n" >"$f"
  printf '%s' "$n"
}

num() { # $1 file name, $2 default
  cat "$STATE/$1" 2>/dev/null || printf '%s' "$2"
}

sub="${clean[0]:-}"
case "$sub" in
  chain-id)
    num "chainid-$role" 8453
    printf '\n'
    ;;
  codesize)
    n="$(bump "codesize-$role")"
    empty="$(num "code-empty-$role" 0)"
    if [ "$n" -le "$empty" ]; then
      echo 0
    else
      num "codesize-$role" 24576
      printf '\n'
    fi
    ;;
  receipt)
    n="$(bump "receipt-$role")"
    failn="$(num "receipt-fail-$role" 0)"
    if [ "$n" -le "$failn" ]; then
      echo "Error: server returned an error response: EOF" >&2
      exit 1
    fi
    f="$STATE/receipt-$role.json"
    [ -f "$f" ] || { echo "Error: transaction not found" >&2; exit 1; }
    cat "$f"
    ;;
  rpc)
    method="${clean[1]:-}"
    case "$method" in
      eth_getTransactionByHash)
        f="$STATE/txobj-$role.json"
        [ -f "$f" ] || { echo "Error: transaction not found" >&2; exit 1; }
        cat "$f"
        ;;
      eth_getProof)
        if [ -f "$STATE/proof-missing-$role" ]; then
          echo "Error: method eth_getProof is not supported" >&2
          exit 1
        fi
        f="$STATE/proof-$role.json"
        [ -f "$f" ] || { echo "Error: not found" >&2; exit 1; }
        cat "$f"
        ;;
      *)
        echo "stub cast: unsupported rpc method '$method'" >&2
        exit 2
        ;;
    esac
    ;;
  call)
    addr="$(printf '%s' "${clean[1]:-}" | tr 'A-Z' 'a-z')"
    sig="$(printf '%s' "${clean[2]:-}" | tr 'A-Z' 'a-z')"
    n="$(bump "call-$role")"
    nocode="$(num "call-nocode-$role" 0)"
    if [ "$n" -le "$nocode" ]; then
      echo "Error: contract $addr does not have any code" >&2
      exit 1
    fi
    key="$addr|$sig"
    if [ "${#clean[@]}" -ge 4 ]; then
      key="$key|$(printf '%s' "${clean[3]}" | tr 'A-Z' 'a-z')"
    fi
    v="$(awk -F'\t' -v k="$key" '$1 == k { print $2; exit }' "$STATE/pins-$role.tsv" 2>/dev/null)"
    [ -n "${v:-}" ] || { echo "Error: execution reverted" >&2; exit 1; }
    printf '%s\n' "$v"
    ;;
  compute-address)
    f="$STATE/computed-address"
    [ -f "$f" ] || { echo "stub cast: no computed-address fixture" >&2; exit 2; }
    cat "$f"
    ;;
  *)
    echo "stub cast: unexpected subcommand '${sub}'" >&2
    exit 2
    ;;
esac
