#!/usr/bin/env bash
# V2 only. Never source or edit the consumed V1 deployment gate.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail() { echo "V2 PREFLIGHT FAIL: $1" >&2; exit 1; }
CFG=deployments/base-mainnet/deploy-v2-config.json
jq -e '.chainId == 8453 and .swapExecutorV2DeployEnabled == true and .consumed == false and (.deployerNonce | type == "number")' "$CFG" >/dev/null || fail 'V2 gate closed or reviewed nonce absent'
[ ! -f deployments/base-mainnet/mpgr-swap-executor-v2.json ] || fail 'already deployed'
[ ! -f deployments/base-mainnet/mpgr-swap-executor-v2.staging.json ] || fail 'unfinished prior deployment'
[ "${MPGR_SWAP_EXECUTOR_V2_DEPLOY_ENABLED:-false}" = true ] || fail 'explicit broadcast approval missing'
: "${BASE_MAINNET_DEPLOYER_PRIVATE_KEY:?environment deployer secret missing}"
: "${BASE_MAINNET_RPC_URL:?Base RPC required}"
: "${SWAP_EXECUTOR_OWNER:?Safe variable required}"
lc() { tr '[:upper:]' '[:lower:]'; }
[ "$(printf '%s' "$SWAP_EXECUTOR_OWNER" | lc)" = 0xd9ae570767c5a15780dd5cdadd0b1b732d98994b ] || fail 'wrong Safe'
[ "$(cast chain-id --rpc-url "$BASE_MAINNET_RPC_URL")" = 8453 ] || fail 'wrong chain'
# cast consumes its key from the environment; never place it in command output.
DEPLOYER=$(cast wallet address --private-key "$BASE_MAINNET_DEPLOYER_PRIVATE_KEY")
D=$(printf '%s' "$DEPLOYER" | lc)
[ "$D" != 0xd9ae570767c5a15780dd5cdadd0b1b732d98994b ] || fail 'deployer is Safe'
[ "$D" != 0x96f7fb5c4277bd1190fb6ef4820ebc96ba6964a4 ] || fail 'deployer is treasury'
# Not nonce == 0. Pin the existing key's observed nonce in the reviewed release.
[ "$(cast nonce "$DEPLOYER" --rpc-url "$BASE_MAINNET_RPC_URL")" = "$(jq -r .deployerNonce "$CFG")" ] || fail 'nonce drift: possible previous broadcast; do not retry'
bash scripts/swap-deploy/safe-check.sh "$SWAP_EXECUTOR_OWNER" "$BASE_MAINNET_RPC_URL"
BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$BASE_MAINNET_RPC_URL")
PRICE=$(cast gas-price --rpc-url "$BASE_MAINNET_RPC_URL")
# Conservative 8M gas allowance plus a 0.003 ETH floor, checked without shell overflow.
BALANCE="$BALANCE" PRICE="$PRICE" python3 - <<'PY'
import os
required = max(3_000_000_000_000_000, int(os.environ['PRICE']) * 8_000_000)
if int(os.environ['BALANCE']) < required:
    raise SystemExit('V2 PREFLIGHT FAIL: deployer ETH insufficient for gas; no broadcast')
PY
# Every typed venue and factory must have code. Factory identity for router adapters
# is checked independently; v4 is a PoolManager, not a v3 factory.
# Each row: router, expected factory, and the router's own factory getter signature.
# Aerodrome Classic (0xcF77...) exposes defaultFactory() and has no factory() selector.
while read -r ROUTER FACTORY GETTER; do
  [ "$(cast codesize "$ROUTER" --rpc-url "$BASE_MAINNET_RPC_URL")" -gt 0 ] || fail 'router has no code'
  [ "$(cast codesize "$FACTORY" --rpc-url "$BASE_MAINNET_RPC_URL")" -gt 0 ] || fail 'factory has no code'
  # A failed read must fail closed with its own message, never fall through to a comparison.
  ACTUAL=$(cast call "$ROUTER" "$GETTER" --rpc-url "$BASE_MAINNET_RPC_URL") \
    || fail "router factory read failed: router=$ROUTER getter=$GETTER expected=$FACTORY (call reverted or RPC error)"
  [ "$(printf '%s' "$ACTUAL" | lc)" = "$(printf '%s' "$FACTORY" | lc)" ] \
    || fail "router factory mismatch: router=$ROUTER getter=$GETTER expected=$FACTORY actual=$ACTUAL"
done <<'VENUES'
0x2626664c2603336E57B271c5C0b26F421741e481 0x33128a8fC17869897dcE68Ed026d694621f6FDfD factory()(address)
0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef factory()(address)
0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6 factory()(address)
0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 0x420DD381b31aEf6683db6B902084cB0FFECe40Da defaultFactory()(address)
VENUES
[ "$(cast codesize 0x498581fF718922c3f8e6A244956aF099B2652b2b --rpc-url "$BASE_MAINNET_RPC_URL")" -gt 0 ] || fail 'v4 manager has no code'
echo 'V2 preflight passed (not a fork-proof attestation)'
