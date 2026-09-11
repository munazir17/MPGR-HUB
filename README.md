# MPGR HUB
AI-powered Onchain Operating System on Base

[![Build Status](https://github.com/munazir17/MPGR-HUB/actions/workflows/ci.yml/badge.svg)](https://github.com/munazir17/MPGR-HUB/actions) [![Repo size](https://img.shields.io/github/repo-size/munazir17/MPGR-HUB)](https://github.com/munazir17/MPGR-HUB) [![Top Language](https://img.shields.io/github/languages/top/munazir17/MPGR-HUB?logo=typescript)](https://github.com/munazir17/MPGR-HUB) [![Last Commit](https://img.shields.io/github/last-commit/munazir17/MPGR-HUB)](https://github.com/munazir17/MPGR-HUB/commits/main) [![GitHub Stars](https://img.shields.io/github/stars/munazir17/MPGR-HUB?style=social)](https://github.com/munazir17/MPGR-HUB/stargazers)

---

Next.js App Router product on Base mainnet (`8453`): wallet session, token/staking/lock/vault UIs, an AI agent with deterministic tools, MPGR Run, and server-owned XP/referral ranking.

## Current status

- Implemented: wallet connect (RainbowKit/Wagmi/Viem), SIWE sessions, server XP ledger, authenticated referrals, MPGR Run with server-issued sessions + heartbeats, AI/AgentKit/x402/trade routes with request guards, Foundry contract tests, npm CI.
- Partial: game-run authority (client stats + heartbeat/timing gates, not cryptographic anti-cheat), settlement exactly-once (lock + reconcile; vault has no idempotency key), referral sybil resistance, dependency-advisory cleanup.
- Not implemented in this repository: Docker/docker-compose, pnpm workspace, BullMQ workers, Prometheus/Grafana, Postgres `DATABASE_URL`, a root `CODE_OF_CONDUCT.md`, or a `/modules` folder layout.
- Financial game rewards stay **disabled by default**. Do not describe them as production-ready.

See `docs/SECURITY_REMEDIATION.md` and `docs/FINAL_REMEDIATION_VERIFICATION.md`.

## What is implemented

- Wallet Connect / RainbowKit on Base mainnet
- Live MPGR token, staking, token-lock, and reward-vault clients
- Dashboard, holder tiers, XP/achievements UI (XP totals are server-ledger; some UX fields remain local cache)
- MPGR Run, leaderboard sourced from the server XP rank, daily check-in, referral capture
- AI agent: server-owned policy, request limits, deterministic tools, prepare-only AgentKit, user-wallet signing
- Trade quotes bound to the authenticated session wallet
- CI: `npm ci`, lint, typecheck, unit tests, production build, high-severity audit script, Foundry tests

## Technology stack (actual)

- Next.js 15 App Router, React 18, TypeScript strict, Tailwind CSS
- Wagmi + RainbowKit + Viem
- Base mainnet only
- Upstash Redis / Vercel KV for sessions, XP, referrals, game allocation
- Vitest for unit tests, Foundry for Solidity tests
- npm (Node 20). There is no pnpm lockfile and no Docker setup here.

## Local development

Use Node 20:

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Quality commands:

```bash
npm run lint
npm run typecheck
npm test
npm run check
npm run build
```

Contract tests (requires Foundry and the pinned clones under `.forge-deps/` used by CI):

```bash
forge test -vvv
```

Environment variables are listed in `.env.example`. Required for authenticated writes: `AUTH_SESSION_SECRET`, `APP_ORIGIN`, and Redis (`UPSTASH_REDIS_*` or `KV_REST_API_*`). Real-value game settlement also needs `CRON_SECRET`, `REWARD_MANAGER_PRIVATE_KEY`, and an authoritative verifier. Leave `GAME_REWARDS_ENABLED` and `GAME_AUTHORITATIVE_VERIFICATION_ENABLED` unset/false unless those gates are actually deployed.

## Deployment

Vercel is the supported host (`vercel.json` exists). Connect the GitHub repo, set the server secrets from `.env.example`, and deploy from `main`.

There is no first-party Dockerfile or docker-compose in this repository. Claims about HSM/KMS, Prometheus, or a background worker fleet are roadmap, not current runtime.

## Folder map (this repo)

- `/app` — App Router pages and API routes
- `/components` — UI
- `/hooks` — client hooks
- `/lib` — domain logic (auth, XP ledger, games, trade, agent, staking)
- `/contracts` and `/test` — MPGRStaking + Foundry tests
- `/docs` — architecture, security, runbooks
- `/.github/workflows` — `ci.yml` plus a manual `debug-build.yml`

## Security

- Signed wallet sessions; user writes take the wallet from the session, not JSON.
- Browser XP/score/referral fields are not trusted for ranking or rewards.
- Game financial settlement is fail-closed without both operator gates and a verifier.
- Report vulnerabilities privately (GitHub Security Advisory). Do not file public issues for exploit details.

## Honest remaining gates

These are **not** done and must not be marked fixed:

1. Independent smart-contract audit and production funding review
2. Real replay/anti-cheat for MPGR Run (heartbeats are a liveness signal, not proof of play)
3. Referral sybil identity
4. Vault-level settlement idempotency or a durable outbox
5. Full 204MB game-art conversion (only lossless PNG work has been done)
6. Split of `RunGame.tsx` (physics helpers were extracted; the component is still large)

## Licensing

Split licensing — see root `LICENSE`:

- MIT for `/contracts/` and `/test/`
- All Rights Reserved for everything else

## Support

- Issues: https://github.com/munazir17/MPGR-HUB/issues
- Maintainer: munazir17
