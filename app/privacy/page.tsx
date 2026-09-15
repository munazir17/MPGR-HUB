import { LegalPage } from "@/components/layout/LegalPage";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy">
      <p>
        MPGR HUB is a wallet-based app. It does not require an email or password.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Wallet and session data</h2>
      <p>
        Wallet addresses, SIWE sessions, and HMAC session cookies are used so
        protected writes can be authorized. A wallet address alone is not treated
        as proof for privileged actions.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Game, XP, and referrals</h2>
      <p>
        Game sessions, XP, ranks, check-in, and referral records may be stored on
        the server ledger so Rewards can function. Browser XP or scores are a
        cache, not proof.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Agent conversations</h2>
      <p>
        Agent messages may be processed by a configured AI provider (Gemini by
        default) to generate replies. Do not paste secrets, seed phrases, or
        private keys into the Agent.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Onchain activity</h2>
      <p>
        Swaps, transfers, locks, stakes, and claims occur on Base and are public
        by nature of the chain.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Third parties</h2>
      <p>
        Wallets, Base RPC, Coinbase Developer Platform, 0x, Aerodrome, Vercel,
        Upstash/Vercel KV, and community platforms (X, Telegram, Discord, GitHub)
        have their own policies. Mention is not an endorsement.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Your responsibility</h2>
      <p>
        You control your wallet. Never share a seed or private key. Report
        vulnerabilities via a private GitHub Security Advisory.
      </p>
    </LegalPage>
  );
}
