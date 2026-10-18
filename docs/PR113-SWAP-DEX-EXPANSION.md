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
