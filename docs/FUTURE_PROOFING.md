# Future-Proofing Guide

This guide keeps MPGR HUB easy to change without building a large framework too early.

## 1. Use clear trust boundaries

Split facts into three groups:

- **Client hints:** UI state, cached XP, game animation state. Useful, but never trusted for value.
- **Server facts:** authenticated events, XP ledger, referral attribution, limits, settlement records.
- **On-chain facts:** balances, claims, allocations, ownership, transaction receipts.

Every type and API response should make the source clear. Do not mix an estimated client value with a confirmed on-chain value under the same field name.

## 2. Add wallet authentication once

Build one signed-session module and reuse it:

1. Server creates a random, one-time nonce.
2. Wallet signs a domain-bound message.
3. Server verifies address, chain, domain, nonce, issued time, and expiry.
4. Server creates a short session.
5. Write routes take the wallet from the session, not request JSON.
6. Nonces are consumed once.

Keep authorization separate from authentication. A valid wallet session does not automatically make someone an admin or reward manager.

## 3. Make rewards event-driven

Use an append-only event ledger:

```text
Event -> verification -> idempotency key -> XP/reward policy -> ledger entry -> derived totals
```

A ledger makes disputes, rollback, anti-abuse, and rule changes manageable. Store the policy version on every award. Never edit totals directly unless a compensating audit entry explains why.

## 4. Refactor by feature

The current folder structure mixes feature code across `app`, `components`, `hooks`, and `lib`. Move gradually, one feature at a time:

```text
modules/
  rewards/
    domain/       pure rules and types
    server/       stores and services
    client/       hooks and UI adapters
    api/          request/response schemas
    tests/
```

Do not perform a whole-repository move. First define public imports, add tests, move one feature, and keep compatibility exports until callers migrate.

### First refactor targets

1. `RunGame.tsx`: simulation, rendering, input, audio, assets, effects, HUD.
2. AI providers: one shared prompt builder and one shared server request guard.
3. XP: separate award policy from storage and React hooks.
4. Contract configuration: one typed chain/address/ABI registry.
5. Redis setup: lazy server-only client factory with health checks.

## 5. Keep AI safe and replaceable

Use this provider-neutral contract:

```text
validated request -> context policy -> provider -> parsed output -> guardrails -> deterministic tools
```

Rules:

- The server owns system policy.
- Client context is data, not instructions.
- Give the model the minimum wallet data needed.
- Version prompts and output schemas.
- Record provider, model, latency, token use, fallback, and request ID without logging sensitive prompt content.
- Set a timeout, retry budget, size limit, token limit, and cost limit.
- Test with malformed JSON, prompt injection, long text, provider timeout, and unavailable tools.
- Keep a deterministic fallback that clearly says when live data is unavailable.

## 6. Design agent tools as capabilities

Each tool should have:

- stable ID and version;
- plain-language purpose;
- strict input and output schema;
- data source and freshness;
- read or write mode;
- risk level;
- timeout and retry policy;
- authorization rule;
- idempotency rule for writes;
- audit event;
- unit tests.

A write tool should support simulation and return an exact preview before confirmation. The wallet, not the model or server, signs user transactions.

## 7. Make multi-chain an adapter, not a rewrite

Do not spread `8453`, addresses, explorers, and RPC URLs through features. Create a typed chain registry. Domain services should accept a chain context. Only enable a chain after contracts, addresses, confirmations, explorer links, token decimals, and tests are configured.

## 8. Treat contracts as a separate product

Add `contracts/` tooling with:

- pinned Solidity and OpenZeppelin versions;
- unit, fuzz, and invariant tests;
- deployment scripts and verified addresses;
- role and upgrade model;
- Slither/static analysis;
- gas snapshots;
- audit reports and remediation;
- pause and incident runbooks.

Important invariants include principal solvency, reward solvency, monotonic accounting checkpoints, no double claim, and user exit availability.

## 9. Improve delivery in small steps

Required CI for every PR:

1. locked install (`npm ci`);
2. lint;
3. typecheck;
4. unit tests;
5. production build;
6. dependency and secret scanning;
7. contract checks when contracts change.

Use branch protection, dependency update automation, CODEOWNERS for contracts/rewards, preview deployments, and a rollback note in risky PRs.

## 10. Add observability before scale

Start with a small set of useful signals:

- request count, status, and latency by route;
- AI provider latency, failure, fallback, and cost;
- RPC failures and rate limits;
- reward submissions rejected by reason;
- settlement status and time stuck;
- on-chain transaction hash and confirmation;
- Redis health and CAS conflicts.

Use structured logs with request IDs. Redact secrets, authorization headers, complete prompts, and sensitive wallet activity.

## 11. Store less personal data

Wallet activity can still be sensitive even if it is public on-chain. Define retention for chat memory, logs, IP/rate-limit keys, and analytics. Namespace memory by wallet and chain. Add clear/delete controls. Never use private chat data for model training without explicit consent.

## 12. Suggested 90-day plan

### Days 1–30: trust and release safety

- signed wallet sessions;
- protect all public writes;
- server XP ledger design;
- distributed AI/API limits;
- required CI and dependency upgrades;
- pause real-value rewards if runs are not authoritative.

### Days 31–60: financial assurance

- Foundry setup and contract invariants;
- settlement reconciliation/outbox design;
- multisig roles and runbooks;
- reward/referral/leaderboard integration tests;
- external audit preparation.

### Days 61–90: maintainability and scale

- split `RunGame.tsx` behind tests;
- shared AI prompt policy;
- typed chain registry;
- asset optimization;
- production metrics and alerts;
- README/status cleanup.

## Avoid these mistakes

- Do not do a full rewrite.
- Do not add microservices before the single app has clear module boundaries.
- Do not use blockchain writes as a replacement for basic server authentication.
- Do not let an LLM become the security policy engine.
- Do not call browser validation anti-cheat.
- Do not run forced dependency upgrades without tests.
- Do not promise production readiness before evidence supports it.
