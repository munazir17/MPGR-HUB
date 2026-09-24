import type { Metadata } from "next";

import { InfoPageShell } from "@/components/layout/InfoPageShell";
import {
  Callout,
  InfoSection,
  LI,
  P,
  StatusBadge,
  Strong,
  TLink,
  UL,
  type TocItem,
} from "@/components/layout/info-ui";
import {
  ROADMAP_STATUS_ORDER,
  ROADMAP_TRACKS,
  type RoadmapItem,
  type RoadmapStatus,
} from "@/lib/content/roadmap";

// app/roadmap/page.tsx
//
// The public roadmap. Every item carries an explicit status so the page
// never implies that planned work is already shipped. No dates, partners,
// allocations or launch commitments are invented anywhere on this page.

export const metadata: Metadata = {
  title: "Roadmap — MPGR HUB",
  description:
    "The MPGR HUB roadmap: AI agent, onchain execution, x402, gaming, rewards, staking, token lock, Base expansion, security and developer ecosystem — labelled LIVE, IN PROGRESS, PLANNED or LONG-TERM VISION.",
};

const STATUS_MEANING: Record<RoadmapStatus, string> = {
  LIVE: "Shipped and reachable in the running product today.",
  "IN PROGRESS": "Underway — partially shipped, or shipped and still being hardened.",
  PLANNED: "Intended next work. Not shipped, and no date is promised.",
  "LONG-TERM VISION": "Directional. Explains where the product is heading and may change shape.",
};

const TOC: readonly TocItem[] = [
  { id: "status-legend", label: "How to read this" },
  ...ROADMAP_TRACKS.map((track) => ({ id: track.id, label: track.title })),
  { id: "not-planned", label: "Explicitly not planned" },
];

function countByStatus(): Record<RoadmapStatus, number> {
  const counts: Record<RoadmapStatus, number> = {
    LIVE: 0,
    "IN PROGRESS": 0,
    PLANNED: 0,
    "LONG-TERM VISION": 0,
  };
  for (const track of ROADMAP_TRACKS) {
    for (const item of track.items) counts[item.status] += 1;
  }
  return counts;
}

function RoadmapItems({ items }: { items: readonly RoadmapItem[] }) {
  // Group by status so the shipped work reads first and the vision reads
  // last, in the same order everywhere on the page.
  const ordered: RoadmapItem[] = ROADMAP_STATUS_ORDER.flatMap((status) =>
    items.filter((item) => item.status === status),
  );

  return (
    <ul className="space-y-2">
      {ordered.map((item) => (
        <li
          key={item.label}
          className="flex flex-col gap-1.5 rounded-xl border border-white/[0.07] bg-surface px-3.5 py-2.5 sm:flex-row sm:items-start sm:gap-3"
        >
          <StatusBadge status={item.status} />
          <span className="text-[14px] leading-[1.6] text-muted">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

export default function RoadmapPage() {
  const counts = countByStatus();
  const total = ROADMAP_TRACKS.reduce((sum, track) => sum + track.items.length, 0);

  return (
    <InfoPageShell
      title="Roadmap"
      subtitle="Where MPGR HUB is today and where it is heading — across the Agent, onchain execution, payments, gaming, rewards, security and the developer ecosystem."
      meta={`${total} tracked items across ${ROADMAP_TRACKS.length} areas · status is measured against the running product, not a marketing plan`}
      toc={TOC}
    >
      <InfoSection id="status-legend" title="How to read this roadmap">
        <P>
          Every item on this page carries one of four statuses. Nothing is
          described as live unless a route, engine or deployed contract in the
          repository actually implements it.
        </P>
        <div className="grid gap-2 sm:grid-cols-2">
          {ROADMAP_STATUS_ORDER.map((status) => (
            <div
              key={status}
              className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-surface px-3.5 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <StatusBadge status={status} />
                <span className="text-[13px] font-semibold text-white">{counts[status]}</span>
              </div>
              <p className="text-[13px] leading-[1.6] text-muted">{STATUS_MEANING[status]}</p>
            </div>
          ))}
        </div>
        <Callout tone="warn" title="No dates are promised">
          <P>
            This roadmap intentionally omits launch dates, allocation figures and
            partnership announcements. If a commitment is not visible in the
            product or in a signed public statement, it is not on this page.
          </P>
        </Callout>
        <P>
          For what each area means in the product, see{" "}
          <TLink href="/docs">Docs</TLink>. For the reasoning behind it, see{" "}
          <TLink href="/whitepaper#long-term-vision">
            Whitepaper → long-term ecosystem vision
          </TLink>
          .
        </P>
      </InfoSection>

      {ROADMAP_TRACKS.map((track) => (
        <InfoSection key={track.id} id={track.id} title={track.title}>
          <P>{track.summary}</P>
          <RoadmapItems items={track.items} />
        </InfoSection>
      ))}

      <InfoSection id="not-planned" title="Explicitly not planned">
        <P>
          Stating what MPGR HUB is <Strong>not</Strong> doing is part of keeping
          this page honest.
        </P>
        <UL>
          <LI>
            <Strong>Cross-chain execution.</Strong> Base is the home chain and the
            only configured runtime. Cross-chain support is not committed.
          </LI>
          <LI>
            <Strong>Custodial trading.</Strong> The Agent never holds keys, never
            holds a balance for you, and never signs on your behalf.
          </LI>
          <LI>
            <Strong>Paid subscriptions.</Strong> Premium is a function of locked
            MPGR, not a recurring payment.
          </LI>
          <LI>
            <Strong>New token supply.</Strong> Maximum supply stays fixed at
            1,000,000,000 MPGR. Rewards come from the community treasury.
          </LI>
          <LI>
            <Strong>Retail tokenized-stock minting.</Strong> Primary mint and
            redeem are Authorized Participant only; MPGR HUB implements no retail
            mint API.
          </LI>
        </UL>
        <P>
          Related: <TLink href="/docs#overview">Docs → overview</TLink> ·{" "}
          <TLink href="/about#product-direction">About → product direction</TLink>{" "}
          · <TLink href="/token#tokenomics">$MPGR → tokenomics</TLink>
        </P>
      </InfoSection>
    </InfoPageShell>
  );
}
