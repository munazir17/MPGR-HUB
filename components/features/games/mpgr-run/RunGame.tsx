"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Coins as CoinsIcon,
  Pause,
  Play,
  RotateCcw,
  Share2,
  Trophy,
  Zap,
} from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { formatCompactNumber } from "@/lib/format";
import { startSession, endSession, type GameSessionMeta } from "@/lib/games/game-session";
import { finalizeRun, type RunResult, type RunStats } from "@/lib/games/mpgr-run/run-score";
import { processRunResult, type ProcessRunResultOutcome } from "@/lib/games/mpgr-run/run-rewards";
import { getGameStats } from "@/lib/games/game-storage";
import {
  MPGR_RUN_GAME_ID,
  GROUND_Y,
  PLAYER_X,
  PLAYER_SIZE,
  GRAVITY,
  JUMP_VELOCITY,
  BASE_SPEED,
  MAX_SPEED,
  RAMP_DURATION_MS,
  SPEED_TIERS,
  PX_PER_METER,
  OBSTACLE_MIN_GAP_PX,
  OBSTACLE_MAX_GAP_PX,
  COIN_MIN_GAP_PX,
  COIN_MAX_GAP_PX,
  COUNTDOWN_SECONDS,
} from "@/lib/games/mpgr-run/run-config";

type Phase = "idle" | "countdown" | "running" | "paused" | "game_over";

interface Obstacle {
  x: number;
  width: number;
  height: number;
  passed: boolean;
}

interface Coin {
  x: number;
  heightAboveGround: number;
  radius: number;
  collected: boolean;
}

interface World {
  playerY: number; // px above ground, 0 = grounded
  velocityY: number;
  speed: number;
  elapsedMs: number;
  obstacles: Obstacle[];
  coins: Coin[];
  coinsCollected: number;
  obstaclesPassed: number;
  collided: boolean;
}

function freshWorld(): World {
  return {
    playerY: 0,
    velocityY: 0,
    speed: BASE_SPEED,
    elapsedMs: 0,
    obstacles: [],
    coins: [],
    coinsCollected: 0,
    obstaclesPassed: 0,
    collided: false,
  };
}

function randRange(min: number, max: number) {
  return min + Math.random() * (max - min);
}

const COLORS = {
  bg: "#0A0B0D",
  ground: "#1E2128",
  groundLine: "#3B82F6",
  player: "#60A5FA",
  playerCore: "#3B82F6",
  obstacle: "#F0B90B",
  obstacleDark: "#B45309",
  coin: "#FCD34D",
  coinRing: "#F0B90B",
};

interface HudSnapshot {
  distance: number;
  coins: number;
  score: number;
  speedTier: number;
}

interface RunGameProps {
  address: string;
}

export function RunGame({ address }: RunGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(freshWorld());
  const sessionRef = useRef<GameSessionMeta | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const hudIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const phaseRef = useRef<Phase>("idle");

  const [phase, setPhase] = useState<Phase>("idle");
  const [countdownValue, setCountdownValue] = useState(COUNTDOWN_SECONDS);
  const [hud, setHud] = useState<HudSnapshot>({ distance: 0, coins: 0, score: 0, speedTier: 0 });
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [outcome, setOutcome] = useState<ProcessRunResultOutcome | null>(null);
  const [personalBest, setPersonalBest] = useState(0);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Load personal best once on mount / when a run completes.
  const refreshPersonalBest = useCallback(() => {
    const stats = getGameStats(MPGR_RUN_GAME_ID, address);
    setPersonalBest(stats.bestScore);
  }, [address]);

  useEffect(() => {
    refreshPersonalBest();
  }, [refreshPersonalBest]);

  // --- Canvas sizing -------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { width: rect.width, height: rect.height };
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // --- Render a single frame ------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width, height } = sizeRef.current;
    if (width === 0 || height === 0) return;

    const world = worldRef.current;
    const groundY = height * GROUND_Y;
    const playerScreenX = width * PLAYER_X;

    // Background
    ctx.clearRect(0, 0, width, height);
    const skyGradient = ctx.createLinearGradient(0, 0, 0, height);
    skyGradient.addColorStop(0, "#0A0B0D");
    skyGradient.addColorStop(1, "#111318");
    ctx.fillStyle = skyGradient;
    ctx.fillRect(0, 0, width, height);

    // Ground
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, groundY, width, height - groundY);
    ctx.strokeStyle = COLORS.groundLine;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(width, groundY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Coins
    for (const c of world.coins) {
      if (c.collected) continue;
      const cy = groundY - c.heightAboveGround;
      ctx.beginPath();
      ctx.arc(c.x, cy, c.radius, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.coin;
      ctx.shadowColor = COLORS.coinRing;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = COLORS.coinRing;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Obstacles
    for (const o of world.obstacles) {
      const top = groundY - o.height;
      const gradient = ctx.createLinearGradient(o.x, top, o.x, groundY);
      gradient.addColorStop(0, COLORS.obstacle);
      gradient.addColorStop(1, COLORS.obstacleDark);
      ctx.fillStyle = gradient;
      const r = 4;
      ctx.beginPath();
      ctx.moveTo(o.x + r, top);
      ctx.lineTo(o.x + o.width - r, top);
      ctx.quadraticCurveTo(o.x + o.width, top, o.x + o.width, top + r);
      ctx.lineTo(o.x + o.width, groundY);
      ctx.lineTo(o.x, groundY);
      ctx.lineTo(o.x, top + r);
      ctx.quadraticCurveTo(o.x, top, o.x + r, top);
      ctx.closePath();
      ctx.fill();
    }

    // Player
    const playerBottom = groundY - world.playerY;
    const playerTop = playerBottom - PLAYER_SIZE;
    const grad = ctx.createLinearGradient(0, playerTop, 0, playerBottom);
    grad.addColorStop(0, COLORS.player);
    grad.addColorStop(1, COLORS.playerCore);
    ctx.fillStyle = grad;
    ctx.shadowColor = "rgba(59,130,246,0.55)";
    ctx.shadowBlur = 14;
    const pr = 8;
    ctx.beginPath();
    ctx.moveTo(playerScreenX + pr, playerTop);
    ctx.lineTo(playerScreenX + PLAYER_SIZE - pr, playerTop);
    ctx.quadraticCurveTo(playerScreenX + PLAYER_SIZE, playerTop, playerScreenX + PLAYER_SIZE, playerTop + pr);
    ctx.lineTo(playerScreenX + PLAYER_SIZE, playerBottom - pr);
    ctx.quadraticCurveTo(playerScreenX + PLAYER_SIZE, playerBottom, playerScreenX + PLAYER_SIZE - pr, playerBottom);
    ctx.lineTo(playerScreenX + pr, playerBottom);
    ctx.quadraticCurveTo(playerScreenX, playerBottom, playerScreenX, playerBottom - pr);
    ctx.lineTo(playerScreenX, playerTop + pr);
    ctx.quadraticCurveTo(playerScreenX, playerTop, playerScreenX + pr, playerTop);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    // "visor" accent so the runner has an original, simple identity
    ctx.fillStyle = "#0A0B0D";
    ctx.fillRect(playerScreenX + PLAYER_SIZE * 0.45, playerTop + PLAYER_SIZE * 0.28, PLAYER_SIZE * 0.4, PLAYER_SIZE * 0.22);
  }, []);

  // --- Physics / spawn step -------------------------------------------
  const step = useCallback((dt: number) => {
    const world = worldRef.current;
    const { width } = sizeRef.current;
    if (width === 0) return;
    const playerScreenX = width * PLAYER_X;

    world.elapsedMs += dt * 1000;
    const rampProgress = Math.min(1, world.elapsedMs / RAMP_DURATION_MS);
    world.speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * rampProgress;

    // Physics
    world.velocityY -= GRAVITY * dt;
    world.playerY += world.velocityY * dt;
    if (world.playerY <= 0) {
      world.playerY = 0;
      world.velocityY = 0;
    }

    // Scroll obstacles/coins
    for (const o of world.obstacles) o.x -= world.speed * dt;
    for (const c of world.coins) c.x -= world.speed * dt;
    world.obstacles = world.obstacles.filter((o) => o.x + o.width > -20);
    world.coins = world.coins.filter((c) => c.x > -30 && !c.collected);

    // Spawn obstacles
    const lastObstacle = world.obstacles[world.obstacles.length - 1];
    const obstacleGap = randRange(OBSTACLE_MIN_GAP_PX, OBSTACLE_MAX_GAP_PX);
    if (!lastObstacle || lastObstacle.x < width - obstacleGap) {
      world.obstacles.push({
        x: width + 20,
        width: 24 + Math.random() * 16,
        height: 32 + Math.random() * 24,
        passed: false,
      });
    }

    // Spawn coins
    const lastCoin = world.coins[world.coins.length - 1];
    const coinGap = randRange(COIN_MIN_GAP_PX, COIN_MAX_GAP_PX);
    if (!lastCoin || lastCoin.x < width - coinGap) {
      const highBand = Math.random() > 0.5;
      world.coins.push({
        x: width + 40,
        heightAboveGround: highBand ? randRange(70, 130) : randRange(6, 22),
        radius: 8,
        collected: false,
      });
    }

    // Collisions: obstacles
    for (const o of world.obstacles) {
      const overlapX = playerScreenX + PLAYER_SIZE > o.x && playerScreenX < o.x + o.width;
      const overlapY = world.playerY < o.height;
      if (overlapX && overlapY && !world.collided) {
        world.collided = true;
      }
      if (!o.passed && o.x + o.width < playerScreenX) {
        o.passed = true;
        world.obstaclesPassed += 1;
      }
    }

    // Collisions: coins
    for (const c of world.coins) {
      if (c.collected) continue;
      const overlapX = Math.abs(c.x - (playerScreenX + PLAYER_SIZE / 2)) < c.radius + PLAYER_SIZE / 2;
      const overlapY = Math.abs(c.heightAboveGround - (world.playerY + PLAYER_SIZE / 2)) < c.radius + PLAYER_SIZE / 2;
      if (overlapX && overlapY) {
        c.collected = true;
        world.coinsCollected += 1;
      }
    }
  }, []);

  // --- Game loop --------------------------------------------------------
  const loop = useCallback(
    (now: number) => {
      if (phaseRef.current !== "running") return;
      const last = lastTimeRef.current || now;
      const dt = Math.min((now - last) / 1000, 0.05);
      lastTimeRef.current = now;

      step(dt);
      draw();

      if (worldRef.current.collided) {
        finishRun();
        return;
      }

      rafRef.current = requestAnimationFrame(loop);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [step, draw]
  );

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (hudIntervalRef.current != null) clearInterval(hudIntervalRef.current);
    hudIntervalRef.current = null;
  }, []);

  const finishRun = useCallback(() => {
    stopLoop();
    const world = worldRef.current;
    const session = sessionRef.current;
    setPhase("game_over");
    if (!session) return;

    const ended = endSession(session);
    sessionRef.current = ended;

    // Distance is derived from accumulated scroll speed*time, tracked as
    // meters via PX_PER_METER — recomputed here from the same world speed
    // ramp rather than stored separately, so it can never drift from what
    // was actually rendered.
    const traveledPx = integratePxTraveled(world.elapsedMs);
    const stats: RunStats = {
      distanceMeters: traveledPx / PX_PER_METER,
      durationMs: Math.round(world.elapsedMs),
      coinsCollected: world.coinsCollected,
      obstaclesPassed: world.obstaclesPassed,
      collided: world.collided,
      maxSpeedTierReached: Math.floor(Math.min(1, world.elapsedMs / RAMP_DURATION_MS) * SPEED_TIERS),
    };
    const result = finalizeRun(stats);
    setRunResult(result);

    const rewardOutcome = processRunResult(address, ended.sessionId, result);
    setOutcome(rewardOutcome);
    refreshPersonalBest();
  }, [address, stopLoop, refreshPersonalBest]);

  // Integrates the same speed ramp used during the run to get total
  // px traveled — kept as a pure function of elapsed time so it's
  // deterministic and reproducible from the tracked duration alone.
  function integratePxTraveled(elapsedMs: number): number {
    const rampMs = Math.min(elapsedMs, RAMP_DURATION_MS);
    const afterRampMs = Math.max(0, elapsedMs - RAMP_DURATION_MS);
    // Average speed during the ramp (linear ramp from BASE to MAX).
    const avgRampSpeed = (BASE_SPEED + (BASE_SPEED + (MAX_SPEED - BASE_SPEED) * (rampMs / RAMP_DURATION_MS || 0))) / 2;
    const rampPx = avgRampSpeed * (rampMs / 1000);
    const afterRampPx = MAX_SPEED * (afterRampMs / 1000);
    return rampPx + afterRampPx;
  }

  const startHudSync = useCallback(() => {
    if (hudIntervalRef.current != null) clearInterval(hudIntervalRef.current);
    hudIntervalRef.current = setInterval(() => {
      const world = worldRef.current;
      const distance = integratePxTraveled(world.elapsedMs) / PX_PER_METER;
      const provisional = finalizeRun({
        distanceMeters: distance,
        durationMs: world.elapsedMs,
        coinsCollected: world.coinsCollected,
        obstaclesPassed: world.obstaclesPassed,
        collided: world.collided,
        maxSpeedTierReached: Math.floor(Math.min(1, world.elapsedMs / RAMP_DURATION_MS) * SPEED_TIERS),
      });
      setHud({
        distance: Math.floor(distance),
        coins: world.coinsCollected,
        score: provisional.score,
        speedTier: provisional.maxSpeedTierReached,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginCountdown = useCallback(() => {
    worldRef.current = freshWorld();
    sessionRef.current = startSession(MPGR_RUN_GAME_ID, address);
    setRunResult(null);
    setOutcome(null);
    setHud({ distance: 0, coins: 0, score: 0, speedTier: 0 });
    setCountdownValue(COUNTDOWN_SECONDS);
    setPhase("countdown");

    let remaining = COUNTDOWN_SECONDS;
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        setPhase("running");
        lastTimeRef.current = 0;
        startHudSync();
        rafRef.current = requestAnimationFrame(loop);
      } else {
        setCountdownValue(remaining);
      }
    }, 700);
  }, [address, loop, startHudSync]);

  const jump = useCallback(() => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    if (world.playerY <= 0) {
      world.velocityY = JUMP_VELOCITY;
    }
  }, []);

  const togglePause = useCallback(() => {
    if (phaseRef.current === "running") {
      stopLoop();
      setPhase("paused");
    } else if (phaseRef.current === "paused") {
      setPhase("running");
      lastTimeRef.current = 0;
      startHudSync();
      rafRef.current = requestAnimationFrame(loop);
    }
  }, [loop, startHudSync, stopLoop]);

  // Pause automatically if the tab loses focus mid-run.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && phaseRef.current === "running") {
        stopLoop();
        setPhase("paused");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [stopLoop]);

  // Keyboard controls (desktop): Space / ArrowUp = jump.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        jump();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [jump]);

  useEffect(() => stopLoop, [stopLoop]);

  const handleShare = async () => {
    if (!runResult) return;
    const text = `🦖 I survived ${Math.floor(runResult.distanceMeters)}m in MPGR Run.\n\nScore: ${formatCompactNumber(
      runResult.score
    )}\n\nCan you beat me?\n\n🔵 MPGR HUB`;
    try {
      if (navigator.share) {
        await navigator.share({ text });
      } else {
        await navigator.clipboard.writeText(text);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 1800);
      }
    } catch {
      // User cancelled the share sheet or clipboard was unavailable — no-op.
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Link
          href="/games"
          className="flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to Games
        </Link>
        {phase === "running" && (
          <button
            onClick={togglePause}
            aria-label="Pause"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-white ring-1 ring-white/10 active:scale-95"
          >
            <Pause className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <GlassCard className="relative overflow-hidden p-0">
        <div
          ref={containerRef}
          onPointerDown={(e) => {
            if (phase === "running") {
              e.preventDefault();
              jump();
            }
          }}
          className="relative h-[62vh] max-h-[560px] min-h-[360px] w-full select-none touch-none"
          style={{ touchAction: "none" }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

          {/* In-run HUD */}
          {(phase === "running" || phase === "paused") && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
              <div className="flex gap-2">
                <HudChip icon={Zap} label="Score" value={formatCompactNumber(hud.score)} />
                <HudChip icon={CoinsIcon} label="Coins" value={String(hud.coins)} />
              </div>
              <div className="rounded-full bg-black/40 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-md">
                {formatCompactNumber(hud.distance)}m
              </div>
            </div>
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
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-glow/25 to-primary/10 text-4xl ring-1 ring-primary/25 animate-float">
                  🦖
                </div>
                <div>
                  <p className="text-lg font-bold text-white">MPGR Run</p>
                  <p className="mt-1 max-w-xs text-xs text-muted">
                    Tap anywhere to jump. Dodge obstacles, grab coins, and survive as long as you can.
                  </p>
                </div>
                <button
                  onClick={beginCountdown}
                  className="flex min-h-[44px] items-center gap-2 rounded-xl bg-gradient-premium px-6 py-2.5 text-sm font-semibold text-white shadow-glow-gold transition-transform active:scale-95"
                >
                  <Play className="h-4 w-4" aria-hidden="true" />
                  Start Run
                </button>
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
                  onClick={togglePause}
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
                    This run couldn't be validated, so no XP was awarded. {outcome.validationReasons[0]}
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
                    onClick={beginCountdown}
                    className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-gradient-premium px-6 py-2.5 text-sm font-semibold text-white shadow-glow-gold transition-transform active:scale-95"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    Try Again
                  </button>
                  <button
                    onClick={handleShare}
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
        </div>
      </GlassCard>
    </div>
  );
}

function HudChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Zap;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 backdrop-blur-md">
      <Icon className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
      <span className="text-xs font-semibold text-white">{value}</span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function StatPill({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-2 py-2.5">
      <p className={highlight ? "text-sm font-bold text-gold" : "text-sm font-bold text-white"}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted">{label}</p>
    </div>
  );
}
