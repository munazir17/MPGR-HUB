---
pdf_options:
  format: A4
  printBackground: true
  margin:
    top: 22mm
    bottom: 22mm
    left: 18mm
    right: 18mm
stylesheet: docs/whitepaper.css
body_class: whitepaper
---

<div class="cover">

# MPGR HUB

**MoneyPaiger · $MPGR**

### Play. Trade. Earn. With AI.

An onchain operating system for agents, payments, games, and holder utility — built natively on **Base**, the Coinbase L2.

**Whitepaper**  
Version 2.0 · September 2026  
Public product documentation

https://mpgrhub.xyz  
Contract: `0xB2000000000000000000008d204203177a78AF01`

</div>

<div class="disclaimer-box">

**Disclaimer.** This document is informational. MPGR HUB provides technology services. It does **not** provide financial, investment, legal, or trading advice. $MPGR is a utility token on Base. Nothing in this paper is an offer to sell or a solicitation to buy securities. Digital assets are volatile. Do your own research. Past performance is not indicative of future results.

</div>

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Vision and mission](#2-vision-and-mission)
3. [Why Base and Coinbase](#3-why-base-and-coinbase)
4. [The product](#4-the-product)
5. [The MPGR Agent](#5-the-mpgr-agent)
6. [Trade, tokenized stocks, and x402](#6-trade-tokenized-stocks-and-x402)
7. [Play, XP, and seasons](#7-play-xp-and-seasons)
8. [Onchain utility](#8-onchain-utility)
9. [Tokenomics](#9-tokenomics)
10. [Architecture and stack](#10-architecture-and-stack)
11. [Security model](#11-security-model)
12. [Roadmap](#12-roadmap)
13. [Governance](#13-governance)
14. [Official references](#14-official-references)
15. [Legal](#15-legal)

---

## 1. Executive summary

**MoneyPaiger ($MPGR)** is a fixed-supply token on **Base** (Coinbase’s Ethereum Layer 2). **MPGR HUB** is the product built around it: a Base-native application where people talk to an AI agent, research and prepare onchain actions, play **MPGR Run**, earn XP and season points, stake and lock $MPGR, and claim rewards from a vault.

The thesis is simple and public:

> Token → app → AI → payments → autonomous onchain activity.

MPGR HUB is not a ticker with a landing page. It is a shipping product on [mpgrhub.xyz](https://mpgrhub.xyz), deployed from GitHub (`munazir17/MPGR-HUB`) to Vercel, on **Base mainnet only** (chain ID `8453`).

**What is live today**

| Capability | Status |
|---|---|
| $MPGR token on Base | Live |
| Wallet connect (RainbowKit, Coinbase Wallet, Farcaster Mini App) | Live |
| MPGR Agent (research, reason, prepare; user signs) | Live |
| Coinbase CDP Trade API + 0x fallback (BYO wallet) | Live |
| Coinbase B20 tokenized-stock research + Aerodrome Slipstream path | Live (prepare / confirm) |
| x402 payment proposals | Live (prepare / confirm) |
| MPGR Run + XP, seasons, leaderboard, check-in, referrals | Live |
| Staking, token lock, reward vault clients | Live on Base |
| SIWE sessions, server XP ledger | Live |

**What is not claimed as finished**

Independent third-party contract audit, fully enabled competitive *financial* game payouts (operator-gated), and onchain DAO governance. Those are documented as next work, not as current production guarantees.

---

## 2. Vision and mission

### Vision

Build the leading **AI-powered onchain operating system on Base**.

A place where a user can:

- talk to an agent that understands wallet and market context,
- research tokenized stocks and Base markets,
- prepare a trade, transfer, or payment,
- confirm it in their own wallet,
- play, earn, stake, and belong to a season,

without leaving Base.

### Mission

Reward **real users**, **builders**, and **contributors**. Prefer long-term utility over short-term hype. Keep the token supply fixed. Fund rewards from a community treasury, not from inflation.

### Brand

| | |
|---|---|
| Token name | MoneyPaiger |
| Symbol | $MPGR |
| Product | MPGR HUB |
| Tagline | Play. Trade. Earn. With AI. |
| Network | Base (Coinbase L2) |
| Website | https://mpgrhub.xyz |
| X | [@Moneypaiger](https://x.com/Moneypaiger) |

Official public positioning (August–September 2026):

- “We’re not just building another token — we’re building an onchain product stack around it.”
- “Base is the foundation. $MPGR is the ecosystem.”
- “Finance runs on Base. Culture moves with $MPGR.”
- “The distribution flywheel is getting real. X → Coinbase → Base → onchain.”

---

## 3. Why Base and Coinbase

MPGR HUB is **Base-native by design**. There is no multi-chain runtime today.

**Base** is Coinbase’s Ethereum Layer 2: low fees, fast finality, Ethereum security assumptions, and the distribution surface of Coinbase, Coinbase Wallet, and Base App.

MPGR HUB uses that stack on purpose:

| Layer | How MPGR HUB uses it |
|---|---|
| **Base mainnet** | Sole production chain (`8453`) |
| **Coinbase Wallet / Base App** | First-class wallet path; $MPGR is tradable on Base App |
| **Coinbase CDP Trade API** | Onchain swaps (ETH / WETH / USDC / MPGR / Base ERC-20), BYO wallet |
| **Coinbase tokenized stocks (B20)** | Research + Aerodrome Slipstream USDC pools; no retail mint API |
| **USDC on Base** | Settlement asset for swaps, x402, and agentic payments |
| **Farcaster Mini App** | In-app distribution on the Base / Farcaster social graph |
| **Vercel** | Production host, GitHub-connected |

The agent never custodially trades a Coinbase brokerage account. Swaps are **bring-your-own-wallet**: the protocol prepares; the user’s wallet signs.

This matches Coinbase’s B20 direction — “everything will be tokenized on Base” — without pretending MPGR HUB is an authorized participant or a broker-dealer.

---

## 4. The product

MPGR HUB is a three-surface application:

### Home — the Agent

Home **is** the MPGR Agent. There is no separate Agent tab. The user greets an always-on command center: status, suggested prompts, conversation, and shortcuts into Research, Trade, Portfolio, and Rewards.

### Rewards — play and progression

Rewards is the hub for **MPGR Run**, XP, level, streak, season, season pass, leaderboard, achievements, $MPGR rewards, and onchain claims. MPGR Run is the flagship game. Placeholder / coming-soon games are not shown in production UI.

### Profile — account control

Wallet, SIWE session, preferences (daily check-in), referral, activity, holder tier, help, and sign-out. Community socials live in the footer (X, Telegram, Discord, GitHub), not as a second social graph inside Profile.

### Always-on rails

RainbowKit connect, Base-only network, SIWE session cookies, and a compact footer: socials, Buy $MPGR, legal pages, © 2026, and the financial-advice disclaimer.

---

## 5. The MPGR Agent

The Agent is the center of MPGR HUB.

**Loop (enforced in code, not only in a prompt):**

understand → research → reason → plan → **confirm** → execute → verify

The model may **suggest**. Deterministic tools **decide** whether an action is allowed. The Agent **prepares** transactions. The **user wallet signs**. Nothing is auto-broadcast.

### What it can do today

- Research $MPGR, Base markets, and tokenized stocks
- Analyze portfolio / wallet context
- Prepare Base transfers
- Prepare swaps via Coinbase CDP (with 0x fallback)
- Prepare B20 tokenized-stock swaps on Aerodrome Slipstream
- Prepare **x402** payments (machine-to-machine / agentic commerce)
- Route the user into Rewards, Run, staking, and lock flows
- Fall back to an on-device deterministic engine if a network model fails

### Provider policy

Network AI (Gemini by default, with other providers available in configuration) is untrusted text. Tool arguments are validated. Write tools declare risk and require confirmation. Secrets never ship as `NEXT_PUBLIC_`.

Coinbase **AgentKit** is used in **prepare-only** mode.

---

## 6. Trade, tokenized stocks, and x402

MPGR HUB does not invent a DEX, a stock mint API, or a custodial broker.

### Regular tokens — Coinbase CDP Trade API

- Quote and price via Coinbase Developer Platform on network `base`
- Execution: user signs (Permit2 / approve as required)
- Quotes older than 30 seconds are refreshed; a worse `minToAmount` aborts
- If CDP rejects a token, **0x Swap API v2** on Base is tried next
- Used for ETH / WETH / USDC / MPGR / ordinary Base ERC-20
- **Not** used for Coinbase B20 tokenized stocks

### Tokenized stocks — Coinbase B20 on Base

- Product: Coinbase tokenized stocks on Base
- Spec: Base B20 tokenized-stocks specification
- Holding and secondary-market trading are permissionless
- Primary mint/redeem is Authorized Participant only — **MPGR HUB implements no retail mint**
- Buy/sell in-app = a single-hop **Aerodrome Slipstream** USDC pool swap
- Chainlink Coinbase equity feeds are used as published (no double-counting the multiplier)

### x402

x402 is the payment protocol path for agentic / machine-to-machine commerce. The Agent can construct a payment **proposal**. The user reviews amount, destination, and asset, then confirms in-wallet. No silent payment.

---

## 7. Play, XP, and seasons

### MPGR Run

The live flagship game: a one-tap endless runner using the official MPGR character art. Sessions are **server-issued**, with heartbeats and verification gates. Weekly stats and leaderboard identity are bound to the authenticated wallet.

Competitive **financial** game rewards stay **disabled by default** (`GAME_REWARDS_ENABLED=false`) until authoritative verification is operator-complete. XP and season progression still run.

### Progression

- Server-owned XP ledger (browser XP is a cache, not proof)
- Levels, streaks, daily check-in
- Season points and monthly seasons
- Season Pass track
- Achievements
- Referrals (authenticated; sybil resistance is still being hardened)
- Global leaderboard from the server rank, not a client score

Coming-soon titles (Clicker, Memory, Space Shooter, and others) exist in an internal registry for future shipping. They are **not** presented as live games.

---

## 8. Onchain utility

All of the following are Base mainnet contracts, wired through Viem/Wagmi. Rewards are funded from the community treasury. **No new $MPGR is minted.**

| Contract | Address | Role |
|---|---|---|
| **$MPGR token** | `0xB2000000000000000000008d204203177a78AF01` | Fixed-supply ERC-20 / B20-era token |
| **Staking** | `0x1690C7b6d312284e30434d93498e56eE09fFa12c` | Stake / unstake / claim |
| **Token lock** | `0x0cb910b19b9d0ab772375a0b2e49b84ccdd51550` | Time-lock; 10% on-chain early-unlock penalty |
| **Reward vault** | `0xbe4B0e8692670229129562a50A62f5173E30937C` | Allocated claims on Base |

Explorer: [basescan.org](https://basescan.org).

**Holder score / tiers** remain as onchain-adjacent reputation. A paid Premium *subscription* is **not** part of the current product UI.

**Buy $MPGR:** Base App / Coinbase Wallet, and the official launch listing:

https://launch.o1.exchange/token/0xB2000000000000000000008d204203177a78AF01?chain=8453

---

## 9. Tokenomics

Official parameters published with the project (GitHub `docs/TOKENOMICS.md` and @Moneypaiger).

| Parameter | Value |
|---|---|
| Name | MoneyPaiger |
| Symbol | MPGR |
| Network | Base |
| Maximum supply | **1,000,000,000** MPGR |
| Decimals | 18 |
| Inflation | None |
| Future minting | None |
| Private sale | None |
| VC allocation | None |
| Locked team allocation | None |

### Initial distribution

| Bucket | Amount | Share |
|---|---|---|
| Liquidity pool (Base DEX) | 900,000,000 | 90% |
| Community treasury | 100,000,000 | 10% |
| **Total** | **1,000,000,000** | **100%** |

The 90% LP allocation is already in market liquidity. The 10% treasury funds every MPGR HUB incentive. It is not a hidden team unlock.

### Community treasury (100,000,000 MPGR)

| Program | Allocation | Purpose |
|---|---|---|
| Staking rewards | 30,000,000 | Long-term stakers; live staking emissions |
| Mini games | 15,000,000 | MPGR Run today; future playable titles; weekly competition |
| Community quests | 12,000,000 | Missions, Base campaigns, partner challenges |
| Daily check-in | 10,000,000 | Recurring engagement |
| Seasonal campaigns | 10,000,000 | Season Pass, XP seasons, limited events |
| Referral program | 8,000,000 | Invite-to-earn |
| AI ecosystem rewards | 5,000,000 | Agent participation and future AI incentives |
| Community airdrops | 5,000,000 | Early supporters and campaigns |
| Ecosystem partnerships | 3,000,000 | Base collaborations and integrations |
| Emergency reserve | 2,000,000 | Unforeseen ecosystem needs (future governance) |
| **Treasury total** | **100,000,000** | |

Unused category balances are **not** burned out of existence. Future governance may **reallocate undistributed** treasury between programs. The treasury ceiling stays **100,000,000 MPGR**. The max supply stays **1,000,000,000**.

### Emission policy

Rewards are dynamic against:

- user activity,
- treasury remaining,
- staking participation,
- seasons,
- governance.

No category emits forever. Rates can be slowed to protect the treasury. **All rewards are existing tokens**, never newly minted supply.

### Token utility

$MPGR is the unit of:

- staking yield,
- lock / holder commitment,
- vault claims,
- game and season incentives (when gates are on),
- referral and quest budgets,
- future governance weight,
- the economic surface the Agent operates around (swaps, x402, portfolio).

---

## 10. Architecture and stack

Production stack as implemented in `munazir17/MPGR-HUB`:

| Layer | Choice |
|---|---|
| App | Next.js 15 App Router, React 18, TypeScript, Tailwind CSS |
| Wallets | Wagmi, Viem, RainbowKit, Farcaster Mini App connector |
| Chain | Base mainnet only |
| AI | Gemini (configurable) + deterministic fallback + Coinbase AgentKit (prepare-only) |
| Payments | x402 proposals; USDC on Base |
| Trade | Coinbase CDP Trade API, 0x, Aerodrome Slipstream (B20) |
| Data | Upstash Redis / Vercel KV (sessions, XP, referrals, game allocation) |
| Auth | SIWE, HMAC session cookies |
| CI | GitHub Actions — lint, typecheck, Vitest, Foundry, production build |
| Host | Vercel, connected to GitHub `main` |
| Contracts | Solidity / Foundry (`/contracts`, `/test`) |

Folder map: `app/` pages and APIs, `components/` UI, `hooks/` client, `lib/` domain (auth, XP, games, trade, agent, staking), `contracts/` onchain.

---

## 11. Security model

Non-negotiable rules in `AGENTS.md` and `docs/SECURITY.md`:

1. No private keys, seeds, or secrets in client bundles.
2. A wallet address alone is not authentication. Protected writes need a signed session.
3. Browser XP, score, referral, or rank claims are never trusted as proof.
4. The LLM never executes a wallet write. Parse → tool → validate → simulate → show effect → confirm → **user signs**.
5. Read tools and write tools are separate. Write tools declare risk.
6. APIs validate shape, size, range, and authorization.
7. Token amounts are integer / bigint. No floating-point accounting.
8. Chain ID, addresses, decimals, and ABIs live in one typed registry (`lib/chain/base.ts`).
9. Game financial settlement is **fail-closed** without operator gates and a verifier.
10. Independent audit and production funding review remain **open items**.

If you find a vulnerability, use a private GitHub Security Advisory. Do not file a public exploit issue.

---

## 12. Roadmap

Status below is **honest against the running product** (September 2026), not a marketing slide.

### Live now

- $MPGR on Base; LP in market
- MPGR HUB on Vercel / GitHub
- Wallet, SIWE, Base-only
- MPGR Agent with confirmation-gated tools
- CDP / 0x swaps; B20 research + Slipstream path
- x402 proposals
- MPGR Run, XP, seasons, leaderboard, check-in, referrals
- Staking, lock, reward vault UIs against deployed contracts
- Farcaster Mini App connector
- CI and Foundry tests

### Hardening (in flight)

- Authoritative MPGR Run verification and anti-cheat beyond heartbeats
- Enablement review for financial game rewards
- Referral sybil resistance
- Vault-level settlement idempotency
- Independent smart-contract audit
- Performance and production-funding review

### Next

- Community governance (proposals, treasury, emissions)
- Additional *playable* games (only when actually shipped)
- Broader AI marketplace incentives (from the 5M AI treasury line)
- Public SDK / partner integrations
- Mobile wrapper
- Cross-chain — **not** in the current runtime; Base remains the home chain

Premium *subscription* UI is intentionally out of the product. Holder utility and lock remain.

---

## 13. Governance

Governance is **planned**, not live as a DAO.

When it ships, the intended scope is:

- treasury reallocation **within** the 100M cap,
- emission rates,
- campaign budgets,
- partnership incentives,
- emergency reserve use.

Until then, operators ship in public (GitHub `main`, Vercel, X @Moneypaiger) and keep the fixed-supply / no-VC / no-team-unlock commitments as the constitutional constraints.

---

## 14. Official references

| Resource | Location |
|---|---|
| App | https://mpgrhub.xyz |
| Token (Base) | `0xB2000000000000000000008d204203177a78AF01` |
| Staking | `0x1690C7b6d312284e30434d93498e56eE09fFa12c` |
| Token lock | `0x0cb910b19b9d0ab772375a0b2e49b84ccdd51550` |
| Reward vault | `0xbe4B0e8692670229129562a50A62f5173E30937C` |
| Buy | Coinbase Wallet / Base App / o1.exchange listing |
| GitHub | https://github.com/munazir17/MPGR-HUB |
| X | https://x.com/Moneypaiger |
| Telegram | https://t.me/+K3HMNmx1PpQ3MjY1 |
| Discord | https://discord.gg/gxpv5vTE |
| Explorer | https://basescan.org |
| Tokenomics source | `docs/TOKENOMICS.md` |
| Architecture | `docs/ARCHITECTURE.md` |
| Security | `docs/SECURITY.md` |
| Trade / B20 / x402 | `docs/TRADE.md` |

---

## 15. Legal

MPGR HUB, MoneyPaiger, and $MPGR are product and token names of the MPGR project. Base, Coinbase, Coinbase Wallet, Coinbase Developer Platform, USDC, Farcaster, Vercel, Aerodrome, and 0x are trademarks of their respective owners. Mention does not imply partnership, endorsement, or agency unless a separate agreement says so.

This whitepaper may be updated. Version **2.0** reflects the product as of **September 2026**.

© 2026 MPGR HUB. All rights reserved.

*Play. Trade. Earn. With AI.*
