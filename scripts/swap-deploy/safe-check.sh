#!/usr/bin/env bash
# Genuine Safe/multisig verification for the governance owner address.
# Bytecode presence alone is NOT sufficient: this checks that the address is a
# Safe PROXY whose storage-slot-0 singleton is a canonical Safe implementation
# on Base, and that getThreshold()/getOwners()/VERSION() respond consistently.
# All data read is public on-chain state; no secret is involved or printed.
#
# Usage: safe-check.sh <owner-address> <rpc-url>
# Optional env:
#   SWAP_SAFE_EXTRA_SINGLETONS  space-separated extra accepted singleton
#                               addresses (owner-controlled, e.g. future Safe
#                               releases); canonical 1.3.0/1.4.1 (+L2) always
#                               accepted.
#   SWAP_SAFE_MIN_THRESHOLD     minimum required threshold (default 1; a
#                               notice recommends >= 2 for governance).
#   SWAP_SAFE_RETRY_BASE_SLEEP  test seam: scales the RPC retry backoff
#                               (sleep = attempt * 2 * base seconds, default
#                               base 1). The attempt count (5) is fixed and
#                               production callers never set this.
set -euo pipefail
OWNER="${1:?usage: safe-check.sh <owner-address> <rpc-url>}"
RPC="${2:?usage: safe-check.sh <owner-address> <rpc-url>}"
MIN_THRESHOLD="${SWAP_SAFE_MIN_THRESHOLD:-1}"

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
strip() { sed 's/ *\[.*//' | tr -d '[:space:]'; }
fail() {
  echo "SAFE-CHECK FAIL: $1" >&2
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Safe verification failed::$1"
  exit 1
}
note() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice title=Safe verification::$1" || echo "SAFE-CHECK: $1"; }

echo "$OWNER" | grep -Eq '^0x[0-9a-fA-F]{40}$' || fail "owner is not a valid address"

RETRY_BASE_SLEEP="${SWAP_SAFE_RETRY_BASE_SLEEP:-1}"
rpc() { # retrying cast wrapper; fail closed when the chain cannot be read
  local a out
  for a in 1 2 3 4 5; do
    if out="$("$@" 2>/dev/null)"; then printf '%s\n' "$out"; return 0; fi
    sleep $((a * 2 * RETRY_BASE_SLEEP))
  done
  return 1
}

SIZE="$(rpc cast codesize "$OWNER" --rpc-url "$RPC" | strip)" || fail "RPC unavailable - cannot verify Safe (fail closed)"
[ "${SIZE:-0}" -gt 0 ] 2>/dev/null || fail "$OWNER has no bytecode on Base - not a multisig"

SLOT0="$(rpc cast storage "$OWNER" 0 --rpc-url "$RPC" | strip)" || fail "cannot read storage slot 0"
SINGLETON="$(lc "0x${SLOT0: -40}")"
CANONICAL="0xd9db270c1b5e3bd161e8c8503c55ceabee709552 0x3e5c63644e683549055b9be8653de26e0b4cd36e 0x41675c099f32341bf84bfc5382af534df5c7461a 0x29fcb43b46531bca003ddc8fcb67ffe91900c762"
IMPL=""
case "$SINGLETON" in
  0xd9db270c1b5e3bd161e8c8503c55ceabee709552) IMPL="GnosisSafe 1.3.0" ;;
  0x3e5c63644e683549055b9be8653de26e0b4cd36e) IMPL="GnosisSafeL2 1.3.0" ;;
  0x41675c099f32341bf84bfc5382af534df5c7461a) IMPL="Safe 1.4.1" ;;
  0x29fcb43b46531bca003ddc8fcb67ffe91900c762) IMPL="SafeL2 1.4.1" ;;
esac
if [ -z "$IMPL" ]; then
  for EXTRA in ${SWAP_SAFE_EXTRA_SINGLETONS:-}; do
    [ "$(lc "$EXTRA")" = "$SINGLETON" ] && IMPL="owner-allowlisted singleton $SINGLETON" && break
  done
fi
[ -n "$IMPL" ] || fail "$OWNER is NOT a recognised Safe proxy (slot-0 singleton $SINGLETON is not a canonical Base Safe implementation and not owner-allowlisted)"

THRESHOLD="$(rpc cast call "$OWNER" 'getThreshold()(uint256)' --rpc-url "$RPC" | strip)" || fail "getThreshold() did not respond - not a functioning Safe"
OWNERS="$(rpc cast call "$OWNER" 'getOwners()(address[])' --rpc-url "$RPC")" || fail "getOwners() did not respond - not a functioning Safe"
VERSION="$(rpc cast call "$OWNER" 'VERSION()(string)' --rpc-url "$RPC" | tr -d '"')" || fail "VERSION() did not respond - not a functioning Safe"
# Parse getOwners() robustly across every layout emitted by supported Foundry
# versions: one bracketed comma-separated line ([0x.., 0x.., ..]), one address
# per line, or bulleted lines (- 0x..). Normalise to one token per line, then
# STRICTLY validate each token as exactly a 20-byte address. Malformed output,
# empty arrays and duplicate owners fail closed - a count is never silently
# derived from data that does not parse. Address case is irrelevant here; the
# threshold comparison below is unchanged.
OWNERS_NORM="$(tr ',[]' '\n\n\n' <<<"$OWNERS" | sed 's/^[[:space:]-]*//; s/[[:space:]]*$//' | grep -v '^$' || true)"
OWNER_COUNT=0
SEEN_OWNERS=""
if [ -n "$OWNERS_NORM" ]; then
  while IFS= read -r ENTRY; do
    grep -Eq '^0x[0-9a-fA-F]{40}$' <<<"$ENTRY" || fail "malformed getOwners() output: entry '$ENTRY' is not a 20-byte address"
    ENTRY_LC="$(lc "$ENTRY")"
    case " $SEEN_OWNERS " in
      *" $ENTRY_LC "*) fail "malformed getOwners() output: duplicate owner $ENTRY_LC (a genuine Safe never lists one owner twice)" ;;
    esac
    SEEN_OWNERS="$SEEN_OWNERS $ENTRY_LC"
    OWNER_COUNT=$((OWNER_COUNT + 1))
  done <<<"$OWNERS_NORM"
fi
[ "$OWNER_COUNT" -ge 1 ] || fail "getOwners() returned an empty owner list - not a functioning Safe"

[ "$THRESHOLD" -ge 1 ] 2>/dev/null || fail "threshold '$THRESHOLD' invalid"
[ "$THRESHOLD" -ge "$MIN_THRESHOLD" ] || fail "threshold $THRESHOLD below required minimum $MIN_THRESHOLD"
[ "$OWNER_COUNT" -ge "$THRESHOLD" ] || fail "owners ($OWNER_COUNT) fewer than threshold ($THRESHOLD) - misconfigured Safe"
[ -n "$VERSION" ] || fail "empty VERSION"

note "$OWNER is a genuine $IMPL (VERSION=$VERSION) threshold=$THRESHOLD owners=$OWNER_COUNT"
echo "owners:"; echo "$OWNERS"
if [ "$THRESHOLD" -lt 2 ] 2>/dev/null; then
  note "ADVISORY: threshold is $THRESHOLD - governance ownership should normally require >= 2 signers"
fi
echo "SAFE-CHECK PASS: $OWNER verified as $IMPL, threshold=$THRESHOLD, owners=$OWNER_COUNT, VERSION=$VERSION"
