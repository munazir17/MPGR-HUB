# Changelog

All notable changes to MPGR HUB are documented in this file.

The project follows a milestone-based development roadmap.

---

# Unreleased

## Task 12 — assets and loading performance

### Fixed

- Small-slot portal images no longer download megabyte art: the 32px header mark uses a new 128×128 `public/brand/mpgr-mark-128.webp` (~3.7KB vs 1.58MB `/icon.png`), the 44px game-card icon uses a 128×128 idle-sprite thumbnail (~5.8KB vs 597KB), and the featured-game banner uses a 256px run-sprite thumbnail (~10KB vs 490KB). All thumbnails are high-quality WebP with alpha preserved; full-resolution sources are untouched and the game canvas keeps loading them via the existing tiered pipeline.
- `GameCard` icons (below the fold) now render with `loading="lazy"` and `decoding="async"`; the featured banner keeps eager loading with `decoding="async"`. `/icon.png` itself is unchanged (favicon, apple-touch-icon, and Farcaster manifest still reference it); unreferenced on-disk art (portal, screen, `image.png`) was intentionally left in place — zero runtime cost.
- Regression tests: `lib/__tests__/image-assets.test.ts` (every game-manifest sprite resolves on disk, thumbnail magic/dimensions/size bounds, registry iconImage stays small), `BrandMark` / `GameCard` / `FeaturedGameBanner` render tests for src + loading attributes. `vitest.config.ts` applies the automatic JSX runtime inside the test runner only (Next still requires `"jsx": "preserve"`).

## Task 8 — referral abuse hardening

### Fixed

- Referral rewards (the +100 XP `REFERRAL_SUCCESS` ledger grant — the largest single award in the system) were paid to the referrer **instantly on attribution**, uncapped. Rate limits key on the request sender — the *referred* wallet — so a sybil farm of throwaway wallets arriving through one `?ref=` link minted unlimited XP for one referrer with zero genuine activity. Now the reward is stored as a durable pending record at registration and settles only when the referred wallet earns a genuine server-awarded activity event (daily check-in), the referrer already exists in the server XP ledger, and the per-referrer daily reward cap (`REFERRAL_REWARDS_PER_REFERRER_PER_DAY`, default 5, fail-closed) has room. Cap check + claim are atomic in one Lua script; the permanent ledger event key keeps every replay/race at-most-once.
- Self-referral, attribution-steal attempts and cap saturations are now logged (`referral.abuse.*` / `referral.reward.daily-cap`) and counted per wallet/day in `mpgrhub:referral:abuse:{wallet}:{day}` for operator review.
- Attribution itself is unchanged: permanent, first-write-wins, referred identity always taken from the authenticated session (never the request body), all existing `mpgrhub:referral:referredby:*` / `referrals:*` keys and values keep their format, and referral counts stay capped to real attributed wallets. No migration needed; records written by the old immediate-pay path are never re-paid (same ledger event id) and never invalidated.
- Regression tests: `lib/referral/referral-store.test.ts` (real Lua via the fengari Redis double: idempotency, atomic caps, concurrent claims, corrupt records, Redis-failure paths, legacy data), `app/api/referral/route.security.test.ts` (real route + session + origin + guard: farming window, cap, replays, multi-session, steal, tampering, fail-closed), `app/api/referral/route.ratelimit.test.ts` (real dual-bucket limiter on the endpoint).

## Task 4 — next.config.mjs hardening

### Fixed

- `images.remotePatterns` no longer allows `hostname: "**"`. The always-on `/_next/image` route would fetch and re-serve any https URL a caller named (open image proxy / quota abuse). The repo has no `next/image` usage — first-party or in bundled dependencies — and every image is a local `/public` file rendered with `<img>`, so the allowlist is now explicitly empty. Local images through `/_next/image` keep working.
- Framing policy (owner-approved 2026-09-20): page and static routes now send `Content-Security-Policy: frame-ancestors 'self' https://farcaster.xyz` instead of `X-Frame-Options: DENY`. The Farcaster **web** client loads Mini Apps in an iframe, which `DENY` refused (mobile clients use a WebView and were unaffected). `/api/*` keeps `X-Frame-Options: DENY` and additionally sends `frame-ancestors 'none'`. The CSP contains only the framing directive. Allowlist lives in `FRAME_ANCESTORS` in `next.config.mjs`.
- Regression tests: `lib/__tests__/next-config.test.ts` (runs Next's real config loader, image-optimizer validation and header-route compiler).

---

# Version 0.6.1

## Remaining August 2026 audit closeout

### Fixed

- XP ledger Lua uses `redis.call` with event TTLs and an atomic daily game-XP cap.
- `useXP` displays server-ledger totals; local storage is a cache.
- Trade price keeps its original `{ from, to, slippageBps, price, provider, network }` body and binds taker to the session. Tokenized-stock quotes do the same.
- MPGR Run records live heartbeats and rejects uncovered durations; physics helpers are shared.
- Foundry remappings match CI `.forge-deps` clones. CI uses `npm ci`, a 4 GB heap, and Foundry `stable`.
- README no longer claims Docker, pnpm, BullMQ, Prometheus, or production-ready financial rewards.

### Still open (honest)

- Independent contract audit, real replay anti-cheat, referral sybil, vault settlement idempotency, full 204MB art conversion, `RunGame.tsx` split.

---

# Version 0.6.0

## Tokenized-stock execution

### Changed

- Coinbase B20 buy/sell now routes through Aerodrome Slipstream USDC pools (Gauges V3 factory / QuoterV2 / SwapRouter). Coinbase CDP Trade API and 0x Swap API legally reject these tokens and are not used as a fallback.
- Regular ERC-20 swaps (ETH, USDC, MPGR, …) are unchanged: CDP Trade API, then 0x AllowanceHolder.
- Tokenized-stock research probes Aerodrome directly and no longer requires CDP credentials.
- ETH/WETH ↔ B20 is rejected with a convert-to-USDC-first message (no direct pool in v1).

---

# Version 0.1.0

## Foundation

### Completed

- Project initialization
- Next.js architecture
- TypeScript setup
- Tailwind CSS integration
- Wallet connection
- RainbowKit integration
- Wagmi integration
- Base network support

---

# Version 0.2.0

## Gamification

### Added

- Daily Check-In
- XP System
- Levels
- Achievements
- Lucky Spin
- Mini Games
- Memory Challenge
- Tap Challenge
- Leaderboards
- Season Points

---

# Version 0.3.0

## Dashboard

### Added

- Premium Dashboard
- Wallet Overview
- Profile
- Statistics
- Responsive UI
- Performance improvements

---

# Version 0.4.0

## Reward System

### Added

- Reward Center
- Weekly Rewards
- Reward History
- Reward Analytics
- Claim Center

---

# Version 0.5.0

## Token Utility

### Added

- Staking UI
- Token Lock UI
- Treasury foundation
- Holder tiers
- Premium framework

---

# Version 0.6.0

## AI Foundation

### Added

- AI architecture
- Event Bus
- Task Queue
- Logger
- Performance Monitor
- Background Sync
- Refresh Manager
- Service Layer

---

# Version 0.7.0

## Phase 3E

### Part 1

Completed

- MPGR Token Integration
- B20 Foundation
- Contract Client
- Balance Reads
- Token Metadata
- Transaction Utilities

### Part 2

Completed

- Portfolio Engine
- Live Portfolio
- Wallet Balances
- Holdings
- Portfolio Sync
- Event Listeners
- Mock Removal

### Part 3

In Progress

- Live Staking
- Live Rewards

### Part 4

Planned

- Token Lock
- Premium Integration

### Part 5

Planned

- On-Chain Intelligence
- Analytics
- Activity Feed

### Part 6

Planned

- Production Audit
- Security Review
- Performance Optimization
- Final Production Release

---

# Future

- Governance
- AI Expansion
- Mobile Support
- DAO
- Advanced Analytics
- Cross-Chain Features
- Developer SDK
