"use client";

// components/layout/InfoToc.tsx
//
// Table of contents for the informational pages (Docs, Whitepaper,
// Roadmap, About, Support).
//
// Two renderings of the SAME list:
//   variant="desktop" — a sticky column beside the article (≥lg only)
//   variant="mobile"  — a collapsible disclosure above the article (<lg)
//
// Both are plain hash anchors, so normal browser navigation, back/forward,
// refresh and copy-link all keep working — no router interception, no
// scroll hijacking. The only client behaviour is "which entry is active",
// derived from an IntersectionObserver over the real section elements.
// If JS is unavailable the links still jump to their section.

import { useEffect, useState } from "react";
import { ChevronDown, ListTree } from "lucide-react";
import { clsx } from "clsx";

export interface TocItem {
  /** Must match the rendered section's DOM id exactly. */
  id: string;
  label: string;
}

function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState<string>(ids[0] ?? "");

  useEffect(() => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    // First section to cross the top band wins; the band is offset for
    // the sticky navbar (56–64px) and stops well short of the viewport
    // bottom so the last short section can still become active.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActive(visible[0].target.id);
          return;
        }
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: [0, 0.01, 1] },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [ids]);

  return active;
}

function TocList({
  items,
  active,
  onNavigate,
}: {
  items: readonly TocItem[];
  active: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const isActive = active === item.id;
        return (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              onClick={onNavigate}
              aria-current={isActive ? "true" : undefined}
              className={clsx(
                "block rounded-lg border-l-2 py-1.5 pl-3 pr-2 text-[13px] leading-snug transition-colors duration-150",
                isActive
                  ? "border-primary bg-primary/[0.07] font-semibold text-white"
                  : "border-white/[0.08] text-muted hover:border-white/20 hover:text-white",
              )}
            >
              {item.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function InfoToc({
  items,
  variant,
}: {
  items: readonly TocItem[];
  variant: "desktop" | "mobile";
}) {
  const ids = items.map((item) => item.id);
  const active = useActiveSection(ids);
  const [open, setOpen] = useState(false);

  if (variant === "desktop") {
    return (
      <aside className="hidden lg:block">
        <nav
          aria-label="On this page"
          className="sticky top-24 max-h-[calc(100dvh-8rem)] overflow-y-auto pr-2"
        >
          <p className="eyebrow mb-3">On this page</p>
          <TocList items={items} active={active} />
        </nav>
      </aside>
    );
  }

  return (
    <nav
      aria-label="On this page"
      className="mb-8 rounded-2xl border border-white/[0.08] bg-surface/70 lg:hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-white">
          <ListTree className="h-4 w-4 text-primary" aria-hidden="true" />
          On this page
        </span>
        <ChevronDown
          className={clsx(
            "h-4 w-4 text-muted transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="border-t border-white/[0.06] px-3 pb-3 pt-3">
          <TocList items={items} active={active} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
    </nav>
  );
}
