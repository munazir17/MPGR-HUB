import Link from "next/link";
import { LegalPage } from "@/components/layout/LegalPage";
import { ROADMAP_HARDENING, ROADMAP_LIVE, ROADMAP_NEXT } from "@/lib/content/roadmap";

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function RoadmapPage() {
  return (
    <LegalPage
      title="Roadmap"
      subtitle="Status against the running product (September 2026), not a marketing slide."
    >
      <p>
        No overall progress percentage is shown. Mixing live work with in-flight
        and next items would be misleading. Use milestone status instead.
      </p>

      <h2 className="pt-2 text-base font-semibold text-white">Live now</h2>
      <List items={ROADMAP_LIVE} />

      <h2 className="pt-2 text-base font-semibold text-white">Hardening / in flight</h2>
      <List items={ROADMAP_HARDENING} />

      <h2 className="pt-2 text-base font-semibold text-white">Next</h2>
      <List items={ROADMAP_NEXT} />

      <p>
        Premium subscription UI is intentionally out of the product. Holder utility
        and lock remain. Unfinished items are not presented as live.
      </p>

      <p className="flex flex-wrap gap-x-3">
        <Link href="/whitepaper" className="text-white underline-offset-2 hover:underline">
          Whitepaper v2.0
        </Link>
        <Link href="/token" className="text-white underline-offset-2 hover:underline">
          $MPGR
        </Link>
      </p>
    </LegalPage>
  );
}
