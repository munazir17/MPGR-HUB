#!/usr/bin/env bash
# Offline regression suite for the V2 manifest seal (scripts/swap-deploy-v2/
# finalize-manifest.sh), run against a stub `cast` (no RPC, no key, no tx).
#
# Covers exactly the failure mode of trusted run 39294717599 and the hardening
# added afterwards:
#   - RPC propagation delay: the executor has no code for the first N polls,
#     then appears -> bounded polling waits and the seal proceeds;
#   - missing code: code never appears -> fail closed, nothing sealed;
#   - receipt/address mismatch (contractAddress / from / transactionHash /
#     missing contractAddress) -> fail closed;
#   - retry exhaustion: a permanently failing RPC read stops after the bounded
#     attempt count (no infinite loop) and nothing is sealed;
#   - independent second-RPC disagreement -> fail closed with both values;
#   - derived CREATE address mismatch, non-CREATE tx, chain drift, multiple
#     CREATEs -> fail closed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/swap-deploy-v2/mocks/fixtures.sh
. "$HERE/mocks/fixtures.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home"
BIN="$WORK/bin"
install_mocks "$BIN"

PRIMARY_URL=http://primary.stub.invalid
ALT_URL=http://alt.stub.invalid
STUB_LOG="$WORK/cast-calls.log"
: >"$STUB_LOG"

CASE_REPO=""
STUB_DIR=""
OUT=""
RC=0

new_case() { # fresh repo + fixture dir per scenario (independent counters)
  local n="${1:-case}"
  local base="$WORK/$n-$(date +%s%N)"
  CASE_REPO="$base/repo"
  STUB_DIR="$base/stub"
  mkdir -p "$base"
  scaffold_repo "$CASE_REPO"
  seed_fixtures "$STUB_DIR"
  install_recovery_inputs "$CASE_REPO" "$STUB_DIR"
  : >"$STUB_LOG"
}

run_finalize() { # optional extra args (e.g. the alt RPC URL)
  : >"$STUB_LOG"
  set +e
  OUT="$(cd "$CASE_REPO" && env -i PATH="$BIN:/usr/bin:/bin" HOME="$WORK/home" \
    FINALIZE_RPC_ATTEMPTS=3 \
    FINALIZE_RPC_BACKOFF_SECONDS=0 \
    FINALIZE_RPC_BACKOFF_CAP_SECONDS=0 \
    FINALIZE_CODE_WAIT_ATTEMPTS=4 \
    FINALIZE_CODE_WAIT_INTERVAL_SECONDS=0 \
    STUB_DIR="$STUB_DIR" STUB_LOG="$STUB_LOG" \
    STUB_PRIMARY_URL="$PRIMARY_URL" STUB_ALT_URL="$ALT_URL" \
    bash scripts/swap-deploy-v2/finalize-manifest.sh "$PRIMARY_URL" "$@" 2>&1)"
  RC=$?
  set -e
}

FINAL_REL=deployments/base-mainnet/mpgr-swap-executor-v2.json
STAGING_REL=deployments/base-mainnet/mpgr-swap-executor-v2.staging.json
GATE_REL=deployments/base-mainnet/deploy-v2-config.json

sealed() { [ -f "$CASE_REPO/$FINAL_REL" ]; }
staged() { [ -f "$CASE_REPO/$STAGING_REL" ]; }
gate_flipped() { [ "$(jq -r .consumed "$CASE_REPO/$GATE_REL")" = "true" ]; }
call_count() { grep -c "^$1" "$STUB_LOG" 2>/dev/null || true; }

echo "# single-RPC happy path (backward compatible: one argument)"
new_case single
run_finalize
check "seals with a single RPC (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "writes the final manifest" "$(sealed && echo 0 || echo 1)"
check "removes the staging manifest" "$(! staged && echo 0 || echo 1)"
check "flips only the V2 gate to consumed" "$(gate_flipped && echo 0 || echo 1)"
check "seals tx/block/receipt from the recovered facts" "$(
  [ "$(jq -r .deployTx "$CASE_REPO/$FINAL_REL")" = "$FIX_TX" ] \
  && [ "$(jq -r .deployBlock "$CASE_REPO/$FINAL_REL")" = "$((FIX_BLOCK_HEX))" ] \
  && [ "$(jq -r .deployReceipt.status "$CASE_REPO/$FINAL_REL")" = "0x1" ] \
  && [ "$(jq -r .deployReceipt.gasUsed "$CASE_REPO/$FINAL_REL")" = "$FIX_GAS" ] \
  && [ "$(jq -r '.deployReceipt.contractAddress | ascii_downcase' "$CASE_REPO/$FINAL_REL")" = "$(printf '%s' "$FIX_EXECUTOR" | tr 'A-Z' 'a-z')" ] \
  && echo 0 || echo 1)"
check "records crossChecked=false and the derived CREATE address" "$(
  [ "$(jq -r .verification.crossCheckedWithSecondRpc "$CASE_REPO/$FINAL_REL")" = "false" ] \
  && [ "$(jq -r '.verification.computedCreateAddress | ascii_downcase' "$CASE_REPO/$FINAL_REL")" = "$(printf '%s' "$FIX_EXECUTOR" | tr 'A-Z' 'a-z')" ] \
  && echo 0 || echo 1)"
check "reports FINALIZE PASS with the real facts" "$(grep -q "FINALIZE PASS: executor=$FIX_EXECUTOR tx=$FIX_TX" <<<"$OUT" && echo 0 || echo 1)"

echo "# dual-RPC happy path (independent cross-checks)"
new_case dual
run_finalize "$ALT_URL"
check "seals when both RPCs agree (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "records crossCheckedWithSecondRpc=true" "$(jq -e '.verification.crossCheckedWithSecondRpc == true' "$CASE_REPO/$FINAL_REL" >/dev/null && echo 0 || echo 1)"
check "records the runtime code hash observed by both endpoints" "$(jq -e --arg h "$FIX_CODE_HASH" '.verification.runtimeCodeHash == $h' "$CASE_REPO/$FINAL_REL" >/dev/null && echo 0 || echo 1)"
check "both endpoints were actually queried" "$(
  grep -q "$PRIMARY_URL" "$STUB_LOG" && grep -q "$ALT_URL" "$STUB_LOG" && echo 0 || echo 1)"

echo "# RPC propagation delay: code appears after two empty polls"
new_case delay
printf '2\n' >"$STUB_DIR/code-empty-primary"
printf '2\n' >"$STUB_DIR/code-empty-alt"
run_finalize "$ALT_URL"
check "seals once code propagates (exit 0)" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "polled codesize at least three times per endpoint" "$(
  [ "$(call_count 'codesize')" -ge 6 ] && echo 0 || echo 1)"
check "reports the poll that finally saw code" "$(grep -q 'after poll 3/4' <<<"$OUT" && echo 0 || echo 1)"
check "waited instead of failing on the first empty read" "$(grep -q 'waiting for runtime code' <<<"$OUT" && echo 0 || echo 1)"

echo "# missing code: never appears within the bounded window"
new_case nocode
printf '99\n' >"$STUB_DIR/code-empty-primary"
run_finalize
check "fails closed when code never appears" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "message names the exhausted propagation window" "$(grep -q 'NO runtime code' <<<"$OUT" && echo 0 || echo 1)"
check "no final manifest was written" "$(! sealed && echo 0 || echo 1)"
check "the staging manifest is preserved as evidence" "$(staged && echo 0 || echo 1)"
check "the gate is not consumed on failure" "$(! gate_flipped && echo 0 || echo 1)"
check "stops after the bounded poll count instead of looping" "$(
  [ "$(call_count 'codesize')" -eq 4 ] && echo 0 || echo 1)"

echo "# receipt/address mismatch"
new_case mismatch
jq '.contractAddress = "0x000000000000000000000000000000000000dEaD"' \
  "$STUB_DIR/receipt-primary.json" >"$STUB_DIR/r.json" && mv "$STUB_DIR/r.json" "$STUB_DIR/receipt-primary.json"
run_finalize
check "fails closed on receipt contractAddress != executor" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "reports the exact receipt/address mismatch" "$(grep -q 'receipt contractAddress 0x000000000000000000000000000000000000dEaD != executor' <<<"$OUT" && echo 0 || echo 1)"
check "seals nothing on receipt/address mismatch" "$(! sealed && echo 0 || echo 1)"

new_case no_contract_field
jq 'del(.contractAddress)' "$STUB_DIR/receipt-primary.json" >"$STUB_DIR/r.json" && mv "$STUB_DIR/r.json" "$STUB_DIR/receipt-primary.json"
run_finalize
check "fails closed when the receipt has no contractAddress" "$(grep -q 'has no contractAddress' <<<"$OUT" && echo 0 || echo 1)"

new_case from_mismatch
jq '.from = "0x1111111111111111111111111111111111111111"' "$STUB_DIR/receipt-primary.json" >"$STUB_DIR/r.json" && mv "$STUB_DIR/r.json" "$STUB_DIR/receipt-primary.json"
run_finalize
check "fails closed when receipt.from != deployer" "$(grep -q 'receipt from .* != manifest deployer' <<<"$OUT" && echo 0 || echo 1)"

new_case txhash_mismatch
jq '.transactionHash = "0xdeadbeef"' "$STUB_DIR/receipt-primary.json" >"$STUB_DIR/r.json" && mv "$STUB_DIR/r.json" "$STUB_DIR/receipt-primary.json"
run_finalize
check "fails closed when the receipt belongs to another tx" "$(grep -q 'receipt transactionHash' <<<"$OUT" && echo 0 || echo 1)"

new_case status_zero
jq '.status = "0x0"' "$STUB_DIR/receipt-primary.json" >"$STUB_DIR/r.json" && mv "$STUB_DIR/r.json" "$STUB_DIR/receipt-primary.json"
run_finalize
check "fails closed on a reverted deployment receipt" "$(grep -q 'deploy tx status 0x0 != 0x1' <<<"$OUT" && echo 0 || echo 1)"

echo "# retry exhaustion (bounded, never infinite)"
new_case exhaustion
printf '99\n' >"$STUB_DIR/receipt-fail-primary"
run_finalize
check "fails closed after bounded receipt retries" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "stops at exactly FINALIZE_RPC_ATTEMPTS=3 receipt reads" "$(
  [ "$(call_count 'receipt')" -eq 3 ] && echo 0 || echo 1)"
check "message states the bounded exhaustion" "$(grep -q 'failed all 3 bounded attempts' <<<"$OUT" && echo 0 || echo 1)"
check "nothing is sealed after retry exhaustion" "$(! sealed && echo 0 || echo 1)"

echo "# transient call failure that names missing code is retried, not fatal"
new_case transient
printf '1\n' >"$STUB_DIR/call-nocode-primary"
run_finalize
check "retries one 'does not have any code' blip and still seals" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "logged the transient retry" "$(grep -q 'transient RPC failure' <<<"$OUT" && echo 0 || echo 1)"

echo "# independent second RPC disagreement"
new_case pin_disagree
write_pins "$STUB_DIR/pins-alt.tsv" 26
run_finalize "$ALT_URL"
check "fails closed when feeBps disagrees across RPCs" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "reports both disagreeing values" "$(grep -q 'RPC DISAGREEMENT on feeBps: primary=25 second=26' <<<"$OUT" && echo 0 || echo 1)"
check "seals nothing on cross-RPC disagreement" "$(! sealed && echo 0 || echo 1)"

new_case blockhash_disagree
jq '.blockHash = "0x1111111111111111111111111111111111111111111111111111111111111111"' \
  "$STUB_DIR/receipt-alt.json" >"$STUB_DIR/r.json" && mv "$STUB_DIR/r.json" "$STUB_DIR/receipt-alt.json"
run_finalize "$ALT_URL"
check "fails closed when the receipt blockHash disagrees" "$(grep -q 'RPC DISAGREEMENT on receipt blockHash' <<<"$OUT" && echo 0 || echo 1)"

new_case router_disagree
awk -F'\t' 'BEGIN{OFS="\t"} { if ($1 ~ /routerkind\(address\)\(uint8\)\|0xcf77/) $2="3"; print }' \
  "$STUB_DIR/pins-alt.tsv" >"$STUB_DIR/p.tsv" && mv "$STUB_DIR/p.tsv" "$STUB_DIR/pins-alt.tsv"
run_finalize "$ALT_URL"
check "fails closed when a router registration disagrees" "$(grep -q 'RPC DISAGREEMENT on routerKind' <<<"$OUT" && echo 0 || echo 1)"

echo "# independent-endpoint candidate list (unavailable candidates are skipped, disagreement never is)"
new_case alt_fallback
run_finalize "http://unavailable.stub.invalid,$ALT_URL"
check "skips an unresponsive independent endpoint and seals against the next" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "logs the skipped candidate by host only" "$(grep -q 'independent endpoint unavailable.stub.invalid did not answer the cross-check probe' <<<"$OUT" && echo 0 || echo 1)"
check "records the endpoint that actually answered" "$(
  [ "$(jq -r '.verification.rpcHosts.secondary' "$CASE_REPO/$FINAL_REL")" = "alt.stub.invalid" ] && echo 0 || echo 1)"

new_case alt_all_down
run_finalize "http://down-a.stub.invalid,http://down-b.stub.invalid"
check "fails closed when NO independent endpoint answers" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "names the missing cross-check instead of sealing on one endpoint" "$(grep -q 'refusing to seal without an independent cross-check' <<<"$OUT" && echo 0 || echo 1)"
check "seals nothing without a cross-check" "$(! sealed && echo 0 || echo 1)"

new_case alt_disagree_no_fallback
write_pins "$STUB_DIR/pins-alt.tsv" 26
run_finalize "$ALT_URL,http://down.stub.invalid"
check "a responsive but disagreeing endpoint hard-fails (no silent fallback)" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "reports the disagreement" "$(grep -q 'RPC DISAGREEMENT on feeBps' <<<"$OUT" && echo 0 || echo 1)"
check "does not fall through to the next candidate after a disagreement" "$(! grep -q 'independent endpoint down.stub.invalid did not answer' <<<"$OUT" && echo 0 || echo 1)"

echo "# CREATE derivation and transaction shape"
new_case computed_wrong
printf 'Address: 0x000000000000000000000000000000000000dEaD\n' >"$STUB_DIR/computed-address"
run_finalize
check "fails closed when (deployer, nonce) derives another address" "$(grep -q 'is 0x000000000000000000000000000000000000dEaD, not' <<<"$OUT" && echo 0 || echo 1)"

new_case not_create
write_txobj "$STUB_DIR/txobj-primary.json" "$FIX_TX" 0x2 "0x2626664c2603336E57B271c5C0b26F421741e481"
run_finalize
check "fails closed when the tx has a 'to' (not a CREATE)" "$(grep -q 'not a contract-creating transaction' <<<"$OUT" && echo 0 || echo 1)"

new_case chain_drift
printf '84532\n' >"$STUB_DIR/chainid-primary"
run_finalize
check "fails closed when chain id is not 8453" "$(grep -q 'chain id drifted: 84532' <<<"$OUT" && echo 0 || echo 1)"

new_case multi_create
write_run_json "$CASE_REPO/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json" "$FIX_TX" "$FIX_EXECUTOR" 2
run_finalize
check "fails closed when the artifact records more than one CREATE" "$(grep -q 'records 2 CREATE transactions' <<<"$OUT" && echo 0 || echo 1)"

echo "# eth_getProof unavailable (optional evidence degrades, agreement still required)"
new_case no_proof
: >"$STUB_DIR/proof-missing-primary"
: >"$STUB_DIR/proof-missing-alt"
run_finalize "$ALT_URL"
check "still seals when neither endpoint serves eth_getProof" "$([ "$RC" -eq 0 ] && echo 0 || echo 1)"
check "records runtimeCodeHash as null instead of guessing" "$(jq -e '.verification.runtimeCodeHash == null' "$CASE_REPO/$FINAL_REL" >/dev/null && echo 0 || echo 1)"
check "still records the agreed runtime code size" "$(jq -e '.verification.runtimeCodeSize > 0' "$CASE_REPO/$FINAL_REL" >/dev/null && echo 0 || echo 1)"

echo "# gate/flags guards"
new_case already_sealed
cp "$STUB_DIR/staging.json" "$CASE_REPO/$FINAL_REL"
run_finalize
check "refuses to reseal an existing final manifest" "$([ "$RC" -ne 0 ] && grep -q 'final manifest already exists' <<<"$OUT" && echo 0 || echo 1)"

new_case no_staging
rm -f "$CASE_REPO/$STAGING_REL"
run_finalize
check "refuses to seal without a staging manifest" "$(grep -q 'staging manifest missing' <<<"$OUT" && echo 0 || echo 1)"

echo
echo "finalize-manifest: $FIX_PASS passed, $FIX_FAIL failed"
[ "$FIX_FAIL" -eq 0 ]
