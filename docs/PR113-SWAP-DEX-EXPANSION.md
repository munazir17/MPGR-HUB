# PR #113 — staged DEX expansion

## Stage 1: fresh audit (2026-10-18)

Starting local, remote and PR head verified as `526fb1580dd8aa1bbc3f0d162cbc3dbd72e02c18`, clean worktree, branch `arena/b8c82200-mpgr-hub`, PR OPEN/unmerged. Executed GitHub quality/build/contracts/fork/security/reference and Vercel checks were successful; deployment and MCP E2E were skipped. This is not live wallet verification.

### Capability matrix — before new execution support

| Family | Discovery/import at audit head | Application execution / blocker |
| --- | --- | --- |
| Arbitrary Base ERC-20 | Exact-address read-only import through shared `/api/trade/token`; published-list hints through Swap API. Bytecode/decimals/supply/balance/symbol reads exist. | Unsupported selector entries disabled. Imports do not register tokens. Existing import does not independently assert RPC chain ID/pin all metadata; separate Swap-only validation is appropriate. |
| Uni V3 direct | Four fee tiers (100/500/3000/10000), approved token identities only | Typed SwapRouter02 single-hop only; canonical identity, current permissions, fresh amount quote/minimum and conditional Executor simulation required. No newly verified live route. |
| Slipstream direct | Tick spacing 10, approved token identities only | Typed single-hop only, same qualification boundary. |
| Uni V3 / Slipstream two-hop | Review-only `MPGRSwapPathExecutorDraft` plus 18 deterministic tests | No deployed method, application wiring, deployment approval or live settlement evidence. |
| Uni V2 | Not integrated | Existing deployed ABI cannot call V2; requires typed isolated source, not a router-address substitution. |
| Aerodrome Classic | Not integrated | Stable/volatile pools and router tuple ABI differ from Slipstream; no implied compatibility. |
| Uni V4 / Universal Router | Historical MPGR V4 evidence only, not fresh qualification | Unsupported selectors/callback/settlement architecture; no V4-through-V3 or generic calldata fallback. |

### Security and fee findings

- Deployed assisted Executor `0xD982726e28275661F8aB64054E6b17a70a63505A` is non-proxy and has two typed single-hop methods. Shared deployment enum kind 3 belongs to delegated modules, not a generic assisted router permission.
- Mandatory policy is `floor(gross atomic SELL amount * 25 / 10000)`, recipient `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`, both directions. The deployed `_begin` checks expected fee amount, but owner-set recipient/bps remain mutable. Reads/simulation/events cannot establish immutable atomic terms across privileged callbacks or pending state changes. Do not advertise new routes as atomically fee-enforced on that deployment.
- The isolated draft fixes bps/recipient, measures delivered ERC-20 fee, and rolls fee/hops/output back together. It is not deployed, audited for production, registered, or application-wired. Existing Agent source/ABI/fee behavior must remain unchanged.
- Approval fix verifies the actual mined approval input, spender, gross amount and receipt block, then reads real allowance with bounded RPC catch-up. Unknown reads remain provider errors, not fabricated insufficiency. Settlement checks mined calldata/value/receipt identity; terminal same-modal overview shows verified actual amounts, separate approval/swap links and no stale confirmation controls. Preserve both.
- Import metadata and canonical pool identity do not prove transfer compatibility, permissions, amount-specific output, reliable gas, actual recipient delivery or settlement. RPC failure must not become an illiquidity verdict.

### Dependency / change boundary

Prefer `lib/swap`, Swap API routes and components, and the review-only draft/tests. Shared `lib/trade`, deployed executor configuration/ABI/contracts, Agent hooks/APIs/autonomy and Campaigns remain untouched. Read-only liquidity results must not contain signing transactions or enter candidate authorization. Native ETH maps to WETH only for pool discovery; ETH/WETH itself is not a market pair.

### Stage report

- Files: this audit only. No executable routes added; no implementation changed.
- Actual live executable additions: **none**. Existing routes remain conditional, not freshly certified.
- Discovery-only additions: **none yet**.
- Checks: clean status, local/remote/PR head equality, exact-head GitHub/Vercel checks; source audit. Prior QA is documented in `PR113-SWAP-PREVIEW-FIXES.md`, not rerun or claimed as fresh here.
- Blockers: no approved new deployment/grants; current live RPC/permissions/liquidity and authenticated wallet settlement not established; mutable deployed fee terms; V2/Classic/V4 missing deployed methods.
- Commit: the commit containing this stage report (reported separately after push).

Next stages: Swap-specific arbitrary-address metadata validation and bounded canonical read-only liquidity discovery; isolated typed source additions only where supported by verified interfaces; focused and full regressions, build/security/contracts and final shared-diff review. Report each completed stage separately; never promote a discovered pool into execution automatically.

## Stage 2: arbitrary-CA validation and read-only canonical discovery

New Swap-only `/api/swap/token` verifies Base RPC chain, fresh numeric block/hash, deployed bytecode, ERC-20 supply/balance/decimals and safe metadata at that block, then rechecks the hash/freshness. Unicode symbols and legacy bytes32 metadata are supported; invisible/bidi/control identities, EOA, sentinel-as-ERC20 and known identity conflicts fail closed. No catalog membership prerequisite, automatic registration, symbol-derived trusted logo or transaction is returned. Unsupported interfaces/invalid metadata are distinguished from provider failures. Native ETH remains a separate selector asset.

New `/api/swap/liquidity` independently revalidates metadata and probes canonical factories for arbitrary valid pairs, direct plus two-hop via USDC/WETH. It searches four Uni V3 fee tiers, Slipstream spacing 10, Uni V2 and Aerodrome Classic stable/volatile pools: at most five unique edges / 40 candidates, four workers, fixed source addresses, no unbounded log scan, request-wide 10-second transport deadline, bounded fallback retries. Pool code/factory/token/key and active liquidity or both reserves are checked at the fresh snapshot. Reorg/staleness invalidate the result. Provider/identity failures remain explicitly partial, total read outage is 503, factory-zero is only absence within the stated search. This does not find every Base pool or establish amount-specific tradability.

Selectors now offer a separate **Inspect liquidity (read-only)** action for unsupported entries. Import/inspection are authenticated, origin/size/wallet+IP rate protected, opt-in, abortable and no-store. Refresh/expiry/partial-provider explanations are explicit. A wallet/network change unmounts the keyed Swap session and cancels pending work; changing search discards inspection. Neither pool results nor source addresses are added to execution admission. No quote, minimum, gas estimate or delivered amount is fabricated. These reads make no signing requests (existing account-switch SIWE remains authentication, not trade signing).

### Provenance: official upstream discovery configuration, not a live chain attestation

Fetched with GitHub API on 2026-10-18:

- Uniswap SDK addresses at [`81db6f17e5d9b94ce86f9629a7f3085192670035`](https://github.com/Uniswap/sdks/blob/81db6f17e5d9b94ce86f9629a7f3085192670035/sdks/sdk-core/src/addresses.ts): Base V2 factory `0x8909dc15e40173ff4699343b6eb8132c65e18ec6` (router `0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24`, not app-wired).
- Aerodrome contracts [`1ba30815bba620f7e9faa34769ffd00c214c9b82`](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/README.md): Classic factory `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`, router `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` (not Slipstream). Same pinned source's `contracts/factories/PoolFactory.sol` and `contracts/interfaces/IPool.sol` confirm bool-stable getPool, stable(), factory/token identity and uint256 reserves. No guessed V2 ABI for Classic reserves.
- Existing Uni V3/Slipstream constants reused read-only; deployed registry/permissions untouched. GitHub provenance is not current bytecode/liquidity/permission proof; the new API must perform chain reads each request.

### Stage report / boundaries

- Files: two API route handlers; Swap-only discovery guard/client/snapshot/metadata/text/liquidity modules and tests; `TokenSelector`, new `SwapLiquidityInspection`; browser test and minimal fixture branch for the new token URL. Existing Agent fixture URL/payload semantics unchanged.
- Executable additions: **none**. Discovery objects have literal `executionAuthorized: false` / `executionSupported: false`; fee blocker `IMMUTABLE_FEE_EXECUTOR_REQUIRED`. No execution flags supplied by a browser can change this.
- Discovery additions: arbitrary validated Base CA across the bounded sources/paths above. Pool liquidity is not an amount quote or execution permission.
- Focused unit/API/client checks: **94 passed**. Typecheck passed. Lint: **0 errors / 62 warnings**, all warning locations in unchanged files (prior report recorded 61; do not silently claim that older count).
- Initial focused browser run: 42 passed / 2 new assertion failures because account-switch SIWE was incorrectly expected to be absent. No application change was needed; new assertion now requires exactly the existing SIWE authentication signature for account change and no trade/approval signatures. Final browser checks recorded after completion below.
- Blockers: current deployed fee-recipient mutability; new protocols/multihop have no deployed assisted methods. No live RPC pool/amount/execution/settlement claim. No deployment, permission grants, flags, Agent implementation or shared trade behavior changes.
- Final stage browser evidence: **20 new cases passed** across 360×800 / 390×844 and explicit 1280×900 desktop (16 in the focused rerun, 4 direction/desktop cases). The first desktop attempt used a touch-only test helper in a non-touch context; the helper now uses click for desktop, preserving all assertions. **28 existing approval/import/completion cases passed** in the earlier focused run. All browser evidence uses deterministic HTTP/EIP-1193 fixtures and actual components/controllers, not physical wallets or live settlement.
- Stage 2 commit: the commit containing this report section; exact SHA reported after push. Full regression/build and isolated source work follow separately.
