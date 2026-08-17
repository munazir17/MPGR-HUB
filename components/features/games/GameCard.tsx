"use client";

import Link from "next/link";
import { ArrowRight, Clock3, Lock, Trophy } from "lucide-react";

import { GlassCard } from "@/components/ui/GlassCard";
import type { GameDefinition } from "@/lib/games";

interface GameCardProps {
  game: GameDefinition;
  bestScore?: number;
}

export function GameCard({ game, bestScore = 0 }: GameCardProps) {
  const playable = game.status === "playable";

  return (
    <GlassCard className="group relative overflow-hidden p-0">
      {/* Game accent */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${game.accentGradient} opacity-80`}
      />

      <div className="relative p-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06] text-3xl shadow-inner">
            {game.iconImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={game.iconImage} alt="" className="h-11 w-11 object-contain" aria-hidden="true" />
            ) : (
              <span aria-hidden="true">{game.icon}</span>
            )}
          </div>

          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${
              playable
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-white/10 bg-white/[0.04] text-muted-foreground"
            }`}
          >
            {playable ? "Playable" : "Coming Soon"}
          </span>
        </div>

        <div className="mb-4">
          <h3 className="text-lg font-bold tracking-tight text-foreground">
            {game.name}
          </h3>

          <p className="mt-1 text-sm font-medium text-primary">
            {game.tagline}
          </p>

          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {game.description}
          </p>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
            <Clock3 className="h-3 w-3" />
            {game.estimatedPlayTime}
          </span>

          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 capitalize">
            {game.difficulty}
          </span>

          {game.supportsLeaderboard && (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
              <Trophy className="h-3 w-3" />
              Leaderboard
            </span>
          )}
        </div>

        {bestScore > 0 && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-white/10 bg-black/10 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              Personal Best
            </span>

            <span className="text-sm font-bold tabular-nums text-foreground">
              {bestScore.toLocaleString()}
            </span>
          </div>
        )}

        {playable ? (
          <Link
            href={game.route}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition-all hover:brightness-110 active:scale-[0.98]"
          >
            Play Now
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        ) : (
          <div className="flex w-full cursor-default items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-muted-foreground">
            <Lock className="h-4 w-4" />
            Coming Soon
          </div>
        )}
      </div>
    </GlassCard>
  );
}
