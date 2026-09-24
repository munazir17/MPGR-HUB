import type { Metadata } from "next";

import { InfoPageShell } from "@/components/layout/InfoPageShell";
import {
  Callout,
  Code,
  DataTable,
  InfoSection,
  InfoSub,
  LI,
  LinkGrid,
  P,
  Strong,
  TLink,
  UL,
  type TocItem,
} from "@/components/layout/info-ui";
import {
  CHAIN_ID,
  MPGR_REWARD_VAULT_ADDRESS,
  MPGR_STAKING_ADDRESS,
  MPGR_TOKEN_ADDRESS,
  MPGR_TOKEN_LOCK_ADDRESS,
} from "@/lib/chain/base";
import { SOCIALS } from "@/lib/site";

// app/docs/page.tsx
//
// MPGR HUB product documentation.
//
// Source of truth for everything on this page is the running code in this
// repository — routes under /app, engines under /lib, and the deployed Base
// mainnet contracts listed in lib/chain/base.ts. Anything that is designed
// but not shipped is labelled PLANNED / FUTURE and cross-linked to the
// roadmap. Nothing here is invented.

export const metadata: Metadata = {
  title: "Docs — MPGR HUB",
  description:
    "MPGR HUB product documentation: the MPGR Agent, wallet and confirmation model, security, trading, tokenized stocks, x402, MPGR Run, rewards, staking, token lock and Base integration.",
};

const TOC: readonly TocItem[] = [
  { id: "overview", label: "Overview" },
  { id: "getting-started", label: "Getting started" },
  { id: "agent", label: "MPGR Agent" },
  { id: "agent-workflow", label: "Agent workflow" },
  { id: "wallet", label: "Wallet & confirmations" },
  { id: "security", label: "Security model" },
  { id: "boundaries", label: "Approval boundaries" },
  { id: "protocols", label: "Protocols & actions" },
  { id: "research", label: "Research & portfolio" },
  { id: "trading", label: "Trading & swaps" },
  { id: "tokenized-stocks", label: "Tokenized stocks (B20)" },
  { id: "x402", label: "x402 payments" },
  { id: "mpgr-run", label: "MPGR Run" },
  { id: "rewards", label: "Rewards & claims" },
  { id: "xp", label: "XP, levels & streaks" },
  { id: "seasons", label: "Season points & pass" },
  { id: "achievements", label: "Achievements" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "staking", label: "Staking" },
  { id: "token-lock", label: "Token lock" },
  { id: "holder-tier", label: "Holder tier & Premium" },
  { id: "referrals", label: "Referrals" },
  { id: "campaigns", label: "Campaigns & quests" },
  { id: "base", label: "Base ecosystem" },
  { id: "ai", label: "AI architecture" },
  { id: "account", label: "Account & profile" },
  { id: "faq", label: "FAQ" },
  { id: "support", label: "Support" },
] as const;

export default function DocsPage() {
  return (
    <InfoPageShell
      title="Docs"
      subtitle="How MPGR HUB actually works — the Agent, wallet and confirmation model, onchain utilities, games and rewards on Base."
      meta="Written against the running product. Anything not shipped is labelled PLANNED / FUTURE."
      toc={TOC}
    >
      {/* ---------------------------------------------------------------- */}
      <InfoSection id="overview" title="Overview">
        <P>
          <Strong>MPGR HUB</Strong> is a Base-native application built around{" "}
          <Strong>MoneyPaiger ($MPGR)</Strong>. It combines four things in one
          place: an AI agent that researches and prepares onchain actions, a
          play-and-progress layer (MPGR Run, XP, seasons, leaderboard), live
          onchain utility (staking, token lock, reward vault claims), and a
          tokenized-stock / agentic-payments surface — all on Base mainnet.
        </P>
        <Callout tone="future" title="Live vs planned">
          <P>
            This page documents the product as it exists today. Items that are
            designed but not shipped are marked <Strong>PLANNED</Strong> or{" "}
            <Strong>FUTURE</Strong> and linked to{" "}
            <TLink href="/roadmap#ai-agent">the roadmap</TLink>. No future item
            is described as live.
          </P>
        </Callout>
        <InfoSub>The four product areas</InfoSub>
        <UL>
          <LI>
            <Strong>Agent</Strong> — Home (<Code>/</Code>) is the MPGR Agent.
            There is no separate Agent tab.
          </LI>
          <LI>
            <Strong>Play</Strong> —{" "}
            <TLink href="/games">Games</TLink> and{" "}
            <TLink href="/games/mpgr-run">MPGR Run</TLink>.
          </LI>
          <LI>
            <Strong>Earn</Strong> —{" "}
            <TLink href="/rewards">Rewards</TLink>,{" "}
            <TLink href="/staking">Staking</TLink>,{" "}
            <TLink href="/app/token-lock">Token Lock</TLink>,{" "}
            <TLink href="/leaderboard">Leaderboard</TLink>.
          </LI>
          <LI>
            <Strong>Trade</Strong> — swap and tokenized-stock preparation on Base,
            always prepare → confirm → sign.
          </LI>
        </UL>
        <P>
          The positioning is <Strong>Play. Trade. Earn. With AI.</Strong>{" "}
          Architectural detail lives in the{" "}
          <TLink href="/whitepaper#architecture">Whitepaper</TLink>; product
          intent lives in <TLink href="/about#what-is-mpgr-hub">About</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="getting-started" title="Getting started">
        <P>
          You can read, research and browse without connecting anything. A
          wallet is only needed for an action that moves value or writes to a
          contract. Start on Home — the Agent — and connect when the first
          onchain step comes up.
        </P>
        <P>
          Every destination below is a real, shipped route in the application.
        </P>
        <LinkGrid
          items={[
            {
              href: "/",
              label: "MPGR Agent (Home)",
              note: "Chat, research, prepare transfers / swaps / payments.",
            },
            {
              href: "/rewards",
              label: "Reward Hub",
              note: "XP, seasons, on-chain claims, achievements.",
            },
            {
              href: "/games/mpgr-run",
              label: "MPGR Run",
              note: "The playable endless runner with server-verified sessions.",
            },
            {
              href: "/staking",
              label: "Staking",
              note: "Stake, unstake and claim against the deployed Base contract.",
            },
            {
              href: "/app/token-lock",
              label: "Token Lock",
              note: "Time-lock MPGR; drives Premium tier and Holder Score.",
            },
            {
              href: "/leaderboard",
              label: "Leaderboard",
              note: "Global ranking sourced from the server XP ledger.",
            },
            {
              href: "/campaigns",
              label: "Campaigns",
              note: "Operator-launched events with their own points and boards.",
            },
            {
              href: "/profile",
              label: "Profile",
              note: "Wallet, session, XP, holder tier, referrals, activity.",
            },
          ]}
        />
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="agent" title="MPGR Agent">
        <P>
          The Agent is the centre of MPGR HUB. It lives on{" "}
          <TLink href="/">Home</TLink> (<Code>/</Code> redirects to it from{" "}
          <Code>/agent</Code>). The screen is a single workspace: a status bar,
          suggested prompts, the conversation thread, a composer, and a live
          Base market tape whose <Strong>Prepare swap</Strong> action drops the
          same prompt into the chat.
        </P>
        <InfoSub>What the Agent can do today</InfoSub>
        <UL>
          <LI>
            Research <Strong>$MPGR</Strong>, Base markets and Coinbase B20
            tokenized stocks through read-only tools.
          </LI>
          <LI>
            Summarise your portfolio context — XP, level, streak, holder tier,
            Premium status, season progress, staking, token lock, referral count
            and claimable rewards.
          </LI>
          <LI>
            <Strong>Prepare</Strong> a Base transfer (native ETH or any Base
            ERC-20, to an address or a Basename).
          </LI>
          <LI>
            <Strong>Prepare</Strong> a Base swap via the Coinbase CDP Trade API,
            with a 0x fallback.
          </LI>
          <LI>
            <Strong>Prepare</Strong> a B20 tokenized-stock order through an
            Aerodrome Slipstream USDC pool.
          </LI>
          <LI>
            <Strong>Prepare</Strong> an <Strong>x402</Strong> payment against a
            discovered paid resource.
          </LI>
          <LI>
            Offer smart actions that deep-link into Rewards, Games, Staking,
            Token Lock, Profile, Leaderboard and Premium.
          </LI>
        </UL>
        <InfoSub>What the Agent cannot do</InfoSub>
        <UL>
          <LI>
            It cannot sign, broadcast, approve, pay or move funds by itself.
            There is no autonomous execution path and no custody.
          </LI>
          <LI>
            It cannot invent a recipient, amount or destination — every
            value-moving field is re-validated server-side before a proposal is
            ever shown.
          </LI>
          <LI>
            It cannot claim a transaction succeeded until deterministic
            application code has confirmed it.
          </LI>
        </UL>
        <Callout tone="info" title="Model output is untrusted">
          <P>
            Replies are generated by a network model (Gemini by default) or by
            the on-device deterministic engine. Model text is treated as
            untrusted data; tool arguments are validated; write actions are
            gated by deterministic code, not by the model.
          </P>
        </Callout>
        <P>
          Full detail: <TLink href="/docs#agent-workflow">Agent workflow</TLink>{" "}
          · <TLink href="/whitepaper#mpgr-agent">Whitepaper → MPGR Agent</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="agent-workflow" title="Agent workflow">
        <P>
          The Agent loop is:{" "}
          <Strong>
            understand → research → reason → plan → confirm → execute → verify
          </Strong>
          . The order is enforced by application structure — the model suggests,
          deterministic code decides.
        </P>
        <DataTable
          head={["Stage", "What happens"]}
          rows={[
            [
              "Understand",
              "The message is matched against a closed list of intents (portfolio, XP, holder tier, premium, rewards, staking, locked tokens, season, referral, research, market overview, navigation). An unmatched message falls back to research/help — it never becomes an action.",
            ],
            [
              "Research",
              "Read-only tools fetch facts: Base RPC reads, MPGR token / staking / token-lock / reward-vault clients, /api/market/price data, the B20 catalog, x402 resource discovery. Tools return where a fact came from and when it was read.",
            ],
            [
              "Reason",
              "A configured AI provider composes the reply. Policy sits in the system channel; client context is explicitly labelled untrusted so it cannot override it. Providers are tried in order (Gemini → NVIDIA NIM → OpenAI) and fall back to a deterministic engine that never invents live values.",
            ],
            [
              "Plan",
              "Deterministic code decides which action is allowed and builds a structured proposal. Write-capable paths are limited to prepare-mode tools: no tool in the registry executes a wallet write.",
            ],
            [
              "Confirm",
              "A confirmation modal shows the exact effect — amount, asset, destination or route, provider, slippage, and deterministic risk facts. Nothing is sent until you confirm.",
            ],
            [
              "Execute",
              "Your connected wallet signs. For swaps the app submits the transaction (and, where the provider requires it, an ERC-20 approval first); for x402 it signs an EIP-3009 TransferWithAuthorization.",
            ],
            [
              "Verify",
              "The app waits for the receipt and checks its status before reporting success. A failed or reverted transaction is reported as failed — never as done.",
            ],
          ]}
        />
        <P>
          The same loop applies to transfers, swaps, B20 orders and x402
          payments. See{" "}
          <TLink href="/whitepaper#agent-loop">
            Whitepaper → research, planning, confirmation, execution,
            verification
          </TLink>
          .
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="wallet" title="Wallet connection & confirmations">
        <P>
          MPGR HUB is <Strong>Base mainnet only</Strong> (chain ID{" "}
          <Code>{CHAIN_ID}</Code>). Connect with{" "}
          <Strong>RainbowKit</Strong> — Coinbase Wallet, WalletConnect or an
          injected wallet — or through the{" "}
          <Strong>Farcaster Mini App</Strong> connector. If you are on another
          network the header shows a <Strong>Wrong network</Strong> button that
          opens the chain switcher.
        </P>
        <InfoSub>Session, not just signature</InfoSub>
        <P>
          Reading is open. Protected writes require a signed session: the app
          issues a nonce, you sign a SIWE message, and the server issues an
          HMAC session cookie. A wallet address sent by a browser is never
          treated as authentication on its own, and server-side write handlers
          take the wallet from the session rather than from request JSON.
        </P>
        <InfoSub>The confirmation step</InfoSub>
        <UL>
          <LI>
            Every value-moving action opens a confirmation surface before
            anything is signed.
          </LI>
          <LI>
            It shows amount, asset, destination (or route), provider, network,
            slippage and any deterministic risk facts the code computed.
          </LI>
          <LI>
            Tokenized-stock and swap proposals are bound to the session wallet —
            a quote cannot be replayed for a different taker.
          </LI>
          <LI>
            Cancelling a confirmation signs nothing. Nothing is broadcast in the
            background.
          </LI>
        </UL>
        <P>
          Troubleshooting: <TLink href="/support#wallet">Support → Wallet</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="security" title="Security model">
        <P>
          These rules are enforced in code, not only described in policy.
        </P>
        <UL>
          <LI>
            <Strong>No keys in the client.</Strong> Private keys, API secrets and
            CDP credentials are server-only. No secret is exposed under a{" "}
            <Code>NEXT_PUBLIC_</Code> name.
          </LI>
          <LI>
            <Strong>A wallet address is not authentication.</Strong> Privileged
            writes require a signed nonce and session.
          </LI>
          <LI>
            <Strong>Browser values are a cache, not proof.</Strong> XP, score,
            referral, rank and reward claims sent from the browser are never
            trusted for ranking or payouts; ranking comes from the server ledger.
          </LI>
          <LI>
            <Strong>The model never executes a wallet write.</Strong> The path is
            always parse → deterministic tool → validate → simulate → show exact
            effect → confirm → wallet signs.
          </LI>
          <LI>
            <Strong>Read and write tools are separate.</Strong> Write-capable
            tools declare a risk level and require confirmation. Coinbase
            AgentKit runs in <Strong>prepare-only</Strong> mode on Base, and its
            automatic signing / payment actions are denied server-side.
          </LI>
          <LI>
            <Strong>One typed registry.</Strong> Chain ID, contract addresses,
            decimals and ABIs live in a single typed source (
            <Code>lib/chain/base.ts</Code> and the per-domain configs).
          </LI>
          <LI>
            <Strong>Integer / bigint token math.</Strong> No floating-point
            accounting for token amounts.
          </LI>
          <LI>
            <Strong>Validated API boundaries.</Strong> Request shape, size,
            numeric range, origin and authorization are checked at every route,
            with rate limits and a daily AI token budget. Provider, RPC, Redis
            and stack-trace errors are never returned raw to the client.
          </LI>
          <LI>
            <Strong>Fail-closed game settlement.</Strong> Financial game rewards
            stay disabled unless the operator gates are explicitly on.
          </LI>
        </UL>
        <Callout tone="warn" title="Still open">
          <P>
            An independent smart-contract audit and a full anti-cheat
            certification for MPGR Run have <Strong>not</Strong> been completed.
            See <TLink href="/roadmap#security-audit">Roadmap → Security</TLink>{" "}
            and <TLink href="/whitepaper#risks">Whitepaper → Risks</TLink>.
          </P>
        </Callout>
        <P>
          Report vulnerabilities privately through a GitHub Security Advisory —
          never as a public issue.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="boundaries" title="Approval & execution boundaries">
        <P>
          MPGR HUB has <Strong>no autonomous spending authority</Strong>. There
          is no standing delegation, no auto-approval, and no agent-held
          balance. The boundaries below are the real, enforced limits.
        </P>
        <DataTable
          head={["Boundary", "Enforced value", "Where"]}
          rows={[
            [
              "User confirmation",
              "Required for every value-moving action — no exceptions, no allowlist that bypasses it",
              "Confirmation modals; prepare-only tool mode",
            ],
            [
              "Slippage",
              "Default 100 bps (1%); accepted range 1–500 bps (0.01%–5%)",
              "lib/trade/trade-config.ts",
            ],
            [
              "Quote freshness",
              "A quote older than 30 seconds is re-quoted before signing; a worse minimum-output aborts",
              "lib/trade/trade-config.ts, lib/trade/trade-execution.ts",
            ],
            [
              "Taker binding",
              "Swap and B20 quotes are bound to the authenticated session wallet",
              "Trade / B20 quote routes",
            ],
            [
              "Liquidity gate",
              "No reported liquidity → nothing is signed",
              "lib/trade/trade-risk.ts",
            ],
            [
              "Balance gate",
              "Insufficient balance is a critical risk fact and blocks the proposal",
              "lib/trade/trade-risk.ts, lib/trade/transfer-risk.ts",
            ],
            [
              "x402 scope",
              "Base mainnet only (eip155:8453), exact scheme only, known-asset EIP-712 domain required",
              "lib/x402/x402-config.ts",
            ],
            [
              "Chain scope",
              "Base mainnet (8453) only; unsupported chain IDs are rejected by every tool",
              "lib/architecture/tools/tool-helpers.ts",
            ],
            [
              "Prompt & output budget",
              "System ≤ 12,000 chars, user ≤ 8,000 chars, body ≤ 16 KiB, output ≤ 700 tokens",
              "lib/architecture/ai/server-policy.ts",
            ],
            [
              "Request limits",
              "Per-IP and per-wallet rate limits on AI, XP, referral, x402 and trade routes, plus a daily AI token budget",
              "lib/api/request-guard.ts",
            ],
            [
              "Staking minimum",
              "100 MPGR minimum per stake (contract constant)",
              "contracts/MPGRStaking.sol",
            ],
            [
              "Token lock penalty",
              "10% on-chain early-unlock penalty (contract constant, not a UI decision)",
              "contracts · lib/token-lock/token-lock-config.ts",
            ],
          ]}
        />
        <Callout tone="future" title="PLANNED — configurable agent limits">
          <P>
            User-configurable agent spend caps, per-action allowance limits and
            scheduled / recurring agent automations are{" "}
            <Strong>not implemented</Strong>. They are tracked under{" "}
            <TLink href="/roadmap#agent-autonomy">
              Roadmap → autonomous agent permissions
            </TLink>
            . Today the only limit that matters is that you approve each action
            individually.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="protocols" title="Supported protocols & actions">
        <P>
          The Agent&rsquo;s tool registry is explicit. Read tools return facts;{" "}
          <Strong>prepare</Strong> tools build a proposal that requires your
          confirmation; there is <Strong>no execute-mode tool</Strong>.
        </P>
        <InfoSub>Read tools (no confirmation needed)</InfoSub>
        <UL>
          <LI>
            Wallet &amp; portfolio — <Code>wallet_analyzer</Code>,{" "}
            <Code>token_analyzer</Code>, <Code>portfolio_analyzer</Code>,{" "}
            <Code>wallet_balances</Code>, <Code>base_research</Code>
          </LI>
          <LI>
            Market — <Code>market_intelligence</Code>,{" "}
            <Code>trade_get_price</Code>, <Code>get_tape</Code>,{" "}
            <Code>get_pair</Code>, <Code>get_stock_holdings</Code>
          </LI>
          <LI>
            Tokenized stocks — <Code>tokenized_stock_research</Code>,{" "}
            <Code>verify_b20_contract</Code>
          </LI>
          <LI>
            Yield — <Code>yield_opportunities</Code>,{" "}
            <Code>yield_estimator</Code>, <Code>yield_comparison</Code> (normalised
            from live MPGR staking on-chain data)
          </LI>
          <LI>
            x402 &amp; AgentKit — <Code>x402_discover_resource</Code>,{" "}
            <Code>describe_x402_tape</Code>,{" "}
            <Code>agentkit_wallet_details</Code>,{" "}
            <Code>agentkit_discover_x402_services</Code>,{" "}
            <Code>agentkit_onchain_policy</Code>
          </LI>
          <LI>
            Account — <Code>get_premium</Code>
          </LI>
        </UL>
        <InfoSub>Prepare tools (always require confirmation)</InfoSub>
        <UL>
          <LI>
            <Code>trade_prepare_swap</Code> — Base swap proposal (medium risk)
          </LI>
          <LI>
            <Code>prepare_swap</Code> — tape-driven swap proposal (medium risk)
          </LI>
          <LI>
            <Code>tokenized_stock_prepare_order</Code> — B20 order (medium risk)
          </LI>
          <LI>
            <Code>transfer_prepare_send</Code> — Base transfer (high risk)
          </LI>
          <LI>
            <Code>x402_prepare_payment</Code> — x402 payment (medium risk)
          </LI>
        </UL>
        <InfoSub>Infrastructure actually wired</InfoSub>
        <DataTable
          head={["Layer", "What MPGR HUB uses"]}
          rows={[
            [
              "Chain",
              "Base mainnet (8453) — the only configured chain; public RPC with fallbacks",
            ],
            [
              "Swaps",
              "Coinbase CDP Trade API (EVM swaps), 0x Swap API allowance-holder fallback, Permit2 signature append",
            ],
            [
              "Tokenized stocks",
              "Coinbase B20 catalog; single-hop Aerodrome Slipstream USDC pools (tick spacing 10)",
            ],
            [
              "Payments",
              "x402 — exact scheme, USDC on Base, EIP-3009 TransferWithAuthorization",
            ],
            [
              "Agent framework",
              "Coinbase AgentKit in prepare-only mode on base-mainnet (read actions only)",
            ],
            [
              "Naming",
              "Basename resolution for transfer recipients (server-side, never guessed)",
            ],
            [
              "Auth",
              "SIWE nonce + verify + HMAC session cookie; logout clears the session",
            ],
            [
              "Data",
              "Upstash Redis / Vercel KV for sessions, XP ledger, referrals, leaderboard and game allocation",
            ],
            [
              "Contracts",
              "MPGR token, MPGRStaking, MPGRTokenLock (V1), MPGRRewardVault — see below",
            ],
          ]}
        />
        <InfoSub>Contract actions your wallet may be asked to sign</InfoSub>
        <UL>
          <LI>
            <Strong>MPGR token</Strong> — <Code>approve</Code> (
            <Code>{MPGR_TOKEN_ADDRESS}</Code>)
          </LI>
          <LI>
            <Strong>MPGRStaking</Strong> — <Code>stake</Code>,{" "}
            <Code>unstake</Code>, <Code>claimRewards</Code>, <Code>exit</Code> (
            <Code>{MPGR_STAKING_ADDRESS}</Code>)
          </LI>
          <LI>
            <Strong>MPGRTokenLock</Strong> — <Code>createLock</Code>,{" "}
            <Code>withdraw</Code>, <Code>earlyUnlock</Code> (
            <Code>{MPGR_TOKEN_LOCK_ADDRESS}</Code>)
          </LI>
          <LI>
            <Strong>MPGRRewardVault</Strong> — <Code>claim</Code>,{" "}
            <Code>claimMultiple</Code> (
            <Code>{MPGR_REWARD_VAULT_ADDRESS}</Code>)
          </LI>
        </UL>
        <P>
          Admin-only contract functions (setAPR, pause, depositRewards,
          recoverERC20 and similar) are not reachable from the app or the Agent.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="research" title="Research, market & portfolio">
        <P>
          Research is fact retrieval, not opinion generation. The Agent answers
          from read-only tools and clearly states when live data is unavailable
          rather than filling the gap.
        </P>
        <UL>
          <LI>
            <Strong>Market tape</Strong> — the live Base market tape on Home,
            with a pair sheet for detail (right drawer on desktop, bottom sheet
            on mobile).
          </LI>
          <LI>
            <Strong>$MPGR market data</Strong> — served from{" "}
            <Code>/api/market/mpgr</Code>; the tool reports{" "}
            <Code>DATA_UNAVAILABLE</Code> instead of fabricating a price.
          </LI>
          <LI>
            <Strong>Tokenized-stock research</Strong> — the official Coinbase B20
            catalog, plus contract verification for a supplied Base address.
          </LI>
          <LI>
            <Strong>Portfolio summary</Strong> — MPGR balance, staked and locked
            amounts, claimable rewards, XP and level, streak, holder tier,
            Premium status, season progress and referral count.
          </LI>
          <LI>
            <Strong>Wallet analysis</Strong> — ETH balance, MPGR balance and
            recent MPGR transfer history for any Base address.
          </LI>
        </UL>
        <Callout tone="future" title="Scope note">
          <P>
            There is no general multi-chain portfolio indexer and no external
            market-data vendor beyond the MPGR market endpoint. Cross-chain
            portfolio aggregation and third-party price feeds are{" "}
            <Strong>not implemented</Strong> — see{" "}
            <TLink href="/roadmap#research-portfolio">
              Roadmap → research and portfolio intelligence
            </TLink>
            .
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="trading" title="Trading & swap execution">
        <P>
          Trading is <Strong>prepare → confirm → sign</Strong>. The Agent (or the
          tape) builds a quote; nothing is submitted until you confirm in your
          wallet.
        </P>
        <UL>
          <LI>
            <Strong>Assets</Strong> — ETH / WETH / USDC / MPGR and ordinary Base
            ERC-20 tokens by contract address.
          </LI>
          <LI>
            <Strong>Routing</Strong> — Coinbase CDP Trade API first; 0x Swap API
            is used when CDP will not route the pair.
          </LI>
          <LI>
            <Strong>Slippage</Strong> — 1% default, 1–500 bps accepted.
          </LI>
          <LI>
            <Strong>Freshness</Strong> — a quote older than 30 seconds is
            refreshed, and a worse minimum-output aborts the execution.
          </LI>
          <LI>
            <Strong>Approvals</Strong> — where the provider requires it, an
            ERC-20 approval is submitted and its receipt confirmed before the
            swap transaction is sent.
          </LI>
          <LI>
            <Strong>Risk facts</Strong> — unverified token, no liquidity,
            incomplete simulation and insufficient balance are surfaced as
            deterministic warnings before signing.
          </LI>
        </UL>
        <P>
          Coinbase B20 tokenized stocks do <Strong>not</Strong> use this path —
          see <TLink href="/docs#tokenized-stocks">Tokenized stocks</TLink>.
        </P>
        <P>
          Troubleshooting:{" "}
          <TLink href="/support#trading">Support → Trading &amp; swaps</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="tokenized-stocks" title="Tokenized stocks (B20)">
        <P>
          Coinbase B20 tokenized stocks are supported as{" "}
          <Strong>research and secondary-market trading only</Strong>.
        </P>
        <UL>
          <LI>
            The catalog shipped in the app is the official Coinbase B20 list:{" "}
            <Strong>
              AAPLc, AMZNc, COINc, CRCLc, GOOGLc, INTCc, METAc, MSFTc, MSTRc,
              NVDAc, SNDKc, SPCXc, TSLAc
            </Strong>
            .
          </LI>
          <LI>
            A buy or sell is a single-hop swap through the{" "}
            <Strong>Aerodrome Slipstream</Strong> USDC pool for that asset on
            Base — not through CDP or 0x.
          </LI>
          <LI>
            Primary mint and redeem are <Strong>Authorized Participant only</Strong>
            . MPGR HUB implements <Strong>no retail mint API</Strong> and is not a
            broker-dealer or authorized participant.
          </LI>
          <LI>
            You can verify any Base address against the official B20 list with
            the Agent.
          </LI>
        </UL>
        <Callout tone="warn" title="Not investment advice">
          <P>
            Tokenized equity exposure carries market, liquidity and smart-contract
            risk. MPGR HUB provides technology services and does not provide
            financial, investment or trading advice.
          </P>
        </Callout>
        <P>
          See also{" "}
          <TLink href="/whitepaper#trading-execution">
            Whitepaper → trading and execution architecture
          </TLink>
          .
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="x402" title="x402 / agentic payments">
        <P>
          x402 is the payment path for agentic / machine-to-machine commerce.
          MPGR HUB implements it as a{" "}
          <Strong>discover → register → confirm → sign → submit</Strong> flow.
          There is no silent payment.
        </P>
        <UL>
          <LI>
            <Strong>Discover</Strong> — the Agent fetches a resource and reads
            its <Code>402 Payment Required</Code> requirements.
          </LI>
          <LI>
            <Strong>Register</Strong> — the server re-fetches the resource
            unauthenticated, applies SSRF and allowlist checks, and stores the
            server-observed terms. Terms are never taken from the client.
          </LI>
          <LI>
            <Strong>Confirm</Strong> — you review amount, asset, recipient and
            resource in the payment modal.
          </LI>
          <LI>
            <Strong>Sign</Strong> — your wallet produces an EIP-3009{" "}
            <Code>TransferWithAuthorization</Code> signature. No token approval
            and no transfer is sent by the signature alone.
          </LI>
          <LI>
            <Strong>Submit</Strong> — the signed payment is submitted against the
            stored registration, bound to the exact terms you approved.
          </LI>
        </UL>
        <InfoSub>Scope limits</InfoSub>
        <UL>
          <LI>
            <Strong>Base mainnet only</Strong> — <Code>eip155:8453</Code> (and
            the <Code>base</Code> / <Code>base-mainnet</Code> aliases).
          </LI>
          <LI>
            <Strong>Exact scheme only.</Strong>
          </LI>
          <LI>
            USDC on Base is a known asset; an unknown asset without a supplied
            EIP-712 domain is rejected.
          </LI>
          <LI>
            AgentKit&rsquo;s automatic payment actions are denied server-side —
            the Agent can never pay on its own.
          </LI>
        </UL>
        <P>
          Roadmap:{" "}
          <TLink href="/roadmap#x402">Roadmap → x402 &amp; agentic payments</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="mpgr-run" title="MPGR Run">
        <P>
          <Strong>MPGR Run</Strong> is the flagship game and the only playable
          title today: a one-tap endless runner built on the official MPGR
          character art, playable at{" "}
          <TLink href="/games/mpgr-run">/games/mpgr-run</TLink>.
        </P>
        <UL>
          <LI>
            <Strong>Server-issued sessions.</Strong> A run starts against a
            server session with heartbeats, so a client cannot simply declare a
            score.
          </LI>
          <LI>
            <Strong>Authoritative verification.</Strong> The server replays the
            issued seed and the submitted input trace tick-for-tick and
            recomputes the score, with drift-tolerant timing checks.
          </LI>
          <LI>
            <Strong>XP.</Strong> A completed run awards 8 XP, capped at 10
            XP-earning runs per day. Runs beyond the cap still count toward
            campaign and eligibility logic.
          </LI>
          <LI>
            <Strong>Weekly stats.</Strong> Verified runs feed the weekly game
            panel and are bound to the authenticated wallet.
          </LI>
        </UL>
        <Callout tone="warn" title="Financial game rewards are OFF by default">
          <P>
            Competitive <Strong>financial</Strong> payouts for MPGR Run require
            two independent operator gates (
            <Code>GAME_REWARDS_ENABLED</Code> and{" "}
            <Code>GAME_AUTHORITATIVE_VERIFICATION_ENABLED</Code>) and both
            default to false — the pipeline is fail-closed. The economics behind
            it (a 7,000,000 MPGR lifetime games budget and a 35,000 MPGR weekly
            pool cap, with eligibility, weighting, per-player share caps and
            settlement reconciliation) are implemented but{" "}
            <Strong>not enabled</Strong>. XP and season progression run
            regardless.
          </P>
        </Callout>
        <P>
          Other titles (Clicker, Memory Challenge, Space Shooter, 2048 Daily, Pet
          Raising, Speed Run, Roguelike RPG, AI Battle Arena) exist in the game
          registry as <Strong>coming soon</Strong> and are not presented as
          playable. See{" "}
          <TLink href="/roadmap#gaming">Roadmap → gaming ecosystem</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="rewards" title="Rewards & claims">
        <P>
          <TLink href="/rewards">/rewards</TLink> is the Reward Hub: a summary,
          reward categories, on-chain claims, claim history, achievements and the
          season preview.
        </P>
        <InfoSub>How claiming works</InfoSub>
        <P>
          Real MPGR claiming is <Strong>on-chain</Strong>, through the deployed{" "}
          <Strong>MPGRRewardVault</Strong> contract on Base (
          <Code>claim</Code> / <Code>claimMultiple</Code>). A vault reward is
          either allocated or claimed — there is no partial-progress concept. An
          older local/mock claim system was removed; the hub no longer invents
          claimable MPGR.
        </P>
        <InfoSub>Reward categories</InfoSub>
        <P>
          The hub groups rewards into daily, weekly, staking, quest, game,
          referral, season, AI, premium and airdrop. Category metadata covers the
          full program, but a category only shows real numbers when a live
          provider exists behind it:
        </P>
        <DataTable
          head={["Category", "Status"]}
          rows={[
            ["Staking", "LIVE — real rewards from the deployed staking contract"],
            [
              "Game",
              "GATED — pipeline implemented, financial payouts disabled by default"],
            ["Season", "UI track — Season Pass progress is computed in-app"],
            [
              "Daily / weekly / quest / referral",
              "Program categories in the treasury plan; surfaced through the hub when an allocation exists"],
            [
              "AI / premium / airdrop",
              "FUTURE — no live per-wallet provider yet"],
          ]}
        />
        <P>
          All rewards are <Strong>existing tokens</Strong> from the community
          treasury — no new $MPGR is ever minted. See{" "}
          <TLink href="/token#tokenomics">$MPGR → tokenomics</TLink> and{" "}
          <TLink href="/whitepaper#rewards-economy">
            Whitepaper → rewards economy
          </TLink>
          .
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="xp" title="XP, levels & streaks">
        <P>
          XP is earned from a fixed set of actions with fixed values. There are
          no arbitrary or variable grants.
        </P>
        <DataTable
          head={["Action", "XP"]}
          rows={[
            ["Wallet connected (one-time)", "50"],
            ["Daily check-in", "20"],
            ["Profile completed (one-time)", "30"],
            ["Shared on X", "15"],
            ["Quest completed", "40"],
            ["Referral success", "100"],
            ["MPGR Run completed (max 10/day)", "8"],
          ]}
        />
        <UL>
          <LI>
            XP drives your <Strong>level</Strong> on a progressive curve and your{" "}
            <Strong>daily check-in streak</Strong>.
          </LI>
          <LI>
            The authoritative XP total is the{" "}
            <Strong>server-owned ledger</Strong> (
            <Code>/api/xp</Code>), not the browser. XP shown in the app before
            the server value syncs is a cache and is never used for ranking.
          </LI>
          <LI>
            Authenticated XP writes are rate-limited and the server rejects
            client-supplied XP totals.
          </LI>
        </UL>
        <P>
          Troubleshooting:{" "}
          <TLink href="/support#rewards">Support → Rewards &amp; games</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="seasons" title="Season points & Season Pass">
        <P>
          Seasons run on <Strong>UTC calendar months</Strong>. Season points are
          derived from XP earned inside the current season window — there is no
          separate points currency.
        </P>
        <UL>
          <LI>
            <TLink href="/season">/season</TLink> — current season number, your
            season points, milestones (250 / 500 / 1000) and the countdown to
            season end.
          </LI>
          <LI>
            <TLink href="/season-pass">/season-pass</TLink> — a reward track over
            the same season: 20 levels at 150 season points per level, with a free
            track and a Premium track (every 5th level is a milestone) plus
            missions.
          </LI>
          <LI>
            Premium-track eligibility comes from your{" "}
            <TLink href="/docs#holder-tier">Premium tier</TLink>, which is derived
            from active token locks.
          </LI>
        </UL>
        <Callout tone="info" title="Where season-pass state lives">
          <P>
            Season points come from the XP engine, but Season Pass{" "}
            <Strong>claim state</Strong> is stored per wallet per season in
            browser storage. It resets naturally when a new season starts. It is
            not an on-chain balance.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="achievements" title="Achievements">
        <P>
          Achievements are computed from your XP record and your MPGR Run stats.
          They are unlocked by meeting a target and then claimed once.
        </P>
        <UL>
          <LI>
            <Strong>Account</Strong> — First Check-in, 7 Day Streak, 30 Day
            Streak, 100 XP, Level 5, Level 10, Community Builder, Top Referrer.
          </LI>
          <LI>
            <Strong>MPGR Run</Strong> — First Run, 1,000m Club, 5,000m Club,
            10,000m Club, Flawless Run, Coin Collector, MPGR Runner.
          </LI>
          <LI>
            Some cosmetic entries are flagged <Strong>coming soon</Strong> and
            stay locked until their feature ships.
          </LI>
        </UL>
        <P>
          Achievements are visible on <TLink href="/rewards">Rewards</TLink>,{" "}
          <TLink href="/games">Games</TLink> and{" "}
          <TLink href="/profile">Profile</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="leaderboard" title="Leaderboard">
        <P>
          The global leaderboard at{" "}
          <TLink href="/leaderboard">/leaderboard</TLink> is sourced from the{" "}
          <Strong>server-side ranking</Strong> built on the XP ledger in Redis —
          not from a client-reported score. It shows the global top plus your own
          row, with your wallet highlighted as{" "}
          <Strong>you</Strong> and never presented as the whole board.
        </P>
        <P>
          Ranking updates as authenticated XP is awarded. Browser-side scores are
          ignored for ranking purposes.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="staking" title="Staking">
        <P>
          Staking runs against the deployed <Strong>MPGRStaking</Strong> contract
          on Base at <Code>{MPGR_STAKING_ADDRESS}</Code>. The UI is at{" "}
          <TLink href="/staking">/staking</TLink>.
        </P>
        <UL>
          <LI>
            <Strong>Single-sided</Strong> — stake MPGR, earn MPGR.
          </LI>
          <LI>
            <Strong>No lock term</Strong> — rewards accrue continuously and can
            be staked, claimed or unstaked at any time.
          </LI>
          <LI>
            <Strong>Minimum stake</Strong> — 100 MPGR (contract constant).
          </LI>
          <LI>
            <Strong>Reward schedule</Strong> — the contract declares a 730-day
            rewards duration and a 25,000,000 MPGR reward pool, with APR bounded
            between 1% and 100%.
          </LI>
          <LI>
            <Strong>Actions</Strong> — approve, stake, unstake, claim rewards and{" "}
            <Code>exit</Code> (claim plus full unstake). Each is a wallet-signed
            transaction with a confirmation step.
          </LI>
          <LI>
            Live APR, total staked, your stake, accrued rewards and pool state
            are read from the contract with short cache TTLs and background
            refresh.
          </LI>
        </UL>
        <P>
          See <TLink href="/whitepaper#staking">Whitepaper → staking</TLink> and{" "}
          <TLink href="/roadmap#staking">Roadmap → staking</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="token-lock" title="Token lock">
        <P>
          Token lock runs against the deployed, immutable{" "}
          <Strong>MPGRTokenLock V1</Strong> contract at{" "}
          <Code>{MPGR_TOKEN_LOCK_ADDRESS}</Code>. The UI is at{" "}
          <TLink href="/app/token-lock">/app/token-lock</TLink>.
        </P>
        <UL>
          <LI>
            <Strong>Duration presets</Strong> — 30, 90, 180 or 365 days.
          </LI>
          <LI>
            <Strong>Early unlock</Strong> — allowed at any time, but the contract
            applies a fixed <Strong>10% penalty</Strong> (90% returned to you, 10%
            to the penalty recipient). The split is computed and executed
            on-chain; the app only previews it.
          </LI>
          <LI>
            <Strong>What it powers</Strong> — locked MPGR feeds your{" "}
            <TLink href="/docs#holder-tier">Premium tier and Holder Score</TLink>.
          </LI>
          <LI>
            <Strong>Actions</Strong> — approve, create lock, withdraw (after
            maturity) and early unlock, each wallet-signed after confirmation.
          </LI>
        </UL>
        <P>
          See <TLink href="/whitepaper#token-lock">Whitepaper → token lock</TLink>
          .
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="holder-tier" title="Holder tier & Premium">
        <P>
          Two independent reputation systems read the same on-chain positions.
        </P>
        <InfoSub>Holder tier</InfoSub>
        <P>
          Derived from your <Strong>Total Holder Score</Strong> — live wallet
          balance + active staked + active locked. It is not a purchase and falls
          away automatically if the score drops. It grants a badge, frame,
          governance voting weight and community reputation.
        </P>
        <DataTable
          head={["Tier", "Min score", "Vote multiplier"]}
          rows={[
            ["Bronze", "1,000", "1×"],
            ["Silver", "10,000", "1.25×"],
            ["Gold", "50,000", "1.5×"],
            ["Platinum", "150,000", "2×"],
            ["Diamond", "500,000", "3×"],
          ]}
        />
        <InfoSub>Premium</InfoSub>
        <P>
          Derived <Strong>only</Strong> from MPGR currently active in Token Lock.
          Premium owns the XP and rewards multipliers (1.5× XP, 1.25× rewards on
          every tier); Holder tier never touches multipliers.
        </P>
        <DataTable
          head={["Tier", "Min locked MPGR"]}
          rows={[
            ["Silver", "10,000"],
            ["Gold", "50,000"],
            ["Diamond", "100,000"],
          ]}
        />
        <Callout tone="info" title="No paid subscription">
          <P>
            There is no paid Premium subscription in the product. Premium is a
            function of what you have locked on-chain, and it lapses if you
            release enough locked MPGR.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="referrals" title="Referrals">
        <P>
          Referrals are <Strong>authenticated</Strong> and server-recorded.
        </P>
        <UL>
          <LI>
            A referral link (<Code>?ref=</Code>) is captured when a visitor
            arrives, and attributed only once that wallet holds a valid signed
            session.
          </LI>
          <LI>
            The <Strong>referred</Strong> wallet is always the authenticated
            session wallet — a client can only ever supply the{" "}
            <Strong>referrer</Strong>, never the referred identity.
          </LI>
          <LI>
            A successful referral awards <Strong>100 XP</Strong>.
          </LI>
          <LI>
            Self-referral is rejected and recorded as abuse; re-pointing an
            already-attributed wallet at a different referrer is rejected and
            logged.
          </LI>
          <LI>
            The referral endpoint is rate-limited (20 requests per 60 seconds)
            and requires authentication.
          </LI>
        </UL>
        <Callout tone="future" title="Hardening in progress">
          <P>
            Referral sybil resistance is still being hardened — see{" "}
            <TLink href="/roadmap#quests-referrals-leaderboards">
              Roadmap → quests, referrals &amp; leaderboards
            </TLink>
            .
          </P>
        </Callout>
        <P>
          Your referral link and count are on{" "}
          <TLink href="/profile">Profile</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="campaigns" title="Campaigns & quests">
        <P>
          <TLink href="/campaigns">/campaigns</TLink> hosts temporary,
          operator-launched events. Campaigns are{" "}
          <Strong>config-driven</Strong>: a definition file plus a registry entry
          is all a new campaign needs — no page or engine changes.
        </P>
        <UL>
          <LI>
            Each campaign owns its <Strong>own points ledger and leaderboard</Strong>,
            separate from global XP and Season Points.
          </LI>
          <LI>
            Joining and scoring require an <Strong>authenticated wallet session</Strong>.
          </LI>
          <LI>
            Points are computed <Strong>server-side</Strong> from the campaign
            config and adapter validation; clients submit only an action id, an
            idempotency event id and an optional bounded number.
          </LI>
          <LI>
            Adapter types exist for game, trading, agent and social activity, with
            a generic fallback for future event types.
          </LI>
        </UL>
        <Callout tone="info" title="Current registry">
          <P>
            The registry currently ships example campaign definitions
            (MPGR Run weekly, a trading competition and an agent competition)
            used to exercise the system. Treat the specific pools and dates as
            illustrative until an operator announces a live campaign.
          </P>
        </Callout>
        <P>
          Quests in the wider sense (community and on-chain missions) are part of
          the treasury program and are surfaced through the Reward Hub when an
          allocation exists. Deep quest automation is{" "}
          <TLink href="/roadmap#quests-referrals-leaderboards">planned</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="base" title="Base ecosystem integration">
        <P>
          MPGR HUB is <Strong>Base-native by design</Strong>. There is no
          multi-chain runtime today, and no bridge or cross-chain execution path.
        </P>
        <DataTable
          head={["Layer", "Usage in MPGR HUB"]}
          rows={[
            ["Base mainnet", "Sole production chain, ID 8453"],
            [
              "Coinbase Wallet / Base App",
              "First-class connection path via RainbowKit",
            ],
            [
              "Coinbase CDP Trade API",
              "Swap quotes and swap transactions, BYO wallet",
            ],
            [
              "Coinbase B20 tokenized stocks",
              "Research + Aerodrome Slipstream secondary market",
            ],
            ["USDC on Base", "Settlement asset for swaps and x402 payments"],
            [
              "Farcaster Mini App",
              "In-app distribution and auto-connect on the Base / Farcaster graph",
            ],
            ["Basenames", "Human-readable transfer recipients"],
            ["Vercel", "Production host, GitHub-connected"],
            ["BaseScan", "Public verification of every contract and transaction"],
          ]}
        />
        <P>
          Naming Coinbase, Base, Aerodrome, 0x, Farcaster, Vercel or USDC
          describes public infrastructure MPGR HUB uses. It does not imply
          partnership, endorsement, brokerage access or authorized-participant
          status.
        </P>
        <P>
          See <TLink href="/whitepaper#base-ecosystem">Whitepaper → Base</TLink>{" "}
          and <TLink href="/roadmap#base-expansion">Roadmap → Base expansion</TLink>
          .
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="ai" title="AI provider architecture">
        <P>
          The Agent is a layered, replaceable provider stack. No single model is
          trusted with execution, and a network failure never produces a
          fabricated answer.
        </P>
        <UL>
          <LI>
            <Strong>Providers</Strong> — Gemini is the default, with NVIDIA NIM
            and OpenAI available; the chain falls back to a{" "}
            <Strong>deterministic on-device engine</Strong> that never invents
            live values. Anthropic and Ollama are declared but not implemented.
          </LI>
          <LI>
            <Strong>Routing</Strong> — tasks are classified and routed to a
            provider order; the deterministic engine is always the last link.
          </LI>
          <LI>
            <Strong>Safety layers</Strong> — guardrails, per-provider timeouts, a
            circuit breaker and diagnostics wrap every network provider.
          </LI>
          <LI>
            <Strong>Prompt policy</Strong> — trusted policy sits in the system
            channel; client and tool context is explicitly labelled untrusted so
            it cannot override it.
          </LI>
          <LI>
            <Strong>Budgets</Strong> — prompt/output limits (system 12,000 chars,
            user 8,000 chars, body 16 KiB, output 700 tokens), per-IP and
            per-wallet rate limits, and a daily AI token budget.
          </LI>
          <LI>
            <Strong>Onchain layer</Strong> — Coinbase AgentKit runs in
            prepare-only mode on Base with a read-action allowlist; its signing
            and auto-payment actions are denied server-side.
          </LI>
        </UL>
        <P>
          See{" "}
          <TLink href="/whitepaper#ai-infrastructure">
            Whitepaper → AI agent infrastructure
          </TLink>{" "}
          and <TLink href="/roadmap#ai-provider">Roadmap → AI provider layer</TLink>
          .
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="account" title="Account & profile">
        <P>
          MPGR HUB is wallet-based — there is no email and no password.
        </P>
        <UL>
          <LI>
            <Strong>Session</Strong> — SIWE sign-in creates an HMAC session
            cookie; sign-out from <TLink href="/profile">Profile</TLink> clears
            it. A wallet address alone is never accepted as proof.
          </LI>
          <LI>
            <Strong>What Profile shows</Strong> — wallet and address, XP/level,
            streak, holder tier, Premium status, Season Pass progress, your
            referral link and count, activity timeline, achievements, and links
            into staking, token lock and support.
          </LI>
          <LI>
            <Strong>What is stored</Strong> — sessions, XP ledger rows, referral
            attributions, leaderboard ranking and game allocation state on the
            server; XP/Season Pass/achievement caches and local game state in the
            browser, always as a cache and never as proof.
          </LI>
          <LI>
            <Strong>Memory</Strong> — you can clear the Agent conversation from
            the chat; do not paste secrets, seed phrases or private keys into the
            Agent.
          </LI>
        </UL>
        <P>
          See <TLink href="/privacy">Privacy</TLink> and{" "}
          <TLink href="/terms">Terms</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="faq" title="Frequently asked questions">
        <InfoSub>Is MPGR HUB custodial?</InfoSub>
        <P>
          No. The Agent prepares; your wallet signs. MPGR HUB never holds your
          keys, never holds a balance for you, and never broadcasts a transaction
          you have not confirmed.
        </P>
        <InfoSub>Can the Agent spend without me?</InfoSub>
        <P>
          No. There is no autonomous execution path, no standing allowance and no
          agent-held funds. The AgentKit actions that would sign or pay
          automatically are denied server-side.
        </P>
        <InfoSub>Which network do I need?</InfoSub>
        <P>
          Base mainnet (8453) only. If the header shows{" "}
          <Strong>Wrong network</Strong>, switch to Base and retry.
        </P>
        <InfoSub>Is there a maximum supply?</InfoSub>
        <P>
          Yes — 1,000,000,000 MPGR, fixed. No inflation, no future minting, no
          private sale, no VC allocation, no locked team allocation. Rewards come
          from the community treasury, not from new supply. See{" "}
          <TLink href="/token#tokenomics">$MPGR tokenomics</TLink>.
        </P>
        <InfoSub>Are game rewards live?</InfoSub>
        <P>
          XP and season progression are live. Competitive{" "}
          <Strong>financial</Strong> game payouts are disabled by default behind
          two operator gates and are not enabled in production today.
        </P>
        <InfoSub>Is there a mobile app?</InfoSub>
        <P>
          Not yet. The web app is responsive on phones and tablets, and a mobile
          wrapper is <TLink href="/roadmap#infrastructure">planned</TLink>.
        </P>
        <InfoSub>Is there governance?</InfoSub>
        <P>
          Not as a DAO. Governance is{" "}
          <TLink href="/roadmap#token-utility">planned</TLink>; until then the
          fixed-supply, no-VC, no-team-unlock commitments are the standing
          constraints.
        </P>
        <InfoSub>Has the code been audited?</InfoSub>
        <P>
          An independent third-party smart-contract audit has{" "}
          <Strong>not</Strong> been completed. The repository ships unit,
          security and contract tests in CI, which is not the same thing. See{" "}
          <TLink href="/roadmap#security-audit">Roadmap → security</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="support" title="Support">
        <P>
          For guided troubleshooting — wallet and connection issues, transaction
          and confirmation guidance, swap troubleshooting, rewards and game
          questions, and security reminders — see{" "}
          <TLink href="/support">Support</TLink>.
        </P>
        <P>
          Community and official channels:
        </P>
        <UL>
          <LI>
            <TLink href={SOCIALS.x} external>
              X — @Moneypaiger
            </TLink>
          </LI>
          <LI>
            <TLink href={SOCIALS.telegram} external>
              Telegram
            </TLink>
          </LI>
          <LI>
            <TLink href={SOCIALS.discord} external>
              Discord
            </TLink>
          </LI>
          <LI>
            <TLink href="https://github.com/munazir17/MPGR-HUB" external>
              GitHub
            </TLink>
          </LI>
        </UL>
        <P>Related documentation:</P>
        <LinkGrid
          items={[
            {
              href: "/whitepaper",
              label: "Whitepaper",
              note: "Vision, architecture, safety model, tokenomics, risks.",
            },
            {
              href: "/roadmap",
              label: "Roadmap",
              note: "LIVE / IN PROGRESS / PLANNED / LONG-TERM VISION by area.",
            },
            {
              href: "/about",
              label: "About",
              note: "What MPGR HUB is, why it exists, where it is going.",
            },
            {
              href: "/token",
              label: "$MPGR",
              note: "Token facts, distribution, treasury programs, utility.",
            },
          ]}
        />
      </InfoSection>
    </InfoPageShell>
  );
}
