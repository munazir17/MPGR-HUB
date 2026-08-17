"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight, Trophy } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
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
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Link href={game.route} aria-label={`Play ${game.name}`}>
        <GlassCard className="relative overflow-hidden p-6">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-10 -top-10 h-56 w-56 rounded-full bg-gradient-premium opacity-25 blur-3xl animate-glow-pulse"
          />

          <div className="relative flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-gold">
            <span
              className="h-1.5 w-1.5 rounded-full bg-gold"
              aria-hidden="true"
            />
            Featured Game
          </div>

          <div className="relative mt-3 flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-primary-glow/25 to-primary/10 text-4xl ring-1 ring-primary/25 shadow-glow animate-float">
              {game.iconImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={game.iconImage} alt={game.name} className="h-12 w-12 object-contain" />
              ) : (
                <span role="img" aria-label={game.name}>
                  {game.icon}
                </span>
              )}
            </div>

            <div className="min-w-0">
              <p className="text-xl font-bold tracking-tight text-white">
                {game.name}
              </p>
              <p className="mt-0.5 text-sm text-muted">{game.tagline}</p>
            </div>
          </div>

          <div className="relative mt-5 flex items-center justify-between gap-3">
            {bestScore != null && bestScore > 0 ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-gold">
                <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
                Personal best: {formatCompactNumber(bestScore)}
              </span>
            ) : (
              <span className="text-xs text-muted">
                No runs yet — set your first score
              </span>
            )}

            <span className="flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-premium px-5 py-2.5 text-xs font-semibold text-white shadow-glow-gold transition-transform active:scale-95">
              Play Now
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </div>
        </GlassCard>
      </Link>
    </motion.div>
  );
}
