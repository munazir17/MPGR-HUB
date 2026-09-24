import type { Metadata } from "next";

import { InfoPageShell } from "@/components/layout/InfoPageShell";
import {
  Callout,
  Code,
  DataTable,
  FactGrid,
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
  explorerAddressUrl,
} from "@/lib/chain/base";
import { WHITEPAPER_DATE, WHITEPAPER_VERSION } from "@/lib/content/official";
import {
  INITIAL_DISTRIBUTION,
  TOKEN_FACTS,
  TREASURY_PROGRAMS,
} from "@/lib/content/tokenomics";

// app/whitepaper/page.tsx
//
// Public product documentation for MPGR HUB.
//
// Every LIVE claim here is backed by code in this repository or by a
// deployed Base mainnet contract listed in lib/chain/base.ts. Future
// sections are labelled as such and cross-linked to /roadmap, which is
// the single place where status is tracked.

export const metadata: Metadata = {
  title: `Whitepaper v${WHITEPAPER_VERSION} — MPGR HUB`,
  description:
    "MPGR HUB whitepaper: vision, problem, solution, architecture, the MPGR Agent and its safety model, wallet security, Base ecosystem, execution, gaming, rewards economy, staking, token lock, token utility, AI infrastructure, x402, roadmap and risks.",
};

const TOC: readonly TocItem[] = [
  { id: "executive-summary", label: "Executive summary" },
  { id: "vision", label: "Vision & mission" },
  { id: "problem", label: "Problem" },
  { id: "solution", label: "Solution" },
  { id: "architecture", label: "Architecture" },
  { id: "mpgr-agent", label: "The MPGR Agent" },
  { id: "agent-loop", label: "Research → verify loop" },
  { id: "agent-safety", label: "Agent safety model" },
  { id: "wallet-security", label: "Wallet & security model" },
  { id: "base-ecosystem", label: "Base ecosystem" },
  { id: "trading-execution", label: "Trading & execution" },
  { id: "mpgr-run", label: "MPGR Run & gaming" },
  { id: "rewards-economy", label: "Rewards & XP economy" },
  { id: "staking", label: "Staking" },
  { id: "token-lock", label: "Token lock" },
  { id: "token-utility", label: "Token utility" },
  { id: "tokenomics", label: "Tokenomics" },
  { id: "ai-infrastructure", label: "AI agent infrastructure" },
  { id: "x402", label: "x402 & agentic payments" },
  { id: "agent-marketplace", label: "Provider & agent marketplace" },
  { id: "long-term-vision", label: "Long-term vision" },
  { id: "roadmap", label: "Roadmap" },
  { id: "risks", label: "Risks & limitations" },
  { id: "disclaimer", label: "Disclaimer" },
] as const;

export default function WhitepaperPage() {
  return (
    <InfoPageShell
      title={`Whitepaper v${WHITEPAPER_VERSION}`}
      subtitle="An onchain operating system for agents, payments, games and holder utility — built natively on Base."
      meta={`Public product documentation · ${WHITEPAPER_DATE} · Informational only, not an offer of securities and not financial advice`}
      eyebrow="MPGR HUB · MoneyPaiger ($MPGR)"
      toc={TOC}
    >
      {/* ---------------------------------------------------------------- */}
      <InfoSection id="executive-summary" title="1. Executive summary">
        <P>
          <Strong>MoneyPaiger ($MPGR)</Strong> is a fixed-supply utility token on{" "}
          <Strong>Base</Strong>, Coinbase&rsquo;s Ethereum Layer 2.{" "}
          <Strong>MPGR HUB</Strong> is the product built around it: a
          Base-native application where a person talks to an AI agent,
          researches and prepares onchain actions, plays <Strong>MPGR Run</Strong>,
          earns XP and season points, stakes and locks $MPGR, and claims rewards
          from a vault.
        </P>
        <P>
          The thesis is public and simple:{" "}
          <Strong>token → app → AI → payments → onchain activity</Strong>.
          MPGR HUB is not a ticker with a landing page; it is a shipping
          application deployed from GitHub to Vercel, running on Base mainnet
          only (chain ID <Code>{CHAIN_ID}</Code>).
        </P>
        <InfoSub>What is live today</InfoSub>
        <DataTable
          head={["Capability", "Status"]}
          rows={[
            ["$MPGR token on Base", "LIVE"],
            ["Wallet connect — RainbowKit, Coinbase Wallet, Farcaster Mini App", "LIVE"],
            ["MPGR Agent — research, reason, prepare; user signs", "LIVE"],
            ["Coinbase CDP Trade API with a 0x fallback (BYO wallet)", "LIVE"],
            ["Coinbase B20 tokenized-stock research + Aerodrome Slipstream path", "LIVE (prepare / confirm)"],
            ["x402 payment proposals", "LIVE (prepare / confirm)"],
            ["MPGR Run, XP, seasons, leaderboard, check-in, referrals", "LIVE"],
            ["Staking, token lock and reward vault clients", "LIVE on Base"],
            ["SIWE sessions and a server-owned XP ledger", "LIVE"],
          ]}
        />
        <InfoSub>What is explicitly not claimed as finished</InfoSub>
        <UL>
          <LI>An independent third-party smart-contract audit.</LI>
          <LI>
            Enabled competitive <Strong>financial</Strong> game payouts —
            operator-gated and fail-closed by default.
          </LI>
          <LI>Onchain DAO governance.</LI>
        </UL>
        <P>
          All three are tracked in{" "}
          <TLink href="/roadmap#security-audit">the roadmap</TLink>, not
          presented as current guarantees.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="vision" title="2. Vision & mission">
        <P>
          <Strong>Vision:</Strong> build the leading AI-powered onchain operating
          system on Base — one place where a user can talk to an agent that
          understands wallet and market context, research tokenized stocks and
          Base markets, prepare a trade, transfer or payment, confirm it in their
          own wallet, and play, earn, stake and belong to a season — without
          leaving Base.
        </P>
        <P>
          <Strong>Mission:</Strong> reward real users, builders and contributors.
          Prefer long-term utility over short-term hype. Keep the token supply
          fixed. Fund rewards from a community treasury, not from inflation.
        </P>
        <FactGrid
          items={[
            { label: "Token", value: `${TOKEN_FACTS.name} (${TOKEN_FACTS.symbol})` },
            { label: "Product", value: "MPGR HUB" },
            { label: "Tagline", value: "Play. Trade. Earn. With AI." },
            { label: "Network", value: `${TOKEN_FACTS.network} (${CHAIN_ID})` },
          ]}
        />
        <P>
          See <TLink href="/about#why-it-exists">About → why MPGR HUB exists</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="problem" title="3. Problem">
        <P>
          Onchain products still ask ordinary people to be their own integration
          layer.
        </P>
        <UL>
          <LI>
            <Strong>Fragmentation.</Strong> Staking, locking, claiming, playing
            and trading usually live in five unrelated interfaces with five
            unrelated mental models.
          </LI>
          <LI>
            <strong>High cost of intent.</strong> Turning “swap some USDC into a
            tokenized stock” into a safe, correct transaction means finding a
            route, understanding slippage, checking liquidity and reading raw
            calldata — or blindly trusting a button.
          </LI>
          <LI>
            <strong>AI without guardrails.</strong> Most AI assistants can
            describe an onchain action but cannot safely prepare one, and the
            moment an assistant can sign, the user has lost the only control that
            mattered.
          </LI>
          <LI>
            <strong>Rewards without trust.</strong> Points, streaks and
            leaderboards are easy to fake when the client reports the score and
            the server believes it.
          </LI>
          <LI>
            <strong>Engagement without utility.</strong> Gamified crypto products
            often emit tokens to buy attention, which dilutes holders and ends
            badly.
          </LI>
        </UL>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="solution" title="4. Solution">
        <P>
          MPGR HUB answers with one product built on four commitments.
        </P>
        <UL>
          <LI>
            <strong>One surface, four verbs.</strong> The Agent (Home) for
            research and preparation, Games for play, Rewards for progression,
            Staking and Token Lock for onchain commitment — all on Base, all with
            the same confirmation language.
          </LI>
          <LI>
            <strong>Prepare, never presume.</strong> The Agent converts intent
            into a structured, validated proposal with the exact effect shown
            before signing. Deterministic code decides what is allowed; the model
            only suggests.
          </LI>
          <LI>
            <strong>Server-owned truth.</strong> XP, ranking, referral attribution
            and game verification are computed server-side. The browser is a
            cache, never a witness.
          </LI>
          <LI>
            <strong>Fixed supply, treasury-funded rewards.</strong> 1,000,000,000
            MPGR, permanently. Every reward is an existing token from the
            community treasury — never newly minted supply.
          </LI>
        </UL>
        <P>
          Architecture detail:{" "}
          <TLink href="/whitepaper#architecture">section 5</TLink>. Product
          behaviour: <TLink href="/docs">Docs</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="architecture" title="5. MPGR HUB architecture">
        <P>
          MPGR HUB is a Next.js App Router application. Domain logic lives in
          typed modules; the client renders and signs; the server validates,
          prices, stores and verifies.
        </P>
        <DataTable
          head={["Layer", "Implementation"]}
          rows={[
            ["App", "Next.js App Router, React, TypeScript (strict), Tailwind CSS"],
            ["Wallets", "Wagmi, Viem, RainbowKit, Farcaster Mini App connector"],
            ["Chain", "Base mainnet only — one typed registry for chain ID, addresses, decimals and ABIs"],
            ["AI", "Pluggable providers (Gemini default, NVIDIA NIM, OpenAI) with a deterministic fallback; Coinbase AgentKit prepare-only"],
            ["Trade", "Coinbase CDP Trade API, 0x Swap API fallback, Aerodrome Slipstream for B20"],
            ["Payments", "x402 — exact scheme, USDC on Base, EIP-3009 TransferWithAuthorization"],
            ["Data", "Upstash Redis / Vercel KV for sessions, XP ledger, referrals, leaderboard and game allocation"],
            ["Auth", "SIWE nonce + signature, HMAC session cookie"],
            ["Contracts", "MPGR token, MPGRStaking, MPGRTokenLock V1, MPGRRewardVault on Base"],
            ["CI", "lint, typecheck, unit and security tests, high-severity audit script, Foundry contract tests, production build"],
          ]}
        />
        <InfoSub>Three product surfaces</InfoSub>
        <UL>
          <LI>
            <Strong>Home — the Agent.</Strong> There is no separate Agent tab.
            Home is an always-on command centre: status, suggested prompts,
            conversation, and shortcuts into research, trade and rewards.
          </LI>
          <LI>
            <Strong>Rewards — play and progression.</Strong> MPGR Run, XP, level,
            streak, season, Season Pass, leaderboard, achievements, on-chain
            claims.
          </LI>
          <LI>
            <Strong>Profile — account control.</Strong> Wallet, session, XP,
            holder tier, Premium, referrals, activity and sign-out.
          </LI>
        </UL>
        <P>
          Repository map: <Code>app/</Code> pages and API routes,{" "}
          <Code>components/</Code> UI, <Code>hooks/</Code> client hooks,{" "}
          <Code>lib/</Code> domain logic, <Code>contracts/</Code> and{" "}
          <Code>test/</Code> Solidity and Foundry tests.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="mpgr-agent" title="6. The MPGR Agent">
        <P>
          The Agent is the centre of MPGR HUB. It reads live context, retrieves
          facts through read-only tools, composes an answer, and — when the
          request is an action — produces a structured proposal for the user to
          confirm.
        </P>
        <InfoSub>Capabilities today</InfoSub>
        <UL>
          <LI>Research $MPGR, Base markets and Coinbase B20 tokenized stocks.</LI>
          <LI>Analyse portfolio and wallet context.</LI>
          <LI>Prepare Base transfers, including Basename recipients.</LI>
          <LI>Prepare swaps via Coinbase CDP with a 0x fallback.</LI>
          <LI>Prepare B20 tokenized-stock orders on Aerodrome Slipstream.</LI>
          <LI>Prepare x402 payments for agentic commerce.</LI>
          <LI>Route the user into Rewards, Run, staking and lock flows.</LI>
          <LI>Fall back to an on-device deterministic engine if no network model answers.</LI>
        </UL>
        <InfoSub>Hard limits</InfoSub>
        <UL>
          <LI>The Agent cannot sign, broadcast, approve or pay.</LI>
          <LI>The Agent cannot choose a transaction destination; destinations are resolved from a typed registry.</LI>
          <LI>The Agent cannot claim success before deterministic code confirms it.</LI>
        </UL>
        <P>
          Operational detail: <TLink href="/docs#agent">Docs → MPGR Agent</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="agent-loop" title="7. Research → planning → confirmation → execution → verification">
        <P>
          The enforced loop is{" "}
          <Strong>
            understand → research → reason → plan → confirm → execute → verify
          </Strong>
          . It is a structural property of the codebase, not a prompt convention.
        </P>
        <DataTable
          head={["Stage", "Guarantee"]}
          rows={[
            ["Understand", "A closed intent list. Unmatched input becomes research or help — never an action."],
            ["Research", "Read-only tools only. Facts carry their source and observation time; unavailable data is reported as unavailable."],
            ["Reason", "Policy sits in the system channel; model and tool output are untrusted data and cannot override it."],
            ["Plan", "Deterministic code builds the proposal and validates every field. There is no execute-mode tool in the registry."],
            ["Confirm", "The user sees amount, asset, destination or route, provider, slippage and risk facts, and must confirm."],
            ["Execute", "The connected wallet signs. Where an approval is required, its receipt is confirmed before the main transaction is sent."],
            ["Verify", "The app waits for the receipt and checks its status. A revert is reported as a failure, never as success."],
          ]}
        />
        <P>
          See <TLink href="/docs#agent-workflow">Docs → Agent workflow</TLink> for
          the same loop described at implementation level.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="agent-safety" title="8. Agent safety & permission model">
        <P>
          The model may <Strong>suggest</Strong>. Deterministic code{" "}
          <Strong>decides</Strong>. The wallet <Strong>signs</Strong>.
        </P>
        <UL>
          <LI>
            <strong>Allowlist, not denylist.</strong> AgentKit runs in
            prepare-only mode on Base; its signing, transfer and auto-payment
            actions are unreachable and are denied server-side even if a caller
            invents the action name.
          </LI>
          <LI>
            <strong>Tool contract.</strong> Every tool declares a name, purpose,
            input schema, output shape, timeout and risk level. Write-capable
            tools require confirmation.
          </LI>
          <LI>
            <strong>Risk levels.</strong> Read tools are low risk; prepare tools
            are medium (swap, B20 order, x402) or high (transfer) and always
            require an explicit confirmation step.
          </LI>
          <LI>
            <strong>Closed navigation.</strong> When a reply should navigate, it
            resolves an intent through a fixed whitelist. A model never produces a
            route string.
          </LI>
          <LI>
            <strong>Budgets and limits.</strong> Prompt and output caps, per-IP and
            per-wallet rate limits, a daily AI token budget, and bounded
            execution parameters (slippage 1–500 bps, 30-second quote freshness).
          </LI>
          <LI>
            <strong>Untrusted-data discipline.</strong> User text, memory, tool
            output and model output are all treated as untrusted; only validated
            tool arguments reach the execution layer.
          </LI>
        </UL>
        <Callout tone="future" title="FUTURE — configurable autonomy">
          <P>
            User-set spend caps, per-action allowance limits and revocable
            delegated permissions are <Strong>not implemented</Strong>. They are
            tracked at{" "}
            <TLink href="/roadmap#agent-autonomy">
              Roadmap → autonomous agent permissions
            </TLink>
            . Today the guarantee is absolute: one action, one confirmation.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="wallet-security" title="9. Wallet & security model">
        <P>
          MPGR HUB is non-custodial by construction. Reads are open; writes
          require a signed session and a wallet signature.
        </P>
        <UL>
          <LI>
            <strong>Session over address.</strong> A nonce, a SIWE signature and
            an HMAC session cookie. Server handlers take the wallet from the
            session, never from request JSON.
          </LI>
          <LI>
            <strong>No secrets client-side.</strong> No private key, API secret or
            CDP credential is exposed under a <Code>NEXT_PUBLIC_</Code> name.
          </LI>
          <LI>
            <strong>Browser values are a cache.</strong> XP, scores, referrals,
            ranks and reward claims from the browser are never trusted for ranking
            or payouts.
          </LI>
          <LI>
            <strong>Bigint token math.</strong> Integer or bigint arithmetic only —
            never floating-point accounting.
          </LI>
          <LI>
            <strong>Validated boundaries.</strong> Shape, size, range, origin and
            authorization are checked at every API route. Provider, RPC, Redis and
            stack-trace errors are never returned raw.
          </LI>
          <LI>
            <strong>Fail-closed money paths.</strong> Financial game settlement
            requires both operator gates; if either is off, nothing is paid.
          </LI>
        </UL>
        <P>
          Full list: <TLink href="/docs#security">Docs → security model</TLink> and{" "}
          <TLink href="/docs#boundaries">Docs → approval boundaries</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="base-ecosystem" title="10. Base ecosystem">
        <P>
          MPGR HUB is Base-native by design. There is no multi-chain runtime
          today, no bridge and no cross-chain execution path.
        </P>
        <DataTable
          head={["Layer", "How MPGR HUB uses it"]}
          rows={[
            ["Base mainnet", "Sole production chain (8453) — low fees, fast finality, Ethereum security assumptions"],
            ["Coinbase Wallet / Base App", "First-class connection path through RainbowKit"],
            ["Coinbase CDP Trade API", "Onchain swaps for ETH / WETH / USDC / MPGR and Base ERC-20, BYO wallet"],
            ["Coinbase B20 tokenized stocks", "Research plus Aerodrome Slipstream USDC pools; no retail mint API"],
            ["USDC on Base", "Settlement asset for swaps and x402 payments"],
            ["Farcaster Mini App", "Distribution and auto-connect on the Base / Farcaster graph"],
            ["Basenames", "Human-readable transfer recipients, resolved server-side"],
            ["Vercel", "Production host, GitHub-connected"],
          ]}
        />
        <P>
          The Agent never custodially trades a brokerage account, and MPGR HUB is
          not an authorized participant or a broker-dealer. Naming Coinbase, Base,
          USDC, Farcaster, Aerodrome, 0x or Vercel describes public
          infrastructure — it is not a claim of partnership or endorsement.
        </P>
        <P>
          See <TLink href="/docs#base">Docs → Base ecosystem</TLink> and{" "}
          <TLink href="/roadmap#base-expansion">Roadmap → Base expansion</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="trading-execution" title="11. Trading & execution architecture">
        <P>
          MPGR HUB does not invent a DEX, a stock mint API or a custodial broker.
          It composes public Base infrastructure behind one confirmation
          boundary.
        </P>
        <InfoSub>Regular tokens</InfoSub>
        <UL>
          <LI>Quote and price via the Coinbase CDP Trade API on network <Code>base</Code>.</LI>
          <LI>0x Swap API is used as a fallback when CDP will not route the pair.</LI>
          <LI>
            Quotes older than 30 seconds are refreshed; a worse minimum-output
            aborts. Slippage defaults to 1% and is clamped to 0.01%–5%.
          </LI>
          <LI>
            Where the provider requires it, an ERC-20 approval is submitted and
            its receipt confirmed before the swap transaction is sent. Permit2
            signatures are appended for the CDP flow.
          </LI>
        </UL>
        <InfoSub>Tokenized stocks (B20)</InfoSub>
        <UL>
          <LI>
            Holding and secondary-market trading of Coinbase B20 assets are
            permissionless; primary mint and redeem are Authorized Participant
            only.
          </LI>
          <LI>
            A buy or sell in-app is a single-hop Aerodrome Slipstream USDC pool
            swap — not CDP and not 0x.
          </LI>
          <LI>MPGR HUB implements no retail mint path of any kind.</LI>
        </UL>
        <InfoSub>Risk presentation</InfoSub>
        <P>
          Before signing, the confirmation surface shows deterministic risk facts:
          unverified token, no liquidity, incomplete simulation, insufficient
          balance, irreversibility and network. These are computed from the quote
          and the catalog — never guessed.
        </P>
        <P>
          See <TLink href="/docs#trading">Docs → trading</TLink> and{" "}
          <TLink href="/docs#tokenized-stocks">Docs → tokenized stocks</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="mpgr-run" title="12. MPGR Run & the gaming ecosystem">
        <P>
          <Strong>MPGR Run</Strong> is the flagship title: a one-tap endless
          runner using the official MPGR character art, with server-issued
          sessions, heartbeats and authoritative verification.
        </P>
        <UL>
          <LI>
            <strong>Authoritative verification.</strong> The server replays the
            issued seed and the submitted input trace tick-for-tick, recomputes
            the score, and applies drift-tolerant timing checks alongside
            heartbeat, rate and idempotency gates.
          </LI>
          <LI>
            <strong>Progression.</strong> 8 XP per completed run, capped at 10
            XP-earning runs per day. Verified runs also feed weekly stats and
            campaign scoring.
          </LI>
          <LI>
            <strong>Financial payouts are off by default.</strong> Competitive
            monetary rewards require two independent operator gates and the
            pipeline is fail-closed without both.
          </LI>
        </UL>
        <Callout tone="warn" title="Anti-cheat status">
          <P>
            In-process deterministic replay is implemented, but no independent
            anti-cheat audit has been performed. Anti-cheat hardening is listed as{" "}
            <TLink href="/roadmap#mpgr-run">IN PROGRESS</TLink>.
          </P>
        </Callout>
        <P>
          Additional titles (Clicker, Memory Challenge, Space Shooter, 2048 Daily,
          Pet Raising, Speed Run, Roguelike RPG, AI Battle Arena) exist in the
          game registry as <Strong>coming soon</Strong> and are never shown as
          playable. See{" "}
          <TLink href="/roadmap#gaming">Roadmap → gaming ecosystem</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="rewards-economy" title="13. Rewards & XP economy">
        <P>
          The economy has one rule that matters:{" "}
          <strong>rewards are existing tokens from the treasury, never new
          supply</strong>.
        </P>
        <InfoSub>XP and progression</InfoSub>
        <UL>
          <LI>Fixed XP values: connect 50, daily check-in 20, profile 30, share 15, quest 40, referral 100, MPGR Run 8.</LI>
          <LI>XP drives levels and streaks; the authoritative total is a server-owned ledger, not the browser.</LI>
          <LI>Season points are derived from XP earned inside the current UTC month; the Season Pass adds a 20-level reward track over the same season.</LI>
        </UL>
        <InfoSub>Claiming</InfoSub>
        <UL>
          <LI>
            Real MPGR claiming is on-chain via the deployed{" "}
            <Strong>MPGRRewardVault</Strong> (<Code>claim</Code> /{" "}
            <Code>claimMultiple</Code>). A vault reward is allocated or claimed.
          </LI>
          <LI>
            The Reward Hub groups rewards by category and only shows real numbers
            where a live provider exists behind that category.
          </LI>
          <LI>Local mock claim generation was removed — the hub does not invent claimable MPGR.</LI>
        </UL>
        <InfoSub>Gamification surfaces</InfoSub>
        <UL>
          <LI>Achievements computed from the XP record and MPGR Run statistics.</LI>
          <LI>Global leaderboard sourced from the server ranking.</LI>
          <LI>Campaigns: config-driven events with their own points ledger and leaderboard, separate from global XP.</LI>
        </UL>
        <P>
          See <TLink href="/docs#rewards">Docs → rewards</TLink>,{" "}
          <TLink href="/docs#xp">Docs → XP</TLink> and{" "}
          <TLink href="/docs#seasons">Docs → seasons</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="staking" title="14. Staking">
        <P>
          Staking runs against the deployed <Strong>MPGRStaking</Strong> contract
          on Base.
        </P>
        <FactGrid
          items={[
            { label: "Contract", value: MPGR_STAKING_ADDRESS },
            { label: "Model", value: "Single-sided MPGR staking; rewards paid in MPGR" },
            { label: "Lock term", value: "None — stake, claim or unstake at any time" },
            { label: "Minimum stake", value: "100 MPGR (contract constant)" },
            { label: "Reward schedule", value: "730 days (contract constant)" },
            { label: "Reward pool", value: "25,000,000 MPGR (contract constant)" },
            { label: "APR bounds", value: "1% – 100% (contract constants)" },
            { label: "Actions", value: "approve · stake · unstake · claimRewards · exit" },
          ]}
        />
        <P>
          Live APR, total staked, individual stakes and accrued rewards are read
          from the contract with short cache TTLs and background refresh. All
          actions are wallet-signed after an explicit confirmation.
        </P>
        <P>
          Contract:{" "}
          <TLink href={explorerAddressUrl(MPGR_STAKING_ADDRESS)} external>
            view on BaseScan
          </TLink>
          . Interface: <TLink href="/staking">/staking</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="token-lock" title="15. Token lock">
        <P>
          Token lock runs against the deployed, immutable{" "}
          <Strong>MPGRTokenLock V1</Strong> contract.
        </P>
        <FactGrid
          items={[
            { label: "Contract", value: MPGR_TOKEN_LOCK_ADDRESS },
            { label: "Duration presets", value: "30 · 90 · 180 · 365 days" },
            { label: "Early unlock", value: "Allowed any time with a fixed 10% on-chain penalty" },
            { label: "Penalty split", value: "90% returned to the locker, 10% to the penalty recipient" },
            { label: "Drives", value: "Premium tier and Holder Score" },
            { label: "Actions", value: "approve · createLock · withdraw · earlyUnlock" },
          ]}
        />
        <P>
          The penalty is a contract constant, not a UI decision:{" "}
          <Code>earlyUnlock()</Code> computes and executes the split on-chain. The
          app only previews it before you sign.
        </P>
        <P>
          Contract:{" "}
          <TLink href={explorerAddressUrl(MPGR_TOKEN_LOCK_ADDRESS)} external>
            view on BaseScan
          </TLink>
          . Interface: <TLink href="/app/token-lock">/app/token-lock</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="token-utility" title="16. $MPGR token utility">
        <P>
          $MPGR is the unit of the MPGR HUB economy. It is a{" "}
          <Strong>utility token</Strong>, not a security, not an equity claim and
          not a promise of profit.
        </P>
        <UL>
          <LI>
            <strong>Live utility.</strong> Staking yield; lock and holder
            commitment; vault claims; game and season incentives when the operator
            gates are on; referral and quest budgets; and the economic surface the
            Agent operates around (swaps, x402, portfolio).
          </LI>
          <LI>
            <strong>Reputation utility.</strong> Holder tier (badge, frame,
            governance voting weight, reputation bonus) and Premium multipliers
            (1.5× XP, 1.25× rewards) derived from on-chain positions.
          </LI>
          <LI>
            <strong>Future utility.</strong> Governance weight over treasury
            reallocation inside the 100,000,000 MPGR cap, emission rates, campaign
            budgets and the emergency reserve. Governance is{" "}
            <TLink href="/roadmap#token-utility">PLANNED</TLink>, not live.
          </LI>
        </UL>
        <Callout tone="info" title="No paid subscription">
          <P>
            Premium is not sold. It is derived from MPGR you have locked on-chain,
            and it lapses automatically if you release enough of it.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="tokenomics" title="17. Tokenomics">
        <FactGrid
          items={[
            { label: "Name", value: TOKEN_FACTS.name },
            { label: "Symbol", value: TOKEN_FACTS.symbol },
            { label: "Network", value: `${TOKEN_FACTS.network} (${CHAIN_ID})` },
            { label: "Maximum supply", value: `${TOKEN_FACTS.maxSupply} MPGR` },
            { label: "Decimals", value: String(TOKEN_FACTS.decimals) },
            { label: "Inflation", value: TOKEN_FACTS.inflation },
            { label: "Future minting", value: TOKEN_FACTS.futureMinting },
            { label: "Private sale", value: TOKEN_FACTS.privateSale },
            { label: "VC allocation", value: TOKEN_FACTS.vcAllocation },
            { label: "Locked team allocation", value: TOKEN_FACTS.lockedTeam },
          ]}
        />
        <P>
          Token contract:{" "}
          <TLink href={explorerAddressUrl(MPGR_TOKEN_ADDRESS)} external>
            {MPGR_TOKEN_ADDRESS}
          </TLink>
        </P>
        <InfoSub>Initial distribution</InfoSub>
        <DataTable
          head={["Bucket", "Amount", "Share"]}
          rows={INITIAL_DISTRIBUTION.map((row) => [row.label, row.amount, row.share])}
        />
        <P>
          The 90% liquidity allocation is already in market liquidity. The 10%
          treasury funds every MPGR HUB incentive; it is not a hidden team unlock.
        </P>
        <InfoSub>Community treasury — 100,000,000 MPGR</InfoSub>
        <div className="space-y-2">
          {TREASURY_PROGRAMS.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-surface px-3.5 py-2.5"
            >
              <span className="text-[14px] text-muted">{row.label}</span>
              <span className="text-sm font-semibold text-gold">{row.amount}</span>
            </div>
          ))}
        </div>
        <InfoSub>Emission policy</InfoSub>
        <P>
          Rewards are dynamic against user activity, remaining treasury, staking
          participation and seasons. No category emits forever, and rates can be
          slowed to protect the treasury. Unused category balances are not burned
          out of existence; future governance may reallocate undistributed
          treasury within the 100,000,000 cap. The maximum supply stays
          1,000,000,000.
        </P>
        <P>
          Full token page: <TLink href="/token#tokenomics">/$MPGR → tokenomics</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="ai-infrastructure" title="18. AI agent infrastructure">
        <P>
          The Agent is designed so that no single model, vendor or prompt is a
          point of failure or a point of trust.
        </P>
        <UL>
          <LI>
            <strong>Providers.</strong> A common interface with Gemini as the
            default, NVIDIA NIM and OpenAI implemented, and a deterministic
            on-device engine as the final fallback. Anthropic and Ollama are
            declared but unimplemented.
          </LI>
          <LI>
            <strong>Routing and resilience.</strong> Task classification picks a
            provider order; each network provider is wrapped in guardrails, a
            timeout, a circuit breaker and diagnostics.
          </LI>
          <LI>
            <strong>Prompt architecture.</strong> Trusted policy lives in the
            system channel; client and tool context is explicitly labelled
            untrusted so it cannot override it. Stable policy lives in code, not
            only in a prompt.
          </LI>
          <LI>
            <strong>Tool layer.</strong> Every tool declares schema, purpose,
            timeout and risk; prepares are separate from reads; no tool executes a
            wallet write.
          </LI>
          <LI>
            <strong>Cost control.</strong> Prompt and output caps, per-IP and
            per-wallet rate limits, and a daily AI token budget enforced
            atomically.
          </LI>
          <LI>
            <strong>Onchain layer.</strong> Coinbase AgentKit in prepare-only mode
            on Base with a read-action allowlist.
          </LI>
        </UL>
        <P>
          See <TLink href="/docs#ai">Docs → AI architecture</TLink> and{" "}
          <TLink href="/roadmap#ai-provider">Roadmap → AI provider layer</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="x402" title="19. x402 & agentic payments">
        <P>
          x402 is the payment path for agentic and machine-to-machine commerce.
          MPGR HUB implements it with the same confirmation discipline as trading.
        </P>
        <UL>
          <LI>
            <strong>Discover.</strong> The resource is fetched and its 402 payment
            requirements parsed.
          </LI>
          <LI>
            <strong>Register.</strong> The server independently re-fetches the
            resource, applies SSRF and allowlist checks, and stores the
            server-observed terms. Client-supplied terms are not trusted.
          </LI>
          <LI>
            <strong>Confirm and sign.</strong> The user reviews amount, asset,
            recipient and resource, then signs an EIP-3009
            TransferWithAuthorization.
          </LI>
          <LI>
            <strong>Submit.</strong> The payment is submitted against the stored
            registration, so the terms paid are exactly the terms approved.
          </LI>
        </UL>
        <P>
          Scope is deliberately narrow: Base mainnet only (
          <Code>eip155:8453</Code>), the exact scheme only, and a known-asset
          EIP-712 domain is required. There is no silent payment — AgentKit&rsquo;s
          automatic payment actions are denied server-side.
        </P>
        <P>
          See <TLink href="/docs#x402">Docs → x402</TLink> and{" "}
          <TLink href="/roadmap#x402">Roadmap → x402</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="agent-marketplace" title="20. Provider & agent marketplace (future)">
        <Callout tone="future" title="FUTURE — not shipped">
          <P>
            None of the following exists in the product today. It describes
            direction only, and is tracked at{" "}
            <TLink href="/roadmap#marketplace">Roadmap → AI &amp; service
            marketplace</TLink>{" "}
            and{" "}
            <TLink href="/roadmap#agent-economy">Roadmap → agent-to-agent
            economy</TLink>.
          </P>
        </Callout>
        <P>
          The provider abstraction already in the codebase is what makes a
          marketplace plausible later: any model, tool or service that can satisfy
          the tool contract — schema, risk level, timeout, source attribution and
          confirmation behaviour — could be listed, priced and metered.
        </P>
        <UL>
          <LI>
            <strong>Provider marketplace.</strong> Third-party models registering
            behind the same guardrail, timeout and budget stack.
          </LI>
          <LI>
            <strong>Service marketplace.</strong> Tools and agents listed with
            schemas and pricing, paid per call over x402.
          </LI>
          <LI>
            <strong>Agent-to-agent economy.</strong> Agents that discover, quote
            and pay each other inside budgets a human set, with receipts and an
            audit trail.
          </LI>
          <LI>
            <strong>Funding.</strong> The AI ecosystem line in the community
            treasury is the intended long-term incentive source. No allocation
            has been spent on this today.
          </LI>
        </UL>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="long-term-vision" title="21. Long-term ecosystem vision">
        <P>
          The long-term goal is a Base-first onchain operating system: one
          identity, one agent, one rewards graph and one payment rail — where
          playing, trading, earning and delegating all share the same
          confirmation language and the same treasury.
        </P>
        <UL>
          <LI>
            <strong>One agent surface.</strong> Research, execution, games,
            rewards and account control reachable from a single conversation.
          </LI>
          <LI>
            <strong>Bounded autonomy.</strong> Delegated, revocable permissions
            with onchain-enforceable budgets — always opt-in, always auditable.
          </LI>
          <LI>
            <strong>Open ecosystem.</strong> Public APIs, an SDK and partner
            integrations, so MPGR HUB modules can be used outside the app.
          </LI>
          <LI>
            <strong>Holder governance.</strong> Treasury, emissions and campaign
            budgets directed by the community within the fixed supply.
          </LI>
          <LI>
            <strong>Verifiable fun.</strong> Competitive play where the score, the
            ranking and the payout are all provably server-verified.
          </LI>
        </UL>
        <P>
          This section is directional. It is not a commitment, a timeline or an
          offer.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="roadmap" title="22. Roadmap">
        <P>
          Status is tracked per area on the roadmap page, with four explicit
          labels: <Strong>LIVE</Strong>, <Strong>IN PROGRESS</Strong>,{" "}
          <Strong>PLANNED</Strong> and <Strong>LONG-TERM VISION</Strong>. No
          overall completion percentage is shown, because mixing shipped work with
          in-flight and directional items would be misleading.
        </P>
        <P>Start here:</P>
        <LinkGrid
          items={[
            { href: "/roadmap#ai-agent", label: "AI Agent", note: "What the Agent can do today and what comes next." },
            { href: "/roadmap#mpgr-run", label: "MPGR Run", note: "Verification, XP and the financial-reward gates." },
            { href: "/roadmap#x402", label: "x402 & payments", note: "Agentic payment scope and future metering." },
            { href: "/roadmap#security-audit", label: "Security & auditing", note: "What is enforced, and what is still open." },
          ]}
        />
        <P>
          Full roadmap: <TLink href="/roadmap">/roadmap</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="risks" title="23. Risks & limitations">
        <DataTable
          head={["Risk", "Honest status"]}
          rows={[
            [
              "Smart-contract risk",
              "Contracts are deployed and covered by Foundry unit, fuzz and invariant tests in CI. An independent third-party audit has NOT been completed.",
            ],
            [
              "Game integrity",
              "In-process deterministic replay, server sessions, heartbeats and timing/rate/idempotency gates are implemented. No independent anti-cheat certification has been performed, and an external verifier remains an additional operator gate.",
            ],
            [
              "Financial game rewards",
              "Disabled by default. Two independent operator gates must both be enabled, and the pipeline is fail-closed otherwise.",
            ],
            [
              "Referral abuse",
              "Self-referral is blocked and logged; re-attribution is rejected and logged; endpoints are authenticated and rate-limited. Sybil identity resistance is still being hardened.",
            ],
            [
              "Settlement durability",
              "Settlement uses a lock and a reconciliation pass. Vault-level idempotency or a durable outbox is still in progress.",
            ],
            [
              "AI reliability",
              "Model output can be wrong. It is treated as untrusted data, tool arguments are validated, and no write happens without confirmation — but a wrong answer can still be shown.",
            ],
            [
              "Market risk",
              "Swaps, tokenized stocks and token prices are volatile. Slippage, liquidity and routing failures are possible; MPGR HUB does not guarantee execution at a quoted price.",
            ],
            [
              "Custody and key risk",
              "You control your wallet. MPGR HUB cannot recover a lost seed phrase, reverse a confirmed transaction or refund a payment you approved.",
            ],
            [
              "Regulatory risk",
              "Digital-asset regulation varies by jurisdiction and changes over time. Tokenized-stock access in particular may be restricted where you live.",
            ],
            [
              "Single-chain concentration",
              "Base is the only supported chain. A Base outage, congestion or protocol failure affects the whole product.",
            ],
          ]}
        />
        <P>
          Track remediation at{" "}
          <TLink href="/roadmap#security-audit">Roadmap → security</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="disclaimer" title="24. Disclaimer">
        <P>
          This whitepaper is informational. MPGR HUB provides technology services
          and does <Strong>not</Strong> provide financial, investment, legal or
          trading advice. $MPGR is a utility token on Base. Nothing here is an
          offer to sell or a solicitation to buy securities. Digital assets are
          volatile; do your own research; past performance is not indicative of
          future results.
        </P>
        <P>
          MPGR HUB, MoneyPaiger and $MPGR are product and token names of the MPGR
          project. Base, Coinbase, Coinbase Wallet, Coinbase Developer Platform,
          USDC, Farcaster, Vercel, Aerodrome and 0x are trademarks of their
          respective owners. Mention does not imply partnership, endorsement or
          agency.
        </P>
        <P>
          Reward vault contract:{" "}
          <TLink href={explorerAddressUrl(MPGR_REWARD_VAULT_ADDRESS)} external>
            {MPGR_REWARD_VAULT_ADDRESS}
          </TLink>
        </P>
        <P>
          This document may be updated. Version {WHITEPAPER_VERSION} reflects the
          product as of {WHITEPAPER_DATE}.
        </P>
        <LinkGrid
          items={[
            { href: "/docs", label: "Docs", note: "Product documentation, verified against code." },
            { href: "/roadmap", label: "Roadmap", note: "LIVE / IN PROGRESS / PLANNED / LONG-TERM VISION." },
            { href: "/about", label: "About", note: "What MPGR HUB is and why it exists." },
            { href: "/support", label: "Support", note: "Troubleshooting and contact channels." },
          ]}
        />
      </InfoSection>
    </InfoPageShell>
  );
}
