import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";
import { WHITEPAPER_DATE, WHITEPAPER_VERSION } from "@/lib/content/official";

export default function WhitepaperPage() {
  return (
    <LegalPage
      title={`Whitepaper v${WHITEPAPER_VERSION}`}
      subtitle={`Public product documentation · ${WHITEPAPER_DATE}`}
    >
      <p>
        MPGR HUB is an onchain operating system for agents, payments, games, and
        holder utility — built natively on Base. $MPGR is a utility token. This
        page is informational, not an offer of securities and not financial advice.
      </p>
      <p>Read the structured product docs rather than a dump of the full paper on Home:</p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <Link href="/about" className="text-white underline-offset-2 hover:underline">
            About
          </Link>
        </li>
        <li>
          <Link href="/token" className="text-white underline-offset-2 hover:underline">
            $MPGR and tokenomics
          </Link>
        </li>
        <li>
          <Link href="/roadmap" className="text-white underline-offset-2 hover:underline">
            Roadmap
          </Link>
        </li>
        <li>
          <Link href="/docs" className="text-white underline-offset-2 hover:underline">
            Docs hub
          </Link>
        </li>
      </ul>
      <p>
        Source files in the repository: <code className="text-white">docs/WHITEPAPER.md</code>{" "}
        and the Version {WHITEPAPER_VERSION} product whitepaper used for this update.
      </p>
    </LegalPage>
  );
}
