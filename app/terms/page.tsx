import { LegalPage } from "@/components/layout/LegalPage";

export default function TermsPage() {
  return (
    <LegalPage title="Terms">
      <p>
        By using MPGR HUB you agree to these terms. The Hub is a technology and
        product platform for the MoneyPaiger ecosystem on Base. It is provided
        as-is, without warranties of any kind.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Wallets and transactions</h2>
      <p>
        You control your wallet and every transaction you sign. The Agent may
        prepare a transfer, swap, or x402 payment. Nothing is auto-broadcast.
        Network fees are paid by you. Onchain actions can fail, lose value, or
        become irreversible.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">$MPGR</h2>
      <p>
        $MPGR is a utility token on Base. Nothing on this site is financial,
        investment, legal, or trading advice, or an offer to sell securities.
        Digital assets are volatile.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Games and rewards</h2>
      <p>
        XP and season progression may run while competitive financial game
        rewards stay disabled by default until operator verification is complete.
        Rewards are funded from the existing community treasury. No new $MPGR is
        minted. Rewards, ranks, and game outcomes are not guaranteed.
      </p>
      <h2 className="pt-2 text-base font-semibold text-white">Third-party services</h2>
      <p>
        Base, Coinbase infrastructure, wallets, DEXs, AI providers, and hosts are
        third-party services. Mention does not imply partnership or agency.
      </p>
      <p>
        MPGR HUB does not custody funds and does not act as a broker-dealer or
        authorized participant for tokenized-stock mint/redeem.
      </p>
    </LegalPage>
  );
}
