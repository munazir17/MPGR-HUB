import { LegalPage } from "@/components/layout/LegalPage";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy">
      <p>
        MPGR HUB is a wallet-based app. We do not require an email or password.
        Wallet addresses, on-chain activity, referrals, and game sessions may be
        stored so the Hub can show XP, ranks, and rewards.
      </p>
      <p>
        Agent conversations may be processed by an AI provider to generate replies.
        Do not paste secrets, seed phrases, or private keys into the Agent.
      </p>
      <p>
        Third-party wallets, Base RPC providers, and community platforms (X,
        Telegram, Discord, GitHub) have their own privacy policies.
      </p>
    </LegalPage>
  );
}
