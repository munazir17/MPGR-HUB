"use client";

import Link from "next/link";
import { APP_NAME, BUY_MPGR_URL, SOCIALS, TAGLINE } from "@/lib/site";

const socials = [
  { label: "X", href: SOCIALS.x },
  { label: "Telegram", href: SOCIALS.telegram },
  { label: "Discord", href: SOCIALS.discord },
  { label: "GitHub", href: SOCIALS.github },
];

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
        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs text-muted">
          <nav aria-label="Community" className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {socials.map((l, i) => (
              <span key={l.label} className="flex items-center gap-2.5">
                {i > 0 ? <span aria-hidden>·</span> : null}
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors duration-150 hover:text-white"
                >
                  {l.label}
                </a>
              </span>
            ))}
          </nav>
          <a
            href={BUY_MPGR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-white transition-colors duration-150 hover:text-primary"
          >
            Buy $MPGR
          </a>
        </div>

        <div className="mt-4">
          <p className="text-xs font-medium text-white">{APP_NAME}</p>
          <p className="text-xs text-muted">{TAGLINE}</p>
        </div>

        <nav aria-label="Legal" className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
          {legal.map((l, i) => (
            <span key={l.href} className="flex items-center gap-2.5">
              {i > 0 ? <span aria-hidden>·</span> : null}
              <Link href={l.href} className="transition-colors duration-150 hover:text-white">
                {l.label}
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
