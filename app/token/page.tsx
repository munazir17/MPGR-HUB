import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";
import { MpgrMarketTicker } from "@/components/features/market/MpgrMarketTicker";
import { OFFICIAL_X_TOKEN_ARTICLE, TOKEN_CONTRACT } from "@/lib/content/official";
import {
  INITIAL_DISTRIBUTION,
  TOKEN_FACTS,
  TOKEN_UTILITY,
  TREASURY_PROGRAMS,
} from "@/lib/content/tokenomics";
import { BUY_MPGR_URL } from "@/lib/site";
import { explorerAddressUrl } from "@/lib/chain/base";

export default function TokenPage() {
  return (
    <LegalPage title="$MPGR" subtitle="MoneyPaiger utility token on Base">
      <MpgrMarketTicker />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Object.entries({
          Name: TOKEN_FACTS.name,
          Symbol: TOKEN_FACTS.symbol,
          Network: TOKEN_FACTS.network,
          "Max supply": TOKEN_FACTS.maxSupply,
          Decimals: String(TOKEN_FACTS.decimals),
          Inflation: TOKEN_FACTS.inflation,
        }).map(([k, v]) => (
          <div key={k} className="rounded-xl border border-white/[0.08] bg-surface px-3 py-2">
            <p className="text-[11px] text-muted">{k}</p>
            <p className="text-sm font-medium text-white">{v}</p>
          </div>
        ))}
      </div>

      <p>
        No future minting. No private sale. No VC allocation. No locked team
        allocation. This page is product documentation, not financial advice.
      </p>

      <p className="break-all text-xs">
        Contract:{" "}
        <a
          href={explorerAddressUrl(TOKEN_CONTRACT)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white underline-offset-2 hover:underline"
        >
          {TOKEN_CONTRACT}
        </a>
      </p>

      <a
        href={BUY_MPGR_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex cursor-pointer items-center rounded-full border border-gold/30 bg-gold/10 px-4 py-2 text-sm font-semibold text-gold hover:border-gold/60"
      >
        Buy $MPGR
      </a>

      <h2 id="tokenomics" className="pt-2 text-base font-semibold text-white">
        Initial distribution
      </h2>
      <ul className="list-disc space-y-1 pl-5">
        {INITIAL_DISTRIBUTION.map((row) => (
          <li key={row.id}>
            {row.label}: {row.amount} ({row.share})
          </li>
        ))}
      </ul>

      <h2 className="pt-2 text-base font-semibold text-white">Community treasury (100,000,000)</h2>
      <div className="space-y-2">
        {TREASURY_PROGRAMS.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-surface px-3 py-2">
            <span>{row.label}</span>
            <span className="font-medium text-gold">{row.amount}</span>
          </div>
        ))}
      </div>
      <p>
        Unused category balances are not burned. Future governance may reallocate
        undistributed treasury within the 100,000,000 cap. Max supply stays
        1,000,000,000. All rewards are existing tokens.
      </p>

      <h2 className="pt-2 text-base font-semibold text-white">Token utility</h2>
      <ul className="list-disc space-y-1 pl-5">
        {TOKEN_UTILITY.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h2 className="pt-2 text-base font-semibold text-white">Official X article</h2>
      {OFFICIAL_X_TOKEN_ARTICLE.url ? (
        <a
          href={OFFICIAL_X_TOKEN_ARTICLE.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white underline-offset-2 hover:underline"
        >
          {OFFICIAL_X_TOKEN_ARTICLE.title}
        </a>
      ) : (
        <p>
          Official article URL is not confirmed in the repository.{" "}
          <a
            href="https://x.com/Moneypaiger"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white underline-offset-2 hover:underline"
          >
            @Moneypaiger
          </a>{" "}
          is the official account. Supply the article URL to replace this placeholder.
        </p>
      )}

      <p className="flex flex-wrap gap-x-3">
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
