# Compatibility and risk register

This initiative’s first PR is documentation. The risks below are for the **follow-up PRs** in `scalability-roadmap.md`. If a change is not listed as allowed, it is out of scope.

## Must keep working (backward compatible)

| Surface | Contract to preserve | How to notice a break |
| --- | --- | --- |
| PaigerSwap v1 `POST /api/swap/quote` | Session taker, fee required, response shape | `lib/swap` quote tests |
| PaigerSwap v2 quote / settlement | Sealed manifest, no env address override | `lib/swap/v2` tests, fork proof workflow not run from docs PRs |
| Agent trade quote | Executor, else routed CDP/0x. Stocks order stays 403. | `lib/trade` tests |
| MCP tools | Quote id HMAC, prepare does not broadcast | `lib/mcp` tests, skills text if a field renames |
| Wallet connect | RainbowKit on Base 8453, SIWE cookie | auth tests |
| XP amounts | 50 / 20 / 30 / 15 / 40 / 100 / 8 | ledger tests |
| Season points | UTC month bucket, lifetime not reduced | season-points tests |
| Referrals | Daily cap, settle on real check-in | referral tests |
| Game reward route | No client XP field; replay; cap 10; flags default off | reward route tests |
| Settlement crons | Paths and schedules in `vercel.json` | do not edit in asset PR |
| Campaign idempotency | `SET NX` and cap rollback | campaign store tests |
| Executor ABI | Matches Forge output (`gen-executor-abi.mjs --check`) | CI contracts job |
| Public URLs | `/`, `/swap`, `/games/mpgr-run`, `/api/*` paths | none renamed in early PRs |

## Breaking-change risks

| Change | Risk | Mitigation |
| --- | --- | --- |
| Deleting a WebP that a test or overlay still requests | 404 art, broken screenshot tests | Grep the filename; update `run-assets.files.test.ts` in the same commit |
| Demoting critical panoramas | One frame of procedural background if the new skyline is slow | Already the documented fallback. Watch the play proof. |
| Bumping `RUN_ASSET_VERSION` | Every player redownloads all versioned art | Do not bump unless bytes at a same URL change |
| Navbar stops reading staking | Tier badge empty or stale on every page | Product decision in the PR description. Profile/staking pages keep live reads. |
| Server streak | Two devices disagree during rollout | Read server if present, else local. Never lower XP to “fix” them. |
| Moving `XP_ACTIONS` | Import cycle or amount typo | Move with zero numeric diff. Test the table. |
| Shared fee import | Off-by-one wei vs a copied `25n / 10000n` | Golden test before switching call sites. Separate PR. Approval. |
| React Query or new global fetch | Double fetching, stale quotes | Not in the immediate plan |
| Enabling game token rewards | Real MPGR leaves the vault | Forbidden in this initiative |

## Security risks

| Item | Status | Note |
| --- | --- | --- |
| CSRF on cookie mutations | **V** `verifyTrustedOrigin` | Do not weaken for a new game POST. Use `protectApiRequest`. |
| SSRF on x402 discover | **V** `lib/x402/ip-guard.ts` | New outbound fetches do not get a raw `fetch(userUrl)`. |
| Client XP spoofing | **P** local display can lie; server ledger rejects it | I5 (pending label) reduces the lie. Server streak must not trust the client streak number. |
| Game trace forgery | **V** replay | Light games need their own replay. Do not skip it because the game is “small.” |
| Session fixation / nonce | **V** single-use nonce | — |
| Secrets in repo | CI gitleaks is green on this SHA | Docs must not paste `.env.example` values. WalletConnect project id stays out of these files. |
| Operator keys | Named in `.env.example`, default autonomy off | Architecture PRs do not add new key readers. |
| Fee-less swap fallback | Comments say swap must not drop the fee | Any quote-kernel PR needs a test that a missing fee is an error on `/api/swap/quote`. |
| Campaign point rollback | `DECRBY` only inside a failed grant | Do not reuse that pattern as “streak decay.” |
| Dependency PRs #48–#52 | Open, untrusted relative to this audit | Do not combine. |

## Rollback

| PR | Rollback |
| --- | --- |
| This docs PR | Revert the merge. No data migration. |
| Asset budget | Revert. CDN may cache 404s briefly; filenames that remain keep immutable cache. |
| Navbar | Revert the hook wiring. No Redis change. |
| Dead code delete | Revert. |
| Server streak | New keys can be left in place (harmless) or deleted by prefix after revert. Award script must be reverted **with** the key writer so an old script does not ignore a new ARGV layout. Ship the Lua change and the reader together. |
| Fee dedupe | Revert immediately if any golden vector moves. |

Deploy: merge to `main` is the Vercel production path. Do not use the manual mainnet deploy workflows for documentation or UI PRs.

## Regression tests (minimum bar before merge of a code PR)

Already required by CI on pull_request: `npm run lint`, `typecheck`, `vitest`, `audit:high`, `next build`, Forge tests, slither, gitleaks, real-redis autonomy test.

Add for the specific PR:

- Asset: byte ceilings.
- Navbar: a test that the navbar module graph does not import `useStaking` (import assertion or source test, same style as `asset-loading-policy.test.ts`).
- Streak (only if approved): two concurrent awards, missed day, same day, month boundary, XP unchanged on all of them.
- Fee (only if approved): vector file checked in, expected wei from **current** code.

## Explicit non-goals

- Mass folder rename (`lib/` → `modules/`).
- Replacing Tailwind, wagmi, or Next.
- Turning on autonomous mainnet execution.
- Editing merged PR #143’s branch. That branch is history. This work starts at `3fb5eb82`.
- Publishing a tokenomics change inside an architecture cleanup.
