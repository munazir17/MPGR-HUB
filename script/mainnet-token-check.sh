#!/usr/bin/env bash
# Verifies every production token of the Base Mainnet executor deployment with REAL-NODE
# eth_call (Coinbase B20 stocks are Base-native precompiles that Foundry's local EVM cannot
# execute, so this is the only way to check them). Read-only; needs BASE_MAINNET_RPC_URL.
#
# Every call is retried with backoff: the public RPC rate-limits bursts, and a rate-limit
# error must never be mistaken for "token not live".
set -uo pipefail

: "${BASE_MAINNET_RPC_URL:?BASE_MAINNET_RPC_URL is required}"
SCRIPT="script/DeployMPGRExecutorBaseMainnet.s.sol:DeployMPGRExecutorBaseMainnet"
LAST_ERR_FILE="$(mktemp)"

# rcall <to> <sig> [args...]  -> prints the decoded value, or returns 1 after 8 attempts
# (runs inside $(...), so the last error is persisted to a file, not a variable).
rcall() {
  local out attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if out="$(cast call "$@" --rpc-url "$BASE_MAINNET_RPC_URL" 2>/tmp/rcall.err)" && [ -n "$out" ]; then
      printf '%s\n' "$out" | awk '{print $1}' | tr -d '"'
      return 0
    fi
    { tr '\n' ' ' < /tmp/rcall.err | cut -c1-300; } > "$LAST_ERR_FILE"
    [ -s "$LAST_ERR_FILE" ] || echo "empty result" > "$LAST_ERR_FILE"
    sleep $((attempt * 3))
  done
  return 1
}

forge build >/dev/null 2>&1 || { echo "::error::forge build failed"; exit 1; }
forge script "$SCRIPT" --sig 'printTokens()' 2>/dev/null | awk '/TOKEN /{print $2, $3}' > tokens.txt
if [ "$(wc -l < tokens.txt)" != "15" ]; then
  echo "::error::expected 15 production tokens, got $(wc -l < tokens.txt)"
  exit 1
fi

REPORT=""
BAD=0
while read -r SYM ADDR; do
  DEC="" SUP="" BAL="" ONCHAIN=""
  DEC="$(rcall "$ADDR" 'decimals()(uint8)')" &&
    SUP="$(rcall "$ADDR" 'totalSupply()(uint256)')" &&
    BAL="$(rcall "$ADDR" 'balanceOf(address)(uint256)' 0x000000000000000000000000000000000000dEaD)"
  if [ -z "$DEC" ] || [ -z "$SUP" ] || [ -z "$BAL" ]; then
    BAD=1
    REPORT="${REPORT}${SYM}=FAILED "
    echo "::error title=Token check failed::${SYM} ${ADDR}: eth_call failed after retries: $(cat "$LAST_ERR_FILE")"
    continue
  fi
  # symbol() uses the non-uint decoder path; strip cast's quotes for comparison.
  ONCHAIN="$(cast call "$ADDR" 'symbol()(string)' --rpc-url "$BASE_MAINNET_RPC_URL" 2>/dev/null | tr -d '"' || true)"
  if [ "$ONCHAIN" != "$SYM" ]; then
    echo "::warning title=Token symbol differs::${ADDR} config=${SYM} onchain=${ONCHAIN:-<none>}"
  fi
  REPORT="${REPORT}${SYM}(onchain ${ONCHAIN:-?}, dec ${DEC}, supply ${SUP}) "
  if [ "$SYM" = "USDC" ] && [ "$DEC" != "6" ]; then
    BAD=1
    echo "::error::USDC decimals ${DEC} != 6"
  fi
  sleep 0.5
done < tokens.txt

if [ "$BAD" = "0" ]; then
  echo "::notice title=Production tokens live on Base Mainnet (real-node eth_call)::${REPORT}"
else
  echo "::error title=Production token check::${REPORT}"
fi
exit "$BAD"
