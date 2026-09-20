"use client";

import Link from "next/link";
import { clsx } from "clsx";

/** Official MPGR M mark — existing repo artwork, unaltered. */
export function MpgrMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      // 128x128 PNG downscale of /icon.png (which stays the canonical
      // 1254x1254 mini-app icon referenced by .well-known/farcaster.json).
      // This mark renders at 32 CSS px on every page, and it is also the
      // declared favicon, so /icon.png meant a 1.5 MB fetch per cold visit.
      src="/icon-128.png"
      alt=""
      draggable={false}
      decoding="async"
      className={clsx("h-8 w-8 shrink-0 rounded-lg object-cover select-none", className)}
    />
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="MPGR HUB home"
      className={clsx("flex min-w-0 items-center gap-2.5", className)}
    >
      <MpgrMark />
      <span className="truncate text-sm font-semibold tracking-tight text-white">
        MPGR HUB
      </span>
    </Link>
  );
}
