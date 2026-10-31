// lib/content/roadmap.ts
//
// Single source of truth for the public Roadmap page.
//
// Status vocabulary is deliberately coarse and honest:
//
//   LIVE               — shipped and reachable in the running product
//   IN PROGRESS        — underway; partially shipped or being hardened
//   PLANNED            — intended next work, not shipped, no date promised
//   LONG-TERM VISION   — directional; may never ship in this exact form
//
// Rules when editing:
//   * Do not label anything LIVE unless a route, engine or deployed
//     contract in this repository actually implements it.
//   * Do not invent dates, partners, allocations or launch commitments.
//   * Each track id is a stable anchor on /roadmap and is linked from
//     /docs, /whitepaper, /about and /support — renaming one is a
//     breaking documentation change.

export type RoadmapStatus = "LIVE" | "IN PROGRESS" | "PLANNED" | "LONG-TERM VISION";

export interface RoadmapItem {
  label: string;
  status: RoadmapStatus;
}

export interface RoadmapTrack {
  /** Stable anchor id on /roadmap. */
  id: string;
  title: string;
  summary: string;
  items: readonly RoadmapItem[];
}

export const ROADMAP_STATUS_ORDER: readonly RoadmapStatus[] = [
  "LIVE",
  "IN PROGRESS",
  "PLANNED",
  "LONG-TERM VISION",
];

export const ROADMAP_TRACKS: readonly RoadmapTrack[] = [
  {
    id: "ai-agent",
    title: "AI Agent",
    summary:
      "The MPGR Agent on Home: research, reason and prepare onchain actions, with every write confirmed by the user.",
    items: [
      { label: "Agent workspace on Home — chat, status, prompt suggestions, live Base market tape", status: "LIVE" },
      { label: "Intent detection against a closed intent list with deterministic replies", status: "LIVE" },
      { label: "Smart actions and follow-up prompts derived from live account context", status: "LIVE" },
      { label: "Prepare-only proposals: Base transfer, swap, B20 order, x402 payment", status: "LIVE" },
      { label: "Deterministic fallback engine when every network provider fails", status: "LIVE" },
      { label: "Broader tool coverage and richer multi-step research answers", status: "IN PROGRESS" },
      { label: "Persistent, user-controlled agent memory across sessions", status: "PLANNED" },
      { label: "Long-horizon personal agent that plans across sessions inside user-set limits", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "agent-autonomy",
    title: "Autonomous & onchain agent permissions",
    summary:
      "What the Agent is allowed to do on its own — today, nothing that moves value.",
    items: [
      { label: "Every value-moving action requires explicit confirmation and a wallet signature", status: "LIVE" },
      { label: "No autonomous execution path; AgentKit signing and auto-payment actions denied server-side", status: "LIVE" },
      { label: "Prepare-only AgentKit configuration on Base mainnet with a read-action allowlist", status: "LIVE" },
      { label: "User-configurable spend caps and per-action allowance limits", status: "PLANNED" },
      { label: "Policy profiles — read-only, prepare-only, bounded-execute", status: "PLANNED" },
      { label: "Delegated, revocable agent permissions with onchain-enforceable budgets", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "research-portfolio",
    title: "Research & portfolio intelligence",
    summary:
      "Read-only facts the Agent can retrieve and reason over — from Base, from MPGR contracts and from the app's own ledgers.",
    items: [
      { label: "Wallet, token, portfolio and Base research tools", status: "LIVE" },
      { label: "$MPGR market endpoint, with explicit DATA_UNAVAILABLE instead of invented prices", status: "LIVE" },
      { label: "Yield tools normalised from live MPGR staking on-chain data", status: "LIVE" },
      { label: "Coinbase B20 tokenized-stock research and contract verification", status: "LIVE" },
      { label: "Deeper portfolio analytics and history surfaced through the Agent", status: "IN PROGRESS" },
      { label: "Watchlists, alerts and additional market data providers", status: "PLANNED" },
      { label: "Research copilot with saved theses, scenarios and cited sources", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "trading-execution",
    title: "Trading & execution",
    summary:
      "Swaps and tokenized-stock orders on Base, always prepared and confirmed before anything is signed.",
    items: [
      { label: "Coinbase CDP Trade API with a 0x Swap API fallback", status: "LIVE" },
      { label: "B20 tokenized-stock orders through Aerodrome Slipstream USDC pools", status: "LIVE" },
      { label: "Slippage bounds, quote freshness, risk facts and receipt verification", status: "LIVE" },
      { label: "Quotes bound to the authenticated session wallet", status: "LIVE" },
      { label: "Limit orders, recurring buys and scheduled execution — all confirm-gated", status: "PLANNED" },
      { label: "Price alerts and execution analytics", status: "PLANNED" },
      { label: "Strategy layer where the Agent proposes rule-based execution you approve", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "smart-actions",
    title: "Smart actions & automation",
    summary:
      "Turning an answer into the next correct step, without ever letting a model choose a destination.",
    items: [
      { label: "Context-aware action cards, highlight chips and follow-up prompts", status: "LIVE" },
      { label: "Closed navigation whitelist — the model selects an intent, never a route string", status: "LIVE" },
      { label: "Multi-step action plans (research → prepare → confirm) in one flow", status: "PLANNED" },
      { label: "User-authored automations with explicit budgets and an audit trail", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "ai-provider",
    title: "AI provider abstraction",
    summary:
      "A pluggable provider stack with a deterministic safety net, so no single model is a single point of failure.",
    items: [
      { label: "Provider interface with Gemini (default), NVIDIA NIM and OpenAI implemented", status: "LIVE" },
      { label: "Deterministic on-device fallback provider", status: "LIVE" },
      { label: "Task-based routing, guardrails, timeouts, circuit breaker and diagnostics", status: "LIVE" },
      { label: "Prompt/output budgets and a daily AI token budget", status: "LIVE" },
      { label: "Anthropic and self-hosted providers behind the same interface", status: "PLANNED" },
      { label: "Per-task provider selection with cost and quality telemetry", status: "PLANNED" },
      { label: "Open provider marketplace where third-party models register behind the guardrail stack", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "agent-economy",
    title: "Agent-to-agent economy",
    summary:
      "Agents that can be paid for work — and eventually pay each other — inside limits a human set.",
    items: [
      { label: "Users can pay x402-enabled resources through the Agent with explicit confirmation", status: "LIVE" },
      { label: "Metered agent usage and MPGR-addressable agent services", status: "PLANNED" },
      { label: "Agents that discover, quote and pay each other with user-set budgets and receipts", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "x402",
    title: "x402 & agentic payments",
    summary:
      "The payment rail for machine-to-machine commerce, scoped hard to Base and to explicit consent.",
    items: [
      { label: "x402 discovery, server-registered terms, confirm, EIP-3009 sign, bound submission", status: "LIVE" },
      { label: "Base mainnet only, exact scheme only, known-asset EIP-712 domain required", status: "LIVE" },
      { label: "No silent payment — AgentKit auto-payment actions are denied server-side", status: "LIVE" },
      { label: "Wider resource compatibility and clearer failure messaging", status: "IN PROGRESS" },
      { label: "Receipt history and exportable payment records", status: "PLANNED" },
      { label: "Recurring / subscription-style payments behind explicit caps", status: "PLANNED" },
      { label: "MPGR HUB as an agentic-payment gateway for Base services", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "marketplace",
    title: "AI & service marketplace",
    summary:
      "A registry where models, tools and services can be listed, priced and paid for.",
    items: [
      { label: "Tool registry with schema, risk level, timeout and confirmation requirements", status: "LIVE" },
      { label: "Listing schema and pricing for third-party models, tools and services", status: "PLANNED" },
      { label: "Reputation and ratings derived from verified usage", status: "PLANNED" },
      { label: "AI / service marketplace with x402-metered access, funded from the AI ecosystem treasury line", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "gaming",
    title: "Gaming ecosystem",
    summary:
      "A registry-driven games hub. Titles ship only when their route actually exists.",
    items: [
      { label: "Games hub with a registry-driven catalog", status: "LIVE" },
      { label: "Coming-soon titles clearly labelled, never presented as playable", status: "LIVE" },
      { label: "Additional playable titles (Clicker, Memory Challenge, Space Shooter, 2048 Daily and others)", status: "PLANNED" },
      { label: "Shared progression: XP, season points and campaigns across games", status: "PLANNED" },
      { label: "Multiplayer modes, tournaments and cross-game seasons", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "mpgr-run",
    title: "MPGR Run",
    summary:
      "The flagship title: server-issued sessions, authoritative replay verification, and financial payouts kept fail-closed.",
    items: [
      { label: "Playable endless runner with server-issued sessions and heartbeats", status: "LIVE" },
      { label: "In-process deterministic authoritative replay — seed plus input trace replayed tick-for-tick", status: "LIVE" },
      { label: "Drift-tolerant timing checks, rate and idempotency gates", status: "LIVE" },
      { label: "8 XP per completed run, capped at 10 XP-earning runs per day", status: "LIVE" },
      { label: "Weekly stats and leaderboard identity bound to the authenticated wallet", status: "LIVE" },
      { label: "Anti-cheat hardening beyond deterministic replay and heartbeat/timing gates", status: "IN PROGRESS" },
      { label: "Enablement review for financial game rewards (two independent operator gates, fail-closed)", status: "IN PROGRESS" },
      { label: "Seasonal game modes and cosmetic progression", status: "PLANNED" },
      { label: "Certified competitive play with real-time leaderboards", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "rewards",
    title: "Rewards & gamification",
    summary:
      "A Reward Hub over real on-chain claims, with the rest of the program surfaced as providers come online.",
    items: [
      { label: "Reward Hub: summaries, categories, claim history, achievements, season preview", status: "LIVE" },
      { label: "On-chain claiming through the deployed MPGRRewardVault (claim / claimMultiple)", status: "LIVE" },
      { label: "Server-owned XP ledger, daily check-in, streaks and levels", status: "LIVE" },
      { label: "Season points on UTC monthly seasons plus a Season Pass reward track", status: "LIVE" },
      { label: "Additional reward providers behind the hub (AI, premium, airdrop)", status: "PLANNED" },
      { label: "Unified earn graph where every product action maps to a transparent reward rule", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "staking",
    title: "Staking",
    summary:
      "Single-sided MPGR staking against the deployed Base contract — no lock term, claim any time.",
    items: [
      { label: "Stake, unstake, claim rewards and exit via MPGRStaking on Base", status: "LIVE" },
      { label: "Live APR, total staked and pool state with short cache TTLs", status: "LIVE" },
      { label: "Staking history with progressive backward backfill", status: "LIVE" },
      { label: "Backfill performance work within provider-tier RPC limits", status: "IN PROGRESS" },
      { label: "Additional pools and richer staking analytics", status: "PLANNED" },
      { label: "Governance-directed emission schedules", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "token-lock",
    title: "Token lock",
    summary:
      "Time-locked MPGR on the immutable V1 contract — the commitment primitive behind Premium and Holder Score.",
    items: [
      { label: "createLock / withdraw / earlyUnlock against MPGRTokenLock V1 on Base", status: "LIVE" },
      { label: "Fixed 10% on-chain early-unlock penalty, computed and executed by the contract", status: "LIVE" },
      { label: "Locked MPGR drives Premium tier and Holder Score", status: "LIVE" },
      { label: "Lock analytics and lock-based campaigns", status: "PLANNED" },
      { label: "Lock-weighted governance power", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "token-utility",
    title: "Token utility & governance",
    summary:
      "What $MPGR does today, and what governance could add later — without changing the fixed supply.",
    items: [
      { label: "Staking yield, lock / holder commitment, vault claims", status: "LIVE" },
      { label: "Game and season incentives when the operator gates are on", status: "LIVE" },
      { label: "Referral and quest budgets; the economic surface the Agent operates around", status: "LIVE" },
      { label: "Community governance — treasury reallocation within the 100M cap, emission rates, campaign budgets, emergency reserve", status: "PLANNED" },
      { label: "Onchain proposal lifecycle with voting weight from Holder Score", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "quests-referrals-leaderboards",
    title: "Quests, referrals & leaderboards",
    summary:
      "Progression surfaces that must stay honest — so ranking and attribution are server-owned.",
    items: [
      { label: "Authenticated referrals with self-referral blocking and abuse logging", status: "LIVE" },
      { label: "Global leaderboard sourced from the server ranking, never a client score", status: "LIVE" },
      { label: "Campaigns: config-driven events with their own points ledger and leaderboard", status: "LIVE" },
      { label: "Referral sybil resistance", status: "IN PROGRESS" },
      { label: "Richer quest engine with onchain and offchain verification", status: "PLANNED" },
      { label: "Reputation graph with sybil-resistant identity", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "base-expansion",
    title: "Base ecosystem expansion",
    summary:
      "Base is the home chain. There is no multi-chain runtime today and none is promised.",
    items: [
      { label: "Base mainnet only (8453) across every tool, contract and route", status: "LIVE" },
      { label: "Coinbase CDP Trade API, B20 via Aerodrome Slipstream, USDC on Base", status: "LIVE" },
      { label: "Farcaster Mini App connector and Basename resolution", status: "LIVE" },
      { label: "Deeper Base ecosystem campaigns and integrations", status: "IN PROGRESS" },
      { label: "More Base-native protocols behind the same prepare / confirm boundary", status: "PLANNED" },
      { label: "Base-first onchain operating system; cross-chain remains out of the current runtime", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "security-audit",
    title: "Security, auditing & reliability",
    summary:
      "What is already enforced in code, and the independently verified guarantees still missing.",
    items: [
      { label: "SIWE sessions, HMAC session cookies, request guards, rate limits and daily AI budget", status: "LIVE" },
      { label: "Read/write tool separation, risk levels and mandatory confirmation", status: "LIVE" },
      { label: "Sanitized errors — no raw provider, RPC, Redis or stack-trace output to clients", status: "LIVE" },
      { label: "CI: lint, typecheck, unit and security tests, high-severity audit script, Foundry contract tests, production build", status: "LIVE" },
      { label: "Fail-closed game settlement without both operator gates", status: "LIVE" },
      { label: "Independent smart-contract audit", status: "IN PROGRESS" },
      { label: "Vault-level settlement idempotency or a durable outbox", status: "IN PROGRESS" },
      { label: "Performance and production-funding review", status: "IN PROGRESS" },
      { label: "Public bug bounty and recurring audits", status: "PLANNED" },
      { label: "Continuous onchain monitoring with automated circuit breakers", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "developer-api",
    title: "Developer / API / integration ecosystem",
    summary:
      "Opening the modules that already exist, without weakening the boundaries that make them safe.",
    items: [
      { label: "Internal API surface for market, trade, transfer, x402, XP, referral, leaderboard, campaigns and games", status: "LIVE" },
      { label: "Public GitHub repository with architecture, security and runbook documentation", status: "LIVE" },
      { label: "Public API keys and documented endpoints for partners", status: "PLANNED" },
      { label: "SDK and an embeddable agent surface", status: "PLANNED" },
      { label: "Partner ecosystem building on MPGR HUB modules", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "infrastructure",
    title: "Platform & ecosystem infrastructure",
    summary: "The runtime, the deployment model and the operational maturity work.",
    items: [
      { label: "Next.js App Router on Vercel, GitHub-connected deploys", status: "LIVE" },
      { label: "Redis / KV-backed sessions, XP ledger, referrals, leaderboard and game allocation", status: "LIVE" },
      { label: "Game art optimisation — responsive sizes, lazy loading, preloading", status: "IN PROGRESS" },
      { label: "Mobile wrapper for the responsive web app", status: "PLANNED" },
      { label: "Richer observability and operational runbooks", status: "PLANNED" },
      { label: "Modular service platform with self-hostable components", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "mcp",
    title: "MCP",
    summary:
      "A stateless MCP endpoint that quotes and prepares unsigned Base trades. External chat clients are not a verified live connector.",
    items: [
      { label: "MCP server at POST /api/mcp (Streamable HTTP JSON-RPC) with tool discovery", status: "LIVE" },
      { label: "Unsigned tools: capabilities, token list, quote, prepare, finalize, trade status and verify — the wallet still signs", status: "LIVE" },
      { label: "0.25% Trading Fee shown in capability, quote and /llm.txt responses (25 bps = 25/10000 of the sell token)", status: "LIVE" },
      { label: "Mainnet MCP trading stays off unless MPGR_MCP_ENABLE_BASE_MAINNET is set by the operator", status: "LIVE" },
      { label: "Secure connection notes for external MCP clients (no private keys; user confirms in the wallet)", status: "IN PROGRESS" },
      { label: "ChatGPT connector — not a verified live integration", status: "PLANNED" },
      { label: "Claude and other MCP clients — not a verified live integration", status: "PLANNED" },
      { label: "Portfolio reads and richer market context through MCP", status: "PLANNED" },
      { label: "Third-party MCP apps and an integration marketplace", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "voice-ai",
    title: "Voice-driven AI trading",
    summary:
      "Speech can fill the Agent composer. It cannot sign, broadcast, or skip wallet review.",
    items: [
      { label: "Voice input never signs, never broadcasts, and never sees a private key or seed phrase", status: "LIVE" },
      { label: "Speech-to-text transcript into the existing Agent composer (server ASR plus browser recognition). The site Permissions-Policy currently blocks the microphone, so this is not a finished voice product", status: "IN PROGRESS" },
      { label: "Natural-language buy/sell wording is handled by the existing text composer, not by a separate voice trader", status: "IN PROGRESS" },
      { label: "Text-to-speech replies", status: "PLANNED" },
      { label: "Voice-guided transaction review that speaks the 0.25% Trading Fee, slippage and risks before the wallet prompt", status: "PLANNED" },
      { label: "Spoken portfolio and market answers, still unable to authorize a transaction", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "portfolio-intelligence-2",
    title: "AI Portfolio Intelligence 2.0",
    summary:
      "A later portfolio layer. Today's Agent already has live read-only wallet, staking and MPGR balance tools; this track does not replace those.",
    items: [
      { label: "Allocation and exposure views across Base tokens the wallet already holds", status: "PLANNED" },
      { label: "Performance tracking against executed trade history", status: "PLANNED" },
      { label: "Risk notes that cite the data they used and say when a price is unavailable", status: "PLANNED" },
      { label: "Personalized market briefs that stay read-only until the user asks to prepare a trade", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "autonomous-agent-2",
    title: "Autonomous agent and smart automation 2.0",
    summary:
      "Proposals with limits. Nothing here executes a swap without the wallet. Today every value-moving action still requires an explicit signature.",
    items: [
      { label: "User-defined strategy descriptions the Agent can restate but not run on its own", status: "PLANNED" },
      { label: "Conditional monitoring and smart alerts", status: "PLANNED" },
      { label: "Action proposals with a configurable spending limit shown before signing", status: "PLANNED" },
      { label: "Explicit authorization for every prepared transaction — voice and MCP included", status: "PLANNED" },
      { label: "Bounded unattended execution remains out of the current product", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "x402-marketplace-2",
    title: "x402 agentic payments and AI marketplace 2.0",
    summary:
      "x402 pay-for-resource with wallet confirmation is already live on its own track. This track is the marketplace around it, and it is not live.",
    items: [
      { label: "Agent service discovery beyond the in-app tool registry", status: "PLANNED" },
      { label: "AI provider marketplace listings with prices", status: "PLANNED" },
      { label: "Third-party agent services paid over x402", status: "PLANNED" },
      { label: "Payment and authorization workflows that still require the user to sign", status: "PLANNED" },
      { label: "Open agent-service marketplace funded from the ecosystem treasury line", status: "LONG-TERM VISION" },
    ],
  },
  {
    id: "developer-ecosystem-2",
    title: "MPGR developer and integration ecosystem 2.0",
    summary:
      "The public MCP endpoint and internal APIs exist. A partner SDK and app directory do not.",
    items: [
      { label: "Public MCP tools and /llm.txt integration notes", status: "LIVE" },
      { label: "Developer documentation for quote, prepare and verify", status: "IN PROGRESS" },
      { label: "Documented partner API keys", status: "PLANNED" },
      { label: "Third-party integrations beyond the first-party app", status: "PLANNED" },
      { label: "Partner ecosystem and shared integration marketplace", status: "LONG-TERM VISION" },
    ],
  },
] as const;
