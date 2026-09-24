#!/usr/bin/env bash
# Prepares REAL Uniswap V3 + Permit2 bytecode in ./.uniswap-artifacts (gitignored)
# so test/script/DeployMPGRExecutorBaseSepoliaLocal.t.sol can dry-run the Base
# Sepolia deploy script end-to-end on a local EVM. Pinned versions only.
#
#   - @uniswap/v3-core@1.0.1               UniswapV3Factory (canonical build)
#   - @uniswap/v3-periphery@1.4.4          NonfungiblePositionManager, QuoterV2
#   - @uniswap/swap-router-contracts@1.3.1 SwapRouter02
#   - Uniswap/permit2@cc56ad0f             Permit2 (solc 0.8.17, via-ir, as upstream)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.uniswap-artifacts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$OUT"

(
  cd "$WORK"
  npm init -y >/dev/null
  npm install --no-audit --no-fund --ignore-scripts --silent \
    @uniswap/v3-core@1.0.1 \
    @uniswap/v3-periphery@1.4.4 \
    @uniswap/swap-router-contracts@1.3.1
  U="$WORK/node_modules/@uniswap"
  cp "$U/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json" "$OUT/"
  cp "$U/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json" "$OUT/"
  cp "$U/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json" "$OUT/"
  cp "$U/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json" "$OUT/"
)

(
  cd "$WORK"
  git init -q permit2
  cd permit2
  git remote add origin https://github.com/Uniswap/permit2.git
  git fetch -q --depth 1 origin cc56ad0f3439c502c246fc5cfcc3db92bb8b7219
  git checkout -q FETCH_HEAD
  git submodule update -q --init --depth 1 lib/solmate
  rm -rf test script
  forge build src/Permit2.sol >/dev/null
  cp out/Permit2.sol/Permit2.json "$OUT/"
)

ls -1 "$OUT"
