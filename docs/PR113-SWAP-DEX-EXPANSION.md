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

## Stage 3: isolated typed Uni V2 source expansion — NOT deployed or app-wired

Files: `contracts/executor/drafts/IMPGRSwapV2RouterDraft.sol`, `MPGRSwapPathExecutorDraft.sol`, new `test/executor/MPGRSwapV2Draft.t.sol`, this report. No original Executor, deployment scripts, application ABI/configuration, Agent contract or production router registration changes.

- Added standard typed V2 Router02 `swapExactTokensForTokens` with an internally constructed exactly-two-address path. No arbitrary payload, supporting-fee-on-transfer bypass, V3 shim, Universal Router or chained user transactions. Official interface inspected at [`Uniswap/v2-periphery` `ed24991304291297c3b4a52818d02f46a17aa9a2`](https://github.com/Uniswap/v2-periphery/blob/ed24991304291297c3b4a52818d02f46a17aa9a2/contracts/interfaces/IUniswapV2Router01.sol).
- Added a review-only direct V2 method and V2 as either leg of the existing exact-two-hop lifecycle. V2 hops must have zero V3 fee/tick keys. **Draft-local enum value 3 is V2; deployed/shared Agent enum value 3 is NOT V2 and is unchanged.** No app encoder consumes this draft enum.
- All new paths use the same immutable 25bps/recipient lifecycle, exact gross pull, measured fee delivery, single-use net allowances, exact input/bridge consumption and measured final output minimum. Both legs, fee and native wrap/unwrap roll back on failure. Added full-precision `Math.mulDiv` fee arithmetic so the preview correctly handles the full uint256 domain rather than overflowing before division.
- **16 new deterministic source tests**: 256-run BUY/SELL fee fuzz, full-uint256 fee math, requested 0.0001 ETH input, native output, V2↔Slip and V2↔V3 mixed order, exactly-once fee, second-hop rollback, lying output, unconsumed input, wrong router kind, invalid V3/Slip keys, missing bridge permission, fee omission/dust, privileged callback/reentrancy, deadline/value mismatch, unassigned kind rejection. Original 18 draft tests retained unchanged. Their historical kind-3-on-Slip test still rejects the wrong router kind; the new explicit unassigned-kind-4 test separately checks ABI rejection. No V4 or Classic execution method is implied.
- Full local Forge: **225 passed / 38 skipped**, 263 total across 17 suites; **34 draft cases** including both 256-run fuzz cases. Local public-RPC fork cases are skipped, not counted as live proof. Production Executor ABI synchronization passed unchanged. Slither 0.11.6 fail-high passed; unchanged reentrancy-balance checker passed with only the existing Delegated exception. No new suppression or CI allowlist changes.
- Actual executable application additions: **none**. Source-only capabilities now include V2 direct and mixed V2/V3/Slip two-hop. Discovery-only remains the Stage 2 scope.
- Remaining blockers: independent review/audit, approved deployment and integration, canonical typed router/pool qualification, current per-token/router grants, transfer compatibility, amount-specific bidirectional quotes/minimum/simulation, reliable gas where possible and actual settlement evidence. Existing mutable-fee deployment cannot be upgraded by calling this source. Aerodrome Classic discovery is implemented, but its stable/volatile route ABI still needs a separately reviewed execution extension. V4 needs complete authenticated unlock/callback/currency/hook settlement, not generic calldata.
- Commit: the commit containing this stage section, reported separately after push. No deploy/broadcast/grant/live trade or production flag changes.

## Stage 4: inspection UX and browser fixture follow-up

The first full browser run had **220 passed / 2 failed**: the published-list test still intercepted the shared old token URL after Swap moved to its own endpoint. Updated only that interception URL and its explicit read-only response marker; original exact-address, disabled-selection, no-quote and no-send assertions are unchanged. Exposed read-only inspection for known pairs too (not just unsupported imports), hide it for ETH/WETH same-underlying pairs, and show explicit direct/two-hop asset paths and pool options. The new ETH→AAPLc inspection case uses a clearly mocked WETH→USDC→AAPLc graph and proves selected pay/receive assets stay unchanged with no quote/signing requests. No new execution is enabled.

Files: `TokenSelector`, `SwapLiquidityInspection`, `tests/mobile/swap.spec.ts` fixture interception, `tests/mobile/swap-liquidity.spec.ts`, this report. Four focused repair/known-pair browser cases passed across both mobile sizes. The new known-pair test first used an ambiguous text locator matching two paragraphs; it now asserts the complete exact two-hop paragraph. No application workaround or safety assertion removal. Final full checks are rerun below. Discovery scope and atomic-fee/deployment blockers are unchanged. Commit containing this section is reported after push.

## Final regression and isolation review

### Stage commits

| Stage | Pushed commit |
| --- | --- |
| Fresh audit / capability matrix | `a7567a8528b4d7123b68c664f0894e95332d69e5` |
| Arbitrary-CA metadata and read-only liquidity inspection | `547c7c86597be92eda189dd49b6321458a65c8f1` |
| Isolated fixed-fee V2 draft/source tests | `1aac40fc8507ba537d14177d1db93b07825a841a` |
| Final QA documentation | Commit containing this section; exact SHA in delivery / PR comment |

### Executed checks (source head 1aac40f; final UI-refinement rerun recorded below)

- Full isolated unit regression: **4,224 passed / 24 skipped**, 310 passing / 5 skipped files, 227.66 seconds. No weakened timeout or test expectation in existing suites. Includes the 94 new metadata/liquidity/API/client cases and unchanged Agent/goal authorization regressions.
- Optimized Next production build: **passed**, 34 static pages and the two new dynamic Swap endpoints. Generated-route TypeScript check: **passed**. Local build used the existing external, process-only Google-font fixture because font hosts are outside sandbox egress; real local WOFF2, no repository config/dependency changes, fixture server stopped afterwards. Exact source-head Vercel build also passed without this local fixture.
- Repository lint: **0 errors / 62 warnings**, with warning locations in unchanged files. Separate changed-file lint: **0 warnings / 0 errors**. `git diff --check` passed.
- Contracts: **225 passed / 38 skipped**, 263 cases / 17 suites, with **34 draft cases** and two 256-run fuzz cases. Original deployed ABI check passed. Slither fail-high and the unchanged narrow balance-exception checker passed; no detector/config/allowlist weakening. Draft optimized runtime size **14,109 bytes** (below EIP-170), not deployment approval.
- Full browser regression: result recorded below after completion. Actual controllers with deterministic HTTP/RPC/EIP-1193 fixtures; 360×800 / 390×844 plus explicit desktop. Never physical-wallet or live settlement evidence.
- Isolation diff versus `526fb15`: **22 files**, limited to Swap APIs/modules/UI, isolated draft/source tests, this report and browser tests/fixture branch. No differences in shared `lib/trade`, `lib/executor`, `lib/autonomy`, architecture, Agent hooks/APIs/components, original assisted/delegated contracts, Campaigns, production settings, dependencies/lockfile, deployment scripts or workflows. Browser bundle inspection found none of the new server discovery/metadata error identifiers in client chunks. Existing allowance and terminal overview implementation unchanged.

### CI and live boundary

At exact application/source head `1aac40fc8507ba537d14177d1db93b07825a841a`, GitHub [CI run 39114615047](https://github.com/munazir17/MPGR-HUB/actions/runs/39114615047) quality/build/contracts/contracts-fork/secret-scan/slither/real-redis passed; read-only [reference run 39114615076](https://github.com/munazir17/MPGR-HUB/actions/runs/39114615076) passed; Vercel/preview comments passed. Deployment and MCP E2E were skipped. Final documentation-head checks are reported separately after push. No merge/close operation performed.

**No new live executable route was enabled.** New pool/path results are discovery-only and cannot authorize signing. Review-source V2/V3/Slip direct/two-hop capabilities are not methods on the deployed Executor. Classic remains discovery-only, V4/Universal Router unsupported. Shared/legacy execution behavior was preserved, not retroactively certified as having immutable fee terms; the deployed mutable recipient race remains explicit and unresolved there. Do not describe legacy conditional availability as a new atomic immutable fee guarantee.

No fresh amount-specific public-RPC quotes, authenticated wallet simulations or settlements are asserted for **USDC↔WETH, MPGR↔USDC, ETH↔AAPLc, stocks, AERO, VIRTUAL, cbZEC or a BNB representation**. This sandbox's outbound allowlist excludes Base RPC providers; no live wallet was used. That is an environment/evidence limit, not proof of production provider outage or absent liquidity. Exact CA import, canonical graph search, source execution and actual live settlement remain distinct. Imported/listed symbols do not establish asset backing or native-chain equivalence.

Activation still requires independent source/security review, explicit deployment/integration/grant approval, fresh canonical pool/transfer/permission/amount/minimum/simulation checks, and receipt/actual-output/fee verification. Nothing was deployed, broadcast, traded, granted or enabled in production. PR #113 stays **OPEN / UNMERGED**.
