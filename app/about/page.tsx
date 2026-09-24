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
import { CHAIN_ID, MPGR_TOKEN_ADDRESS, explorerAddressUrl } from "@/lib/chain/base";
import { BUY_MPGR_URL, SOCIALS, TAGLINE } from "@/lib/site";

// app/about/page.tsx
//
// What MPGR HUB is, why it exists, and how the Agent, the games, the
// rewards layer and the onchain utilities fit together. Current product
// direction and long-term vision are kept in separate sections so the
// second is never mistaken for the first.

export const metadata: Metadata = {
  title: "About — MPGR HUB",
  description:
    "What MPGR HUB is, why it exists, how the MPGR Agent connects games, rewards and onchain utility on Base, and where the product is heading.",
};

const TOC: readonly TocItem[] = [
  { id: "what-is-mpgr-hub", label: "What MPGR HUB is" },
  { id: "why-it-exists", label: "Why it exists" },
  { id: "mpgr-agent", label: "The MPGR Agent" },
  { id: "play-trade-earn", label: "Play · Trade · Earn · AI" },
  { id: "base-focus", label: "Base ecosystem focus" },
  { id: "how-it-fits-together", label: "How it fits together" },
  { id: "product-direction", label: "Current direction" },
  { id: "long-term-vision", label: "Long-term vision" },
  { id: "references", label: "References" },
] as const;

export default function AboutPage() {
  return (
    <InfoPageShell
      title="About MPGR HUB"
      subtitle={TAGLINE}
      meta="A Base-native application around MoneyPaiger ($MPGR) — an AI agent, games, rewards and onchain utility in one place."
      toc={TOC}
    >
      {/* ---------------------------------------------------------------- */}
      <InfoSection id="what-is-mpgr-hub" title="What MPGR HUB is">
        <P>
          <Strong>MPGR HUB</Strong> is a Base-native application built around{" "}
          <Strong>MoneyPaiger ($MPGR)</Strong>. You talk to an AI agent, research
          and prepare onchain actions, play <Strong>MPGR Run</Strong>, earn XP and
          season points, stake and lock $MPGR, and claim rewards from a vault —
          without leaving Base.
        </P>
        <P>
          <Strong>MoneyPaiger / $MPGR</Strong> is a fixed-supply utility token on
          Base, Coinbase&rsquo;s Ethereum Layer 2. Maximum supply is{" "}
          <Strong>1,000,000,000 MPGR</Strong>. There is no inflation, no future
          minting, no private sale, no VC allocation and no locked team
          allocation.
        </P>
        <P>
          Production runs on <Strong>Base mainnet only</Strong> (chain ID{" "}
          <Code>{CHAIN_ID}</Code>). Mention of Coinbase, Base or related tools
          describes public infrastructure MPGR HUB uses — it does not imply
          partnership, endorsement, brokerage access or authorized-participant
          status.
        </P>
        <FactGrid
          items={[
            { label: "Product", value: "MPGR HUB" },
            { label: "Token", value: "MoneyPaiger ($MPGR)" },
            { label: "Network", value: `Base mainnet · ${CHAIN_ID}` },
            { label: "Max supply", value: "1,000,000,000 MPGR" },
          ]}
        />
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="why-it-exists" title="Why it exists">
        <P>
          Most token projects ship a ticker and a landing page. Most AI crypto
          assistants can talk about a transaction but cannot safely prepare one.
          Most gamified products buy attention with new supply. MPGR HUB exists to
          reject all three.
        </P>
        <UL>
          <LI>
            <Strong>Utility before hype.</Strong> The token exists because the
            product needs a unit for staking, locking, claiming and competing — not
            the other way round.
          </LI>
          <LI>
            <Strong>AI that prepares, not AI that presumes.</Strong> The Agent can
            do the hard part — finding the route, validating the recipient,
            pricing the swap — and then stops and asks.
          </LI>
          <LI>
            <Strong>Rewards without dilution.</Strong> Every reward is an existing
            token from the community treasury. Nothing is minted to fund
            engagement.
          </LI>
          <LI>
            <Strong>Verification over trust.</Strong> XP, ranking, referral
            attribution and game scores are computed server-side. The browser is a
            cache, not a witness.
          </LI>
        </UL>
        <P>
          The mission is to reward real users, builders and contributors, and to
          prefer long-term utility over short-term attention.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="mpgr-agent" title="The MPGR Agent concept">
        <P>
          The Agent is the front door. It lives on{" "}
          <TLink href="/">Home</TLink> — there is no separate Agent tab — and it
          works in one loop:{" "}
          <Strong>
            understand → research → reason → plan → confirm → execute → verify
          </Strong>
          .
        </P>
        <UL>
          <LI>
            It <Strong>understands</Strong> intent from a closed list, so an
            unexpected message becomes a research answer rather than an action.
          </LI>
          <LI>
            It <Strong>researches</Strong> with read-only tools and reports where
            each fact came from — or says the data is unavailable.
          </LI>
          <LI>
            It <Strong>reasons</Strong> with a network model, but model output is
            untrusted data: arguments are validated and policy lives outside the
            prompt.
          </LI>
          <LI>
            It <Strong>plans</Strong> a structured proposal that you{" "}
            <Strong>confirm</Strong>, your wallet <Strong>executes</Strong>, and
            the app <Strong>verifies</Strong> against the receipt.
          </LI>
        </UL>
        <Callout tone="info" title="The one rule">
          <P>
            The model suggests; deterministic code decides; the wallet signs. The
            Agent can never move value on its own, and there is no autonomous
            execution path anywhere in the product.
          </P>
        </Callout>
        <P>
          Full detail: <TLink href="/docs#agent">Docs → MPGR Agent</TLink> ·{" "}
          <TLink href="/whitepaper#mpgr-agent">Whitepaper → the MPGR Agent</TLink>
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="play-trade-earn" title="Play · Trade · Earn · AI">
        <P>
          The tagline is a map of the product, not a slogan.
        </P>
        <DataTable
          head={["Pillar", "What is live today"]}
          rows={[
            [
              "Play",
              "MPGR Run — a one-tap endless runner with server-issued sessions and authoritative replay verification. Coming-soon titles are labelled as such and are not playable.",
            ],
            [
              "Trade",
              "Base swaps via the Coinbase CDP Trade API with a 0x fallback, plus Coinbase B20 tokenized-stock orders through Aerodrome Slipstream. Always prepare → confirm → sign.",
            ],
            [
              "Earn",
              "XP, levels, streaks, seasons, achievements, a server-ranked leaderboard, referrals, campaigns, staking, token lock and on-chain reward vault claims.",
            ],
            [
              "AI",
              "The Agent: research, portfolio context, preparation of transfers / swaps / B20 orders / x402 payments, and smart actions into every product area.",
            ],
            [
              "Payments",
              "x402 — discover, register, confirm, sign, submit. Base-only, exact scheme, no silent payment.",
            ],
          ]}
        />
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="base-focus" title="Base ecosystem focus">
        <P>
          MPGR HUB is <Strong>Base-native by design</Strong>. Choosing one chain
          means the whole product can assume the same fees, the same finality, the
          same settlement asset and the same wallet surface — which is what makes a
          single confirmation model possible.
        </P>
        <DataTable
          head={["Layer", "Usage"]}
          rows={[
            ["Base mainnet", "Sole production chain — low fees, fast finality, Ethereum security assumptions"],
            ["Coinbase Wallet / Base App", "First-class connection path"],
            ["Coinbase CDP Trade API", "Swap quotes and swap transactions, BYO wallet"],
            ["Coinbase B20 tokenized stocks", "Research and secondary-market trading"],
            ["USDC on Base", "Settlement asset for swaps and x402 payments"],
            ["Farcaster Mini App", "Distribution and auto-connect"],
            ["Basenames", "Human-readable transfer recipients"],
          ]}
        />
        <P>
          Cross-chain support is not part of the current runtime and is not
          committed. See{" "}
          <TLink href="/roadmap#base-expansion">Roadmap → Base expansion</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="how-it-fits-together" title="How it fits together">
        <P>
          The Agent, the games, the rewards layer and the onchain utilities are
          not four products — they are one loop with four entry points.
        </P>
        <UL>
          <LI>
            <Strong>The Agent is the interpreter.</Strong> It turns a question or
            an intention into either an answer or a validated proposal, and it can
            hand you to the right surface when the answer is “go do this”.
          </LI>
          <LI>
            <Strong>Games generate verified activity.</Strong> MPGR Run produces
            server-verified runs that feed XP, weekly stats and campaign scoring.
          </LI>
          <LI>
            <Strong>The rewards layer keeps score.</Strong> A server-owned XP
            ledger, season points, achievements and a ranking that no client can
            inflate.
          </LI>
          <LI>
            <Strong>Onchain utility gives it weight.</Strong> Staking, token lock
            and the reward vault turn participation into real positions, and
            locked MPGR drives Premium tier and Holder Score.
          </LI>
          <LI>
            <Strong>$MPGR is the unit.</Strong> Staking yield, lock commitment,
            vault claims, game and season incentives, referral and quest budgets,
            and the surface the Agent operates around.
          </LI>
        </UL>
        <P>
          A typical path: ask the Agent a question → it researches and answers →
          you play a few runs → XP and season points move → you lock some MPGR →
          your Premium tier and Holder Score change → the Agent&rsquo;s next
          portfolio answer reflects the new position.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="product-direction" title="Current direction">
        <P>
          What the team is working on right now, stated plainly.
        </P>
        <UL>
          <LI>
            <Strong>Deepening the Agent.</Strong> Broader tool coverage and richer
            multi-step research answers, without loosening the confirmation
            boundary.
          </LI>
          <LI>
            <Strong>Hardening game integrity.</Strong> Anti-cheat beyond
            deterministic replay and heartbeat gates, and a formal enablement
            review for financial game rewards.
          </LI>
          <LI>
            <strong>Security maturity.</strong> An independent smart-contract
            audit, vault-level settlement idempotency, referral sybil resistance,
            and a performance and production-funding review.
          </LI>
          <LI>
            <Strong>Operational reliability.</Strong> History backfill performance
            within provider RPC limits, and game asset optimisation.
          </LI>
        </UL>
        <Callout tone="warn" title="Still open, deliberately disclosed">
          <P>
            An independent contract audit has not been completed, financial game
            rewards are disabled by default, and governance is not live. See{" "}
            <TLink href="/roadmap#security-audit">Roadmap → security</TLink> and{" "}
            <TLink href="/whitepaper#risks">Whitepaper → risks</TLink>.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="long-term-vision" title="Long-term vision">
        <P>
          The goal is a <Strong>Base-first onchain operating system</Strong>: one
          identity, one agent, one rewards graph and one payment rail — where
          playing, trading, earning and delegating share the same confirmation
          language and the same treasury.
        </P>
        <UL>
          <LI>
            <Strong>Bounded autonomy.</Strong> Delegated, revocable agent
            permissions with onchain-enforceable budgets, always opt-in and always
            auditable.
          </LI>
          <LI>
            <strong>Open ecosystem.</strong> Public APIs, an SDK and partner
            integrations built on the modules that already exist.
          </LI>
          <LI>
            <strong>Agent economy.</strong> Agents that discover, quote and pay
            each other over x402, inside limits a human set.
          </LI>
          <LI>
            <strong>Holder governance.</strong> Treasury, emissions and campaign
            budgets directed by the community within the fixed supply.
          </LI>
        </UL>
        <Callout tone="future" title="Vision, not a promise">
          <P>
            This section is directional. It is not a commitment, a timeline or an
            offer, and no dates are attached to it. Status is tracked at{" "}
            <TLink href="/roadmap">/roadmap</TLink>.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="references" title="References">
        <P>
          Token contract:{" "}
          <TLink href={explorerAddressUrl(MPGR_TOKEN_ADDRESS)} external>
            {MPGR_TOKEN_ADDRESS}
          </TLink>{" "}
          — verify every contract and transaction yourself on BaseScan.
        </P>
        <LinkGrid
          items={[
            {
              href: "https://github.com/munazir17/MPGR-HUB",
              label: "GitHub",
              note: "Source, architecture notes and security documentation.",
              external: true,
            },
            {
              href: SOCIALS.x,
              label: "X — @Moneypaiger",
              note: "Official announcements.",
              external: true,
            },
            {
              href: SOCIALS.telegram,
              label: "Telegram",
              note: "Community chat.",
              external: true,
            },
            {
              href: SOCIALS.discord,
              label: "Discord",
              note: "Community server.",
              external: true,
            },
            {
              href: BUY_MPGR_URL,
              label: "Buy $MPGR",
              note: "Official launch listing on Base.",
              external: true,
            },
            { href: "/token", label: "$MPGR", note: "Token facts, distribution and treasury programs." },
            { href: "/docs", label: "Docs", note: "How every part of the product actually works." },
            { href: "/whitepaper", label: "Whitepaper", note: "Architecture, safety model, economics and risks." },
            { href: "/roadmap", label: "Roadmap", note: "LIVE / IN PROGRESS / PLANNED / LONG-TERM VISION." },
            { href: "/support", label: "Support", note: "Troubleshooting and contact channels." },
          ]}
        />
        <InfoSub>Legal</InfoSub>
        <P>
          See <TLink href="/terms">Terms</TLink> and{" "}
          <TLink href="/privacy">Privacy</TLink>. MPGR HUB provides technology
          services and does not provide financial, investment or trading advice.
        </P>
      </InfoSection>
    </InfoPageShell>
  );
}
