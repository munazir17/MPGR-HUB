#!/usr/bin/env bash
# Seal the staging manifest with REAL deployment facts: tx hash, block number,
# receipt status and gas from the Foundry broadcast artifact + on-chain receipt,
# then re-read every constructor pin ON-CHAIN and compare against the manifest.
# The final deployments/base-mainnet/mpgr-swap-executor-v2.json is written ONLY if
# every assertion passes; placeholders ("pending-record", empty deployTx,
# deployBlock 0) can therefore never reach the final artifact.
#
# RPC RESILIENCE (added after trusted run 39294717599 broadcast a successful
# CREATE but this seal step died with "contract ... does not have any code"):
# public Base endpoints are load-balanced and a read replica can lag the writer
# that served the receipt, so an immediate eth_call can hit a node that has not
# ingested the deployment block yet. Every read here is therefore:
#   1. preceded by a BOUNDED runtime-code propagation poll (codesize > 0)
#      before any eth_call is attempted, and
#   2. wrapped in bounded retries with capped linear backoff.
# If an independent second RPC (arg 2 or BASE_MAINNET_RPC_URL_ALT) is given, the
# receipt, the CREATE tx, chain id, runtime code hash, codesize, every pin and
# every router registration are read from BOTH endpoints and must agree exactly;
# any disagreement fails closed with both values reported. Retry exhaustion also
# fails closed: nothing is sealed from unavailable, unverified or contradictory
# reads, and the staging manifest + evidence are preserved for investigation.
# This script is strictly READ-ONLY on-chain: it never broadcasts and never
# takes a private key. It can also seal the ONE existing deployment after the
# fact via scripts/swap-deploy-v2/recover-finalize.sh (no re-deployment).
#
# Usage: scripts/swap-deploy-v2/finalize-manifest.sh <rpc-url> [alt-rpc-url]
# Tunables (env): FINALIZE_RPC_ATTEMPTS (default 8),
#   FINALIZE_RPC_BACKOFF_SECONDS (default 3, linear), FINALIZE_RPC_BACKOFF_CAP_SECONDS (15),
#   FINALIZE_CODE_WAIT_ATTEMPTS (default 36), FINALIZE_CODE_WAIT_INTERVAL_SECONDS (5),
#   BASE_MAINNET_RPC_URL_ALT (independent read-only RPC), FINALIZE_EVIDENCE_FILE.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RPC="${1:?usage: finalize-manifest.sh <rpc-url> [alt-rpc-url]}"
ALT_RPC="${2:-${BASE_MAINNET_RPC_URL_ALT:-}}"
STAGING=deployments/base-mainnet/mpgr-swap-executor-v2.staging.json
FINAL=deployments/base-mainnet/mpgr-swap-executor-v2.json
RUN_JSON="broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json"

RPC_ATTEMPTS="${FINALIZE_RPC_ATTEMPTS:-8}"
RPC_BACKOFF="${FINALIZE_RPC_BACKOFF_SECONDS:-3}"
RPC_BACKOFF_CAP="${FINALIZE_RPC_BACKOFF_CAP_SECONDS:-15}"
CODE_POLLS="${FINALIZE_CODE_WAIT_ATTEMPTS:-36}"
CODE_POLL_WAIT="${FINALIZE_CODE_WAIT_INTERVAL_SECONDS:-5}"
EVIDENCE_FILE="${FINALIZE_EVIDENCE_FILE:-}"

ERRLOG="$(mktemp)"
trap 'rm -f "$ERRLOG"' EXIT

fail() {
  echo "FINALIZE FAIL: $1" >&2
  if [ -n "$EVIDENCE_FILE" ]; then printf '%s\n' "FINALIZE FAIL: $1" >>"$EVIDENCE_FILE" 2>/dev/null || true; fi
  exit 1
}
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# Log-safe RPC label: host only. A provider URL may embed an API key in its
# path/query, which must never reach logs, annotations or the manifest.
host_label() { printf '%s' "$1" | sed -E 's|^[A-Za-z][A-Za-z0-9+.-]*://||; s|^[^@/]*@||; s|[/?#].*$||'; }
short() { local s="$1"; if [ "${#s}" -le 84 ]; then printf '%s' "$s"; else printf '%s...(%d chars)' "${s:0:80}" "${#s}"; fi; }

for knob in RPC_ATTEMPTS RPC_BACKOFF RPC_BACKOFF_CAP CODE_POLLS CODE_POLL_WAIT; do
  grep -Eq '^(0|[1-9][0-9]*)$' <<<"${!knob}" || fail "$knob must be a non-negative integer (got '${!knob}')"
done
[ "$RPC_ATTEMPTS" -ge 1 ] || fail "FINALIZE_RPC_ATTEMPTS must be >= 1"
[ "$CODE_POLLS" -ge 1 ] || fail "FINALIZE_CODE_WAIT_ATTEMPTS must be >= 1"
if [ -n "$ALT_RPC" ] && [ "$(host_label "$ALT_RPC")" = "$(host_label "$RPC")" ]; then
  fail "second RPC ($(host_label "$ALT_RPC")) is not independent of the primary ($(host_label "$RPC")); refusing a self-cross-check"
fi

[ -f "$STAGING" ] || fail "staging manifest missing ($STAGING)"
[ ! -f "$FINAL" ] || fail "final manifest already exists"
[ -f "$RUN_JSON" ] || fail "broadcast artifact missing ($RUN_JSON)"

EXEC="$(jq -r '.executor // empty' "$STAGING")"
DEPLOYER="$(jq -r '.deployer // empty' "$STAGING")"
grep -Eq '^0x[0-9a-fA-F]{40}$' <<<"$EXEC" || fail "staging manifest executor is not an address ('$EXEC')"
grep -Eq '^0x[0-9a-fA-F]{40}$' <<<"$DEPLOYER" || fail "staging manifest deployer is not an address ('$DEPLOYER')"

CREATES="$(jq -r '[.transactions[] | select(.transactionType == "CREATE")] | length' "$RUN_JSON")"
[ "$CREATES" = "1" ] || fail "broadcast artifact records $CREATES CREATE transactions; exactly 1 was authorized"
TX="$(jq -r --arg a "$(lc "$EXEC")" \
  '[.transactions[] | select(.transactionType == "CREATE" and ((.contractAddress // "") | ascii_downcase) == $a) | .hash][0] // empty' \
  "$RUN_JSON")"
[ -n "$TX" ] || fail "no CREATE tx for $EXEC in broadcast artifact"
grep -Eq '^0x[0-9a-fA-F]{64}$' <<<"$TX" || fail "malformed tx hash $TX"

# Bounded-retry wrapper for every RPC read. Retries ANY transient failure
# (timeout, empty response, replica lag such as "does not have any code") up to
# RPC_ATTEMPTS times with capped linear backoff, then fails closed loudly.
rpc_read() { # $1 = rpc url; rest = cast args (without --rpc-url)
  local url="$1"; shift
  local attempt=1 out rc delay
  while :; do
    if out="$(cast "$@" --rpc-url "$url" 2>>"$ERRLOG")"; then printf '%s\n' "$out"; return 0; fi
    rc=$?
    if [ "$attempt" -ge "$RPC_ATTEMPTS" ]; then
      echo "FINALIZE FAIL: RPC read 'cast $*' on $(host_label "$url") failed all $RPC_ATTEMPTS bounded attempts; last cast error: $(tail -1 "$ERRLOG" 2>/dev/null)" >&2
      if [ -n "$EVIDENCE_FILE" ]; then tail -5 "$ERRLOG" >>"$EVIDENCE_FILE" 2>/dev/null || true; fi
      return "$rc"
    fi
    delay=$(( RPC_BACKOFF * attempt ))
    if [ "$delay" -gt "$RPC_BACKOFF_CAP" ]; then delay=$RPC_BACKOFF_CAP; fi
    echo "finalize: transient RPC failure on $(host_label "$url") for 'cast $*' (attempt $attempt/$RPC_ATTEMPTS); retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$(( attempt + 1 ))
  done
}

# Bounded runtime-code propagation gate: the direct antidote to sealing against
# a replica that has not ingested the deployment block yet ("contract ... does
# not have any code"). Polls codesize until non-zero; exhaustion fails closed.
CODE_POLLS_USED=0
wait_for_code() { # $1 = rpc url
  local url="$1" attempt=1 sz
  while :; do
    sz="$(cast codesize "$EXEC" --rpc-url "$url" 2>>"$ERRLOG" || true)"
    sz="${sz//[!0-9]/}"
    if [ -n "$sz" ] && [ "$sz" -gt 0 ]; then
      echo "finalize: runtime code for $EXEC visible on $(host_label "$url") (codesize=$sz) after poll $attempt/$CODE_POLLS" >&2
      if [ "$url" = "$RPC" ]; then CODE_POLLS_USED=$attempt; fi
      return 0
    fi
    if [ "$attempt" -ge "$CODE_POLLS" ]; then
      fail "executor $EXEC still has NO runtime code on $(host_label "$url") after $attempt bounded polls (~$(( CODE_POLL_WAIT * attempt ))s); RPC state propagation failed or this is not the deployed address - failing closed without sealing"
    fi
    echo "finalize: waiting for runtime code of $EXEC on $(host_label "$url") (poll $attempt/$CODE_POLLS, next in ${CODE_POLL_WAIT}s)" >&2
    sleep "$CODE_POLL_WAIT"
    attempt=$(( attempt + 1 ))
  done
}

# Second-RPC cross-check: fail closed on ANY disagreement or empty read.
cross_eq() { # $1 label, $2 primary value, $3 second value
  local p a
  p="$(lc "$2")"; a="$(lc "$3")"
  if [ -z "$p" ] || [ -z "$a" ]; then
    fail "second-RPC cross-check of $1 read an empty value (primary='$(short "$2")' second='$(short "$3")')"
  fi
  if [ "$p" != "$a" ]; then
    fail "RPC DISAGREEMENT on $1: primary=$(short "$2") second=$(short "$3"); failing closed - the two providers do not agree on chain state"
  fi
}

# Optional-but-cross-checked runtime code hash via eth_getProof. Providers that
# do not serve eth_getProof yield an empty string (recorded as null); when BOTH
# endpoints answer, the hashes must be identical (checked by the caller).
code_hash() { # $1 = rpc url
  local url="$1" attempt=1 out
  while :; do
    if out="$(cast rpc eth_getProof "$EXEC" '[]' latest --rpc-url "$url" 2>>"$ERRLOG")"; then
      jq -r '.codeHash // empty' <<<"$out"
      return 0
    fi
    if [ "$attempt" -ge "$RPC_ATTEMPTS" ]; then printf '\n'; return 0; fi
    sleep "$RPC_BACKOFF"
    attempt=$(( attempt + 1 ))
  done
}

# --- chain identity + propagation gate on the primary RPC --------------------
CHAIN_NOW="$(rpc_read "$RPC" chain-id)" || fail "chain id unreadable on primary RPC ($(host_label "$RPC"))"
[ "$CHAIN_NOW" = "8453" ] || fail "chain id drifted: $CHAIN_NOW"
wait_for_code "$RPC"

# --- exact CREATE transaction + receipt recovery (never inferred) ------------
RCPT="$(rpc_read "$RPC" receipt "$TX" --json)" || fail "receipt unavailable for $TX on primary RPC ($(host_label "$RPC"))"
STATUS="$(jq -r '.status // empty' <<<"$RCPT")"
[ "$STATUS" = "0x1" ] || fail "deploy tx status $STATUS != 0x1"
BLOCK_HEX="$(jq -r '.blockNumber // empty' <<<"$RCPT")"
[ -n "$BLOCK_HEX" ] || fail "receipt has no blockNumber"
BLOCK=$(( BLOCK_HEX ))
[ "$BLOCK" -gt 0 ] || fail "invalid block number"
RCPT_TXHASH="$(jq -r '.transactionHash // empty' <<<"$RCPT")"
if [ -z "$RCPT_TXHASH" ] || [ "$(lc "$RCPT_TXHASH")" != "$(lc "$TX")" ]; then
  fail "receipt transactionHash '$RCPT_TXHASH' != broadcast tx $TX"
fi
RCPT_FROM="$(jq -r '.from // empty' <<<"$RCPT")"
[ "$(lc "$RCPT_FROM")" = "$(lc "$DEPLOYER")" ] || fail "receipt from $RCPT_FROM != manifest deployer $DEPLOYER"
RCPT_CONTRACT="$(jq -r '.contractAddress // empty' <<<"$RCPT")"
[ -n "$RCPT_CONTRACT" ] || fail "receipt for $TX has no contractAddress: not the CREATE receipt of $EXEC"
[ "$(lc "$RCPT_CONTRACT")" = "$(lc "$EXEC")" ] || fail "receipt contractAddress $RCPT_CONTRACT != executor $EXEC"
GAS_USED="$(jq -r '.gasUsed // empty' <<<"$RCPT")"
[ -n "$GAS_USED" ] || fail "receipt has no gasUsed"
BLOCK_HASH="$(jq -r '.blockHash // empty' <<<"$RCPT")"
[ -n "$BLOCK_HASH" ] || fail "receipt has no blockHash"

TXOBJ="$(rpc_read "$RPC" rpc eth_getTransactionByHash "$TX")" || fail "tx $TX unreadable on primary RPC"
[ "$(jq -r '.hash // empty' <<<"$TXOBJ")" != "" ] || fail "tx $TX not found on primary RPC"
TX_TO="$(jq -r '.to // "null"' <<<"$TXOBJ")"
[ "$TX_TO" = "null" ] || fail "tx $TX has to=$TX_TO: not a contract-creating transaction"
TX_FROM="$(jq -r '.from // empty' <<<"$TXOBJ")"
[ "$(lc "$TX_FROM")" = "$(lc "$DEPLOYER")" ] || fail "tx from $TX_FROM != manifest deployer $DEPLOYER"
TX_NONCE_HEX="$(jq -r '.nonce // empty' <<<"$TXOBJ")"
[ -n "$TX_NONCE_HEX" ] || fail "tx $TX has no nonce"
TX_NONCE=$(( TX_NONCE_HEX ))
TX_CHAIN_HEX="$(jq -r '.chainId // empty' <<<"$TXOBJ")"
if [ -n "$TX_CHAIN_HEX" ] && [ $(( TX_CHAIN_HEX )) -ne 8453 ]; then
  fail "tx $TX carries chainId $(( TX_CHAIN_HEX )) != 8453"
fi

# Independent derivation of the CREATE address from (deployer, tx nonce):
# purely offline RLP/keccak math, so it cannot be fooled by a lagging replica.
COMPUTED="$(cast compute-address "$DEPLOYER" --nonce "$TX_NONCE" 2>>"$ERRLOG" | grep -oE '0x[0-9a-fA-F]{40}' | tail -1 || true)"
[ -n "$COMPUTED" ] || fail "could not derive the CREATE address for deployer $DEPLOYER nonce $TX_NONCE"
[ "$(lc "$COMPUTED")" = "$(lc "$EXEC")" ] || fail "CREATE address derived from deployer $DEPLOYER nonce $TX_NONCE is $COMPUTED, not $EXEC"

CODE_SIZE_P="$(rpc_read "$RPC" codesize "$EXEC")" || fail "codesize unreadable on primary RPC"
CODE_HASH_P="$(code_hash "$RPC")"
ZERO_HASH="0x0000000000000000000000000000000000000000000000000000000000000000"
if [ "$CODE_HASH_P" = "$ZERO_HASH" ]; then
  fail "eth_getProof reports the zero code hash for $EXEC despite codesize=$CODE_SIZE_P"
fi

# --- second-RPC cross-checks of every recovered fact (fail closed) -----------
if [ -n "$ALT_RPC" ]; then
  ALT_CHAIN="$(rpc_read "$ALT_RPC" chain-id)" || fail "chain id unreadable on second RPC ($(host_label "$ALT_RPC"))"
  [ "$ALT_CHAIN" = "8453" ] || fail "second RPC reports chain id $ALT_CHAIN != 8453"
  wait_for_code "$ALT_RPC"
  ALT_RCPT="$(rpc_read "$ALT_RPC" receipt "$TX" --json)" || fail "receipt unavailable for $TX on second RPC"
  cross_eq "receipt status"          "$STATUS"         "$(jq -r '.status // empty' <<<"$ALT_RCPT")"
  cross_eq "receipt blockNumber"     "$BLOCK_HEX"      "$(jq -r '.blockNumber // empty' <<<"$ALT_RCPT")"
  cross_eq "receipt blockHash"       "$BLOCK_HASH"     "$(jq -r '.blockHash // empty' <<<"$ALT_RCPT")"
  cross_eq "receipt transactionHash" "$TX"             "$(jq -r '.transactionHash // empty' <<<"$ALT_RCPT")"
  cross_eq "receipt from"            "$RCPT_FROM"      "$(jq -r '.from // empty' <<<"$ALT_RCPT")"
  cross_eq "receipt contractAddress" "$RCPT_CONTRACT"  "$(jq -r '.contractAddress // empty' <<<"$ALT_RCPT")"
  cross_eq "receipt gasUsed"         "$GAS_USED"       "$(jq -r '.gasUsed // empty' <<<"$ALT_RCPT")"
  ALT_TXOBJ="$(rpc_read "$ALT_RPC" rpc eth_getTransactionByHash "$TX")" || fail "tx $TX unreadable on second RPC"
  cross_eq "tx nonce"                "$TX_NONCE_HEX"   "$(jq -r '.nonce // empty' <<<"$ALT_TXOBJ")"
  cross_eq "tx from"                 "$TX_FROM"        "$(jq -r '.from // empty' <<<"$ALT_TXOBJ")"
  cross_eq "tx to (CREATE => null)"  "$TX_TO"          "$(jq -r '.to // "null"' <<<"$ALT_TXOBJ")"
  cross_eq "tx input (initcode)"     "$(jq -r '.input // empty' <<<"$TXOBJ")" "$(jq -r '.input // empty' <<<"$ALT_TXOBJ")"
  CODE_SIZE_A="$(rpc_read "$ALT_RPC" codesize "$EXEC")" || fail "codesize unreadable on second RPC"
  cross_eq "runtime codesize"        "$CODE_SIZE_P"    "$CODE_SIZE_A"
  CODE_HASH_A="$(code_hash "$ALT_RPC")"
  if [ -n "$CODE_HASH_P" ] && [ -n "$CODE_HASH_A" ]; then
    cross_eq "runtime code hash" "$CODE_HASH_P" "$CODE_HASH_A"
  fi
fi

# --- independent on-chain re-read of every pin (never trust the script's own file).
read_pin() { # $1 = rpc url; rest = cast call args
  local url="$1"; shift
  rpc_read "$url" call "$EXEC" "$@" | sed 's/ *\[.*//' | tr -d '[:space:]'
}
# Reads one pin from the primary (and, when configured, the second RPC),
# cross-checks both reads, and echoes the primary value.
pin_pair() { # $1 = label; rest = cast call args (sig [arg...])
  local label="$1" p a
  shift
  p="$(read_pin "$RPC" "$@")" || fail "on-chain read of $label failed on primary RPC ($(host_label "$RPC"))"
  if [ -n "$ALT_RPC" ]; then
    a="$(read_pin "$ALT_RPC" "$@")" || fail "on-chain read of $label failed on second RPC ($(host_label "$ALT_RPC"))"
    cross_eq "$label" "$p" "$a"
  fi
  printf '%s' "$p"
}
expect_eq() { [ "$(lc "$2")" = "$(lc "$3")" ] || fail "on-chain $1 ($2) != manifest ($3)"; }
FEE_BPS="$(pin_pair feeBps 'feeBps()(uint16)')"
MAX_BPS="$(pin_pair maxFeeBps 'MAX_FEE_BPS()(uint16)')"
TIMELOCK="$(pin_pair timelock 'FEE_TIMELOCK_SECONDS()(uint48)')"
PENDING="$(pin_pair pendingEffectiveAt 'pendingEffectiveAt()(uint48)')"
RECIPIENT="$(pin_pair feeRecipient 'feeRecipient()(address)')"
OWNER="$(pin_pair owner 'owner()(address)')"
WETH_ONCHAIN="$(pin_pair weth 'WETH()(address)')"
PERMIT2_ONCHAIN="$(pin_pair permit2 'PERMIT2()(address)')"

expect_eq "feeBps"       "$FEE_BPS"      "$(jq -r .feeBps "$STAGING")"
expect_eq "maxFeeBps"    "$MAX_BPS"      "$(jq -r .maxFeeBps "$STAGING")"
expect_eq "timelock"     "$TIMELOCK"     "$(jq -r .feeTimelockSeconds "$STAGING")"
[ "$PENDING" = "0" ] || fail "pending fee change at birth"
expect_eq "feeRecipient" "$RECIPIENT"    "$(jq -r .feeRecipient "$STAGING")"
expect_eq "owner"        "$OWNER"        "$(jq -r .owner "$STAGING")"
expect_eq "weth"         "$WETH_ONCHAIN" "$(jq -r .weth "$STAGING")"
expect_eq "permit2"      "$PERMIT2_ONCHAIN" "$(jq -r .permit2 "$STAGING")"

expect_eq "initial fee" "$FEE_BPS" "25"
expect_eq "hard cap" "$MAX_BPS" "100"
expect_eq "delay" "$TIMELOCK" "172800"
expect_eq "Safe" "$OWNER" "0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B"
expect_eq "treasury" "$RECIPIENT" "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4"
# Venue registry: every router must be registered on-chain with the exact kind
# (cross-checked against the second RPC when configured).
VENUE_COUNT=0
while read -r v; do
  R="$(jq -r .router <<<"$v")"; K="$(jq -r .kind <<<"$v")"
  ONCHAIN_KIND="$(pin_pair "routerKind($R)" 'routerKind(address)(uint8)' "$R")"
  [ "$ONCHAIN_KIND" = "$K" ] || fail "router $R kind on-chain $ONCHAIN_KIND != manifest $K"
  VENUE_COUNT=$(( VENUE_COUNT + 1 ))
done < <(jq -c '.venues[]' "$STAGING")
[ "$VENUE_COUNT" = "5" ] || fail "verified $VENUE_COUNT router registrations on-chain; the manifest must pin exactly 5"

# --- seal ---------------------------------------------------------------------
CROSS=false
if [ -n "$ALT_RPC" ]; then CROSS=true; fi
ALT_HOST=""
if [ -n "$ALT_RPC" ]; then ALT_HOST="$(host_label "$ALT_RPC")"; fi
VERIF="$(jq -n \
  --arg codeHash "$CODE_HASH_P" \
  --argjson crossChecked "$CROSS" \
  --argjson polls "$CODE_POLLS_USED" \
  --arg computed "$COMPUTED" \
  --argjson nonce "$TX_NONCE" \
  --arg codesize "$CODE_SIZE_P" \
  --arg primary "$(host_label "$RPC")" \
  --arg secondary "$ALT_HOST" \
  '{chainIdAtSeal: 8453,
    runtimeCodeHash: (if $codeHash == "" then null else $codeHash end),
    runtimeCodeSize: ($codesize | tonumber),
    crossCheckedWithSecondRpc: $crossChecked,
    codeWaitPolls: $polls,
    computedCreateAddress: $computed,
    deployTxNonce: $nonce,
    rpcHosts: {primary: $primary, secondary: (if $secondary == "" then null else $secondary end)}}')"

jq --arg tx "$TX" --argjson block "$BLOCK" --arg status "$STATUS" \
   --arg from "$RCPT_FROM" --arg gas "$GAS_USED" --arg bh "$BLOCK_HASH" --arg ca "$RCPT_CONTRACT" \
   --argjson verif "$VERIF" \
   '.deployTx = $tx | .deployBlock = $block
    | .deployReceipt = {status: $status, from: $from, gasUsed: $gas, blockHash: $bh, contractAddress: $ca}
    | .verification = $verif
    | del(.stagedAtBlock)' "$STAGING" > "$FINAL.tmp"

# Completeness gate on the FINAL artifact itself.
grep -q 'pending-record' "$FINAL.tmp" && fail "placeholder pending-record found" || true
jq -e '.deployTx | test("^0x[0-9a-fA-F]{64}$")' "$FINAL.tmp" >/dev/null || fail "deployTx not a real 32-byte hash"
jq -e '.deployBlock > 0' "$FINAL.tmp" >/dev/null || fail "deployBlock not sealed"
jq -e '(.venues | length) == 5' "$FINAL.tmp" >/dev/null || fail "venue registry incomplete"
jq -e '.executor and .owner and .deployer and .feeRecipient' "$FINAL.tmp" >/dev/null || fail "manifest identity fields incomplete"
jq -e '(.deployReceipt.contractAddress | ascii_downcase) == (.executor | ascii_downcase)' "$FINAL.tmp" >/dev/null || fail "sealed receipt contractAddress != executor"
jq -e '(.verification.computedCreateAddress | ascii_downcase) == (.executor | ascii_downcase)' "$FINAL.tmp" >/dev/null || fail "sealed computed CREATE address != executor"
jq -e '.verification.runtimeCodeHash == null or (.verification.runtimeCodeHash | test("^0x[0-9a-fA-F]{64}$"))' "$FINAL.tmp" >/dev/null || fail "runtime code hash malformed"
jq -e '.verification.runtimeCodeSize > 0' "$FINAL.tmp" >/dev/null || fail "runtime code size not sealed"
mv "$FINAL.tmp" "$FINAL"
rm -f "$STAGING"
echo "FINALIZE PASS: executor=$EXEC tx=$TX block=$BLOCK status=$STATUS gasUsed=$GAS_USED codeSize=$CODE_SIZE_P codeHash=${CODE_HASH_P:-unavailable} crossChecked=$CROSS codeWaitPolls=$CODE_POLLS_USED"

# Close only the V2 gate; never modify v1's consumed one-shot gate.
jq '.swapExecutorV2DeployEnabled = false | .consumed = true' deployments/base-mainnet/deploy-v2-config.json > deployments/base-mainnet/deploy-v2-config.json.tmp
mv deployments/base-mainnet/deploy-v2-config.json.tmp deployments/base-mainnet/deploy-v2-config.json
