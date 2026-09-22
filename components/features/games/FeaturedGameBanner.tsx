"use client";

import Link from "next/link";
import { ArrowRight, Trophy } from "lucide-react";
import { formatCompactNumber } from "@/lib/format";
import type { GameDefinition } from "@/lib/games/game-types";

interface FeaturedGameBannerProps {
  game: GameDefinition;
  bestScore?: number | null;
}

export function FeaturedGameBanner({
  game,
  bestScore,
}: FeaturedGameBannerProps) {
  return (
    <Link
      href={game.route}
      aria-label={`Play ${game.name}`}
      className="relative block overflow-hidden rounded-3xl border border-white/[0.08] bg-surface"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(ellipse 70% 90% at 88% 50%, rgba(56,189,248,0.22), transparent 55%), linear-gradient(90deg, rgba(14,22,40,0.2) 40%, rgba(37,99,235,0.18) 100%)",
        }}
      />

      <div className="relative flex min-h-[168px] items-center gap-4 p-5 sm:min-h-[196px] sm:p-6">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
            Flagship game
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {game.name}
          </h2>
          <p className="mt-1 max-w-xs text-sm text-muted">
            Play. Improve. Climb the ranks.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="btn-primary btn-primary-sm text-sm">
              Play Now
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </span>
            {bestScore != null && bestScore > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
                <Trophy className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
                Best {formatCompactNumber(bestScore)}
              </span>
            ) : (
              <span className="text-xs text-muted">Earn XP as you run</span>
            )}
          </div>
        </div>

        <div className="relative h-28 w-24 shrink-0 sm:h-36 sm:w-32">
          {/* Above the fold on /games and /rewards, so it stays eager (no
              loading="lazy") — but it is the 384x256 banner variant, not the
              full 1536x1024 sprite. No fetchpriority hint: on React 18.3.1
              the camelCase prop renders as the invalid `fetchPriority`
              attribute and @types/react rejects the lowercase form.
              `decoding="async"` keeps its decode off the main thread. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/games/mpgr-run/character/mpgr-runner-run-banner.webp"
            alt=""
            className="h-full w-full object-contain object-right drop-shadow-[0_12px_24px_rgba(56,189,248,0.25)]"
            decoding="async"
          />
        </div>
      </div>
    </Link>
  );
}
