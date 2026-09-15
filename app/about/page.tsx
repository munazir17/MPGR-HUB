import { LegalPage } from "@/components/layout/LegalPage";
import { TAGLINE } from "@/lib/site";

export default function AboutPage() {
  return (
    <LegalPage title="About">
      <p>
        MPGR HUB is the home of the MoneyPaiger ecosystem on Base. {TAGLINE}
      </p>
      <p>
        Talk to the MPGR Agent on Home. Use Rewards for MPGR Run, XP, seasons,
        the leaderboard, and claims. Manage your wallet, referrals, and holder
        status from Profile.
      </p>
      <p>
        The Agent can research, reason, and prepare onchain actions — including
        tokenized stocks and x402 payments — for your explicit confirmation.
        Nothing signs or sends without you.
      </p>
    </LegalPage>
  );
}
