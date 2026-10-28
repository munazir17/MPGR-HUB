# MPGR Swap V2 — deployed, sealed, and routing activated in source

## Current state (verified 2026-10-28 against `main` `d8a004f`)

These are separate facts. A later section of this file records the seal-time
note that routing was not yet activated. That note is historical. It is not the
current source or production status.

| Layer | Status | Evidence |
| --- | --- | --- |
| Contract deployed on Base | Yes | Executor `0x4be1154440b26145d76608D41d403a33e76b9d0A`, chain 8453, deploy tx `0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b`, block 52820895. Read-only `eth_getCode` is 21963 bytes, code hash `0x53896cc37145121436fb4372c6814deb98345261b8ea6e0a6343234dd55e3e39`. |
| Source gate | On | `lib/swap/v2/discovery.ts` exports `V2_DEPLOYMENT = SWAP_V2_SEALED_MANIFEST`. Rollback is reverting that one expression to `null`. |
| Quote API path | Enabled by the gate | `POST /api/swap/v2/quote` builds an executable transaction only after posture, simulation and inspection. Unauthenticated calls are rejected (`AUTH_REQUIRED` / origin guard). A dormant injection still returns `preview: true, executable: false`. |
| Production runtime | Source gate observed on | `GET https://mpgrhub.xyz/api/swap/v2/status` returned `activated: true` with this executor, fee 25 bps, and treasury `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`. That is not a wallet-confirmed swap. |
| On-chain posture | Matches the manifest | Read-only `mainnet.base.org`: `feeBps` 25, `MAX_FEE_BPS` 100, `FEE_TIMELOCK_SECONDS` 172800, `pendingEffectiveAt` 0, `paused` false, owner and `GOVERNANCE_SAFE` `0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B`, fee recipient pinned. Venue kinds: Uniswap V3 = 2, Slipstream = 1, Uniswap V2 = 3, Aerodrome Classic = 4, Uniswap V4 = 7. Pancake and 0x stay disabled. |
| Wallet-confirmed live swap | Not claimed here | No transaction was signed or broadcast for this audit. |

MPGR Agent (`mpgr_get_quote` / `mpgr_prepare_trade`) does **not** automatically use this executor for every pair. Allowlisted legacy routes (USDC↔WETH and USDC↔B20 stocks) stay on the legacy executor `0xD982726e28275661F8aB64054E6b17a70a63505A`. Other Base mainnet pairs, including MPGR, go through `prepareV2Execution` when `MPGR_MCP_ENABLE_BASE_MAINNET=true` and this gate is on. A V2 simulation or RPC failure is returned as an error. Only a completed discovery with no pool may fall through to the existing 0x native-fee path. Sepolia is unchanged. The server never signs.

## Historical seal record

## Production state at seal time

- **Deployed exactly once.** Trusted pinned run
  [39294717599](https://github.com/munazir17/MPGR-HUB/actions/runs/39294717599)
  (pin `da73b567cdb052ff2bc05456f0a73d9e37ca8299`) broadcast exactly one `CREATE`:
  tx `0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b`,
  deployer `0xfDCb6e78217cAf882189e48331a4B42A06309ACA` nonce **2**, executor
  `0x4be1154440b26145d76608D41d403a33e76b9d0A`, block **52820895**. The run's seal
  step failed on public-RPC replica lag ("contract … does not have any code"); the
  manifest was sealed **read-only** from that same run's artifact by run
  [39303633727](https://github.com/munazir17/MPGR-HUB/actions/runs/39303633727)
  with **no new transaction** (see [SWAP-V2-FINALIZE-RECOVERY.md](SWAP-V2-FINALIZE-RECOVERY.md)).
  The sealed record is `deployments/base-mainnet/mpgr-swap-executor-v2.json` and the
  one-shot gate `deployments/base-mainnet/deploy-v2-config.json` is **consumed**
  (`swapExecutorV2DeployEnabled: false`, `consumed: true`) — never re-deploy.
- **On-chain facts verified at the seal (both RPCs agreed):** chain id **8453**;
  runtime code **21963 bytes**, code hash
  `0x53896cc37145121436fb4372c6814deb98345261b8ea6e0a6343234dd55e3e39`; receipt status
  `0x1`, gas used `0x4f0591`; CREATE address derived from `(deployer, nonce 2)` equals
  the executor; owner = governance SafeL2 1.5.0 `0xd9aE570767C5a15780DD5cdAdd0b1b732D98994B`
  (threshold **2**, 2 owners); fee recipient `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`;
  `feeBps` **25**; `MAX_FEE_BPS` **100**; `FEE_TIMELOCK_SECONDS` **172800 (48 h)**;
  `pendingEffectiveAt` **0**; all five router registrations (Uniswap V3 = 2, Slipstream = 1,
  Uniswap V2 = 3, Aerodrome Classic = 4, Uniswap V4 = 7). Primary endpoint
  `mainnet.base.org`, independent cross-check `base.drpc.org` (candidate list in the
  recovery workflow).
- **Routing was not activated at seal time.** The source gate was later set to
  `V2_DEPLOYMENT = SWAP_V2_SEALED_MANIFEST`. See the current-state table above.
  The consumed deploy config JSON still contains the seal-time sentence that
  routing was not activated; that file is a one-shot deployment record and was
  not rewritten.
- **V1 is untouched and still active:** executor `0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E`,
  its sealed manifest, consumed gate, deployment scripts and the active
  `SWAP_PATH_EXECUTOR_DEPLOYMENT` constant are byte-identical to before this change
  (asserted with `git diff --exit-code` in the recovery workflow).
- Historical note: the deployment was authorized by the reviewed V2 gate (merged to
  `main`, owner-pinned via `SWAP_V2_DEPLOY_REF`) plus a human `base-mainnet`
  environment approval. That one-shot authorization is now consumed.

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

**While the source gate is null, the API returns `preview: true`, `executable: false`, `transaction: null`.**
The gate is currently the sealed manifest, so an authenticated quote can be executable after simulation. A venue quote alone is still not a settlement proof. No user is routed to the legacy executor by this endpoint. The existing `/api/swap/quote` path is unchanged.

## Validation

- Solidity 0.8.24 compile: passed.
- Local V2 Foundry tests: 20 passed (mock/unit evidence only).
- `npm run typecheck`: passed.
- `npx vitest run lib/swap app/api/swap/v2`: **501 passed / 29 files**.
- ESLint on the new TS/API/runner scripts: passed.
- Workflow YAML parsing: passed.

## Finalization recovery evidence (2026-10-19)

- Recovery run [39303633727](https://github.com/munazir17/MPGR-HUB/actions/runs/39303633727):
  event gate, broadcast-free assertion, no-double-seal guard, recovery + seal, V1
  untouched audit, Safe re-verification, report and artifact upload — **all green**.
- Seal output: `executor=0x4be1154440b26145d76608D41d403a33e76b9d0A`
  `tx=0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b`
  `block=52820895` `gasUsed=0x4f0591`
  `codeHash=0x53896cc37145121436fb4372c6814deb98345261b8ea6e0a6343234dd55e3e39`
  `crossChecked=true`. Routing was not activated by that recovery; the source
  gate was flipped in a later commit. See the current-state table.
- A first recovery attempt (run 39302687541) failed **closed** because
  `base-rpc.publicnode.com` returned `-32603 no state found for block 52822572` for the
  receipt; the cross-check refused a one-sided verification and nothing was sealed.
  That is the intended behaviour, and the reason the recovery now walks an ordered
  list of independent endpoints.
- Offline regression suites (no RPC, key or tx): `finalize-manifest.test.sh` **57/57**,
  `recover-finalize.test.sh` **35/35**, `swap-v2-finalize-recovery.test.ts` **20/20**.

The recovery did not enable routing. The source gate was enabled later, as a
separate change, and is recorded in the current-state table. Reverting
`V2_DEPLOYMENT` to `null` disables it again. Nothing in the deployment record
should be re-broadcast.
