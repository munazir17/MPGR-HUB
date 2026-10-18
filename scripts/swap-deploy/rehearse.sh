#!/usr/bin/env bash
# LOCAL ANVIL REHEARSAL of the exact deployment pipeline, shared by the CI
# gates job and local verification. Proves, with GENERATED TEST-ONLY keys that
# never touch a public chain:
#   preflight -> forge script simulate -> broadcast (local only) ->
#   finalize-manifest seal (real tx hash/block from the local receipt) ->
#   on-chain pin re-reads -> manifest completeness asserts.
#
# Mode selection:
#   fork mode   - $1 (or BASE_MAINNET_RPC_URL) reachable: anvil forks Base
#                 Mainnet at a pinned block (real state, still local-only).
#   seeded mode - no RPC reachable (e.g. sandbox): anvil runs bare with
#                 --chain-id 8453 and canonical venue addresses are seeded
#                 with anvil_setCode so constructor/pin paths execute. Seeded
#                 mode is labelled TEST-STAND-IN STATE in all output.
#
# SWAP_REHEARSAL_OVERRIDE_GATE=true temporarily opens deploy-config.json IN THE
# WORKING TREE ONLY (restored on exit, never committed) so the success path can
# be rehearsed while the committed production gate stays closed. Without the
# override the rehearsal asserts the committed gate and fails closed.
# SWAP_REHEARSAL_EVIDENCE_DIR (optional): copy rehearsal evidence there.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FORK_RPC="${1:-${BASE_MAINNET_RPC_URL:-}}"
CFG=deployments/base-mainnet/deploy-config.json
STAGING=deployments/base-mainnet/mpgr-swap-executor.staging.json
FINAL=deployments/base-mainnet/mpgr-swap-executor.json
SCRIPT_PATH=script/DeployMPGRSwapExecutorBaseMainnet.s.sol:DeployMPGRSwapExecutorBaseMainnet
LOCAL=http://127.0.0.1:8545
fail() { echo "REHEARSAL FAIL: $1" >&2; exit 1; }

# --- gate handling -----------------------------------------------------------
CFG_BACKUP="$(mktemp)"
cp "$CFG" "$CFG_BACKUP"
if [ "${SWAP_REHEARSAL_OVERRIDE_GATE:-false}" = "true" ]; then
  echo "REHEARSAL NOTICE: committed gate is $(jq -r '.swapExecutorDeployEnabled // false' "$CFG"); overriding IN WORKING TREE ONLY for rehearsal (restored on exit, never committed)."
  jq '.swapExecutorDeployEnabled = true' "$CFG_BACKUP" > "$CFG"
else
  jq -e '.swapExecutorDeployEnabled == true' "$CFG" >/dev/null \
    || fail "committed deployment gate is CLOSED (deploy-config.json swapExecutorDeployEnabled != true) - rehearsal fails closed like the deploy job would"
fi

ANVIL_PID=""
cleanup() {
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  wait "$ANVIL_PID" 2>/dev/null || true
  cp "$CFG_BACKUP" "$CFG"; rm -f "$CFG_BACKUP"
  rm -f "$STAGING" "$FINAL"
  rm -rf broadcast/DeployMPGRSwapExecutorBaseMainnet.s.sol
}
trap cleanup EXIT

[ ! -f "$FINAL" ] || fail "final manifest exists in repo - clean it before rehearsing"
[ ! -f "$STAGING" ] || fail "staging manifest exists in repo - clean it before rehearsing"

# --- anvil --------------------------------------------------------------------
MODE=fork
FORK_BLOCK=""
if [ -n "$FORK_RPC" ]; then
  for a in 1 2 3; do FORK_BLOCK="$(cast block-number --rpc-url "$FORK_RPC" 2>/dev/null || true)"; [ -n "$FORK_BLOCK" ] && break; sleep $((a * 3)); done
fi
if [ -n "$FORK_BLOCK" ]; then
  echo "REHEARSAL MODE: fork of Base Mainnet at block $FORK_BLOCK (local anvil only)"
  anvil --fork-url "$FORK_RPC" --fork-block-number "$FORK_BLOCK" --port 8545 --retries 8 --fork-retry-backoff 2000 --timeout 60000 > anvil-rehearsal.log 2>&1 &
else
  MODE=seeded
  [ -n "$FORK_RPC" ] && echo "REHEARSAL NOTICE: RPC unreachable; falling back to seeded local chain."
  echo "REHEARSAL MODE: seeded TEST-STAND-IN STATE (bare anvil, chain-id 8453, canonical addresses etched with placeholder code)"
  anvil --chain-id 8453 --port 8545 > anvil-rehearsal.log 2>&1 &
fi
ANVIL_PID=$!
for _ in $(seq 1 120); do [ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null || true)" = "8453" ] && break; sleep 1; done
[ "$(cast chain-id --rpc-url "$LOCAL" 2>/dev/null || true)" = "8453" ] || fail "anvil did not come up with chain id 8453"

# --- generated TEST-ONLY identities (never used on any public chain) ----------
KEY="0x$(openssl rand -hex 32)";  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "::add-mask::$KEY" || true
OWNER_KEY="0x$(openssl rand -hex 32)"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "::add-mask::$OWNER_KEY" || true
ADDR="$(cast wallet address --private-key "$KEY")"
OWNER_ADDR="$(cast wallet address --private-key "$OWNER_KEY")"
[ "$(printf '%s' "$ADDR" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$OWNER_ADDR" | tr 'A-Z' 'a-z')" ] || fail "generated deployer == owner (astronomically unlikely; rerun)"
cast rpc anvil_setBalance "$ADDR" 0x8AC7230489E80000 --rpc-url "$LOCAL" >/dev/null   # 10 ETH
cast rpc anvil_setCode "$OWNER_ADDR" 0x600160005260206000f3 --rpc-url "$LOCAL" >/dev/null # multisig stand-in (TEST ONLY)

if [ "$MODE" = "seeded" ]; then
  for A in \
    0x2626664c2603336E57B271c5C0b26F421741e481 0x33128a8fC17869897dcE68Ed026d694621f6FDfD 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a \
    0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef 0x514c8B5f54112481E28028F1166Bd78501089259 \
    0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6 \
    0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 0x420DD381b31aEf6683db6B902084cB0FFECe40Da \
    0x1b81D678ffb9C0263b24A97847620C99d213eB14 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865 \
    0x4200000000000000000000000000000000000006 0x000000000022D473030F116dDEE9F6B43aC78BA3 \
    0x00000000000004533Fe15556B1E086BB1A72cEae 0x0000000000001fF3684f28c67538d4D072C22734; do
    cast rpc anvil_setCode "$A" 0x600160005260206000f3 --rpc-url "$LOCAL" >/dev/null
  done
fi

# --- exact production flow: env key + --private-key, simulate then broadcast ---
export BASE_MAINNET_DEPLOYER_PRIVATE_KEY="$KEY"
export MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true
export SWAP_EXECUTOR_OWNER="$OWNER_ADDR"

echo "REHEARSAL: preflight (nonce must be 0)"
NONCE="$(cast nonce "$ADDR" --rpc-url "$LOCAL")"
[ "$NONCE" = "0" ] || fail "fresh generated key has nonce $NONCE"

echo "REHEARSAL: forge script simulate"
forge script "$SCRIPT_PATH" --rpc-url "$LOCAL" --private-key "$KEY" -vv > rehearse-sim.log 2>&1 \
  || { tail -25 rehearse-sim.log; fail "simulate failed"; }
# The simulate pass executes run() for real (including vm.writeFile), so clear
# its staging artifact before the broadcast pass — same as the broadcast itself
# would refuse to run over an unfinished record.
rm -f "$STAGING"
echo "REHEARSAL: forge script broadcast (LOCAL ANVIL ONLY)"
forge script "$SCRIPT_PATH" --rpc-url "$LOCAL" --private-key "$KEY" --broadcast --slow -vv > rehearse-broadcast.log 2>&1 \
  || { tail -25 rehearse-broadcast.log; fail "broadcast failed"; }

echo "REHEARSAL: finalize manifest (seal with real local tx receipt)"
bash scripts/swap-deploy/finalize-manifest.sh "$LOCAL"

EXEC="$(jq -r .executor "$FINAL")"
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
chk() { V="$(cast call "$EXEC" "$1" --rpc-url "$LOCAL" | sed "s/ *\[.*//" | tr -d "[:space:]")"; [ "$(lc "$V")" = "$(lc "$2")" ] || fail "pin $1 mismatch ($V != $2)"; }
chk 'feeBps()(uint16)' 25
chk 'MAX_FEE_BPS()(uint16)' 100
chk 'FEE_TIMELOCK_SECONDS()(uint48)' 172800
chk 'pendingEffectiveAt()(uint48)' 0
chk 'feeRecipient()(address)' 0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4
chk 'owner()(address)' "$OWNER_ADDR"
chk 'WETH()(address)' 0x4200000000000000000000000000000000000006
chk 'PERMIT2()(address)' 0x000000000022D473030F116dDEE9F6B43aC78BA3
POST_NONCE="$(cast nonce "$ADDR" --rpc-url "$LOCAL")"
[ "$POST_NONCE" = "1" ] || fail "deployer nonce after single deployment should be 1, got $POST_NONCE"

grep -q 'pending-record' "$FINAL" && fail "placeholder in final manifest" || true
jq -e '.deployTx | test("^0x[0-9a-fA-F]{64}$")' "$FINAL" >/dev/null || fail "manifest deployTx not sealed"
jq -e '.deployBlock > 0 and (.venues | length) == 5' "$FINAL" >/dev/null || fail "manifest incomplete"

if [ -n "${SWAP_REHEARSAL_EVIDENCE_DIR:-}" ]; then
  mkdir -p "$SWAP_REHEARSAL_EVIDENCE_DIR"
  cp "$FINAL" rehearse-sim.log rehearse-broadcast.log anvil-rehearsal.log "$SWAP_REHEARSAL_EVIDENCE_DIR/" 2>/dev/null || true
  cp broadcast/DeployMPGRSwapExecutorBaseMainnet.s.sol/8453/run-latest.json "$SWAP_REHEARSAL_EVIDENCE_DIR/broadcast-run-latest.json" 2>/dev/null || true
  jq -r '"mode='"$MODE"' executor=\(.executor) tx=\(.deployTx) block=\(.deployBlock)"' "$FINAL" > "$SWAP_REHEARSAL_EVIDENCE_DIR/summary.txt"
fi
rm -f rehearse-sim.log rehearse-broadcast.log anvil-rehearsal.log
echo "REHEARSAL PASS (mode=$MODE): executor=$EXEC deployTx=$(jq -r .deployTx "$FINAL") deployBlock=$(jq -r .deployBlock "$FINAL") owner=$OWNER_ADDR deployer=$ADDR (test-only keys; local chain only)"
