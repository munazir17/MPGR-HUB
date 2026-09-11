# Changelog

All notable changes to MPGR HUB are documented in this file.

The project follows a milestone-based development roadmap.

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
