# Mainnet trading audit — 2026-09-26

## Scope and release decision

Engineering review of `arena/01a0dbe9-mpgr-hub`, based on `aac7444a65ce8413c6254fe1a9ed8e279572610e`, including the bidirectional mainnet regression fixtures and narrowly scoped hardening below. This is not an independent smart-contract audit or blanket production certification of unrelated MPGR systems.

**Source/test audit: passed after fixes, with the documented external-build exception and existing non-blocking findings. Operational publication gates were confirmed by the operator after reviewing the audit.** The audit phase completed before any commit/push/PR. No deployment command, contract change or on-chain transaction was performed. Only automatic GitHub-triggered Preview deployments are authorized; no Production/manual deployment or merge is authorized.

The session is fixed to this branch; it cannot create/switch to `audit/mainnet-trading-production-hardening`.

### Operational gates and verification limits

1. Authenticated Vercel Production configuration is not accessible in this session. Source/transport tests establish the `BASE_RPC_URL` selection rule, but cannot attest to the currently deployed value, provider account limits, or the absence of credentials in deployed `NEXT_PUBLIC_*` values. The operator confirmed that the currently serving Production deployment has the correct nonblank server RPC and no private RPC/API credentials in `NEXT_PUBLIC_*` variables. This is operator attestation, not independent access to Vercel secrets.
2. GitHub deployment metadata contains recent Vercel **Preview** deployments. Pushing/opening a PR may trigger an automatic preview. The operator explicitly authorized automatic previews after the audit, while prohibiting Production/manual deployments and merging. No Vercel settings were changed.
3. The production build reaches a Google Fonts network failure. This is the explicitly allowed external-build exception, not a successful build. No styling/font workaround was applied.

## Checklist

| # | Result | Evidence and qualifications |
|---|---|---|
| 1. MCP non-custodial | PASS | MCP uses a read-only `ChainReader`. No wallet/private-key account creation or signing/broadcast calls in the MCP/executor source boundary. HMAC quote authentication is not wallet signing. User permit signature recovery is verification, not signing. |
| 2. Tool boundaries | PASS | Quote reads executor config, QuoterV2 via `eth_call`, and balances. Prepare returns unsigned calldata/typed data. Status reads receipts. Finalize verifies an externally supplied signature and returns unsigned calldata. No tool sends a trade. |
| 3. Approval safety | PASS | Executor APPROVAL calldata approves the **gross** sell amount to the registered Executor, never uint256 max. HMAC-bound fields and registry routing prevent input overrides. Permit2 setup intentionally approves Permit2; unchanged 0x fallback intentionally approves AllowanceHolder, not the Executor. |
| 4. Fees | PASS | Recorded/pinned fee is 25 bps. `floor(gross * 25 / 10000)` uses bigint. Quoter gets gross minus fee; slippage applies to that output, without a second fee deduction. Sell token determines fee token in both directions. Existing owner-configurable on-chain fee semantics remain unchanged. |
| 5. Route | PASS | Base 8453 USDC/WETH uses the pinned Uniswap V3 Router02, QuoterV2 and fee 3000; CREATE2 matches the recorded pool. Production addresses/registry, existing 0x fallback and Aerodrome configuration are unchanged. |
| 6. Quote → prepare | PASS | HMAC covers taker, tokens, gross input, output, fee/recipient, slippage and issue/expiry times. Prepare reconstructs the same intent and checks live fee configuration. Quote lifetime is 120 seconds; executor intent deadline is 600 seconds from issue. Existing expiry/tamper/permit tests pass. Browser refreshed-proposal validation was corrected separately. |
| 7. Recipient | PASS | Executor intent sets recipient to requested taker. MCP is intentionally unauthenticated preparation, not proof of wallet ownership. The unchanged contract enforces `recipient == msg.sender`; permit finalization recovers the taker. Browser quote endpoints use session-wallet binding. |
| 8. Production RPC | PASS (source/tests + operator confirmation) | Trimmed server `BASE_RPC_URL` wins. Browser RPC is ignored by MCP. A configured provider failure does not silently fall back. Missing/blank configuration retains the documented public default. The operator confirmed the serving deployment configuration; values were not independently inspected here. |
| 9. Error/secret hygiene | PASS (reviewed scope) | Fixed raw provider-message logging: only tool name and constant error code are logged. Tests include credential-shaped placeholder messages/names/causes/objects and assert they reach neither logs nor responses. Diff inspected; no real keys/secrets added. Automated GitLeaks download was blocked by sandbox egress, so no successful GitLeaks scan is claimed. |
| 10. Scope/quality | PASS | Fixtures stay under test paths and are not imported by production modules. No Campaigns, contract, deployment record, production address, fee arithmetic or routing changes. No unrelated refactor. |
| 11. Checks | PASS with documented external build exception | Results below. |
| 12. Live evidence fidelity | PASS | Historical calldata/raw executor events are independent captured data, not generated from the current ABI. Tests replay both records byte-for-byte. New quote tests explicitly use mocked pricing; they do not claim to recover historical quote IDs or provide current live quotes. |

## Bidirectional live evidence

Captured from the BaseScan transaction overview, input data and executor event logs on 2026-09-26; replayed offline.

| Direction | Transaction | Block | Gross sell units | Fee units | Net pool input units | Actual output units |
|---|---|---|---:|---:|---:|---:|
| USDC → WETH | `0x935607b73388e7d53263577d1b6856708b01cecf1911f991fe2c78850fd75ab3` | 51804466 | 1,000,000 | 2,500 | 997,500 | 370,006,219,589,809 WETH wei |
| WETH → USDC | `0xd7d3a9098ec3615e9dee82a710531f345c96b52c746aef1d65402614a66d55c6` | 51804590 | 100,000,000,000,000 | 250,000,000,000 | 99,750,000,000,000 | 267,304 USDC units |

- Chain: Base Mainnet **8453**.
- Executor: `0xD982726e28275661F8aB64054E6b17a70a63505A`.
- Owner / recorded taker: `0xE0e0d239853c5F2Fe0a524d544eC9eB71fef486e`.
- Fee recipient: `0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`.
- Router02: `0x2626664c2603336E57B271c5C0b26F421741e481`, pool fee **3000**.
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals).
- WETH: `0x4200000000000000000000000000000000000006` (18 decimals).
- Pool: `0x6c561B446416E1A00E8E93E221854d6eA4171372`.

The fixture receipt is explicitly a projection containing the raw Executor event, not an invented full receipt. No block hash or historical HMAC quoteId is fabricated.

## Confirmed issues fixed

1. **Credential-bearing provider messages in MCP logs.** Truncating an exception did not sanitize RPC URLs or nested/provider text. The catch now logs only server-owned fields; external errors remain generic.
2. **Wrong proposal revalidated after browser requoting.** The code validated the old proposal before using the refreshed one. It now validates `fresh`; regression cases reject wrong chain, invalid slippage, missing confirmation and newly insufficient balance before wallet calls.
3. **Invisible receipt-RPC failure.** A swap receipt read could reject without a terminal UI update. Submitted hashes are now retained with an explicit **unknown confirmation** error; no retry/broadcast or fee transfer is introduced.
4. **Nonzero WETH fee displayed as zero.** Six-decimal display truncation hid a 0.00000025 WETH fee. Sell-token precision is now used for display only; fee arithmetic and collection are unchanged.
5. **Confirmation clarity/mobile reachability.** Bounded scrolling, explicit wallet ownership, exact amounts, recipient/spender, fee disclosure, progress stages, submitted transaction links and visible errors were added. Closing during an active wallet operation is disabled so it cannot reset/drop the running operation through this modal.
6. **Stale MCP chain-description text.** Tool metadata now describes the Executor/Uniswap route and unchanged 0x fallback, instead of calling mainnet 0x-only.

## UI audit boundary

**The browser trading flow and MCP Executor flow are different existing paths.** This audit was written while the browser still used its existing CDP/0x/Aerodrome provider selection plus a **separate post-swap wallet-confirmed fee transfer**. That divergence was closed later on 2026-09-26 (same day): the browser quote now tries the MPGR Executor first for its proven pair (`lib/trade/trade-executor-quote.ts`), so the wallet signs the executor swap itself and the 0.25% fee is taken **inside that transaction** from the gross sell amount to the executor's configured `feeRecipient()` — first-time ERC-20 is approve + swap, afterwards swap only, with no third transaction and no separate fee signature anywhere in the swap flow. Pairs without a proven executor route keep their existing CDP/0x/Aerodrome provider selection and are quoted with **no** MPGR fee. The 25 bps is applied to the post-fee pool quote, so the modal's minimum-received is net of the fee. A genuine in-app Aerodrome quote is not falsely relabeled Uniswap.

- Reviewed the existing Home/Agent trading composition, tape-to-quote path, amount/direction handling, confirmation and wallet-execution state paths.
- Render tests cover disclosure, both directions, current route versus separate MCP route, pending/signing states, wallet rejection, fee failure and explorer links.
- Chromium tested the **real updated modal with isolated mock proposals/callbacks** at 1440×1000, 390×844 and 320×568. Both directions × eight states × three viewports = **48 passing checks**. Horizontal overflow, viewport bounds, scrolling/button reachability, disabled close/confirm during busy states, error messages and status links were checked; desktop/mobile screenshots were reviewed.
- This is not a live-wallet or deployed full-app E2E certification. No wallet was connected, no signature produced and no transaction sent. The existing full test suite covers the remaining app flows.

## Verification results

Node **20.20.2**, lockfile install via `npm ci` (no package/lockfile changes).

| Check | Result |
|---|---|
| Targeted MCP/executor/UI/trade tests | **257 passed / 13 files** |
| Full test suite | **1,869 passed / 181 files** |
| TypeScript (`tsc --noEmit`) | PASS |
| Full ESLint | PASS: 0 errors, 59 existing warnings |
| All changed/new TS/TSX files, ESLint `--max-warnings 0` | PASS |
| Local browser modal matrix | **48 passed**, mock-only |
| Dependency security policy (`npm run audit:high`) | PASS under existing policy; 4 pre-existing allowlisted transitive high findings, 0 critical; 45 moderate and 17 low |
| `git diff --check` | PASS |
| Production build (`npm run build`) | BLOCKED only by the reported Inter/Google Fonts fetch error; not claimed successful |
| Automated GitLeaks | NOT RUN successfully: release-binary download blocked by sandbox network |

Build error: `next/font: Failed to fetch Inter from Google Fonts`, requesting `https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap`.

## Changed files

Production (narrow fixes only):
- `components/features/agent/AgentTradeConfirmationModal.tsx`
- `lib/mcp/mcp-server.ts`
- `lib/mcp/mcp-tools.ts`
- `lib/trade/trade-agent-fee.ts` (display precision only)
- `lib/trade/trade-execution.ts` (refreshed validation and error reporting only)

Tests:
- `components/features/agent/AgentTradeConfirmationModal.render.test.ts`
- `lib/executor/__tests__/executor-rpc-config.test.ts`
- `lib/mcp/__tests__/base-mainnet-live-fixtures.ts`
- `lib/mcp/__tests__/base-mainnet-live-regression.test.ts`
- `lib/mcp/__tests__/mcp-read-only-boundary.test.ts`
- `lib/mcp/__tests__/mcp-server.test.ts`
- `lib/trade/__tests__/trade-agent-fee.test.ts`
- `lib/trade/__tests__/trade-execution.test.ts`

Report: `docs/MAINNET_TRADING_AUDIT_2026-09-26.md`.

## Remaining limitations / rollback

Existing lint warnings and dependency-policy exceptions were not expanded or suppressed. Runtime configuration was operator-confirmed; live provider health was not independently probed from this sandbox. Production build must complete in an environment able to fetch the existing font. External contract review remains outside this code audit. No unrelated Campaigns/reward/security work is certified by this report.

Rollback is a code revert of the hardening change; no contract/admin transaction, fee setting, router revocation, deployment record or production environment mutation is needed. Reverting also restores the fixed logging/validation/UI defects, so review that risk before rollback.
