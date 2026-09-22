"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { APP_NAME, BUY_MPGR_URL, SOCIALS, TAGLINE } from "@/lib/site";

// components/layout/HomeFooter.tsx
//
// The ONE canonical Home footer: a compact brand block plus THREE
// clear link sections — Ecosystem / Learn / Legal & Community — and a
// bottom bar with copyright + the existing disclaimer. The old
// scattered pill rows (product-docs pills, a separate social pill row)
// duplicated these links and were removed; every existing link/route
// is still here exactly once.

const ecosystem = [
  { label: "Games", href: "/games" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "Staking", href: "/staking" },
  { label: "Token Lock", href: "/app/token-lock" },
  { label: "Burn", href: "/burn" },
  { label: "$MPGR", href: "/token" },
  { label: "Tokenomics", href: "/token#tokenomics" },
  { label: "Roadmap", href: "/roadmap" },
];

const learn = [
  { label: "Docs", href: "/docs" },
  { label: "Whitepaper v2.0", href: "/whitepaper" },
  { label: "Roadmap", href: "/roadmap" },
  { label: "About", href: "/about" },
  { label: "Support", href: "/support" },
];

const legal = [
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
];

const community = [
  { label: "X", href: SOCIALS.x },
  { label: "Telegram", href: SOCIALS.telegram },
  { label: "Discord", href: SOCIALS.discord },
  { label: "GitHub", href: SOCIALS.github },
];

function FooterLinkColumn({
  title,
  links,
}: {
  title: string;
  links: readonly { label: string; href: string }[];
}) {
  return (
    <nav aria-label={title}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
        {title}
      </p>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={`${title}-${l.label}`}>
            <Link
              href={l.href}
              className="text-xs font-medium text-muted transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function HomeFooter() {
  return (
    <footer
      className="shrink-0 border-t border-white/[0.08] px-4 pb-6 pt-8 sm:px-6"
      style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto w-full max-w-[1760px] lg:px-8">
        {/* Brand block */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">{APP_NAME}</p>
            <p className="text-xs text-muted">{TAGLINE}</p>
          </div>
          <a
            href={BUY_MPGR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-gold/35 bg-gold/10 px-3 py-1 text-[11px] font-semibold text-gold transition-colors hover:border-gold/60 hover:bg-gold/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 active:scale-[0.98]"
          >
            Buy $MPGR
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </a>
        </div>

        {/* THREE information sections */}
        <div className="mt-6 grid gap-8 border-t border-white/[0.06] pt-6 sm:grid-cols-2 lg:grid-cols-3">
          <FooterLinkColumn title="Ecosystem" links={ecosystem} />
          <FooterLinkColumn title="Learn" links={learn} />

          <div className="space-y-6 sm:col-span-2 lg:col-span-1">
            <FooterLinkColumn title="Legal" links={legal} />
            <nav aria-label="Community">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                Community
              </p>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                {community.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-muted transition-colors hover:text-white"
                    >
                      {l.label}
                      <ArrowUpRight className="h-3 w-3" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-8 flex flex-col gap-2 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">© 2026 {APP_NAME}. All rights reserved.</p>
          <p className="max-w-2xl text-xs leading-5 text-muted sm:text-right">
            Disclaimer: {APP_NAME} provides informational and technology services and does
            not provide financial, investment, or trading advice.
          </p>
        </div>
      </div>
    </footer>
  );
}
