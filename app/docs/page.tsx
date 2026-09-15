import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";

const LINKS: { href: string; label: string; note: string }[] = [
  { href: "/", label: "Getting started", note: "Home is the Agent. Connect when you need an onchain action." },
  { href: "/", label: "MPGR Agent", note: "Research, reason, prepare. User wallet signs." },
  { href: "/", label: "How the Agent works", note: "understand → research → reason → plan → confirm → execute → verify." },
  { href: "/", label: "Wallet & confirmations", note: "RainbowKit / Coinbase Wallet / Farcaster Mini App. Base-only." },
  { href: "/", label: "Research / Trade / Portfolio", note: "Quick actions on Home. Trade is prepare + confirm." },
  { href: "/rewards", label: "Rewards", note: "XP, seasons, claims, check-in, referrals." },
  { href: "/games/mpgr-run", label: "MPGR Run", note: "Live runner. Financial game payouts stay gated off by default." },
  { href: "/rewards", label: "XP & seasons", note: "Server-owned XP ledger. Browser XP is a cache." },
  { href: "/token", label: "$MPGR", note: "Fixed-supply utility token on Base." },
  { href: "/token#tokenomics", label: "Tokenomics", note: "90% LP, 10% community treasury." },
  { href: "/profile", label: "Staking & token lock", note: "Live contracts on Base. 10% on-chain early-unlock penalty." },
  { href: "/", label: "x402", note: "Payment proposals. No silent payment." },
  { href: "/", label: "Tokenized stocks", note: "B20 research + Aerodrome Slipstream. No retail mint." },
  { href: "/about", label: "Base", note: "Sole production chain, ID 8453." },
  { href: "/docs", label: "Security", note: "No keys in the client. Writes need a signed session and user confirm." },
  { href: "/roadmap", label: "Roadmap", note: "Live / hardening / next." },
  { href: "/whitepaper", label: "Whitepaper v2.0", note: "Product documentation, September 2026." },
];

export default function DocsPage() {
  return (
    <LegalPage title="Docs" subtitle="MPGR HUB product documentation">
      <p>
        Writes never happen without a wallet confirmation. The Agent prepares; you sign.
      </p>
      <ul className="space-y-3">
        {LINKS.map((item) => (
          <li key={`${item.href}-${item.label}`} className="rounded-xl border border-white/[0.07] bg-surface px-3 py-2.5">
            <Link href={item.href} className="cursor-pointer font-medium text-white underline-offset-2 hover:underline">
              {item.label}
            </Link>
            <p className="mt-1 text-xs text-muted">{item.note}</p>
          </li>
        ))}
      </ul>
      <p>
        Official references:{" "}
        <a href="https://mpgrhub.xyz" className="text-white underline-offset-2 hover:underline">
          mpgrhub.xyz
        </a>
        ,{" "}
        <a href="https://github.com/munazir17/MPGR-HUB" className="text-white underline-offset-2 hover:underline">
          GitHub
        </a>
        ,{" "}
        <a href="https://x.com/Moneypaiger" className="text-white underline-offset-2 hover:underline">
          @Moneypaiger
        </a>
        ,{" "}
        <a href="https://basescan.org" className="text-white underline-offset-2 hover:underline">
          BaseScan
        </a>
        .
      </p>
    </LegalPage>
  );
}
