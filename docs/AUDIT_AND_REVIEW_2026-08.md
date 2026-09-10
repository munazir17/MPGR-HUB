# MPGR HUB Audit and Review

**Review date:** 23 August 2026
**Scope:** repository at commit `839d290`
**Review type:** code, architecture, security, AI-agent readiness, dependency, and delivery review
**Important:** this is an engineering review, not a formal smart-contract audit or penetration test.

## Simple summary

MPGR HUB has a wide feature set and several good building blocks: strict TypeScript, clear feature folders, typed agent tools, AI fallbacks, server-only reward allocation, and careful comments around settlement risk.

It is **not production-ready for financial rewards yet**. The largest problem is trust: several public endpoints accept wallet identity, XP, referrals, or game results directly from the browser. A wallet address does not prove that the caller owns the wallet. Client-side game checks also do not prove that a run was real.

The best next step is not a large visual refactor. First build a small, reliable security foundation: signed sessions, server-owned reward facts, rate limits, contract tests, CI, and honest documentation.

## What was checked

- App Router pages and API routes
- Agent provider, guardrail, memory, command, and tool code
- Leaderboard, referral, game reward, settlement, staking, token-lock, and reward services
- `MPGRStaking.sol` and reward math by manual reading
- Environment and deployment files
- Tests, TypeScript, lint, build, and dependency audit
- Repository structure and documentation accuracy

## Check results at the start of review

| Check | Result | Note |
|---|---|---|
| TypeScript | Pass | `npx tsc --noEmit` passed |
| Unit tests | Fail | 72 passed, 1 failed because one test expected lowercase while Viem returned a checksummed address |
| Lint | Fail / interactive | `next lint` was deprecated and no ESLint config existed |
| Build | Inconclusive locally | compilation exceeded the local Node heap near 806 MB; CI should use a larger heap |
| Dependency audit | Needs action | 37 advisories: 1 critical, 6 high, 30 moderate in the installed tree |
| Smart-contract tests | Missing | no Foundry/Hardhat setup or contract test suite was present |

This PR adds repeatable lint/CI commands, a lockfile, an agent guide, AI request limits, and review documentation. It does not claim to fix the product-level trust issues below.

## Findings

### P0 — fix before financial rewards or a larger public launch

#### 1. Public writes do not prove wallet ownership

Affected areas include leaderboard sync, referral registration, and game run submission.

The caller supplies a wallet address. The server validates its format, but does not ask the wallet to sign a nonce. A third party can therefore submit data in another wallet's name.

**Impact:** false leaderboard data, false referral attribution, reward abuse, and loss of trust.

**Advice:** add Sign-In with Ethereum or an equivalent signed nonce flow. Bind the session to wallet, chain ID, nonce, domain, issued time, and expiry. On write routes, use the authenticated wallet from the session instead of a wallet field from JSON.

#### 2. XP and season points are browser-owned

XP is stored in `localStorage`, then pushed to the global leaderboard. The API accepts the submitted numbers.

**Impact:** a user can report arbitrary XP and rank.

**Advice:** make XP an append-only server ledger. Award XP only from server-verified events. Derive totals and leaderboard score from that ledger. Browser storage can remain an optimistic UI cache.

#### 3. Competitive game results are not authoritative

The server recalculates the score and runs sensible bounds, which catches simple mistakes. However, all run statistics still come from the client. The code itself correctly warns that this is not secure anti-cheat.

**Impact:** forged but plausible runs can receive real allocation.

**Advice:** do not attach real-value rewards until there is server-verifiable evidence. Options include server-issued sessions with expiring nonces, signed event checkpoints, deterministic replay validation, telemetry/risk scoring, per-wallet limits, and manual review for top winners. No single client-side check is enough.

#### 4. Smart contracts lack a runnable test and audit setup

The staking contract imports OpenZeppelin, but the repository does not include a Solidity build configuration or contract tests.

Manual review also found design questions that need explicit tests: fee-on-transfer token behavior, unfunded initial emission, reward-pool solvency, APR changes when no one is staked, schedule extensions, pause behavior, rounding, and owner powers.

**Impact:** financial behavior is not reproducible or proven in CI.

**Advice:** add Foundry, pin compiler and OpenZeppelin versions, and test invariants. Obtain an independent audit before production funding. Use a multisig owner and document emergency procedures.

### P1 — high priority

#### 5. AI proxy routes had no useful input, output-cost, or timeout boundary

The browser calls server routes that spend provider credits. Before this PR, prompts had no size cap and upstream calls had no timeout or output-token cap. Raw upstream error bodies were returned to clients.

**Change in this PR:** shared body/prompt limits, 20-second upstream timeout, output-token caps, generic client errors, and tests.

**Still needed:** authenticated access, distributed rate limiting, per-wallet/IP quotas, cost metrics, request IDs, and server-owned system policy. The browser currently supplies the full system prompt, so the server must not treat that text as trusted policy.

#### 6. Referral registration is first-write-wins but not authenticated

Redis `SET NX` gives good idempotency, but an unauthenticated first caller can claim attribution for a wallet before its owner does.

**Advice:** authenticate the referred wallet and sign or server-store the referral click before wallet connection. Add expiry and abuse monitoring.

#### 7. Settlement has a known exactly-once gap

The code clearly documents a crash window between broadcasting an on-chain batch and persisting confirmation. It safely stops automatic retries, but recovery is manual.

**Advice:** add an idempotency key enforced by the reward-vault contract, or use a durable transaction/outbox record with reconciliation. Add an operator runbook and alert whenever a settlement remains `allocating`.

#### 8. Dependencies need a controlled upgrade plan

The installed dependency tree reported one critical and six high advisories. Some fixes require major upgrades, including Next.js, Vitest, and Wagmi paths.

**Advice:** do not run a blind forced upgrade. Create separate upgrade PRs, inspect production reachability, add smoke tests, and use Dependabot or Renovate. Prioritize production-reachable packages over test-only tooling, but update both.

#### 9. API routes need shared protection

Validation and error handling are repeated. There is no common request-size policy, distributed rate limiting, request ID, structured audit event, or consistent cache/security response policy.

**Advice:** create a small server boundary module and apply it route by route. Avoid a giant middleware framework.

### P2 — maintainability and quality

#### 10. Documentation is ahead of the implementation

The README refers to files, commands, workers, Docker, monitoring, and production readiness that are missing or incomplete. The CI badge pointed to `ci.yml`, but only `debug-build.yml` existed before this PR. A license badge is present, but no root `LICENSE` file was found.

**Advice:** label features as implemented, partial, or planned. Remove unsupported deployment instructions or add the files. Add a real license after the owner chooses one.

#### 11. Several files are too large

`RunGame.tsx` is about 1,755 lines. Agent and home-page files are also large. Large files are harder for people and AI agents to understand, test, and change safely.

**Advice:** refactor by behavior, not by arbitrary line count. For the game, separate canvas renderer, simulation loop, input, audio, asset state, effects, and HUD. First add behavior tests so the refactor does not change gameplay.

#### 12. Similar code is duplicated

Examples include OpenAI/Gemini prompt building and some hook/engine pairs.

**Advice:** share stable provider-neutral prompt construction and validation. Do not over-abstract provider request formats, because they genuinely differ.

#### 13. Static assets are very large

`public/` was about 204 MB in this checkout, with many individual PNGs around 2–3.4 MB.

**Impact:** slow clones, deployments, cold cache, and mobile loading.

**Advice:** measure actual use, compress losslessly, convert suitable images to WebP/AVIF, create device-sized variants, preload only critical assets, and consider Git LFS or object storage for source artwork.

#### 14. Test coverage does not match financial risk

Existing agent-tool and asset tests are useful, but reward, auth, referral, leaderboard, settlement, token math, and contracts need much stronger coverage.

**Advice:** test by risk: pure math first, then store concurrency/idempotency, route authorization, contract invariants, and a few wallet E2E flows.

## What is already good

- TypeScript strict mode is enabled.
- AI actions are mostly grounded in deterministic code rather than model-generated routes.
- AI providers have fallback and circuit-breaker concepts.
- Tool schemas, risk levels, and runtime tests are a strong base.
- The settlement route protects its cron secret and documents its crash gap honestly.
- Reward allocation uses integer/bigint values.
- Redis operations use idempotency/CAS patterns in important places.
- Staking exits remain available while new staking is paused.
- Secrets are generally kept server-side and example files warn against public prefixes.

## Recommended order of work

1. Pause real-value game rewards until authoritative verification exists.
2. Add signed wallet sessions and require them on every user write.
3. Move XP and season-point truth to a server ledger.
4. Add contract build, invariant tests, multisig ownership, and independent audit.
5. Add distributed limits and cost monitoring to AI routes.
6. Fix the dependency advisories through tested upgrade PRs.
7. Make CI required on protected `main`.
8. Reconcile README claims with the repository.
9. Refactor large files behind tests.
10. Optimize game assets and measure page/game performance.

## Release gate

Do not call the system production-ready for financial rewards until all P0 items are fixed, contract tests and an external audit are complete, recovery procedures are tested, and required CI passes on a protected branch.
