import { LegalPage } from "@/components/layout/LegalPage";
import { SOCIALS } from "@/lib/site";

export default function SupportPage() {
  return (
    <LegalPage title="Support">
      <p>Reach the MPGR community through the official channels:</p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <a href={SOCIALS.x} target="_blank" rel="noopener noreferrer" className="text-white hover:underline">
            X
          </a>
        </li>
        <li>
          <a href={SOCIALS.telegram} target="_blank" rel="noopener noreferrer" className="text-white hover:underline">
            Telegram
          </a>
        </li>
        <li>
          <a href={SOCIALS.discord} target="_blank" rel="noopener noreferrer" className="text-white hover:underline">
            Discord
          </a>
        </li>
        <li>
          <a href={SOCIALS.github} target="_blank" rel="noopener noreferrer" className="text-white hover:underline">
            GitHub
          </a>
        </li>
      </ul>
      <p>
        Never share your seed phrase or private key. MPGR HUB will never ask for
        them.
      </p>
    </LegalPage>
  );
}
