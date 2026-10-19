#!/usr/bin/env bash
# Genuine Safe/multisig verification for the governance owner address.
# Bytecode presence alone is NOT sufficient: this checks that the address is a
# Safe PROXY whose storage-slot-0 singleton is a canonical Safe implementation
# on Base, that the singleton's runtime bytecode hash is the one published by
# safe-global/safe-deployments for Base Mainnet, and that
# getThreshold()/getOwners()/VERSION() respond consistently.
# All data read is public on-chain state; no secret is involved or printed.
#
# Usage: safe-check.sh <owner-address> <rpc-url>
# Optional env:
#   SWAP_SAFE_EXTRA_SINGLETONS  space-separated `address:codehash` pairs for
#                               owner-approved extra Safe implementations (e.g.
#                               a future release not yet in this table). The
#                               runtime code hash is mandatory so an extra is
#                               never trusted on address alone. Canonical
#                               1.3.0/1.4.1/1.5.0 (+L2) are always accepted and
#                               pinned to their registry code hash.
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
# Canonical Safe singletons on Base Mainnet (chain id 8453): lowercase address,
# runtime code hash, label. Both values are copied verbatim from
# safe-global/safe-deployments (src/assets/<version>/, "deployments.canonical"
# + "networkAddresses.8453"), the authoritative registry used by the Safe
# tooling. Pinning the code hash means an allowlisted ADDRESS is never trusted
# on its own: the bytecode served at that address must be the audited canonical
# implementation. Do not add an address here without its registry code hash.
CANONICAL_SINGLETONS="
0xd9db270c1b5e3bd161e8c8503c55ceabee709552 0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e GnosisSafe 1.3.0
0x3e5c63644e683549055b9be8653de26e0b4cd36e 0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f GnosisSafeL2 1.3.0
0x41675c099f32341bf84bfc5382af534df5c7461a 0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4 Safe 1.4.1
0x29fcb43b46531bca003ddc8fcb67ffe91900c762 0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff SafeL2 1.4.1
0xff51a5898e281db6dfc7855790607438df2ca44b 0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2 Safe 1.5.0
0xedd160febbd92e350d4d398fb636302fccd67c7e 0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc SafeL2 1.5.0
"
IMPL=""
EXPECTED_HASH=""
while read -r ADDR HASH LABEL; do
  [ -n "$ADDR" ] || continue
  if [ "$ADDR" = "$SINGLETON" ]; then
    IMPL="$LABEL"
    EXPECTED_HASH="$HASH"
    break
  fi
done <<<"$CANONICAL_SINGLETONS"
if [ -z "$IMPL" ]; then
  for EXTRA in ${SWAP_SAFE_EXTRA_SINGLETONS:-}; do
    EXTRA_ADDR="${EXTRA%%:*}"
    EXTRA_HASH="${EXTRA#*:}"
    [ "$EXTRA_HASH" != "$EXTRA" ] || fail "SWAP_SAFE_EXTRA_SINGLETONS entry '$EXTRA' must be address:codehash - address-only allowlisting is not accepted"
    if [ "$(lc "$EXTRA_ADDR")" = "$SINGLETON" ]; then
      IMPL="owner-allowlisted singleton $SINGLETON"
      EXPECTED_HASH="$(lc "$EXTRA_HASH")"
      break
    fi
  done
fi
[ -n "$IMPL" ] || fail "$OWNER is NOT a recognised Safe proxy (slot-0 singleton $SINGLETON is not a canonical Base Safe implementation and not owner-allowlisted)"
grep -Eq '^0x[0-9a-f]{64}$' <<<"$EXPECTED_HASH" || fail "invalid expected runtime code hash '$EXPECTED_HASH' for $SINGLETON"
# The slot-0 address alone proves nothing: read the implementation bytecode and
# require it to hash to the pinned canonical value. A different contract cannot
# impersonate a canonical singleton, and an unverified/forked implementation is
# rejected even if it sits at a known address.
SINGLETON_CODE="$(rpc cast code "$SINGLETON" --rpc-url "$RPC" | strip)" || fail "cannot read singleton $SINGLETON bytecode"
grep -Eq '^0x[0-9a-fA-F]*$' <<<"$SINGLETON_CODE" || fail "singleton $SINGLETON returned non-hex bytecode"
KECCAK_OUT="$(rpc cast keccak "$SINGLETON_CODE" | strip)" || fail "cannot hash singleton $SINGLETON bytecode"
ACTUAL_HASH="$(lc "$KECCAK_OUT")"
[ "$ACTUAL_HASH" = "$EXPECTED_HASH" ] || fail "singleton $SINGLETON does not match the pinned implementation ($IMPL): runtime code hash $ACTUAL_HASH != expected $EXPECTED_HASH"

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

note "$OWNER is a genuine $IMPL (VERSION=$VERSION) threshold=$THRESHOLD owners=$OWNER_COUNT singleton_codehash=$EXPECTED_HASH"
echo "owners:"; echo "$OWNERS"
if [ "$THRESHOLD" -lt 2 ] 2>/dev/null; then
  note "ADVISORY: threshold is $THRESHOLD - governance ownership should normally require >= 2 signers"
fi
echo "SAFE-CHECK PASS: $OWNER verified as $IMPL, threshold=$THRESHOLD, owners=$OWNER_COUNT, VERSION=$VERSION, singleton_codehash=$ACTUAL_HASH"
