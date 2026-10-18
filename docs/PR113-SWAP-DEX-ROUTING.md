# PR #113 — DEX routing audit and bounded code-only upgrade

Date: 2026-10-18. Incremental baseline: `e73b54fd41016e3cb090408d0e405f17ca707605`.

**Delivery boundary:** an assisted single-hop routing improvement, **not completion of universal DEX routing or an immutable-fee architecture**. PR #113 stays open/unmerged. No signing, public-chain transaction, on-chain deployment, permission/owner/recipient change, production setting or Agent/runtime change is authorized or performed here.

## 1. Audit before implementation

Read: Swap form/selector/details, quote request/API, capability registry, routing/admission, quote builder, wallet/pre-sign/approval/recovery controller, receipt verification, Executor configuration, Solidity implementation/router interfaces, deployed ABI/record and relevant unit/browser/fork tests. The starting checkout was clean and GitHub PR head matched. Previous-head CI was green (write/deployment jobs skipped); that is not evidence for the new code.

Executor: `0xD982726e28275661F8aB64054E6b17a70a63505A`, Base 8453. Source: `contracts/executor/MPGRExecutor.sol`. Recorded deployment: `deployments/base-mainnet/mpgr-executor.json`. Browser ABI and `deployments/base-mainnet/MPGRExecutor.abi.json` contain the same **74 entries**, order-independent. This compares repository artifacts; the deployed ABI/source was **not freshly retrieved or runtime-hash-verified in this sandbox**. Historical verification links are in the deployment record, including https://basescan.org/address/0xD982726e28275661F8aB64054E6b17a70a63505A#code . Do not replace an actual ABI check with a README capability claim.

### Contract capabilities and exact limits

| Path | Actual assisted capability | Classification |
|---|---|---|
| Aerodrome Slipstream concentrated-liquidity | `swapSlipstreamExactInputSingle(p,int24,auth)` → typed `exactInputSingle`; positive tick spacing | 2, subject to current permissions/pool/transfer proof |
| Uniswap V3 SwapRouter02 | `swapUniswapV3ExactInputSingle(p,uint24,auth)`; tiers 100/500/3000/10000 | 2, subject to the same proof |
| Native ETH input/output | WETH alias only for pool identity; gross `msg.value` for native input; net wrapping, native fee, output unwrap | 2, not ERC-20 sentinel calls |
| Multi-hop / mixed venue | No path/step array, `exactInput`, `multicall` or arbitrary `execute` entrypoint | 4 |
| Uniswap V4 / Universal Router / Aerodrome classic stable/volatile | Incompatible entrypoints/architectures; V4 PoolId is not a V3 pool address | 4 |
| Delegated typed modules (kind 3) | Not in this assisted contract's enum or ABI | 4; never borrow Agent/delegated signing |
| Strong atomic commitment to exactly 25bps AND this recipient | Existing `expectedFeeAmount` is insufficient | 4 for a complete guarantee |

Canonical venue identities remain from the shared **unchanged** typed configuration:

- Slipstream router `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F`, kind 1; factory `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`; quoter `0x514c8B5f54112481E28028F1166Bd78501089259`.
- Uniswap V3 router `0x2626664c2603336E57B271c5C0b26F421741e481`, kind 2; factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`; quoter `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`.

### Why valid-looking routes fail

| Failure class | Prior limitation / present treatment |
|---|---|
| Application pair gate | Previously only 14 hardcoded pairs could quote; even two registered/allowed tokens with another direct pool were blocked. Swap-only candidate search now removes that pair gate. |
| One pool key / no comparison | Previously one venue/key per pair; duplicates rejected rather than compared. Now compare a bounded compatible search space and retain deterministic ties. |
| Permission | `_validate` requires both exact token addresses and `routerKind(router)` to match. No on-chain pair allowlist exists. Imports, balances and pool listings grant no authority. Fresh unknown ≠ denied. |
| Pool identity | Canonical factory must return a nonzero pool; pool factory/tokens/key and required contract code must match at the pinned block. Nonempty code alone is not liquidity proof. |
| Liquidity / amount | A positive net-input quoter output is required, then exact slippage/minimum checks. Zero output rejects that amount; a revert/RPC error is not automatically classified as no liquidity. |
| ABI | Multi-hop/V4/classic/typed-module routes cannot be encoded safely by the assisted ABI, even if endpoints/intermediates are allowed. Never chain user swaps to pretend atomic multi-hop. |
| Provider | Wrong chain, timeout, unreadable state, stale block or reorg fails closed. Some unknown candidates can leave a clearly labeled partial comparison; global fee/owner/metadata/snapshot drift aborts all venues. |
| Wallet / settlement | Quoter output alone is not balance, allowance, successful approval, gas estimation, Executor simulation, mining or fee delivery. Existing real preflight, confirmation, separate hashes, receipt/input/event checks and unknown-submission recovery remain mandatory. |

## 2. Implemented code-only behavior

### Search bounds and route selection

- Exact token identities remain the already approved **15 ERC-20 registry entries**. The 35 other catalog/import identities remain disabled; lifecycle-hidden COINc/CRCLc/INTCc are not added to catalog discovery. No symbol-based trust or arbitrary routing address is accepted.
- Any distinct approved pair can request a direct-pool search, BUY or SELL. There are **105 unordered potential ERC-20 pairs**, not 105 proven pools. Native ETH shares WETH pool identity without sharing ERC-20 balance/allowance/value semantics.
- At most **five candidates per request**: four V3 tiers plus Slipstream's existing reviewed spacing **10**. Other Slipstream spacings are potentially code-compatible with the ABI but **not enumerated/enabled here**. No universal venue/pool coverage is claimed. New canonical pools for these keys can be found without a new hardcoded pair entry.
- Server owns all router/quoter/factory/key choices. Each candidate gets canonical pool/permission/decimals/owner/pause/25bps/recipient admission at the same fresh block/hash. Request-local read memoization reduces duplicated state reads; it never crosses requests and never memoizes block identity. Initial hash is bound **before** any shared reads, including when the first pool is rejected.
- Use the existing proposal builder with a **request-local deployment view containing just the qualified candidate**, and a pinned reader. The default/shared registry, Agent route priority/fallback and shared builder are unchanged.
- Quote the **same gross-minus-fee input** for every candidate. Validate each candidate's fee/calldata/minimum/recipient/value independently before comparison. Choose maximum atomic buy output; exact ties preserve original registered venue priority, then deterministic tier order. A failed candidate can fall back only to another qualified assisted-Executor candidate.
- A 12-second **scheduling** budget stops starting further candidates; this is not an abort of an in-flight RPC or a hard request wall-time guarantee. Existing bounded RPC transports still apply. A 30-second snapshot/proposal bound and before/after block-hash checks reject expired/reorganized results. No expiry is extended. Numeric-block pinning with hash checks is not an EIP-1898 atomic snapshot or a post-signing stability guarantee.
- Cache keys include candidate, wallet, exact identities/decimals/amount/slippage and block number/hash; permissions/posture/pool identity are rechecked even on cache hits. Search result metadata is attached to a fresh proposal copy, not the cached builder object.

### Accurate comparison / cost / reliability disclosures

This is **highest quoted output among successfully evaluated bounded direct candidates**, not a universal, gas-adjusted or MEV-protected “best route.” Quoter gas units are exposed only as **quoter-only**, excluding approval, Executor overhead and Base L1/operator costs. Missing costs are unknown, not zero. Output is not normalized against gas through invented prices. When the pinned taker balance and real allowance permit it, each candidate also gets an exact Executor `eth_call` using the session taker, selected calldata, gross native value and the same block—no overrides. A revert, unknown simulation or output inconsistent with the quote excludes that candidate; alternatives continue. An unfunded/unapproved or unreadable wallet state leaves simulation explicitly unrun and retains wallet preflight requirements. A successful call is neither a receipt nor fee-delivery proof. The existing trusted-price reference impact calculation runs on the selected quote; maximizing output for the same pair/input also maximizes execution price against a common reference. Missing reference prices remain null. Full gas-adjusted optimization remains unimplemented.

`swapRouting` is a Swap-only response extension: selected canonical route/pool, pinned block identity, calldata hash, all five candidate outcomes, partial/completed comparison and optional quoter gas. Independent browser policy binds this route to the exact encoded transaction and keeps the old static-route checks for legacy proposals without search evidence. **This hash is not a signed certificate of liquidity, immutable fees or execution.** A quote explicitly records either unrun simulation or an Executor call that succeeded at its pinned block; wallet preflight is still required in either case. An approval may be needed before real Executor gas estimation/simulation can succeed; no state overrides or approvals are fabricated to make that look ready.

UI draft selection distinguishes existing registered-but-unquoted routes from approved-token pairs requiring live direct search. It never silently changes pay/receive. Metadata-only imports remain visibly blocked. Costs/details show selected pool, comparison limits, partial evidence, gas scope and the owner-mutable fee caveat. There is still one contextual fee row and substantive confirmation/risk disclosure.

No new endpoint, request flag, application environment setting, provider/vendor or dependency. No changes to shared Agent APIs, wallet creation, autonomy, `lib/trade`, `lib/executor`, contracts, deployed ABI, deployments or production flags. One **test-only** scope addition was announced before editing: `tests/mobile/flow-fixtures.ts` now uses the configured fee-recipient identity rather than a synthetic recipient, so the independent fixed-recipient check is not weakened to satisfy mocks.

## 3. Mandatory-fee audit — what is and is not guaranteed

Configured recipient remains **`0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`**, rate **25bps**. App policy independently requires that identity, not merely agreement between an arbitrary displayed recipient and a matching mocked event.

`_begin`: validate taker/recipient, tokens/router, deadline/minimum; calculate `floor(grossSellAtomic × feeBps / 10000)`; require equality with `expectedFeeAmount`; reject nonzero-bps fees rounding to zero; pull exact gross (or accept exact native gross), pay fee and approve only net input. `_finish`: clear router allowance, require full net consumption and measure actual output ≥ minimum, unwrap if requested, emit `SwapExecuted`. Router failure reverts the **whole** transaction including fee collection. Fee is on the gross SELL side in both directions, never on buy output or each intermediate hop. There is no separate fee transaction or fee-less fallback.

**Residual blocker:** `setFeeBps` permits 0–100 and `setFeeRecipient` is owner-controlled. `SwapParams` contains neither expected recipient nor expected exact bps/owner. Gross 400 yields expected fee 1 at both 25 and 26bps, demonstrating a rounding collision. A configuration change after the final check/signature can therefore escape a rounded-amount guard. Admin fee setters are `onlyOwner` but not `nonReentrant`, so callback-time privileged mutation must also be included in a future contract audit. Do not claim the source comment about “every state-touching function” being guarded is literally true.

Quote/cache and wallet preflight checks reduce observed drift; receipt verification detects inconsistent events after mining but **cannot reverse a settled discrepancy**. The verifier's exact Executor event checks are not universal recipient balance-delta proof for arbitrary exotic tokens. `SwapExecuted` also omits the pool key. Immediate confirmation checks the submitted hash and matching event; history recovery additionally fetches and matches transaction input. Thus event-only confirmation does not independently attest the exact pool fee/tick spacing from mined input; stronger immediate input attestation remains a code-level follow-up, not a newly claimed guarantee. Sell-transfer deltas reject mismatching gross receipts; per-token compatibility still needs review and real transfer evidence. No new token is enabled from a DEX listing or bytecode response.

Therefore a universal promise that every successful transaction can never deliver a different recipient/bps is **not achieved by this code-only upgrade**. Keeping existing swaps working and retaining all current guards must not be described as eliminating this on-chain limitation.

## 4. Smallest safe separately approved extension plan

1. **Do not attempt an in-place ABI upgrade.** The verified assisted deployment is a concrete, non-proxy contract. Editing Solidity or ABI cannot add methods to its deployed address.
2. **First evaluate reuse via a typed router adapter**, not a generic arbitrary-call Executor: it would need the exact existing router interface, immutable/committed route definitions, canonical pool checks, every intermediate token/venue permission, exact net consumption, same taker/output semantics and atomic rollback. A mutable route-ID lookup hidden in tick spacing is not an acceptable path commitment. The old call has no arbitrary path bytes/hash, so fully dynamic general routing cannot simply be passed through it.
3. A downstream adapter is entered **after `_begin` transfers the fee**. A later configuration check alone does not prove which recipient actually received funds in a privileged callback scenario. Do not advertise an adapter as a complete fee-recipient fix without proving orchestration and transfer invariants. Any adapter deployment/allowlisting requires separate approval and audit.
4. If the adapter cannot satisfy those commitments, the minimal honest option is a **reviewed extension of the existing verified source**, not an unrelated replacement architecture: add a guarded typed exact-input path entrypoint, expected-recipient/exact-bps (and owner where policy requires) commitments checked **before pulls/transfers**, immutable per-call fee configuration, callback-safe administration, bounded path length and canonical per-hop validation. A non-proxy deployment would require a separately approved new version/migration. No new Executor is implemented or deployed here.
5. Fee once on gross input, route only net, measure final taker output, commit complete route/minimum/deadline/value, zero residual allowances/balances, and preserve native wrapping. Add path-hash/event verification; approvals target only the reviewed execution architecture. Do not reuse V3 path encoding for Slipstream or V4. V4 requires its own PoolManager/unlock/settlement/hook architecture review.
6. Required future tests: both directions for each direct/path venue, all intermediate permissions, one fee only, exact recipient delta, no rounding bypass, owner/setter callbacks, changed path, malicious router/token, dust, native paths, expiry, slippage/final balance delta and complete rollback of fee/approval effects on failure. Fork results with injected state are not live fee-delivery acceptance. No public-chain deployment, grant or transaction until explicitly approved.

## 5. Live evidence and per-asset classification

Fresh pre-edit CLI attempt: [`evidence/pr113-swap-routing/qualification.json`](evidence/pr113-swap-routing/qualification.json), observed **2026-10-18T05:57:37.347Z**, exit **2 / incomplete evidence**. Null block identity; **50 unknown permission rows, 35 unregistered catalog assets with historical discovery annotations, 60 unavailable legacy direction×amount cases**. It uses no key, signing, broadcast or state overrides. The 60 rows audit the original 14 registrations plus native aliases at two sizes each; they are **not coverage of every new candidate pair/tier**. New candidates also have no live proof in this sandbox.

Categories are independent, conditional gates, not marketing labels:

1. **Verified and executable:** none freshly established in this run. Archived successful receipts remain historical settlement evidence, not a new liquidity/permission guarantee.
2. **Compatible after code changes:** supported single-hop ABI/known token identity; runtime admission, quote, funds/allowance and execution/fee proof are still required.
3. **Requires separately approved on-chain authorization:** action only if a fresh read confirms a missing grant. For unregistered assets current permission is unknown, so **3?** means authorization review is pending, not a fabricated assertion of denial. Local registration/metadata/transfer review is also required before enabling.
4. **Requires contract/adapter changes:** multi-hop, V4/classic/unsupported router types and the strong atomic recipient/exact-bps commitment described above.
5. **Unavailable due to external constraints:** RPC evidence is unavailable here. This **does not establish absent liquidity or token invalidity**.

Every token below also inherits category **4 for a universal immutable-fee guarantee**; category 2 does not waive that limitation. No category-3 permission action was prepared or performed.

<!-- Asset and legacy-route tables are generated below from the actual audit inventory and typed registry, not live claims. -->

### Exact token inventory (50 ERC-20 identities)

| Catalog/registry symbol | Exact Base contract | Category / remaining gate |
|---|---|---|
| WETH | `0x4200000000000000000000000000000000000006` | 2 + 5 — current permission/liquidity/execution unverified |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 2 + 5 — current permission/liquidity/execution unverified |
| MPGR | `0xB2000000000000000000008d204203177a78AF01` | 3? + 5 — unregistered; current grant and transfer compatibility unknown; 4 for historically discovered V4 market |
| AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` | 2 + 5 — current permission/liquidity/execution unverified |
| AMZNc | `0xb200000000000000000000d9192b6B456483C2E8` | 2 + 5 — current permission/liquidity/execution unverified |
| GOOGLc | `0xb2000000000000000000002D0BA3164cc74f58B7` | 2 + 5 — current permission/liquidity/execution unverified |
| METAc | `0xb2000000000000000000008bC8786B856E61707C` | 2 + 5 — current permission/liquidity/execution unverified |
| MSFTc | `0xB200000000000000000000Ab99cFa739E253872B` | 2 + 5 — current permission/liquidity/execution unverified |
| MSTRc | `0xb2000000000000000000004884b426556b92883d` | 2 + 5 — current permission/liquidity/execution unverified |
| NVDAc | `0xb20000000000000000000078ee7ce2fE4908108C` | 2 + 5 — current permission/liquidity/execution unverified |
| SNDKc | `0xb200000000000000000000397293Cb8cda9a10c5` | 2 + 5 — current permission/liquidity/execution unverified |
| SPCXc | `0xb2000000000000000000007b9fcbd005511aCBd5` | 2 + 5 — current permission/liquidity/execution unverified |
| TSLAc | `0xb2000000000000000000001e800a7f5189430cD0` | 2 + 5 — current permission/liquidity/execution unverified |
| AMDc | `0xB2000000000000000000000d8ce462E99ee7A47B` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| ASTSc | `0xB200000000000000000000B1a29cF17A1819288a` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| AVGOc | `0xB200000000000000000000Fc737aeA6196aB5a4c` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| BEc | `0xb20000000000000000000016f9dfe862feBA122b` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| CAKEc | `0xb200000000000000000000f215e4c890cfb7176b` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| DJTc | `0xb200000000000000000000428E3a3eebBb20692B` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| DUOLc | `0xb200000000000000000000a613d12deafbbb1db7` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| GMEc | `0xb2000000000000000000007790ed6E48e06eD935` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| HIMSc | `0xB20000000000000000000043a599976181Bcf336` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| HTZc | `0xb2000000000000000000002601C5C94F435da168` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| LLYc | `0xB200000000000000000000f1a0F91e34892E4718` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| MRNAc | `0xB200000000000000000000e215e9B76ecBA02468` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| MRVLc | `0xB200000000000000000000eC3c4c7395Cc609813` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| MUc | `0xb200000000000000000000Fd2f87532B90095211` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| NFLXc | `0xb20000000000000000000058B8c947e44011dFE6` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| NVAXc | `0xb200000000000000000000c597c476fcf9aed3a8` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| ORCLc | `0xb200000000000000000000347AFbA223D7B6b63C` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| PFEc | `0xb20000000000000000000018fe7ec7d6dfeeb528` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| PLTRc | `0xb2000000000000000000007d16372840dF4dAbbe` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| PMc | `0xb2000000000000000000008fc2a8c23cf5937b66` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| PTONc | `0xb2000000000000000000009272a491812842aa84` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| PYPLc | `0xb200000000000000000000450ad3abe5d4846c6e` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| QUBTc | `0xb200000000000000000000CA425ab42e07C35bC3` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| RBLXc | `0xB2000000000000000000005bd7AE89b9E6189Bb5` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| RDDTc | `0xb20000000000000000000066242d4067724cB7A1` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| SOUNc | `0xb2000000000000000000002137743d4a01fe4e88` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| TTWOc | `0xB200000000000000000000f720C26062Bc3067Da` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| WENc | `0xb20000000000000000000044e3cd7a0e1028e57a` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| cbETH | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| cbDOGE | `0xcbD06E5A2B0C65597161de254AA074E489dEb510` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| cbXRP | `0xcb585250f852C6c6bf90434AB21A00f02833a4af` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| cbLTC | `0xcb17C9Db87B595717C857a08468793f5bAb6445F` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| cbADA | `0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c` | 3? + 5 — unregistered; current grant and transfer compatibility unknown |
| COINc | `0xb200000000000000000000c85a31389D71F3ecfb` | 2 + 5 — current permission/liquidity/execution unverified; hidden from catalog |
| CRCLc | `0xB20000000000000000000019f6E7C675b73C2e4D` | 2 + 5 — current permission/liquidity/execution unverified; hidden from catalog |
| INTCc | `0xB2000000000000000000004AFF16039bA04bdFBc` | 2 + 5 — current permission/liquidity/execution unverified; hidden from catalog |

Native ETH is not an additional ERC-20 permission row. It aliases WETH only in pool discovery; ETH↔WETH remains rejected as the same underlying asset.

### Original registered route inventory (14, BOTH directions)

| Pair | Registered venue / key | Category |
|---|---|---|
| USDC ↔ WETH | Uniswap V3 / fee 3000 | 2 + 5; not freshly live-verified |
| USDC ↔ AAPLc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ AMZNc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ COINc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ CRCLc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ GOOGLc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ INTCc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ METAc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ MSFTc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ MSTRc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ NVDAc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ SNDKc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ SPCXc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |
| USDC ↔ TSLAc | Aerodrome Slipstream / tick spacing 10 | 2 + 5; not freshly live-verified |

For every other distinct pair of the 15 registered tokens, each of the five candidate keys is category **2 + 5**, not a verified pool or route. A factory miss/zero quote/permission denial from an actual reachable node would refine its category; no such result is fabricated here. The historical 35 candidate annotations remain discovery-only.

## 6. Failure/abuse analysis and rollback

- Authentication/origin/rate/body/chain/amount guards precede quote execution; a model/import/caller cannot nominate routing destinations or extend deadlines. Uint256/dust input fails before pool reads. Unknown allowance still blocks wallet prompts through the unchanged stricter preflight.
- Only canonical direct candidates from registered identities can reach the builder. Off-list tokens, kind 3/V4, ambiguous key fields, arbitrary router/quoter addresses and fabricated search evidence fail policy checks. Unsupported multi-hop is not split into user transactions.
- Global configuration or snapshot drift aborts the whole search. Rejected candidates do not poison fallback permissions across a reorg. Provider failures remain unknown/partial, not denied/illiquid. Cache copies and per-request memoization prevent route/evidence leakage or stale authority.
- Read pressure grows versus one-route quoting; candidates are capped at five with request-local read reuse and a scheduling budget. **Real RPC latency/cost/rate-limit behavior has not been profiled**, because RPC was unavailable. Active RPC cancellation, gas-adjusted optimization, additional Slipstream spacings and on-chain immutable fee enforcement remain limitations, not hidden successes.
- No automatic permission change, alternative broadcaster, hosted key, new signature scheme, provider-priority change outside Swap, Agent authorization persistence, or production/autonomy flag is introduced.
- Rollback: review/revert this application-only commit on the existing tracked PR branch. No migration, live approval revocation, contract/permission rollback or production setting is necessary. Do not remove fee/minimum/receipt guards to work around missing evidence.

## 7. Verification

Actual final check results and the incremental file list follow. Deterministic mocks, local/fork injected state and archived receipts are kept distinct from current public-chain permission, funded-taker simulation and actual fee-delivery evidence. No new route is category 1 merely because a test or CI job passed.

Final repository checks use **Node 20.20.2**, sequentially to avoid CPU contention:

| Check | Actual result |
|---|---|
| `npm run lint` | Pass — 0 errors, 61 existing warnings |
| `npm run typecheck` | Pass |
| `npx vitest run --maxWorkers=1` | **4,074 passed / 24 skipped**, 301 passing / 5 skipped files (306 total); Agent/autonomy test sources unchanged |
| `npm run build` | Pass with process-local isolated font fixture; TypeScript and 34 static pages completed |
| `npm run typecheck` after generated build types | Pass |
| Full Playwright, all five existing browser files | **190 passed** across all five files (112 Swap/native/desktop + 78 existing Agent/review cases) |
| Pre-edit read-only RPC qualification | **Blocked / exit 2**, null block, 50 unknown permissions, no live route/fee claim |

Focused final routing/API/policy/receipt/UI-renderer audit checks: **394 passed / 15 files**; another 104-test focused pass covered the final simulation disclosure/native API assertions. The earlier full version without optional ready-taker Executor simulation passed 4,070 unit tests and 190 browser cases; those counts are not substituted for the final version.

Build used `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` only on that process, serving real Inter WOFF2 from a temporary server outside the repository. It verifies the optimized application build, **not external Google-font availability**. Normal unmocked font-network build was not repeated. No app font/config/dependency/lockfile changed. Existing optional bigint-native-binding and Vite CommonJS warnings were not suppressed. Local Foundry was unavailable; no new local Solidity/fork run is claimed. GitHub's unchanged contract jobs are reported separately, and fork injected state must not be called live wallet settlement.

Browser harness: isolated Chromium 138 / bundled Linux libraries, real controllers/components and deterministic HTTP/EIP-1193/RPC fixtures; **not a physical wallet, public-chain signature, funded-taker live simulation or live fee delivery**. Includes 360×800, 390×844 and explicit 1280×900 desktop, registered/unregistered search status, alternate canonical tier through approval → swap → receipt, amount/minimum consistency, cancellations/reverts, fee drift, insufficient/unknown allowance, expiry, unknown submission, balances and the unchanged Agent/authorization flows. The final sequential runner exited 0 with lint/type/unit/build/generated-type/browser statuses all 0.

### Exact incremental files (18)

```text
lib/swap/swap-route-candidates.ts
lib/swap/__tests__/swap-route-candidates.test.ts
lib/swap/swap-route-search.ts
lib/swap/__tests__/swap-route-search.test.ts
lib/swap/swap-route-selection.ts
lib/swap/__tests__/swap-route-selection.test.ts
lib/swap/swap-capability.ts
lib/swap/__tests__/swap-capability.test.ts
lib/swap/swap-policy.ts
lib/swap/__tests__/swap-policy.test.ts
app/api/swap/quote/route.ts
app/api/swap/quote/route.test.ts
components/features/swap/SwapDetails.tsx
components/features/swap/SwapDetails.test.ts
tests/mobile/swap.spec.ts
tests/mobile/flow-fixtures.ts
docs/PR113-SWAP-DEX-ROUTING.md
docs/evidence/pr113-swap-routing/qualification.json
```

Incremental unrelated-diff review is against the starting head, not a claim that the entire historical PR is Swap-only. `git diff --check` passed. No forbidden implementation/configuration paths changed. Keep PR #113 **OPEN / UNMERGED**; commit/push is not production activation or owner permission approval.
