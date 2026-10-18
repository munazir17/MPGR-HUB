#!/usr/bin/env bash
# Seal the staging manifest with REAL deployment facts: tx hash, block number,
# receipt status and gas from the Foundry broadcast artifact + on-chain receipt,
# then re-read every constructor pin ON-CHAIN and compare against the manifest.
# The final deployments/base-mainnet/mpgr-swap-executor.json is written ONLY if
# every assertion passes; placeholders ("pending-record", empty deployTx,
# deployBlock 0) can therefore never reach the final artifact.
# Usage: scripts/swap-deploy/finalize-manifest.sh <rpc-url>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RPC="${1:?usage: finalize-manifest.sh <rpc-url>}"
STAGING=deployments/base-mainnet/mpgr-swap-executor.staging.json
FINAL=deployments/base-mainnet/mpgr-swap-executor.json
RUN_JSON="broadcast/DeployMPGRSwapExecutorBaseMainnet.s.sol/8453/run-latest.json"
fail() { echo "FINALIZE FAIL: $1" >&2; exit 1; }
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

[ -f "$STAGING" ] || fail "staging manifest missing ($STAGING)"
[ ! -f "$FINAL" ] || fail "final manifest already exists"
[ -f "$RUN_JSON" ] || fail "broadcast artifact missing ($RUN_JSON)"

EXEC="$(jq -r .executor "$STAGING")"
DEPLOYER="$(jq -r .deployer "$STAGING")"
TX="$(jq -r --arg a "$(lc "$EXEC")" \
  '[.transactions[] | select(.transactionType == "CREATE" and ((.contractAddress // "") | ascii_downcase) == $a) | .hash][0] // empty' \
  "$RUN_JSON")"
[ -n "$TX" ] || fail "no CREATE tx for $EXEC in broadcast artifact"
case "$TX" in 0x[0-9a-fA-F]*) ;; *) fail "malformed tx hash $TX" ;; esac

RCPT="$(cast receipt "$TX" --rpc-url "$RPC" --json 2>/dev/null)" || fail "receipt unavailable for $TX"
STATUS="$(jq -r '.status // empty' <<<"$RCPT")"
[ "$STATUS" = "0x1" ] || fail "deploy tx status $STATUS != 0x1"
BLOCK_HEX="$(jq -r '.blockNumber // empty' <<<"$RCPT")"
[ -n "$BLOCK_HEX" ] || fail "receipt has no blockNumber"
BLOCK=$((BLOCK_HEX))
[ "$BLOCK" -gt 0 ] || fail "invalid block number"
RCPT_FROM="$(jq -r '.from // empty' <<<"$RCPT")"
[ "$(lc "$RCPT_FROM")" = "$(lc "$DEPLOYER")" ] || fail "receipt from $RCPT_FROM != manifest deployer $DEPLOYER"
RCPT_CONTRACT="$(jq -r '.contractAddress // empty' <<<"$RCPT")"
[ -z "$RCPT_CONTRACT" ] || [ "$(lc "$RCPT_CONTRACT")" = "$(lc "$EXEC")" ] || fail "receipt contractAddress $RCPT_CONTRACT != $EXEC"
GAS_USED="$(jq -r '.gasUsed // "0"' <<<"$RCPT")"
BLOCK_HASH="$(jq -r '.blockHash // ""' <<<"$RCPT")"

# Independent on-chain re-read of every pin (never trust the script's own file).
read_pin() { cast call "$EXEC" "$1" --rpc-url "$RPC" | sed "s/ *\[.*//" | tr -d "[:space:]"; }
expect_eq() { [ "$(lc "$2")" = "$(lc "$3")" ] || fail "on-chain $1 ($2) != manifest ($3)"; }
FEE_BPS="$(read_pin 'feeBps()(uint16)')"
MAX_BPS="$(read_pin 'MAX_FEE_BPS()(uint16)')"
TIMELOCK="$(read_pin 'FEE_TIMELOCK_SECONDS()(uint48)')"
PENDING="$(read_pin 'pendingEffectiveAt()(uint48)')"
RECIPIENT="$(read_pin 'feeRecipient()(address)')"
OWNER="$(read_pin 'owner()(address)')"
WETH_ONCHAIN="$(read_pin 'WETH()(address)')"
PERMIT2_ONCHAIN="$(read_pin 'PERMIT2()(address)')"
CHAIN_NOW="$(cast chain-id --rpc-url "$RPC")"

expect_eq "feeBps"       "$FEE_BPS"      "$(jq -r .feeBps "$STAGING")"
expect_eq "maxFeeBps"    "$MAX_BPS"      "$(jq -r .maxFeeBps "$STAGING")"
expect_eq "timelock"     "$TIMELOCK"     "$(jq -r .feeTimelockSeconds "$STAGING")"
[ "$PENDING" = "0" ] || fail "pending fee change at birth"
expect_eq "feeRecipient" "$RECIPIENT"    "$(jq -r .feeRecipient "$STAGING")"
expect_eq "owner"        "$OWNER"        "$(jq -r .owner "$STAGING")"
expect_eq "weth"         "$WETH_ONCHAIN" "$(jq -r .weth "$STAGING")"
expect_eq "permit2"      "$PERMIT2_ONCHAIN" "$(jq -r .permit2 "$STAGING")"
[ "$CHAIN_NOW" = "8453" ] || fail "chain id drifted: $CHAIN_NOW"

# Venue registry: every router must be registered on-chain with the exact kind.
jq -c '.venues[]' "$STAGING" | while read -r v; do
  R="$(jq -r .router <<<"$v")"; K="$(jq -r .kind <<<"$v")"
  ONCHAIN_KIND="$(cast call "$EXEC" 'routerKind(address)(uint8)' "$R" --rpc-url "$RPC")"
  [ "$ONCHAIN_KIND" = "$K" ] || fail "router $R kind on-chain $ONCHAIN_KIND != manifest $K"
done

jq --arg tx "$TX" --argjson block "$BLOCK" --arg status "$STATUS" \
   --arg from "$RCPT_FROM" --arg gas "$GAS_USED" --arg bh "$BLOCK_HASH" \
   '.deployTx = $tx | .deployBlock = $block
    | .deployReceipt = {status: $status, from: $from, gasUsed: $gas, blockHash: $bh}
    | del(.stagedAtBlock)' "$STAGING" > "$FINAL.tmp"

# Completeness gate on the FINAL artifact itself.
grep -q 'pending-record' "$FINAL.tmp" && fail "placeholder pending-record found" || true
jq -e '.deployTx | test("^0x[0-9a-fA-F]{64}$")' "$FINAL.tmp" >/dev/null || fail "deployTx not a real 32-byte hash"
jq -e '.deployBlock > 0' "$FINAL.tmp" >/dev/null || fail "deployBlock not sealed"
jq -e '(.venues | length) == 5' "$FINAL.tmp" >/dev/null || fail "venue registry incomplete"
jq -e '.executor and .owner and .deployer and .feeRecipient' "$FINAL.tmp" >/dev/null || fail "manifest identity fields incomplete"
mv "$FINAL.tmp" "$FINAL"
rm -f "$STAGING"
echo "FINALIZE PASS: executor=$EXEC tx=$TX block=$BLOCK status=$STATUS gasUsed=$GAS_USED"
