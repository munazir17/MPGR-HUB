// components/features/games/mpgr-run/RunGameOverlays.tsx
"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Play,
  RotateCcw,
  Share2,
  Trophy,
  Zap,
} from "lucide-react";
import { HudChip, ControlButton, StatPill } from "./RunGameHud";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { formatCompactNumber } from "@/lib/format";
import {
  CHARACTER_SPRITES,
  COLLECTIBLE_SPRITES,
  POWERUP_SPRITES,
  UI_SPRITES,
} from "@/lib/games/mpgr-run/run-assets";
import {
  STARTING_HP,
  POWERUP_TYPES,
} from "@/lib/games/mpgr-run/run-config";
import type { ProcessRunResultOutcome } from "@/lib/games/mpgr-run/run-rewards";
import type { RunResult } from "@/lib/games/mpgr-run/run-score";
import type { HudSnapshot, Phase } from "./RunGameTypes";

interface RunGameOverlaysProps {
  phase: Phase;
  hud: HudSnapshot;
  countdownValue: number;
  starting: boolean;
  authenticating: boolean;
  startError: string | null;
  personalBest: number;
  runResult: RunResult | null;
  outcome: ProcessRunResultOutcome | null;
  shareCopied: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onBeginCountdown: () => void;
  onTogglePause: () => void;
  onJump: () => void;
  onSlide: () => void;
  onSwitchLane: (dir: -1 | 1) => void;
  onShare: () => void;
}

export function RunGameOverlays({
  phase,
  hud,
  countdownValue,
  starting,
  authenticating,
  startError,
  personalBest,
  runResult,
  outcome,
  shareCopied,
  containerRef,
  onBeginCountdown,
  onTogglePause,
  onJump,
  onSlide,
  onSwitchLane,
  onShare,
}: RunGameOverlaysProps) {
  return (
    <>
      {/* In-run HUD */}
      {(phase === "running" || phase === "paused") && (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3"
            style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
          >
            <div className="flex flex-wrap gap-1.5">
              <HudChip icon={Zap} label="Score" value={formatCompactNumber(hud.score)} />
              <HudChip imgSrc={COLLECTIBLE_SPRITES.coin} label="Coins" value={String(hud.coins)} />
              <HudChip imgSrc={COLLECTIBLE_SPRITES.gem} label="Gems" value={String(hud.gems)} />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="rounded-full bg-black/40 px-3 py-1.5 text-xs font-semibold text-white shadow-[0_0_0_1px_rgba(59,130,246,0.35)] backdrop-blur-md">
                {formatCompactNumber(hud.distance)}m
              </div>
              <div className="flex items-center gap-0.5 rounded-full bg-black/40 px-2.5 py-1 backdrop-blur-md">
                {Array.from({ length: STARTING_HP }).map((_, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={UI_SPRITES.heart}
                    alt=""
                    className={`h-4 w-4 object-contain transition-all duration-300 ${
                      i < hud.hp ? "opacity-100 drop-shadow-[0_0_4px_rgba(244,63,94,0.7)]" : "opacity-20 grayscale"
                    }`}
                    aria-hidden="true"
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Active power-ups */}
          {hud.activePowerups.length > 0 && (
            <div className="pointer-events-none absolute left-3 top-16 flex flex-col gap-1.5">
              {hud.activePowerups.map(({ type, remainingMs }) => {
                const cfg = POWERUP_TYPES[type];
                return (
                  <div
                    key={type}
                    className="flex items-center gap-1.5 rounded-full bg-black/50 py-1 pl-1 pr-2.5 backdrop-blur-md"
                    style={{ boxShadow: `0 0 0 1px ${cfg.color}55, 0 0 10px 0 ${cfg.color}33` }}
                  >
                    <span className="relative flex h-6 w-6 items-center justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={UI_SPRITES.powerupFrame}
                        alt=""
                        className="absolute inset-0 h-full w-full object-contain opacity-80"
                        aria-hidden="true"
                      />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={POWERUP_SPRITES[type]}
                        alt=""
                        className="relative h-4 w-4 object-contain"
                        aria-hidden="true"
                      />
                    </span>
                    <span className="text-[10px] font-semibold text-white">{Math.ceil(remainingMs / 1000)}s</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* On-screen controls */}
          {phase === "running" && (
            <div
              className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-end justify-between px-3 pb-3"
              style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
            >
              <div className="flex gap-2">
                <ControlButton icon={ChevronLeft} label="Left" onPress={() => onSwitchLane(-1)} />
                <ControlButton icon={ChevronRight} label="Right" onPress={() => onSwitchLane(1)} />
              </div>
              <div className="flex gap-2">
                <ControlButton icon={ChevronDown} label="Slide" onPress={onSlide} />
                <ControlButton icon={ChevronUp} label="Jump" onPress={onJump} accent />
              </div>
            </div>
          )}
        </>
      )}

      {/* Idle */}
      <AnimatePresence>
        {phase === "idle" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/70 px-6 text-center backdrop-blur-sm"
          >
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-glow/25 to-primary/10 ring-1 ring-primary/25 animate-float">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={CHARACTER_SPRITES.idle} alt="MPGR Runner" className="h-16 w-16 object-contain" />
            </div>
            <div>
              <p className="text-lg font-bold text-white">MPGR Run</p>
              <p className="mt-1 max-w-xs text-xs text-muted">
                Swipe or use the buttons — left/right to switch lanes, up to jump, down to slide. Dodge hazards,
                grab collectibles and power-ups, and survive as long as you can.
              </p>
            </div>
            <button
              onClick={() => {
                if (
                  containerRef.current &&
                  typeof containerRef.current.requestFullscreen === "function" &&
                  window.matchMedia("(min-width: 1024px)").matches
                ) {
                  void containerRef.current.requestFullscreen().catch(() => undefined);
                }
                void onBeginCountdown();
              }}
              disabled={starting || authenticating}
              className="flex min-h-[44px] items-center gap-2 rounded-xl bg-gradient-premium px-6 py-2.5 text-sm font-semibold text-white shadow-glow-gold transition-transform active:scale-95 disabled:opacity-60"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              {starting || authenticating ? "Starting..." : "Start Run"}
            </button>
            {startError && (
              <p className="max-w-xs text-xs text-rose-300">{startError}</p>
            )}
            {personalBest > 0 && (
              <p className="flex items-center gap-1.5 text-xs text-gold">
                <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
                Personal best: {formatCompactNumber(personalBest)}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Countdown */}
      <AnimatePresence>
        {phase === "countdown" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm"
          >
            <motion.span
              key={countdownValue}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 16 }}
              className="text-gradient-premium text-6xl font-extrabold"
            >
              {countdownValue > 0 ? countdownValue : "GO"}
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Paused */}
      <AnimatePresence>
        {phase === "paused" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/75 backdrop-blur-sm"
          >
            <p className="text-lg font-bold text-white">Paused</p>
            <button
              onClick={onTogglePause}
              className="flex min-h-[44px] items-center gap-2 rounded-xl bg-gradient-premium px-6 py-2.5 text-sm font-semibold text-white shadow-glow-gold transition-transform active:scale-95"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              Resume
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Game over */}
      <AnimatePresence>
        {phase === "game_over" && runResult && outcome && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-background/85 px-5 py-6 text-center backdrop-blur-md"
          >
            <p className="text-sm font-semibold uppercase tracking-wider text-rose-400">💀 Game Over</p>

            <AnimatedNumber
              value={runResult.score}
              className="text-4xl font-extrabold tracking-tight text-white"
            />
            <p className="text-xs text-muted">Score</p>

            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <StatPill label="Distance" value={`${formatCompactNumber(runResult.distanceMeters)}m`} />
              <StatPill label="Coins" value={String(runResult.coinsCollected)} />
              <StatPill label="Gems" value={String(runResult.gemsCollected)} />
              <StatPill label="Checkpoints" value={String(runResult.checkpointsReached)} />
              <StatPill label="Power-ups" value={String(runResult.powerupsCollected)} />
              <StatPill
                label="Best"
                value={formatCompactNumber(Math.max(personalBest, runResult.score))}
                highlight
              />
            </div>

            {outcome.isNewPersonalBest && (
              <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-gold">
                <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
                New personal best!
              </p>
            )}

            {!outcome.valid ? (
              <p className="mt-1 max-w-xs text-[11px] text-muted">
                This run couldn&apos;t be validated, so no XP was awarded. {outcome.validationReasons[0]}
              </p>
            ) : outcome.xpAwarded > 0 ? (
              <p className="mt-1 text-xs font-medium text-primary-glow">+{outcome.xpAwarded} XP earned</p>
            ) : outcome.dailyCapReached ? (
              <p className="mt-1 text-[11px] text-muted">Daily XP cap reached — come back tomorrow for more XP.</p>
            ) : null}

            {outcome.newlyUnlockedAchievementIds.length > 0 && (
              <p className="mt-1 text-[11px] text-gold">
                🏆 {outcome.newlyUnlockedAchievementIds.length} achievement
                {outcome.newlyUnlockedAchievementIds.length > 1 ? "s" : ""} unlocked — check Achievements
              </p>
            )}

            <p className="mt-1 text-[10px] text-muted">
              Personal best shown above · verified competitive leaderboards launch once the MPGR HUB backend is live
            </p>

            <div className="mt-3 flex w-full max-w-xs flex-col gap-2">
              <button
                onClick={onBeginCountdown}
                className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-gradient-premium px-6 py-2.5 text-sm font-semibold text-white shadow-glow-gold transition-transform active:scale-95"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Try Again
              </button>
              <button
                onClick={onShare}
                className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-white/5 px-6 py-2.5 text-sm font-semibold text-white ring-1 ring-white/10 transition-transform active:scale-95"
              >
                <Share2 className="h-4 w-4" aria-hidden="true" />
                {shareCopied ? "Copied!" : "Share Run"}
              </button>
              <Link
                href="/games"
                className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl text-xs font-medium text-muted transition-colors hover:text-white"
              >
                Back to Games
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
