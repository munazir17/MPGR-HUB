import { LegalPage } from "@/components/layout/LegalPage";

export default function TermsPage() {
  return (
    <LegalPage title="Terms">
      <p>
        By using MPGR HUB you agree to these terms. The Hub is software for
        interacting with the MoneyPaiger ecosystem on Base. It is provided as-is,
        without warranties of any kind.
      </p>
      <p>
        You are responsible for your wallet, private keys, and every transaction
        you sign. Smart-contract interactions can fail, lose value, or become
        irreversible. Network fees are paid by you.
      </p>
      <p>
        MPGR HUB does not custody funds, does not act as a broker, and does not
        guarantee rewards, XP, game outcomes, or token performance. Access may
        change as the product evolves.
      </p>
    </LegalPage>
  );
}
