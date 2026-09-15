import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";
import { SOCIALS } from "@/lib/site";

export default function SupportPage() {
  return (
    <LegalPage title="Support">
      <h2 className="text-base font-semibold text-white">Getting started</h2>
      <p>
        Open Home, read what the Agent can do, then connect a Base wallet when you
        need an onchain action. See{" "}
        <Link href="/docs" className="text-white underline-offset-2 hover:underline">
          Docs
        </Link>{" "}
        and{" "}
        <Link href="/about" className="text-white underline-offset-2 hover:underline">
          About
        </Link>
        .
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Wallet / connect</h2>
      <p>
        Use RainbowKit, Coinbase Wallet, or the Farcaster Mini App path. The app
        is Base mainnet only (8453). If the network is wrong, switch to Base and
        retry.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Agent</h2>
      <p>
        The Agent can research without pretending to execute. Prepare-transfer,
        swap, and x402 flows always show a confirmation. If a reply looks off,
        clear the chat and try again.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Rewards / MPGR Run</h2>
      <p>
        XP is server-owned. Financial game payouts stay off by default. If a
        session fails, start a new run from Rewards after reconnecting.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Transactions</h2>
      <p>
        Review destination, asset, and amount in your wallet before signing.
        Quotes older than 30 seconds are refreshed on the trade path.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Security</h2>
      <p>
        MPGR HUB will never ask for a seed phrase or private key. Report issues
        with a private GitHub Security Advisory, not a public exploit issue.
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <a href={SOCIALS.x} target="_blank" rel="noopener noreferrer" className="text-white underline-offset-2 hover:underline">
            X
          </a>
        </li>
        <li>
          <a href={SOCIALS.telegram} target="_blank" rel="noopener noreferrer" className="text-white underline-offset-2 hover:underline">
            Telegram
          </a>
        </li>
        <li>
          <a href={SOCIALS.discord} target="_blank" rel="noopener noreferrer" className="text-white underline-offset-2 hover:underline">
            Discord
          </a>
        </li>
        <li>
          <a href={SOCIALS.github} target="_blank" rel="noopener noreferrer" className="text-white underline-offset-2 hover:underline">
            GitHub
          </a>
        </li>
      </ul>
    </LegalPage>
  );
}
