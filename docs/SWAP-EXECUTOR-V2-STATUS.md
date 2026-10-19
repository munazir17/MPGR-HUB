# MPGR Swap V2 — fork-proven, not deployed

## Production state (unchanged)

- **No deployment or mainnet transaction in this pass.** No V2 address, deployment
  receipt, sealed manifest, or app activation has been fabricated.
- `swapExecutorV2DeployEnabled` remains **false** and its deployer nonce remains
  unset. The V2 deployment workflow has **not** been dispatched.
- The live `0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E` executor, V1 manifest,
  consumed gate, V1 script/preflight, and active app deployment constant are unchanged.
- PR #119 was already an ancestor; permissionless token selection is preserved.

## Read-only GitHub proof

**Green run:** [39261269154](https://github.com/munazir17/MPGR-HUB/actions/runs/39261269154),
reviewed code `09cae630eec12cfa9a780016b18f439b9d94cf46`, Base fork block
**52813757**, **13 passed / 0 failed / 0 skipped**. The full sanitized proof log
is committed in [docs/proofs/swap-v2-base-fork-39261269154.md](proofs/swap-v2-base-fork-39261269154.md)
and posted on PR #120.

The dedicated `.github/workflows/swap-v2-fork-proof.yml` runs only discovery and
`test/swap-fork/MPGRSwapExecutorV2BaseFork.t.sol`. Its only mapped RPC secret is
`BASE_MAINNET_RPC_URL`, falling back to `https://mainnet.base.org`. No deployer
key or production environment is mapped. It is invoked on same-repository PR
updates; `swap-fork-tests-base-mainnet.yml` is also a manual dispatch wrapper.

Proof logs and the discovered v4 fixture are uploaded as artifacts; sanitized
logs are posted directly on PR #120. The result verifier rejects missing tests,
failures and skips. Tests with no local RPC skip explicitly in ordinary unit CI;
**those skips cannot qualify the dedicated fork workflow**. No fork was retried
from the sandbox in this pass.

### Why the Base VM is required

MPGR is a Base-native B20 stateful precompile; `eth_getCode` returns the `0xef`
sentinel, not ERC-20 EVM bytecode. Ethereum/Cancun/Prague execution cannot run it.
The proof pins Foundry **v1.8.5**, `--network base --hardfork base:Beryl`, and
checks actual PoolManager code on Base before use. It never etches MPGR code,
mocks calls, or guesses B20 storage. A real v4 ETH-to-MPGR funding buy precedes
the MPGR sell proof. The fee is still collected on both swaps.

### Real pools exercised

| Venue / pair | Real pool address or v4 pool ID |
|---|---|
| Uniswap v3 USDC/WETH | `0xd0b53D9277642d899DF5C87A3966A349A798F224` |
| Aerodrome Classic AERO/DEGEN, direct, neither side major | `0x629b51E5d5d8f29da84857Eeb899c080816fBfc8` |
| Aerodrome Classic AERO/WETH | `0x7f670f78B17dEC44d5Ef68a48740b6f8849cc2e6` |
| Aerodrome Slipstream AERO/WETH | `0x9Be74093980230702f766bc6F8234177E58237E4` |
| Uniswap v2 USDC/WETH | `0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C` |
| Uniswap v4 MPGR/native ETH | `0xfc151dc0278bc0b2e2ad5404e14f8e3a43e77f176537c29e25f179262ad1cc44` |

V4 PoolManager: `0x498581fF718922c3f8e6A244956aF099B2652b2b`.
On-chain code hash: `0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6`.
MPGR key: native currency0, MPGR currency1, fee **0**, tick spacing **200**,
hooks `0x985C14BAa2a18316ffdA0aeFB3a632fAdfcA2AcC`.
Initialize receipt: `0x4403d04d2136576c65c60581c8bdf34b592bf00d7ea2564f2c78c5e35d2f7abc`,
block **48631199**. Dexscreener provides only a search hint; the indexed on-chain
Initialize event and derived PoolKey hash are independently checked.

The proof covers measured output against an executor-simulated minimum; exactly
one 25 bps fee event and exact recipient balance delta; direct non-major routing;
v4; every enabled AMM adapter; split and multihop accounting; missing direct-pool
reversion with no pull/fee; forged constructor/trade fee terms; the 48h owner-only
fee change; disabled Pancake/Settler paths. Real v3, Slipstream and v4 quoter ABIs
are also exercised. The multihop fork test proves accounting, **not** absence of
a direct route; direct-first/fallback policy is tested separately in TypeScript.

**Pancake and 0x remain disabled.** No working Pancake/0x execution is claimed.

## Unreleased product path

`POST /api/swap/v2/quote` is an authenticated, rate-limited, read-only preview.
It accepts any two validated Base ERC-20 addresses or native ETH on one side,
without importing the legacy token registry or vetoing non-catalog pairs.
ETH/WETH and identical assets are rejected as the same asset.

`lib/swap/v2/` implements:

- Canonical factory/PoolManager event discovery for v2, v3, v4, Classic and
  Slipstream, including arbitrary enabled tiers/spacings/PoolKeys.
- Untrusted search hints verified against factory lookups or a real v4
  Initialize event before use. Hints cannot establish missing liquidity.
- Exact-pair direct quotes first. A direct quote is never replaced by a hop.
- Fallback paths of at most **3 hops**, with intermediates discovered from the
  endpoints' actual liquidity neighbors, not a WETH/USDC bridge list.
- Optional better direct-venue splits, charging **one fee on gross input** and
  allocating the entire net amount. Ties prefer simpler routes.
- `LIQUIDITY_UNAVAILABLE` for completed discovery with no quotable route.
  Network/index/budget failure is `DISCOVERY_UNAVAILABLE`, not an unsupported
  token or a false no-liquidity verdict. Range-limited RPCs are subdivided with
  a work budget; a persistent complete liquidity index can implement the same
  source interface without rescanning history.
- Explicit fee-policy validation before calldata construction, typed V2 ABI,
  and a future activation boundary that verifies owner/fee/cap/recipient and
  simulates the actual executor at the pinned block before exposing execution.

**The API returns `preview: true`, `executable: false`, `transaction: null`.**
`V2_DEPLOYMENT` is null. A venue quote is not called executor simulation or
execution proof. No user is routed to either legacy executor by this endpoint.
The existing active quote endpoint and app deployment config are unchanged.

## Validation

- Solidity 0.8.24 compile: passed.
- Local V2 Foundry tests: 20 passed (mock/unit evidence only).
- `npm run typecheck`: passed.
- `npx vitest run lib/swap app/api/swap/v2`: **501 passed / 29 files**.
- ESLint on the new TS/API/runner scripts: passed.
- Workflow YAML parsing: passed.

A green fork workflow is a prerequisite for review readiness, **not deployment
approval**. Deployment, gas/key preflight, sealed receipt/constructor pins,
source verification and app activation require the user's next instruction.
