"use client";

import Link from "next/link";
import { clsx } from "clsx";

/** Official MPGR M mark — existing repo artwork, unaltered.
 *
 * Header slot is 32px, so this renders a 128×128 thumbnail derived from
 * /icon.png (q90 WebP, ~3.7KB vs 1.58MB) instead of the full icon file.
 * /icon.png itself is untouched: favicon, apple-touch-icon, and the
 * Farcaster manifest keep referencing it. */
export function MpgrMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/mpgr-mark-128.webp"
      alt=""
      draggable={false}
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
