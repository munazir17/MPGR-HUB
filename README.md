# MPGR HUB
AI-powered Onchain Operating System on Base

[![Build Status](https://github.com/munazir17/MPGR-HUB/actions/workflows/ci.yml/badge.svg)](https://github.com/munazir17/MPGR-HUB/actions) [![License](https://img.shields.io/github/license/munazir17/MPGR-HUB)](https://github.com/munazir17/MPGR-HUB/blob/main/LICENSE) [![Repo size](https://img.shields.io/github/repo-size/munazir17/MPGR-HUB)](https://github.com/munazir17/MPGR-HUB) [![Top Language](https://img.shields.io/github/languages/top/munazir17/MPGR-HUB?logo=typescript)](https://github.com/munazir17/MPGR-HUB) [![Last Commit](https://img.shields.io/github/last-commit/munazir17/MPGR-HUB)](https://github.com/munazir17/MPGR-HUB/commits/main) [![GitHub Stars](https://img.shields.io/github/stars/munazir17/MPGR-HUB?style=social)](https://github.com/munazir17/MPGR-HUB/stargazers)

---

Premium open-source Web3 product: a composable, AI-first OS for onchain identity, token utilities, and user experiences on Base.

Current Status
- 🚧 Phase 3E — AI Foundation & Live MPGR B20 Integration
- IMPORTANT:
  - Phase 1 ✅ Complete
  - Phase 2A ✅ Complete
  - Phase 2B ✅ Complete

This project is no longer just a gaming platform. MPGR HUB is evolving into an AI-powered onchain operating system built on Base — combining token utilities, owner-first experiences, live token-driven utilities, composable AI actions, and production-grade infrastructure.

Core Vision
- Provide a secure, modular platform for holders and apps to interact with onchain assets and AI services.
- Enable persistent onchain reputation (XP, tiers, achievements) and live token-driven utilities.
- Deliver intelligent background services that automate portfolio & treasury primitives, decisioning, and onchain actions.

What’s inside
- Wallet Connect + RainbowKit for seamless Base Mainnet onboarding
- Live MPGR B20 token integration and staking primitives
- Premium analytics dashboard, holder tiers, and season-based rewards
- AI Foundation stack powering Smart Actions, Event Bus, and Production Services
- A secure background task queue, refresh manager, and live token services

Key Features
- Wallet Connect / RainbowKit integration (Base mainnet)
- Live MPGR B20 token: balance, transfers, staking, token lock
- Dashboard: Premium + Public views, Holder Tiers, XP & Achievements
- Quests, Daily Check-in, Lucky Spin, Leaderboard, Season Rewards
- Reward Center & Staking UI with token lock options
- AI Foundation: architecture, Event Bus, Smart Actions, Background Task Queue
- Live Token Services: refresh, streaming data, onchain sync
- Production-grade deployment & monitoring pipelines

AI Work (Active)
- AI Foundation & Architecture
- Event Bus (real-time internal event stream)
- Smart Actions (AI-driven onchain/offchain actions)
- Background Task Queue (retries, scheduling, idempotency)
- Live Token Services (real-time token state + feeds)
- Refresh Manager (rate-limited refresh pipelines)
- Production Services (observability, tracing, service health)

Planned & Upcoming
- AI Memory — persistent user / onchain context for agents
- AI Portfolio — portfolio insights & recommendations
- AI Trading & AI Execution — signal -> execution layers
- Treasury Buyback Engine (governed & auditable)
- Governance primitives & DAO tooling
- Marketplace (digital goods + onchain commerce)
- Native Mobile App (wallet-first mobile UX)

Technology Stack
- Next.js 15 (App Router)
- TypeScript (strict)
- Tailwind CSS (design system)
- Framer Motion (animations)
- Wagmi + RainbowKit (wallets)
- Viem (onchain RPC)
- Base Mainnet (L2)
- MPGR B20 token (live integration)
- Background workers (Node, BullMQ / Redis or similar)
- Observability (Prometheus / Grafana or Sentry)

Repository Status & Quality
- TypeScript-first with strict typing
- CI workflows (lint, test, build)
- Tests for core business logic and background processes
- Production-ready deployment templates (Vercel / Docker)
- Security-first: audits planned for financial flows and AI execution

Recommended Folder Structure (updated)
- /app — Next.js App Router pages and layout
- /components — UI primitives & atoms
- /ui — design system + tailwind config
- /modules
  - /auth — wallet + session bindings
  - /dashboard — premium & public dashboard features
  - /tokens — token service, staking, token-lock
  - /quests — quest engine & handlers
  - /xp — XP system & achievements
  - /rewards — reward center, seasons
  - /ai — AI foundation, agents, smart actions
  - /jobs — background queue workers and task definitions
  - /events — event bus producers/consumers
  - /services — integrations (RPC, analytics, third-party APIs)
- /lib — shared utilities & contract bindings
- /scripts — dev tools, migrations, seeders
- /config — environment configs & schema
- /deploy — deployment manifests & Dockerfiles
- /tests — unit, integration, and e2e suites
- /public — static assets

Roadmap (concise & actionable)
- Short term (Phase 3E)
  - Stabilize AI Foundation & integrate Smart Actions into dashboard
  - Complete production live MPGR B20 services and staking flows
  - Harden background queue & refresh manager for scale
  - Add observability & error recovery for AI execution
- Medium term
  - AI Memory & Portfolio features (user-context persistence)
  - Treasury Buyback Engine (simulation + small-scale live)
  - Governance primitives for onchain proposals & voting
  - Marketplace MVP & partner integrations
- Long term
  - Full AI Execution pipeline with safe-guards & governance hooks
  - Mobile-first apps (iOS/Android)
  - Multi-chain reach beyond Base (modular adapters)

Deployment (improved, production-ready)
1. Preview & local
   - Install: node >= 20, pnpm (recommended)
     - pnpm install
   - Local env:
     - copy .env.example -> .env.local (see Environment section)
   - Dev server:
     - pnpm dev
   - Background workers:
     - Start local Redis and run job workers (pnpm workspace run start:worker)
2. Vercel (recommended for Next.js)
   - Connect repo to Vercel
   - Set Environment Variables in Vercel Dashboard (Production + Preview)
   - Add required secrets (see ENV below)
   - Enable Auto-deploy from main branch
   - Add a post-deploy job to migrate DB or seed critical data
3. Docker (for on-prem / managed)
   - Build: docker build -t mpgr-hub:latest .
   - Run with docker-compose (includes redis, db, worker, web)
4. Production considerations
   - Use hardware-backed HSM or cloud KMS for private key material
   - Rate-limit RPC access and stagger background refreshes
   - Add circuit-breakers to AI execution and token services
   - Integrate metrics & alerting (Sentry, Prometheus, Grafana)
   - Run periodic security scans and dependency updates

Environment Variables (example and explanations)
Create .env.local from .env.example. Required / recommended variables:

- NEXT_PUBLIC_BASE_RPC_URL — (required) Base mainnet RPC endpoint (public)
- NEXT_PUBLIC_APP_URL — (required) Public URL for app (https://app.example.com)
- NEXT_PUBLIC_API_VERCEL_ORIGIN — (optional) Vercel preview origin
- PRIVATE_KEY_MANAGER_ENDPOINT — (required for backend jobs) URL to key manager or signing service
- MPGR_B20_CONTRACT_ADDRESS — (required) Live MPGR B20 token contract address
- MPGR_STAKING_CONTRACT_ADDRESS — (required) Staking contract address
- DATABASE_URL — (required) Postgres connection string for app & jobs
- REDIS_URL — (required) Redis for queues/event bus
- SENTRY_DSN — (optional) Sentry DSN for error reporting
- NEXT_PUBLIC_ANALYTICS_ID — (optional) Analytics provider ID
- AI_SERVICE_ENDPOINT — (required) Internal AI foundation service endpoint
- AI_SERVICE_API_KEY — (required) Key with minimal privileges for AI services
- EMAIL_PROVIDER_DSN — (optional) For account emails / notifications
- TELLER_ORACLE_URL — (optional) Price oracle / external feed
- NODE_ENV — production | development | test

Example .env.local
```
NEXT_PUBLIC_BASE_RPC_URL=https://mainnet.base.org
NEXT_PUBLIC_APP_URL=https://app.mpgrhub.com
MPGR_B20_CONTRACT_ADDRESS=0xYourTokenAddressHere
MPGR_STAKING_CONTRACT_ADDRESS=0xYourStakingAddressHere
DATABASE_URL=postgres://user:pass@db:5432/mpgr
REDIS_URL=redis://redis:6379
AI_SERVICE_ENDPOINT=https://ai-service.internal
AI_SERVICE_API_KEY=super-secret-key
SENTRY_DSN=
```

Contributing (improved)
We welcome contributors — follow these steps to make high-quality contributions:
1. Read CODE_OF_CONDUCT.md and CONTRIBUTING.md in repo root.
2. Create an issue to discuss major changes before implementing.
3. Fork -> branch naming: feat/<short-desc>, fix/<short-desc>, chore/<short-desc>
4. Commit messages: Conventional Commits (feat, fix, chore, docs, test, refactor)
5. Add tests for new features; all CI checks must pass.
6. Run linters & formatters:
   - pnpm lint
   - pnpm format
7. PR guidelines:
   - Link related issue
   - Include screenshots or recording for UI changes
   - Provide migration steps if applicable
   - Add reviewers & label PRs (feature, bug, security)
8. Maintainers reserve the right to request changes to meet production standards.

Security
- Responsible Disclosure: Open a GitHub Security Advisory or email security@mpgrhub.com (PGP available in SECURITY.md) for vulnerabilities.
- Critical flows subject to audits: staking, token-lock, buyback, AI execution.
- Secrets: never commit private keys, API keys, or credentials. Use environment variables or secret stores.
- Signing & Execution: All onchain-critical transactions should pass governance rules and multi-sig sign-off where applicable.
- Emergency Response: We maintain a runbook for incidents, and will notify stakeholders via the configured onchain & offchain channels.

Testing & QA
- Unit tests with high coverage for business-critical modules (token accounting, staking math, reward allocation)
- Integration tests for RPC interactions (mocked or testnet)
- E2E for user flows (Wallet connect, staking, reward claims)
- Load testing for background queue and refresh manager (simulate large holder counts and heavy refresh cycles)

Governance & Audits
- Governance primitives planned for later phases
- Smart-contract audit schedule: critical financial contracts before mainnet-wide campaign launches
- Keep audit reports and remediation in /security or /audits directory

Licensing
- See LICENSE file in repository root for license details.

Acknowledgements
- Base Network & developer community
- Wagmi, RainbowKit, Viem for wallet and RPC utilities
- Contributors and partners building toward an open AI-onchain ecosystem

Support & Contact
- Issues: https://github.com/munazir17/MPGR-HUB/issues
- Discussions: enable GitHub Discussions for community Q&A
- Security: https://github.com/munazir17/MPGR-HUB/security or security@mpgrhub.com

Maintainer
- Organization / Owner: munazir17

Thank you for building with MPGR HUB — an AI-first, onchain operating system for Base.