import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";

export default function DocsPage() {
  return (
    <LegalPage title="Docs">
      <p>Start here:</p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <Link href="/" className="text-white hover:underline">
            Home / Agent
          </Link>{" "}
          — chat, research, and prepare onchain actions.
        </li>
        <li>
          <Link href="/rewards" className="text-white hover:underline">
            Rewards
          </Link>{" "}
          — MPGR Run, XP, seasons, leaderboard, and claims.
        </li>
        <li>
          <Link href="/profile" className="text-white hover:underline">
            Profile
          </Link>{" "}
          — wallet, referrals, staking, and token lock.
        </li>
        <li>
          <Link href="/games/mpgr-run" className="text-white hover:underline">
            MPGR Run
          </Link>{" "}
          — playable endless runner on Base.
        </li>
      </ul>
      <p>
        Writes never happen without a wallet confirmation. The Agent prepares;
        you sign.
      </p>
    </LegalPage>
  );
}
