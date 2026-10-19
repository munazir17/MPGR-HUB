# PR #113 — MPGR Swap: one-pass DEX completion report

Branch `arena/b8c82200-mpgr-hub`, built on the verified remote PR head `489cc1e`.
PR stays **open/unmerged**. No contract was deployed, no owner/permission was
changed, and no live swap or broadcast was performed in this pass.

Commits in this pass:

| Commit | Scope |
| --- | --- |
| `eb65178` | `MPGRSwapExecutor` release candidate: fixed-fee, typed 1–3 hop Base paths + 22 contract tests |
| `2c52e79` | Backend integration behind an explicit deployment gate (`swapPathExecutor()` = `null` until a reviewed manifest is committed) |
| `8b2c4a3` | Token-selector UX cleanup, optional technical diagnostics, vetted logo manifest, activation doc, gated deploy script |
| _(final QA commit)_ | Slither annotation + deploy-script checksum fixes, manifest-anchored logo semantics, `.forge-deps` symlink untracked |

## 1. Capability matrix (what is executable, and under which condition)

### A. Executable today in production (unchanged legacy path)

| Route class | Venue | Status | Fee behavior |
| --- | --- | --- | --- |
| USDC ↔ WETH | Uniswap V3 0.30% direct pool via deployed executor `0xD982726e28275661F8aB64054E6b17a70a63505A` | Executable (pre-existing) | 25 bps read live from the deployed contract; recipient/fee drift blocks the swap at proposal time; recipient is **mutable by owner** (documented risk) |
| MPGR (B200) ↔ USDC | Slipstream (CL) direct pool via the same deployed executor | Executable (pre-existing) | Same as above |

The deployed executor is non-upgradeable and single-hop typed: no source or ABI
change can add methods to that address. Everything beyond the two routes above
requires the new contract in section B.

### B. Integrated + fully tested, awaiting deployment approval (dormant by design)

`contracts/swap/MPGRSwapExecutor.sol` (new, fixed-fee) with typed adapters for:

| Route class | Adapter |
| --- | --- |
| UniV3 direct (any fee tier, any pool-discovered Base pair) | `HOP_UNIV3` |
| Slipstream/CL direct | `HOP_SLIPSTREAM` |
| UniV2 direct (`0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24`) | `HOP_UNIV2` |
| Aerodrome Classic direct (`0xcF77…4E43`, stable/volatile flag per pool) | `HOP_AERODROME_CLASSIC` |
| Two-hop combinations across the four venue types | `swapExactInput` 2 hops |
| Three-hop paths (max) | `swapExactInput` 3 hops |

Every path proposal goes through: pool discovery → fresh amount-specific quote
→ route/token/router/pool/chain validation → exact fee computation →
allowance/approval lifecycle → explicit wallet confirm → typed calldata submit →
receipt wait → mined-output verification → transaction overview. A discovered
pool or quote is **never** marked executable by itself.

**Fee guarantee (section B routes):** `floor(gross × 25 / 10000)` transferred
atomically inside `swapExactInput` to the immutable recipient
`0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4`. There is no fee-less fallback —
a failed fee transfer reverts the whole swap. This removes the mutable-recipient
concern for path swaps. Agent fee logic is untouched.

**Gate:** `lib/swap/swap-executor-config.ts` → `swapPathExecutor()` returns
`null` until a reviewed `deployments/base-mainnet/mpgr-swap-executor.json`
manifest is committed to `SWAP_PATH_EXECUTOR_DEPLOYMENT`. With the gate closed,
legacy behavior is byte-identical (tested invariant) and no path proposal can
surface as executable.

### C. Discovery-only (explicitly not claimed executable)

| Item | Honest status |
| --- | --- |
| Universal Base ERC-20 import by contract address | Validated on-chain (chain id + exact address + metadata); route discovery runs dynamically; UI shows “Available to swap” only when a supported typed path with verified liquidity exists (post-activation), otherwise “No route found” / “Route not supported” |
| ETH ↔ AAPLc (both directions) | No genuine Base liquidity/route found → reported as “No route found”; never fabricated |
| Uniswap V4, aggregators (1inch/0x/etc.), venues outside the four typed adapters, cross-chain | Not integrated; no availability claims |
| Candidate breadth | ≤ 10 candidates per search (4 direct + combinations cap), each requiring a verified quote |

## 2. Logos

- `lib/swap/token-logos.json`: 9 vetted tokens, each pinned by Base chain id +
  exact normalized address + token kind, with sha256 content hashes and
  TrustWallet asset-commit source URLs (`c0df8990…`). Artwork is vendored under
  `public/tokens/base/` (bounded PNGs, never executable SVG, never remote URLs).
- Trust anchor is the **manifest address match**, not the token's
  verified/imported flag or symbol: an import-validated contract whose exact
  address+kind matches the manifest shows the same official artwork; a lookalike
  symbol or a different address always gets the neutral fallback.
- Broken/failed image loads fall back to the neutral icon (`token-logo-fallback`
  testid); loading states never leak remote requests (all assets are local).
- Verified in the real mobile browser matrix at 360×800 and 390×844
  (`swap.spec.ts`, `swap-native-ui.spec.ts` logo assertions) and in the Vercel
  Preview on a real mobile viewport (see §5).
- Tokens without official upstream artwork (e.g. cbBTC, RNBW, ZORA) keep the
  neutral fallback by design — no symbol-matched or guessed logos.

## 3. UX cleanup (per the three screenshots)

- Per-row technical disclaimers and per-token read-only “inspect” buttons
  removed from the main selection flow.
- Diagnostics moved into an optional disclosure: `swap-technical-details`
  (route evidence + liquidity inspection) and `import-technical-details`.
- Compact contract-address import; duplicate imported-token row fixed.
- Modal scrolling, address wrapping (`shortAddress` rows), clipped text, logo
  sizing and button spacing fixed.
- Concise truthful statuses: “Available to swap”, “Quote verifies route”,
  “Same asset”, “No route found”, “Route not supported”.

## 4. Preserved prior fixes (regression-covered)

Receipt-anchored allowance verification, genuine insufficient-allowance
protection, approval recovery, success-modal → transaction overview, mined-tx +
actual-output verification, quote freshness and duplicate-submission protection,
wallet rejection / chain change / account change / tx replacement / dropped tx /
revert / stale-quote handling — all retained and exercised by the unit and
browser suites listed below.

## 5. Verification actually run (mocked vs live separated)

| Check | Result | Evidence |
| --- | --- | --- |
| Unit tests (`npm test`) | 4235 passed / 24 skipped, 311 files | `/home/user/swap-final-unit.txt` (session log); targeted re-run after final edits: 771/771 (`lib/swap` + `lib/trade`) |
| Contract tests (`forge test`) | 18 suites: 244 passed / 0 failed / 41 skipped (incl. 22 new `MPGRSwapExecutor` tests) | `/home/user/swap-forge-final.txt` |
| Static analysis (Slither 0.11.6) | 0 real findings on `contracts/swap`; single remaining hit is the known OZ `Math.mulDiv` incorrect-exp false positive; `_runHop` balance-snapshot annotations added with justification | `/home/user/swap-slither-new.txt` |
| Lint (`npm run lint`) | exit 0, no errors; 63 warnings, all pre-existing (SwapForm warnings verified identical before/after this pass's edits) | `/home/user/swap-final-lint.txt` |
| Production build + typecheck | `next build` exit 0 (34/34 static pages, `/swap` prerendered, offline font mock); `tsc --noEmit` exit 0 | `/home/user/swap-final-build2.txt` |
| Browser matrix (mocked harness, real Chromium, 360×800 + 390×844) | focused swap-liquidity suite 22/22; full matrix: 218/224 first run — the 6 failures were stale spec copy-assertions against the intentional concise-status redesign (“no ERC-20 contract” row note, “trading is not supported…” row disclaimer); assertions updated to the new concise statuses (full sentence still enforced via the row `title`), rerun of both affected files: **122/122 green** → effective full matrix **224/224** | `/home/user/swap-browser-full.txt`, `/home/user/swap-browser-rerun.txt` |
| CI on exact pushed head `ee08162` | **success** — jobs: build, contracts, contracts-fork, quality, real-redis, reference, secret-scan, slither all pass; deploy workflows skipped (gated, no on-chain action) | GitHub Actions run 39137408722 |
| Vercel Preview | Deployed SUCCESS for `ee08162`: `https://mpgr-hub-ezxs-git-arena-b8c82200-7f7d9c-munazir-razas-projects.vercel.app` | Vercel check + bot comment |
| Production-bundle mobile logo verification | Optimized build served via `next start`, driven by real Chromium at 360×800 (isMobile, DSF2): 48 selector rows — 4 rows with locally decoded official artwork (`/tokens/base/0x…png`, `naturalWidth>0`), 44 neutral fallbacks, **0 failed asset requests**; AAPLc row shows neutral fallback (never symbol-matched); screenshots committed under `docs/evidence/pr113-prod-mobile/` (Vercel domain itself is outside this sandbox's network allowlist, so the visual preview confirmation for humans is the URL above) | `docs/evidence/pr113-prod-mobile/01-swap-page.png`, `02-selector-logos.png`, `03-aaplc-fallback.png` |
| Live network checks | Base RPC is unreachable from this sandbox: **no live quotes or settlements were possible locally**; all on-chain facts cited (deployed executor, routers, owner, fee recipient) come from read-only checks performed earlier in the PR timeline | — |

Full browser matrix: **224/224 effective** (first full run 218 passed + 6 stale-assertion failures; corrected assertion files rerun 122/122).
CI on `ee08162`: **success** (8 jobs pass, 2 gated deploy workflows skipped). Vercel Preview: **deployed** (URL above).

## 6. Agent isolation review

The only shared-file touch in this pass is `verifyAgentFeeInSwapTransaction` in
`lib/trade/trade-agent-fee.ts`: it now also accepts the fixed-fee Swap executor
address as fee-collecting target **when (and only when) a reviewed deployment
manifest exists** — currently `null`, so runtime behavior is byte-identical
(tested invariant). The 25 bps amount, floor semantics and recipient are
unchanged; no Agent autonomous runtime, quote/execute API, wallet behavior or
Campaigns code was modified. No private keys, no arbitrary calldata paths.

## 7. Remaining blocker and the exact approval needed

Everything safely implementable without on-chain action is complete. The single
remaining step for section-B routes is deployment + activation of
`MPGRSwapExecutor`, which requires explicit approval per
`docs/PR113-SWAP-EXECUTOR-ACTIVATION.md`:

1. Owner decision to deploy the fixed-fee executor on Base Mainnet.
2. Config gate: `swapExecutorDeployEnabled: true` in
   `deployments/base-mainnet/deploy-config.json` (key deliberately absent from
   the committed config) **and** env `MPGR_SWAP_EXECUTOR_DEPLOY_ENABLED=true`,
   `SWAP_EXECUTOR_OWNER`, `SWAP_EXECUTOR_INITIAL_TOKENS`, fresh nonce-0 deployer.
3. `forge script script/DeployMPGRSwapExecutorBaseMainnet.s.sol --rpc-url $BASE_RPC --broadcast --verify`
   (only runs with both gates open).
4. On-chain verification of `feeBps == 25` and the pinned recipient, then commit
   the reviewed manifest into `SWAP_PATH_EXECUTOR_DEPLOYMENT`.
5. Rollback = revert the manifest commit (path proposals deactivate instantly;
   legacy routes unaffected).

No deploy, ownership change or live swap was executed in this pass.
