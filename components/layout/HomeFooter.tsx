"use client";

import Link from "next/link";
import { ArrowUpRight, Coins, FileText, Map, PieChart } from "lucide-react";
import { APP_NAME, BUY_MPGR_URL, SOCIALS, TAGLINE } from "@/lib/site";

// components/layout/HomeFooter.tsx
//
// The Home/lower-content footer. Same MPGR content as before (socials,
// product links, legal, disclaimer) reorganized into the reference
// information architecture — ECOSYSTEM / LEARN / SOCIAL / LEGAL — with
// a responsive grid: stacked on phones, grouped columns on desktop.
// Visual polish (colors/typography/art) is a later pass.

const pill =
  "inline-flex cursor-pointer items-center gap-1 rounded-full border border-primary/25 bg-background px-2.5 py-1 text-[11px] font-medium text-primary-glow transition-colors hover:border-primary/50 hover:bg-surface-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-[0.98]";

const socials = [
  { label: "X", href: SOCIALS.x },
  { label: "Telegram", href: SOCIALS.telegram },
  { label: "Discord", href: SOCIALS.discord },
  { label: "GitHub", href: SOCIALS.github },
];

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

const product = [
  { label: "$MPGR", href: "/token", icon: Coins, gold: true },
  { label: "Tokenomics", href: "/token#tokenomics", icon: PieChart, gold: false },
  { label: "Roadmap", href: "/roadmap", icon: Map, gold: false },
  { label: "Whitepaper v2.0", href: "/whitepaper", icon: FileText, gold: true },
] as const;

function FooterLinkGroup({
  title,
  links,
}: {
  title: string;
  links: readonly { label: string; href: string }[];
}) {
  return (
    <nav aria-label={title}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={`${title}-${l.href}-${l.label}`}>
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
      <div className="mx-auto max-w-6xl lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand + social/community */}
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-white">{APP_NAME}</p>
              <p className="text-xs text-muted">{TAGLINE}</p>
            </div>
            <nav aria-label="Community" className="flex flex-wrap items-center gap-1.5">
              {socials.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={pill}
                >
                  {l.label}
                  <ArrowUpRight className="h-3 w-3" aria-hidden />
                </a>
              ))}
            </nav>
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

          <FooterLinkGroup title="Ecosystem" links={ecosystem} />

          <FooterLinkGroup title="Learn" links={learn} />

          <div className="space-y-4">
            <FooterLinkGroup title="Legal" links={legal} />
            <nav aria-label="Product docs" className="flex flex-wrap items-center gap-1.5">
              {product.map((l) => {
                const Icon = l.icon;
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    className={
                      l.gold
                        ? "inline-flex cursor-pointer items-center gap-1 rounded-full border border-gold/30 bg-background px-2.5 py-1 text-[11px] font-medium text-gold transition-colors hover:border-gold/55 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/35 active:scale-[0.98]"
                        : pill
                    }
                  >
                    <Icon className="h-3 w-3" aria-hidden />
                    {l.label}
                    <ArrowUpRight className="h-3 w-3" aria-hidden />
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

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
