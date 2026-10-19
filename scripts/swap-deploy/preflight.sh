#!/usr/bin/env bash
# Fail-closed preflight for the REAL Base Mainnet broadcast (deploy job only).
# Every check must pass or the script exits nonzero BEFORE any tx is signed.
# The private key is consumed from the environment and NEVER printed; only the
# derived public address appears in logs.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RPC="${BASE_MAINNET_RPC_URL:?BASE_MAINNET_RPC_URL required}"
KEY="${BASE_MAINNET_DEPLOYER_PRIVATE_KEY:?secret SWAP_BASE_MAINNET_DEPLOYER_PRIVATE_KEY missing (env BASE_MAINNET_DEPLOYER_PRIVATE_KEY)}"
OWNER="${SWAP_EXECUTOR_OWNER:?variable SWAP_EXECUTOR_OWNER missing in environment base-mainnet}"

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
fail() {
  echo "PREFLIGHT FAIL: $1" >&2
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Preflight failed closed::$1"
  exit 1
}
note() { [ -n "${GITHUB_ACTIONS:-}" ] && echo "::notice title=Preflight::$1" || echo "PREFLIGHT: $1"; }

note "deployer secret present (BASE_MAINNET_DEPLOYER_PRIVATE_KEY set; value never printed)"
note "owner variable present (SWAP_EXECUTOR_OWNER=$OWNER)"
[ "${MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED:-false}" = "true" ] || fail "MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED != true"

CFG=deployments/base-mainnet/deploy-config.json
jq -e '.chainId == 8453' "$CFG" >/dev/null || fail "deploy-config.json chainId != 8453"
GATE_STATE="$(jq -r '.swapExecutorDeployEnabled // "absent"' "$CFG")"
note "committed gate swapExecutorDeployEnabled=$GATE_STATE"
[ "$GATE_STATE" = "true" ] || fail "committed deployment gate is CLOSED (swapExecutorDeployEnabled=$GATE_STATE) - open it only via explicit owner approval"
[ ! -f deployments/base-mainnet/mpgr-swap-executor.json ] || fail "final manifest already exists - refusing a second deployment"
[ ! -f deployments/base-mainnet/mpgr-swap-executor.staging.json ] || fail "staging manifest exists - unfinished prior run must be resolved"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[ "$CHAIN_ID" = "8453" ] || fail "RPC chain id $CHAIN_ID != 8453"

ADDR="$(cast wallet address --private-key "$KEY")"
case "$ADDR" in 0x*) ;; *) fail "could not derive deployer address" ;; esac
NONCE="$(cast nonce "$ADDR" --rpc-url "$RPC")"
[ "$NONCE" = "0" ] || fail "deployer $ADDR nonce is $NONCE, must be 0 (fresh dedicated key; a used key can never deploy twice deterministically)"
[ "$(lc "$OWNER")" != "$(lc "$ADDR")" ] || fail "SWAP_EXECUTOR_OWNER must be the governance multisig, not the ephemeral deployer ($ADDR)"
SIZE="$(cast codesize "$OWNER" --rpc-url "$RPC")"
[ "$SIZE" -gt 0 ] || fail "SWAP_EXECUTOR_OWNER $OWNER has no code on Base - governance multisig must be a deployed contract"

# Bytecode alone is insufficient: verify a GENUINE Safe (canonical singleton in
# storage slot 0 + functioning getThreshold/getOwners/VERSION). Public data only.
SAFE_OUT="$(bash "$(dirname "$0")/safe-check.sh" "$OWNER" "$RPC")" || fail "SWAP_EXECUTOR_OWNER is not a verified genuine Safe/multisig"
SAFE_LINE="$(grep '^SAFE-CHECK PASS:' <<<"$SAFE_OUT")"

echo "PREFLIGHT PASS: chain=8453 deployer=$ADDR nonce=0 gates=committed-open; $SAFE_LINE"
