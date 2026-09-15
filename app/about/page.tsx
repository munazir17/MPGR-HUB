import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";
import { TAGLINE } from "@/lib/site";

export default function AboutPage() {
  return (
    <LegalPage title="About MPGR HUB" subtitle={TAGLINE}>
      <p>
        <strong className="text-white">MPGR HUB</strong> is a Base-native application
        around MoneyPaiger ($MPGR): talk to an AI agent, research and prepare
        onchain actions, play MPGR Run, earn XP and season points, stake and lock
        $MPGR, and claim rewards from a vault.
      </p>
      <p>
        <strong className="text-white">MoneyPaiger / $MPGR</strong> is a
        fixed-supply utility token on Base (Coinbase’s Ethereum Layer 2). Maximum
        supply is 1,000,000,000 MPGR. There is no inflation, no future minting,
        no private sale, no VC allocation, and no locked team allocation.
      </p>
      <p>
        Production runs on <strong className="text-white">Base mainnet only</strong>{" "}
        (chain ID 8453). Mention of Coinbase, Base, or related tools describes
        public infrastructure MPGR HUB uses. It does not imply partnership,
        endorsement, brokerage access, or authorized-participant status.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">What MPGR HUB does</h2>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <strong className="text-white">AI Agent</strong> — research, reason, and
          prepare actions. You confirm and sign.
        </li>
        <li>
          <strong className="text-white">Onchain research</strong> — $MPGR, Base
          markets, and tokenized stocks.
        </li>
        <li>
          <strong className="text-white">Tokenized stocks</strong> — Coinbase B20
          research plus Aerodrome Slipstream USDC pool path. No retail mint API.
        </li>
        <li>
          <strong className="text-white">x402 payments</strong> — the Agent can
          propose a payment; you review amount, destination, and asset, then confirm.
        </li>
        <li>
          <strong className="text-white">MPGR Run</strong> — live endless runner
          with server-issued sessions. Competitive financial game rewards stay
          disabled by default.
        </li>
        <li>
          <strong className="text-white">XP / seasons / leaderboard / rewards</strong>{" "}
          — server-owned XP ledger, check-in, referrals, season pass.
        </li>
        <li>
          <strong className="text-white">Staking, token lock, reward vault</strong>{" "}
          — live Base contracts. Rewards come from the community treasury. No new
          $MPGR is minted.
        </li>
      </ul>
      <h2 className="pt-2 text-base font-semibold text-white">Vision and mission</h2>
      <p>
        Vision: build the leading AI-powered onchain operating system on Base.
        Mission: reward real users, builders, and contributors. Prefer long-term
        utility over short-term hype. Keep supply fixed. Fund rewards from the
        community treasury, not inflation.
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-1">
        <Link href="/token" className="text-white underline-offset-2 hover:underline">
          $MPGR / Tokenomics
        </Link>
        <Link href="/roadmap" className="text-white underline-offset-2 hover:underline">
          Roadmap
        </Link>
        <Link href="/whitepaper" className="text-white underline-offset-2 hover:underline">
          Whitepaper v2.0
        </Link>
      </p>
    </LegalPage>
  );
}
