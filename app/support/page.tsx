import type { Metadata } from "next";

import { InfoPageShell } from "@/components/layout/InfoPageShell";
import {
  Callout,
  Code,
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
import { CHAIN_ID } from "@/lib/chain/base";
import { SOCIALS } from "@/lib/site";

// app/support/page.tsx
//
// Genuinely useful support: the failure modes people actually hit on a
// Base-native, wallet-signed app, what to check, and which section of the
// docs explains it. Nothing here promises a fix that the product cannot
// deliver (for example: MPGR HUB cannot reverse a confirmed transaction).

export const metadata: Metadata = {
  title: "Support — MPGR HUB",
  description:
    "MPGR HUB support: wallet and connection issues, transaction and confirmation guidance, Agent behaviour, swap troubleshooting, rewards and game questions, security reminders and contact channels.",
};

const TOC: readonly TocItem[] = [
  { id: "getting-started", label: "Getting started" },
  { id: "wallet", label: "Wallet & connection" },
  { id: "transactions", label: "Transactions & confirmations" },
  { id: "agent", label: "Agent behaviour" },
  { id: "trading", label: "Trading & swaps" },
  { id: "rewards", label: "Rewards, XP & seasons" },
  { id: "games", label: "MPGR Run & games" },
  { id: "staking-lock", label: "Staking & token lock" },
  { id: "security", label: "Security reminders" },
  { id: "docs", label: "Docs shortcuts" },
  { id: "community", label: "Community & contact" },
] as const;

export default function SupportPage() {
  return (
    <InfoPageShell
      title="Support"
      subtitle="Practical help for the things that actually go wrong — connecting a wallet, confirming a transaction, understanding what the Agent will and will not do, and where your rewards come from."
      meta={`MPGR HUB runs on Base mainnet only (chain ID ${CHAIN_ID}). Most issues come down to network, session or quote freshness.`}
      toc={TOC}
    >
      {/* ---------------------------------------------------------------- */}
      <InfoSection id="getting-started" title="Getting started">
        <P>
          You can read, research and browse without connecting a wallet. Connect
          only when you are about to do something onchain.
        </P>
        <UL>
          <LI>
            Start on <TLink href="/">Home</TLink> — that <Strong>is</Strong> the
            MPGR Agent. There is no separate Agent tab.
          </LI>
          <LI>
            Ask a question first (“what is MPGR?”, “research Base markets”,
            “analyze my portfolio”). The Agent answers from read-only tools.
          </LI>
          <LI>
            When you want an action, ask for it in plain language. The Agent
            prepares a proposal; nothing is signed until you confirm.
          </LI>
        </UL>
        <P>
          New here? Read <TLink href="/about#what-is-mpgr-hub">About</TLink> and{" "}
          <TLink href="/docs#getting-started">Docs → getting started</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="wallet" title="Wallet & connection">
        <InfoSub>“Wrong network” in the header</InfoSub>
        <P>
          MPGR HUB is Base mainnet only (<Code>{CHAIN_ID}</Code>). Tap{" "}
          <Strong>Wrong network</Strong> and switch to Base in your wallet, then
          retry. Adding Base manually is rarely necessary — Coinbase Wallet,
          Rainbow and most injected wallets already ship it.
        </P>
        <InfoSub>The wallet won’t connect</InfoSub>
        <UL>
          <LI>
            Use a supported path: Coinbase Wallet, WalletConnect, an injected
            browser wallet, or the Farcaster Mini App connector.
          </LI>
          <LI>
            If you are inside an in-app browser, open MPGR HUB in your
            wallet&rsquo;s own browser or in a normal mobile browser with
            WalletConnect.
          </LI>
          <LI>
            If a previous connection is stuck, disconnect from the wallet side and
            refresh the page.
          </LI>
        </UL>
        <InfoSub>“Authentication required” on an action</InfoSub>
        <P>
          Protected writes need a signed session, not just a connected address.
          When prompted, sign the SIWE message — it is a signature, not a
          transaction, and it costs no gas. If the session has expired, sign out
          from <TLink href="/profile">Profile</TLink> and sign in again.
        </P>
        <InfoSub>Rate limited</InfoSub>
        <P>
          AI, XP, referral, x402 and trade routes are rate-limited per IP and per
          wallet, with a daily AI token budget. If you hit a limit, wait and
          retry — it is not a bug and retrying faster will not help.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="transactions" title="Transactions & confirmations">
        <InfoSub>Before you sign</InfoSub>
        <UL>
          <LI>
            Check the <Strong>amount</Strong>, the <Strong>asset</Strong>, the{" "}
            <Strong>destination or route</Strong>, and the{" "}
            <Strong>network</Strong> in your wallet, not only in the app.
          </LI>
          <LI>
            Read the risk facts in the confirmation. “Unverified token”, “no
            liquidity” and “insufficient balance” are blockers, not decorations.
          </LI>
          <LI>
            An <Strong>approval</Strong> transaction is not the action itself —
            for some swaps it is a prerequisite, and its receipt is confirmed
            before the swap is sent.
          </LI>
        </UL>
        <InfoSub>After you sign</InfoSub>
        <UL>
          <LI>
            The app waits for the receipt and reports success or failure from the
            receipt status. A failed transaction is reported as failed.
          </LI>
          <LI>
            If a transaction is pending for a long time, check the hash on
            BaseScan. Congestion and low gas are outside the app&rsquo;s control.
          </LI>
          <LI>
            If it reverted, the usual causes are slippage exceeded, a stale quote,
            insufficient balance or a revoked allowance.
          </LI>
        </UL>
        <Callout tone="danger" title="MPGR HUB cannot reverse a transaction">
          <P>
            Once a transaction is confirmed on Base it is final. MPGR HUB cannot
            cancel it, recall it or refund it — and nobody contacting you claiming
            otherwise is legitimate. Always verify the destination before signing.
          </P>
        </Callout>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="agent" title="Agent behaviour">
        <InfoSub>The Agent will never do these</InfoSub>
        <UL>
          <LI>Sign, broadcast or pay on its own.</LI>
          <LI>Hold your keys, your funds, or a balance on your behalf.</LI>
          <LI>Ask for your seed phrase or private key.</LI>
          <LI>Claim a transaction succeeded before it is confirmed on-chain.</LI>
        </UL>
        <InfoSub>“The Agent gave me an unexpected answer”</InfoSub>
        <UL>
          <LI>
            Model output is text, not authority. Treat numbers it gives you as a
            starting point and confirm in the product surfaces.
          </LI>
          <LI>
            If a live value looks wrong or is missing, the correct behaviour is{" "}
            <Code>DATA_UNAVAILABLE</Code> — not a guess. Wait and retry.
          </LI>
          <LI>
            Clear the conversation and restate the request in one sentence. The
            intent detector works on a closed intent list, so precise phrasing
            helps.
          </LI>
        </UL>
        <InfoSub>“The Agent asked me to confirm something I didn’t ask for”</InfoSub>
        <P>
          Cancel it. Nothing has been signed until you approve it in your wallet.
          Every value-moving action — transfer, swap, B20 order, x402 payment —
          requires an explicit confirmation, and cancelling costs nothing.
        </P>
        <P>
          More detail: <TLink href="/docs#agent">Docs → MPGR Agent</TLink> and{" "}
          <TLink href="/docs#agent-workflow">Docs → Agent workflow</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="trading" title="Trading & swaps">
        <UL>
          <LI>
            <Strong>“Quote expired”.</Strong> Quotes are valid for 30 seconds and
            are refreshed automatically; a worse minimum-output aborts the
            execution. Request the quote again.
          </LI>
          <LI>
            <Strong>“No liquidity”.</Strong> The provider reported no route or no
            pool liquidity for that pair. Nothing will be signed. Try a smaller
            size, a different pair, or a different asset.
          </LI>
          <LI>
            <Strong>Slippage too high.</Strong> Slippage is clamped to 0.01%–5%
            (1% default). If a trade needs more than 5%, MPGR HUB will not
            prepare it — that is intentional protection, not a bug.
          </LI>
          <LI>
            <strong>Tokenized stocks behave differently.</strong> Coinbase B20
            assets (AAPLc, TSLAc, NVDAc and the rest) route through Aerodrome
            Slipstream USDC pools, not CDP or 0x, and there is no retail mint path.
          </LI>
          <LI>
            <Strong>Reverted swap.</Strong> Usually slippage moved against you
            between quote and execution. Retry with a fresh quote.
          </LI>
        </UL>
        <P>
          See <TLink href="/docs#trading">Docs → trading &amp; swaps</TLink> and{" "}
          <TLink href="/docs#tokenized-stocks">Docs → tokenized stocks</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="rewards" title="Rewards, XP & seasons">
        <UL>
          <LI>
            <Strong>XP looks stale.</Strong> The authoritative XP total is the
            server ledger (<Code>/api/xp</Code>), not the browser. The app syncs
            it; a browser value is only a cache.
          </LI>
          <LI>
            <Strong>Rank looks wrong.</Strong> The leaderboard is built from the
            server ranking. Client scores are never used for ranking, so a local
            value that disagrees with the board is the local value that is wrong.
          </LI>
          <LI>
            <Strong>Claiming.</Strong> Real MPGR claims are on-chain through the
            deployed reward vault. If a claim fails, it is a wallet or network
            issue — check the transaction on BaseScan.
          </LI>
          <LI>
            <Strong>Season points reset.</Strong> Seasons run on UTC calendar
            months. Season points are the XP you earned inside the current window,
            so they restart each month by design.
          </LI>
          <LI>
            <Strong>Referrals.</Strong> A referral is credited once the referred
            wallet holds a valid signed session. Self-referral is blocked and
            logged, and re-attributing a wallet is rejected.
          </LI>
        </UL>
        <P>
          See <TLink href="/docs#rewards">Docs → rewards</TLink>,{" "}
          <TLink href="/docs#xp">Docs → XP</TLink> and{" "}
          <TLink href="/docs#seasons">Docs → seasons</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="games" title="MPGR Run & games">
        <UL>
          <LI>
            <Strong>A run did not register.</Strong> Runs are server-issued and
            verified. If the session expired, lost heartbeat, or your connection
            dropped, start a new run from{" "}
            <TLink href="/games/mpgr-run">MPGR Run</TLink> after reconnecting.
          </LI>
          <LI>
            <Strong>XP is capped.</Strong> MPGR Run awards 8 XP per completed run,
            capped at 10 XP-earning runs per day. Extra runs still count toward
            campaign and eligibility logic.
          </LI>
          <LI>
            <Strong>No cash rewards yet.</Strong> Competitive{" "}
            <Strong>financial</Strong> game payouts are disabled by default behind
            two operator gates. XP and season progression run regardless.
          </LI>
          <LI>
            <strong>Only one game is playable.</strong> MPGR Run is the only live
            title. Everything else in the catalog is marked coming soon and is not
            playable.
          </LI>
          <LI>
            <strong>Performance on mobile.</strong> Close other tabs, keep the
            game tab in the foreground, and make sure the session stays connected
            during a run.
          </LI>
        </UL>
        <P>
          See <TLink href="/docs#mpgr-run">Docs → MPGR Run</TLink> and{" "}
          <TLink href="/roadmap#mpgr-run">Roadmap → MPGR Run</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="staking-lock" title="Staking & token lock">
        <UL>
          <LI>
            <Strong>Stake below the minimum.</Strong> The staking contract
            enforces a 100 MPGR minimum per stake.
          </LI>
          <LI>
            <strong>Staking has no lock term.</strong> You can stake, claim or
            unstake at any time; rewards accrue continuously.
          </LI>
          <LI>
            <strong>Token lock is a commitment.</strong> Early unlock is always
            available but the contract takes a fixed <Strong>10% penalty</Strong> —
            90% returns to you, 10% goes to the penalty recipient. That split is
            executed on-chain, not by the app.
          </LI>
          <LI>
            <strong>Numbers look delayed.</strong> Contract reads are cached for
            short TTLs and refreshed in the background; give it a few seconds or
            reload.
          </LI>
          <LI>
            <strong>History is backfilled progressively.</strong> Older staking
            events appear over successive refresh cycles rather than all at once.
          </LI>
        </UL>
        <P>
          See <TLink href="/docs#staking">Docs → staking</TLink> and{" "}
          <TLink href="/docs#token-lock">Docs → token lock</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="security" title="Security reminders">
        <Callout tone="danger" title="Never share these">
          <P>
            Your <Strong>seed phrase</Strong>, <Strong>private key</Strong>, or any
            recovery phrase. MPGR HUB will{" "}
            <Strong>never</Strong> ask for them — not in the Agent, not in a
            support channel, not anywhere.
          </P>
        </Callout>
        <UL>
          <LI>
            MPGR HUB is non-custodial. Nobody on the team can move your funds or
            recover your wallet.
          </LI>
          <LI>
            There is no official “support DM”. Anyone contacting you first with a
            fix, an airdrop or a refund is a scam.
          </LI>
          <LI>
            Verify contracts and transactions on BaseScan yourself. Contract
            addresses are listed in{" "}
            <TLink href="/whitepaper#tokenomics">the whitepaper</TLink>.
          </LI>
          <LI>
            Beware of look-alike tokens. $MPGR has a fixed supply and a published
            contract address — check it before you buy.
          </LI>
          <LI>
            Do not paste secrets, seed phrases or private keys into the Agent
            conversation.
          </LI>
          <LI>
            Report vulnerabilities <Strong>privately</Strong> through a GitHub
            Security Advisory. Never post exploit details in a public issue.
          </LI>
        </UL>
        <P>
          See <TLink href="/docs#security">Docs → security model</TLink> and{" "}
          <TLink href="/whitepaper#risks">Whitepaper → risks</TLink>.
        </P>
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="docs" title="Docs shortcuts">
        <P>The sections people need most often:</P>
        <LinkGrid
          items={[
            { href: "/docs#overview", label: "Overview", note: "What MPGR HUB is, in four product areas." },
            { href: "/docs#agent", label: "MPGR Agent", note: "What it can and cannot do." },
            { href: "/docs#agent-workflow", label: "Agent workflow", note: "Understand → verify, stage by stage." },
            { href: "/docs#wallet", label: "Wallet & confirmations", note: "Sessions, SIWE and the confirmation step." },
            { href: "/docs#boundaries", label: "Approval boundaries", note: "Every enforced limit, in one table." },
            { href: "/docs#protocols", label: "Protocols & actions", note: "The exact tool and contract surface." },
            { href: "/docs#trading", label: "Trading & swaps", note: "Routing, slippage, freshness, risk facts." },
            { href: "/docs#x402", label: "x402 payments", note: "Discover → register → confirm → sign → submit." },
            { href: "/docs#mpgr-run", label: "MPGR Run", note: "Sessions, verification, XP and reward gates." },
            { href: "/docs#staking", label: "Staking", note: "Contract facts and actions." },
            { href: "/docs#token-lock", label: "Token lock", note: "Presets, penalty and what it powers." },
            { href: "/docs#faq", label: "FAQ", note: "Short answers to the common questions." },
          ]}
        />
      </InfoSection>

      {/* ---------------------------------------------------------------- */}
      <InfoSection id="community" title="Community & contact">
        <P>
          Official channels. Anyone else claiming to be official support is not.
        </P>
        <LinkGrid
          items={[
            { href: SOCIALS.x, label: "X — @Moneypaiger", note: "Announcements and status updates.", external: true },
            { href: SOCIALS.telegram, label: "Telegram", note: "Community chat.", external: true },
            { href: SOCIALS.discord, label: "Discord", note: "Community server.", external: true },
            {
              href: "https://github.com/munazir17/MPGR-HUB/issues",
              label: "GitHub issues",
              note: "Bugs and feature requests — never exploit details.",
              external: true,
            },
          ]}
        />
        <InfoSub>Before you report a bug</InfoSub>
        <UL>
          <LI>Note the route or page, what you expected and what happened.</LI>
          <LI>
            If it involves a transaction, include the hash — but never include a
            seed phrase, private key or API secret.
          </LI>
          <LI>
            Confirm you are on Base mainnet (<Code>{CHAIN_ID}</Code>) and that
            your session is signed in.
          </LI>
        </UL>
        <P>
          Related: <TLink href="/docs">Docs</TLink> ·{" "}
          <TLink href="/roadmap">Roadmap</TLink> ·{" "}
          <TLink href="/about">About</TLink> ·{" "}
          <TLink href="/terms">Terms</TLink> · <TLink href="/privacy">Privacy</TLink>
        </P>
      </InfoSection>
    </InfoPageShell>
  );
}
