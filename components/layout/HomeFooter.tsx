"use client";

import Link from "next/link";
import { ArrowUpRight, Coins, FileText, Map, PieChart } from "lucide-react";
import { APP_NAME, BUY_MPGR_URL, SOCIALS, TAGLINE } from "@/lib/site";

const pill =
  "inline-flex cursor-pointer items-center gap-1 rounded-full border border-primary/25 bg-background px-2.5 py-1 text-[11px] font-medium text-primary-glow transition-colors hover:border-primary/50 hover:bg-surface-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-[0.98]";

const socials = [
  { label: "X", href: SOCIALS.x },
  { label: "Telegram", href: SOCIALS.telegram },
  { label: "Discord", href: SOCIALS.discord },
  { label: "GitHub", href: SOCIALS.github },
];

const product = [
  { label: "$MPGR", href: "/token", icon: Coins, gold: true },
  { label: "Tokenomics", href: "/token#tokenomics", icon: PieChart, gold: false },
  { label: "Roadmap", href: "/roadmap", icon: Map, gold: false },
  { label: "Whitepaper v2.0", href: "/whitepaper", icon: FileText, gold: true },
] as const;

const legal = [
  { label: "About", href: "/about" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "Docs", href: "/docs" },
  { label: "Support", href: "/support" },
] as const;

export function HomeFooter() {
  return (
    <footer
      className="shrink-0 border-t border-white/[0.08] px-4 pb-6 pt-5 sm:px-6"
      style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
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

        <div className="mt-4">
          <p className="text-xs font-medium text-white">{APP_NAME}</p>
          <p className="text-xs text-muted">{TAGLINE}</p>
        </div>

        <nav aria-label="Product docs" className="mt-3 flex flex-wrap items-center gap-1.5">
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

        <nav aria-label="Legal" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {legal.map((l, i) => (
            <span key={l.href} className="flex items-center gap-2">
              {i > 0 ? <span className="text-white/20" aria-hidden>|</span> : null}
              <Link
                href={l.href}
                className="inline-flex cursor-pointer items-center gap-0.5 font-medium text-primary-glow transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:opacity-80"
              >
                {l.label}
                <ArrowUpRight className="h-3 w-3" aria-hidden />
              </Link>
            </span>
          ))}
        </nav>

        <p className="mt-3 text-xs text-muted">© 2026 {APP_NAME}. All rights reserved.</p>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-muted">
          Disclaimer: {APP_NAME} provides informational and technology services and does
          not provide financial, investment, or trading advice.
        </p>
      </div>
    </footer>
  );
}
