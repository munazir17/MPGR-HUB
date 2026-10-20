#!/usr/bin/env bash
# Shared fixture builders for the offline V2 finalize/recovery regression suites.
# Sourced by scripts/swap-deploy-v2/*.test.sh; never executed on its own.
# Everything here is local: no RPC, no GitHub, no secrets, no transactions.
# The addresses/tx below are PUBLIC chain data from the one existing deployment
# (trusted run 39294717599) and are used only as deterministic fixtures.

SWAP_V2_FIXTURES_LOADED=1

FIX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FIX_MOCKS_DIR="$FIX_ROOT/scripts/swap-deploy-v2/mocks"

FIX_TX=0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b
FIX_EXECUTOR=0x4be1154440b26145d76608D41d403a33e76b9d0A
FIX_DEPLOYER=0xfDCb6e78217cAf882189e48331a4B42A06309ACA
FIX_SAFE=0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B
FIX_TREASURY=0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4
FIX_WETH=0x4200000000000000000000000000000000000006
FIX_PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
FIX_BLOCK_HEX=0x32b0c85
FIX_BLOCK_HASH=0x9c7d6168d4767dce7f1a890a94a5be1877b82a7071072c3229ae1c5ade5b01ea
FIX_GAS=0x47b5b9
FIX_CODE_HASH=0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809
FIX_COMPUTED="Address: $FIX_EXECUTOR"
FIX_CREATES=1

# --- canonical venue registry (mirrors the deploy script / lib constant) ------
fix_venues_json() {
  cat <<'JSON'
[
  {"name":"uniswapV3","kind":2,"router":"0x2626664c2603336E57B271c5C0b26F421741e481","factory":"0x33128a8fC17869897dcE68Ed026d694621f6FDfD","quoter":"0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"},
  {"name":"slipstream","kind":1,"router":"0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F","factory":"0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef","quoter":"0x514c8B5f54112481E28028F1166Bd78501089259"},
  {"name":"uniswapV2","kind":3,"router":"0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24","factory":"0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6","quoter":null},
  {"name":"aerodromeClassic","kind":4,"router":"0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43","factory":"0x420DD381b31aEf6683db6B902084cB0FFECe40Da","quoter":null},
  {"name":"uniswapV4","kind":7,"router":"0x498581fF718922c3f8e6A244956aF099B2652b2b","factory":"0x498581fF718922c3f8e6A244956aF099B2652b2b","quoter":null}
]
JSON
}

# --- unsealed staging manifest (exactly what the deploy script writes) -------
write_staging() { # $1 path, ${2 executor}
  local path="$1" executor="${2:-$FIX_EXECUTOR}" venues
  venues="$(fix_venues_json)"
  jq -n --arg e "$executor" --argjson v "$venues" \
    '{manifestSchema: "mpgr-swap-executor/v2", chainId: 8453, executor: $e,
      deployer: "0xfDCb6e78217cAf882189e48331a4B42A06309ACA",
      owner: "0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B",
      weth: "0x4200000000000000000000000000000000000006",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      feeBps: 25, maxFeeBps: 100, feeTimelockSeconds: 172800,
      feeRecipient: "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4",
      explorerUrl: "https://basescan.org", deployTx: "", deployBlock: 0,
      stagedAtBlock: 52821000, venues: $v,
      disabledVenues: ["pancakeV3", "zerox"]}' >"$path"
}

# --- Foundry broadcast run-latest.json (only the fields finalize reads) ------
write_run_json() { # $1 path, ${2 tx}, ${3 executor}, ${4 creates}
  local path="$1" tx="${2:-$FIX_TX}" executor="${3:-$FIX_EXECUTOR}" creates="${4:-$FIX_CREATES}"
  jq -n --arg tx "$tx" --arg ca "$executor" --argjson n "$creates" \
    '{transactions: ([range(0; $n)] | map({hash: $tx, transactionType: "CREATE",
       contractName: "MPGRSwapExecutorV2", contractAddress: $ca})),
      receipts: [], chain: 8453}' >"$path"
}

write_receipt() { # $1 path, ${2 contractAddress}, ${3 txHash}
  local path="$1" ca="${2:-$FIX_EXECUTOR}" tx="${3:-$FIX_TX}"
  jq -n --arg ca "$ca" --arg tx "$tx" \
    '{status: "0x1", blockNumber: "0x32b0c85",
      blockHash: "0x9c7d6168d4767dce7f1a890a94a5be1877b82a7071072c3229ae1c5ade5b01ea",
      transactionHash: $tx,
      from: "0xfDCb6e78217cAf882189e48331a4B42A06309ACA",
      to: null, contractAddress: $ca, gasUsed: "0x47b5b9", cumulativeGasUsed: "0x47b5b9"}' >"$path"
}

write_txobj() { # $1 path, ${2 tx}, ${3 nonceHex}, ${4 to}
  local path="$1" tx="${2:-$FIX_TX}" nonce="${3:-0x2}" to="${4:-null}"
  if [ "$to" = "null" ]; then to=null; else to="\"$to\""; fi
  printf '{"hash":"%s","from":"0xfDCb6e78217cAf882189e48331a4B42A06309ACA","to":%s,"nonce":"%s","chainId":"0x2105","type":"0x2","input":"0x608060405234801561001057600080fd5b50"}\n' \
    "$tx" "$to" "$nonce" >"$path"
}

write_proof() { # $1 path, ${2 codeHash}
  local path="$1"
  printf '{"accountProof":[],"balance":"0x0","codeHash":"%s","nonce":"0x1","storageHash":"0x00","storageProof":[]}\n' \
    "${2:-$FIX_CODE_HASH}" >"$path"
}

# Pin rows: lowercase `executor|signature[|arg]` <tab> value.
fix_lc_executor() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
fix_lc_router() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

write_pins() { # $1 path, ${2 feeBps}
  local path="$1" fee="${2:-25}" e r_kind
  e="$(fix_lc_executor "$FIX_EXECUTOR")"
  {
    printf '%s\t%s\n' "$e|feebps()(uint16)" "$fee"
    printf '%s\t%s\n' "$e|max_fee_bps()(uint16)" "100"
    printf '%s\t%s\n' "$e|fee_timelock_seconds()(uint48)" "172800"
    printf '%s\t%s\n' "$e|pendingeffectiveat()(uint48)" "0"
    printf '%s\t%s\n' "$e|feerecipient()(address)" "$FIX_TREASURY"
    printf '%s\t%s\n' "$e|owner()(address)" "$FIX_SAFE"
    printf '%s\t%s\n' "$e|weth()(address)" "$FIX_WETH"
    printf '%s\t%s\n' "$e|permit2()(address)" "$FIX_PERMIT2"
    while IFS='|' read -r r k; do
      printf '%s\t%s\n' "$e|routerkind(address)(uint8)|$(fix_lc_router "$r")" "$k"
    done <<'ROWS'
0x2626664c2603336E57B271c5C0b26F421741e481|2
0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F|1
0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24|3
0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43|4
0x498581fF718922c3f8e6A244956aF099B2652b2b|7
ROWS
  } >"$path"
}

# Full, self-consistent fixture set for BOTH stub RPC roles.
seed_fixtures() { # $1 dir
  local d="$1"
  mkdir -p "$d"
  write_staging "$d/staging.json"
  write_run_json "$d/run-latest.json"
  write_receipt "$d/receipt-primary.json"
  cp "$d/receipt-primary.json" "$d/receipt-alt.json"
  write_txobj "$d/txobj-primary.json"
  cp "$d/txobj-primary.json" "$d/txobj-alt.json"
  write_proof "$d/proof-primary.json"
  cp "$d/proof-primary.json" "$d/proof-alt.json"
  write_pins "$d/pins-primary.tsv"
  cp "$d/pins-primary.tsv" "$d/pins-alt.tsv"
  printf '%s\n' "$FIX_COMPUTED" >"$d/computed-address"
  printf '8453\n' >"$d/chainid-primary"
  printf '8453\n' >"$d/chainid-alt"
  printf '24576\n' >"$d/codesize-primary"
  printf '24576\n' >"$d/codesize-alt"
}

# Minimal repo scaffold: git root + the V2 scripts + gate + unsealed recovery inputs.
scaffold_repo() { # $1 repo dir
  local root="$1"
  mkdir -p "$root/scripts/swap-deploy-v2" "$root/scripts/swap-deploy" \
    "$root/deployments/base-mainnet" \
    "$root/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453"
  git -C "$root" init -q
  cp "$FIX_ROOT/scripts/swap-deploy-v2/finalize-manifest.sh" "$root/scripts/swap-deploy-v2/"
  cp "$FIX_ROOT/scripts/swap-deploy-v2/recover-finalize.sh" "$root/scripts/swap-deploy-v2/"
  cat >"$root/deployments/base-mainnet/deploy-v2-config.json" <<'JSON'
{
  "chainId": 8453,
  "swapExecutorV2DeployEnabled": true,
  "consumed": false,
  "deployerNonce": 2,
  "status": "test fixture"
}
JSON
}

# Copy the unsealed staging + broadcast artifact produced by the fake run.
install_recovery_inputs() { # $1 repo dir, $2 fixture dir
  cp "$2/staging.json" "$1/deployments/base-mainnet/mpgr-swap-executor-v2.staging.json"
  cp "$2/run-latest.json" "$1/broadcast/DeployMPGRSwapExecutorV2BaseMainnet.s.sol/8453/run-latest.json"
}

# --- mock binaries -------------------------------------------------------------
install_mocks() { # $1 bin dir
  local bin="$1"
  mkdir -p "$bin"
  cp "$FIX_MOCKS_DIR/cast-stub.sh" "$bin/cast"
  cp "$FIX_MOCKS_DIR/gh-stub.sh" "$bin/gh"
  chmod +x "$bin/cast" "$bin/gh"
}

# --- assertion harness (same shape as preflight-venues.test.sh) ----------------
FIX_PASS=0
FIX_FAIL=0
check() { # $1 description, $2 condition exit status
  if [ "$2" -eq 0 ]; then
    FIX_PASS=$((FIX_PASS + 1)); echo "ok   - $1"
  else
    FIX_FAIL=$((FIX_FAIL + 1)); echo "FAIL - $1"
    if [ -n "${OUT:-}" ]; then printf '%s\n' "$OUT" | sed 's/^/       | /'; fi
  fi
}
