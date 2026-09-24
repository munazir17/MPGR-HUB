import type { ReactNode } from "react";
import { Navbar } from "@/components/Navbar";
import { HomeFooter } from "@/components/layout/HomeFooter";
import { InfoToc, type TocItem } from "@/components/layout/InfoToc";

// components/layout/InfoPageShell.tsx
//
// Shared chrome for the informational pages (Docs, Whitepaper, Roadmap,
// About, Support).
//
// It replaces the narrower `LegalPage` for these long-form pages only:
// same Navbar, same footer, same eyebrow/display-l heading treatment, plus
// a table of contents. LegalPage is left exactly as it is for /terms,
// /privacy and /token so those pages are untouched.
//
// Layout contract (same breakpoints as PageContainer):
//   mobile  — full width, 16px gutters, collapsible TOC above the article
//   tablet  — 24px gutters
//   desktop — 1120px content, 32px gutters, sticky TOC column beside the
//             article; the article column is capped at ~76ch so prose
//             lines stay readable.

export interface InfoPageShellProps {
  title: string;
  subtitle?: string;
  meta?: string;
  eyebrow?: string;
  toc: readonly TocItem[];
  children: ReactNode;
}

export function InfoPageShell({
  title,
  subtitle,
  meta,
  eyebrow = "MPGR HUB",
  toc,
  children,
}: InfoPageShellProps) {
  return (
    <>
      <Navbar />
      <main className="mx-auto w-full max-w-[1120px] px-4 py-10 sm:px-6 md:py-14 lg:px-8">
        <header>
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="display-l mt-3 text-[28px] text-white md:text-4xl md:leading-[44px]">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-3 max-w-[76ch] text-sm leading-relaxed text-muted">{subtitle}</p>
          ) : null}
          {meta ? <p className="mt-2 text-xs text-muted/80">{meta}</p> : null}
        </header>

        <div className="mt-8">
          <InfoToc items={toc} variant="mobile" />
        </div>

        <div className="grid gap-10 lg:grid-cols-[212px_minmax(0,1fr)] lg:gap-12">
          <InfoToc items={toc} variant="desktop" />
          <div className="min-w-0 max-w-[76ch] space-y-12">{children}</div>
        </div>
      </main>
      <HomeFooter />
    </>
  );
}
