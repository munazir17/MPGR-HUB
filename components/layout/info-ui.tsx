import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, Hash } from "lucide-react";
import { clsx } from "clsx";

// Re-exported so page files can pull every piece of the informational-page
// kit from one module.
export type { TocItem } from "@/components/layout/InfoToc";

// components/layout/info-ui.tsx
//
// Small, shared primitives for the informational pages (Docs, Whitepaper,
// Roadmap, About, Support).
//
// They only re-use tokens the app already ships — surface / hairline
// borders / muted body text / white headings / primary + gold accents —
// so these pages read as part of MPGR HUB rather than a separate site.
// Nothing here touches product logic; it is presentation only.

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function InfoSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="group flex items-baseline gap-2 text-lg font-semibold tracking-[-0.02em] text-white md:text-xl">
        <a
          href={`#${id}`}
          aria-label={`Permalink to ${title}`}
          className="text-muted/40 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Hash className="h-4 w-4" aria-hidden="true" />
        </a>
        <span>{title}</span>
      </h2>
      <div className="mt-3 space-y-4 text-[15px] leading-[1.72] text-muted">{children}</div>
    </section>
  );
}

export function InfoSub({ children }: { children: ReactNode }) {
  return <h3 className="pt-1 text-[15px] font-semibold text-white">{children}</h3>;
}

export function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

export function UL({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ul className={clsx("list-disc space-y-1.5 pl-5 marker:text-muted/60", className)}>
      {children}
    </ul>
  );
}

export function LI({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

/** Inline emphasis used for product names / constants / route paths. */
export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-white">{children}</strong>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[12.5px] text-white/90">
      {children}
    </code>
  );
}

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

export type CalloutTone = "info" | "live" | "future" | "warn" | "danger";

const CALLOUT_TONES: Record<CalloutTone, string> = {
  info: "border-primary/25 bg-primary/[0.06]",
  live: "border-good/25 bg-good/[0.06]",
  future: "border-white/[0.12] bg-white/[0.03]",
  warn: "border-gold/30 bg-gold/[0.07]",
  danger: "border-bad/30 bg-bad/[0.07]",
};

const CALLOUT_TITLE_TONES: Record<CalloutTone, string> = {
  info: "text-primary-glow",
  live: "text-good",
  future: "text-white/80",
  warn: "text-gold",
  danger: "text-bad",
};

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: CalloutTone;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={clsx("rounded-2xl border px-4 py-3.5", CALLOUT_TONES[tone])}>
      <p className={clsx("text-[13px] font-semibold uppercase tracking-[0.1em]", CALLOUT_TITLE_TONES[tone])}>
        {title}
      </p>
      <div className="mt-1.5 space-y-2 text-[14px] leading-[1.65] text-muted">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

export type RoadmapStatus = "LIVE" | "IN PROGRESS" | "PLANNED" | "LONG-TERM VISION";

const STATUS_STYLES: Record<RoadmapStatus, string> = {
  LIVE: "border-good/35 bg-good/10 text-good",
  "IN PROGRESS": "border-primary/35 bg-primary/10 text-primary-glow",
  PLANNED: "border-white/[0.14] bg-white/[0.05] text-white/75",
  "LONG-TERM VISION": "border-gold/35 bg-gold/10 text-gold",
};

export function StatusBadge({ status }: { status: RoadmapStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em]",
        STATUS_STYLES[status],
      )}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Fact grid / tables
// ---------------------------------------------------------------------------

export function FactGrid({ items }: { items: readonly { label: string; value: string }[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-xl border border-white/[0.08] bg-surface px-3.5 py-2.5"
        >
          <p className="text-[11px] uppercase tracking-[0.1em] text-muted/80">{item.label}</p>
          <p className="mt-0.5 break-words text-sm font-medium text-white">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

export function DataTable({
  head,
  rows,
  caption,
}: {
  head: readonly string[];
  rows: readonly (readonly string[])[];
  caption?: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/[0.08]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left text-[13.5px]">
          {caption ? (
            <caption className="border-b border-white/[0.08] bg-surface px-4 py-2.5 text-left text-[12px] text-muted">
              {caption}
            </caption>
          ) : null}
          <thead>
            <tr className="bg-surface">
              {head.map((cell) => (
                <th
                  key={cell}
                  scope="col"
                  className="border-b border-white/[0.08] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row[0] ?? ""}-${index}`} className="align-top">
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={clsx(
                      "px-4 py-2.5 leading-[1.55]",
                      index % 2 === 1 ? "bg-white/[0.015]" : "bg-transparent",
                      cellIndex === 0 ? "font-medium text-white" : "text-muted",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** A card linking to one destination — internal (next/link) by default. */
export function LinkCard({
  href,
  label,
  note,
  external,
}: {
  href: string;
  label: string;
  note: string;
  external?: boolean;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
        {label}
        {external ? (
          <ArrowUpRight className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
        ) : null}
      </span>
      <span className="mt-1 block text-[13px] leading-[1.55] text-muted">{note}</span>
    </>
  );

  const className =
    "block h-full rounded-2xl border border-white/[0.08] bg-surface px-4 py-3 transition-colors duration-200 hover:border-primary/25 hover:bg-primary/[0.05]";

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {body}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {body}
    </Link>
  );
}

export function LinkGrid({
  items,
  columns = 2,
}: {
  items: readonly { href: string; label: string; note: string; external?: boolean }[];
  columns?: 2 | 3;
}) {
  return (
    <div className={clsx("grid gap-2.5", columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2")}>
      {items.map((item) => (
        <LinkCard
          key={`${item.href}-${item.label}`}
          href={item.href}
          label={item.label}
          note={item.note}
          external={item.external}
        />
      ))}
    </div>
  );
}

/** Inline text link — internal by default, external with `external`. */
export function TLink({
  href,
  children,
  external,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-white underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white/70"
      >
        {children}
      </a>
    );
  }
  return (
    <Link
      href={href}
      className="font-medium text-white underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white/70"
    >
      {children}
    </Link>
  );
}
