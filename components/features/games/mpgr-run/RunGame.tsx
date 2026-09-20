"use client";

import { MPGR_RUN_SIMULATION_WIDTH } from "@/lib/games/mpgr-run/authoritative-replay";

import { appendRunInputEvent, createRunInputTrace, snapDurationToSimulationTicks } from "@/lib/games/mpgr-run/input-trace";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  Share2,
  Trophy,
  Zap,
} from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { HudChip, ControlButton, StatPill } from "./RunGameHud";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { formatCompactNumber } from "@/lib/format";
import { startSession, endSession, type GameSessionMeta } from "@/lib/games/game-session";
import { finalizeRun, type RunResult, type RunStats } from "@/lib/games/mpgr-run/run-score";
import { processRunResult, type ProcessRunResultOutcome } from "@/lib/games/mpgr-run/run-rewards";
import { submitRunToServer, pingGameHeartbeat } from "@/lib/games/mpgr-run/submit-server-reward";
import { getGameStats } from "@/lib/games/game-storage";
import { resolveDifficulty } from "@/lib/games/mpgr-run/difficulty";
import { createDeterministicRng } from "@/lib/games/mpgr-run/deterministic-rng";
import {
  maybeSpawnObstacles,
  maybeSpawnCollectible,
  maybeSpawnPowerup,
  type CollectibleEntity,
  type PowerupEntity,
} from "@/lib/games/mpgr-run/spawn-manager";
import { getRunAudioHooks } from "@/lib/games/mpgr-run/audio-hooks";
import {
  CHARACTER_SPRITES,
  COLLECTIBLE_SPRITES,
  POWERUP_SPRITES,
  UI_SPRITES,
  EFFECT_SPRITES,
  BACKGROUND_STRIP_TARGETS,
  CRITICAL_SPRITE_PATHS,
  OPTIONAL_SPRITE_PATHS,
} from "@/lib/games/mpgr-run/run-assets";
import { startRunAssetPipeline } from "@/lib/games/mpgr-run/asset-loader";
import {
  MPGR_RUN_GAME_ID,
  LANE_COUNT,
  LANE_GAP_PX,
  PLAYER_X,
  PLAYER_SIZE,
  GRAVITY,
  JUMP_VELOCITY,
  BASE_SPEED,
  MAX_SPEED,
  RAMP_DURATION_MS,
  SPEED_TIERS,
  PX_PER_METER,
  COUNTDOWN_SECONDS,
  STARTING_HP,
  HIT_INVULNERABILITY_MS,
  SLIDE_DURATION_MS,
  CHECKPOINT_INTERVAL_M,
  CHECKPOINT_GRACE_MS,
  JETPACK_FLY_HEIGHT,
  MAGNET_RANGE_PX,
  MAGNET_ATTRACT_MS,
  SPEED_BOOST_MULTIPLIER,
  COLLECTIBLE_TYPES,
  POWERUP_TYPES,
  type PowerupType,
} from "@/lib/games/mpgr-run/run-config";
import { clamp, laneBaselineScreenY, verticalOverlap } from "@/lib/games/mpgr-run/run-physics";
import { type World, freshWorld } from "@/lib/games/mpgr-run/run-world";
import { stripBackgroundToTransparent, drawRunFrame } from "@/lib/games/mpgr-run/run-render";

type Phase = "idle" | "countdown" | "running" | "paused" | "game_over";

interface HudSnapshot {
  distance: number;
  score: number;
  coins: number;
  gems: number;
  hp: number;
  speedTier: number;
  activePowerups: { type: PowerupType; remainingMs: number }[];
  checkpointFlash: boolean;
}

interface RunGameProps {
  address: string;
}

export function RunGame({ address }: RunGameProps) {
  const { authenticate, authenticating } = useWalletAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(freshWorld());
  const sessionRef = useRef<GameSessionMeta | null>(null);

  // Temporary deterministic RNG wiring.
  // The final authoritative version will initialize this from the
  // server-issued run seed.
  const runRngRef = useRef(createDeterministicRng(0));
  const inputTraceRef = useRef(createRunInputTrace());
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const fixedStepAccumulatorRef = useRef(0);
  const hudIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const resizeRef = useRef<(() => void) | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const idRef = useRef(1);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const readySpritesRef = useRef<Map<string, CanvasImageSource>>(new Map());
  const inflightSpritesRef = useRef<Set<string>>(new Set());
  const failedSpritesRef = useRef<Set<string>>(new Set());
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const finishRunRef = useRef<() => void>(() => {});
  const finishingRef = useRef(false);
  // Synchronous guard for the async session-creation request. React state
  // remains "idle" while fetch() is pending, so phaseRef alone cannot prevent
  // rapid Start/Retry taps from minting multiple server sessions.
  const startSessionInFlightRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [countdownValue, setCountdownValue] = useState(COUNTDOWN_SECONDS);
  const [hud, setHud] = useState<HudSnapshot>({
    distance: 0,
    score: 0,
    coins: 0,
    gems: 0,
    hp: STARTING_HP,
    speedTier: 0,
    activePowerups: [],
    checkpointFlash: false,
  });
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [outcome, setOutcome] = useState<ProcessRunResultOutcome | null>(null);
  const [personalBest, setPersonalBest] = useState(0);
  const [shareCopied, setShareCopied] = useState(false);

  // Keep phaseRef in lockstep with React state. Callers that start/stop the
  // rAF loop must also write phaseRef synchronously (via goToPhase) so a
  // frame that is already queued cannot observe a stale phase.
  const goToPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const nextId = useCallback(() => idRef.current++, []);

  // Load personal best once on mount / when a run completes.
  const refreshPersonalBest = useCallback(() => {
    const stats = getGameStats(MPGR_RUN_GAME_ID, address);
    setPersonalBest(stats.bestScore);
  }, [address]);

  useEffect(() => {
    refreshPersonalBest();
  }, [refreshPersonalBest]);

  // --- Canvas sizing -------------------------------------------------
  // Keeps the canvas's drawing-buffer pixels (canvas.width/height, scaled
  // by DPR) in sync with its CSS display size (canvas.style.width/height,
  // driven by the container's actual layout box). On mobile this needs
  // more than a single mount-time measurement + ResizeObserver: the
  // container's height depends on 100dvh several levels up, and mobile
  // browsers resolve dvh *after* first paint as the address-bar/toolbar
  // chrome finishes animating — so an early read can lock the canvas's
  // inline CSS size to a too-small value before the surrounding layout
  // has settled. The fixes below don't change how sizing is computed,
  // only when/how reliably it's re-checked.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      // A transient 0×0 read (mid-orientation-change, mid-hydration, or
      // while an ancestor's dvh-based height hasn't resolved yet) must
      // never be applied — it would lock the canvas to zero size via the
      // inline style below, with nothing left to trigger a later correct
      // resize if the container's box doesn't change again afterward.
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      // Setting canvas.width resets the context; reuse the same 2d context
      // object rather than calling getContext from the hot draw path.
      const ctx = canvas.getContext("2d");
      ctxRef.current = ctx;
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { width: rect.width, height: rect.height };
    };

    resizeRef.current = resize;
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    // Extra correction passes shortly after mount, to catch mobile dvh /
    // safe-area / toolbar settling that can finish after the container's
    // own ResizeObserver entries have already been delivered once.
    const settleTimeouts = [50, 200, 500].map((ms) => window.setTimeout(resize, ms));
    const rafId = window.requestAnimationFrame(resize);

    // ResizeObserver tracks the container's own box reliably in the
    // steady state, but orientation changes and dynamic viewport-chrome
    // transitions on iOS/Android are worth listening to directly too.
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);
    window.visualViewport?.addEventListener("resize", resize);

    return () => {
      observer.disconnect();
      settleTimeouts.forEach((id) => window.clearTimeout(id));
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);

  // --- Sprite preload ---------------------------------------------------
  // Two-tier pipeline (see asset-loader.ts):
  //   CRITICAL  — idle/run/run2/jump/fall/slide + city layers + HUD.
  //               Slot-limited; each PNG occupies a slot until load +
  //               decode (+ strip) has settled.
  //   OPTIONAL  — collectibles, power-ups, obstacles, VFX. Starts only
  //               after every critical asset has settled, not merely started.
  //
  // draw() reads the ready cache and uses the existing procedural fallback
  // for anything not yet load+decode-ready. Gameplay NEVER awaits this, so
  // a slow phone / hung PNG / 404 cannot freeze countdown or the rAF loop.
  //
  // Sprites are versioned (RUN_ASSET_VERSION on every path) so a cached
  // previous-generation PNG cannot win over the current artwork. A sprite
  // is inserted into readySpritesRef only after decode (and background
  // strip, if listed) succeeds — never on a raw onload — so we don't
  // flash an undecoded or black-background frame. Write-once: a late load
  // cannot overwrite a decoded current-version sprite.
  useEffect(() => {
    const stripTargets = new Set(BACKGROUND_STRIP_TARGETS);
    const pipeline = startRunAssetPipeline({
      critical: CRITICAL_SPRITE_PATHS,
      optional: OPTIONAL_SPRITE_PATHS,
      ready: readySpritesRef.current,
      inflight: inflightSpritesRef.current,
      failed: failedSpritesRef.current,
      stripTargets,
      stripBackground: stripBackgroundToTransparent,
    });
    return () => pipeline.stop();
  }, []);

  const getSprite = useCallback((src: string): CanvasImageSource | null => {
    return readySpritesRef.current.get(src) ?? null;
  }, []);

  // --- Particle helper --------------------------------------------------
  const spawnBurst = useCallback((world: World, x: number, y: number, color: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 140;
      world.particles.push({
        id: nextId(),
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 350 + Math.random() * 300,
        maxLife: 650,
        color,
        size: 2 + Math.random() * 3,
      });
    }
    if (world.particles.length > 160) {
      world.particles.splice(0, world.particles.length - 160);
    }
  }, [nextId]);

  // A brief real-artwork overlay (explosion/coin/gem burst art), layered on
  // top of the tiny procedural dot particles above rather than replacing
  // them — capped short so a flurry of pickups can never pile up visually.
  const spawnSpriteBurst = useCallback(
    (world: World, x: number, y: number, sprite: string, durationMs: number, maxSize: number) => {
      world.spriteBursts.push({ id: nextId(), x, y, sprite, startMs: world.elapsedMs, durationMs, maxSize });
      if (world.spriteBursts.length > 12) {
        world.spriteBursts.splice(0, world.spriteBursts.length - 12);
      }
    },
    [nextId]
  );

  // --- Render a single frame ------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let ctx = ctxRef.current;
    if (!ctx || ctx.canvas !== canvas) {
      ctx = canvas.getContext("2d");
      ctxRef.current = ctx;
    }
    if (!ctx) return;
    const { width: viewportWidth, height } = sizeRef.current;
    if (viewportWidth === 0 || height === 0) return;

    drawRunFrame(ctx, worldRef.current, viewportWidth, height, getSprite);
  }, [getSprite]);
  // Paint a frame on every phase change, not just when "running" starts.
  // The authoritative rAF loop below only calls draw() while running, so
  // previously the canvas was never painted during "idle"/"countdown"/
  // "paused"/"game_over" — it just showed whatever was last drawn (often
  // nothing), which is why the countdown appeared over a blank/dark
  // container instead of the actual scene. This only ever calls draw()
  // (pure rendering, reads worldRef/sizeRef but never mutates them and
  // never calls step()) — it cannot affect physics, scoring, or
  // collisions.
  useEffect(() => {
    resizeRef.current?.();
    draw();
  }, [phase, draw]);

  // --- Collect helpers ---------------------------------------------------
  const collectItem = useCallback(
    (world: World, c: CollectibleEntity, height: number) => {
      c.collected = true;
      const cfg = COLLECTIBLE_TYPES[c.type];
      const hooks = getRunAudioHooks();
      switch (c.type) {
        case "coin":
          world.stats.coins += 1;
          hooks.onCoinPickup();
          break;
        case "gem":
          world.stats.gems += 1;
          hooks.onGemPickup();
          break;
        case "xpOrb":
          world.stats.xpOrbs += 1;
          hooks.onCoinPickup();
          break;
        case "key":
          world.stats.keys += 1;
          hooks.onCoinPickup();
          break;
        case "chest":
          world.stats.chests += 1;
          hooks.onCoinPickup();
          break;
      }
      if (world.activePowerups.score2x) world.bonusScore += cfg.scoreValue;
      const cx = c.x;
      const cy = laneBaselineScreenY(height, c.lane) - 14;
      spawnBurst(world, cx, cy, cfg.color, c.type === "chest" ? 16 : 6);
      if (c.type === "coin" || c.type === "xpOrb" || c.type === "key") {
        spawnSpriteBurst(world, cx, cy, EFFECT_SPRITES.coinBurst, 380, c.radius * 5);
      } else if (c.type === "gem") {
        spawnSpriteBurst(world, cx, cy, EFFECT_SPRITES.gemBurst, 420, c.radius * 5.5);
      }
    },
    [spawnBurst, spawnSpriteBurst]
  );

  const collectPowerup = useCallback(
    (world: World, pu: PowerupEntity, height: number) => {
      pu.collected = true;
      const cfg = POWERUP_TYPES[pu.type];
      world.activePowerups[pu.type] = world.elapsedMs + cfg.durationMs;
      world.stats.powerups += 1;
      getRunAudioHooks().onPowerupPickup(pu.type);
      spawnBurst(world, pu.x, laneBaselineScreenY(height, pu.lane) - 20, cfg.color, 10);
    },
    [spawnBurst]
  );

  // --- Physics / spawn step -------------------------------------------
  const step = useCallback(
    (dt: number, canvasHeight: number) => {
      const world = worldRef.current;
      const playerScreenX = MPGR_RUN_SIMULATION_WIDTH * PLAYER_X;
      const p = world.player;
      const hooks = getRunAudioHooks();

      world.elapsedMs += dt * 1000;

      const distanceMetersSoFar = world.traveledPx / PX_PER_METER;
      const band = resolveDifficulty(distanceMetersSoFar);

      const rampProgress = Math.min(1, world.elapsedMs / RAMP_DURATION_MS);
      world.speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * rampProgress;
      const speedActive = !!world.activePowerups.speed;
      world.effectiveSpeed = world.speed * (speedActive ? SPEED_BOOST_MULTIPLIER : 1);
      world.traveledPx += world.effectiveSpeed * dt;

      // Vertical physics.
      const jetpackActive = !!world.activePowerups.jetpack;
      if (jetpackActive) {
        p.playerY += (JETPACK_FLY_HEIGHT - p.playerY) * Math.min(1, dt * 6);
        p.velocityY = 0;
      } else {
        const wasGrounded = p.playerY <= 0;
        p.velocityY -= GRAVITY * dt;
        p.playerY += p.velocityY * dt;
        if (p.playerY <= 0) {
          p.playerY = 0;
          p.velocityY = 0;
          if (!wasGrounded) hooks.onLand();
        }
      }
      if (p.sliding && world.elapsedMs >= p.slideUntilMs) p.sliding = false;

      // Smooth lane transition (visual only — collision uses the logical lane instantly).
      const targetOffset = (p.lane - 1) * LANE_GAP_PX;
      p.laneOffset += (targetOffset - p.laneOffset) * Math.min(1, dt * 10);

      // Scroll entities.
      for (const o of world.obstacles) o.x -= world.effectiveSpeed * dt;
      for (const c of world.collectibles) c.x -= world.effectiveSpeed * dt;
      for (const pu of world.powerups) pu.x -= world.effectiveSpeed * dt;
      world.obstacles = world.obstacles.filter((o) => o.x + o.width > -40);
      world.collectibles = world.collectibles.filter((c) => c.x > -40 && !c.collected);
      world.powerups = world.powerups.filter((pu) => pu.x > -40 && !pu.collected);

      // Particles.
      for (const part of world.particles) {
        part.life -= dt * 1000;
        part.x -= world.effectiveSpeed * dt * 0.5 + part.vx * dt;
        part.y += part.vy * dt;
      }
      world.particles = world.particles.filter((part) => part.life > 0);

      // Sprite bursts (real hit/pickup artwork) — scroll with the world and expire on a fixed timer.
      for (const burst of world.spriteBursts) {
        burst.x -= world.effectiveSpeed * dt * 0.5;
      }
      world.spriteBursts = world.spriteBursts.filter((burst) => world.elapsedMs - burst.startMs < burst.durationMs);

      world.screenShake = Math.max(0, world.screenShake - dt * 40);

      // Spawn.
      const newObstacles = maybeSpawnObstacles(world.obstacles, MPGR_RUN_SIMULATION_WIDTH, band, nextId, runRngRef.current);
      if (newObstacles.length) world.obstacles.push(...newObstacles);
      const newCollectible = maybeSpawnCollectible(world.collectibles, MPGR_RUN_SIMULATION_WIDTH, band, nextId, runRngRef.current);
      if (newCollectible) world.collectibles.push(newCollectible);
      const newPowerup = maybeSpawnPowerup(world.powerups, MPGR_RUN_SIMULATION_WIDTH, band, nextId, runRngRef.current);
      if (newPowerup) world.powerups.push(newPowerup);

      // Expire power-ups.
      (Object.keys(world.activePowerups) as PowerupType[]).forEach((key) => {
        const exp = world.activePowerups[key];
        if (exp !== undefined && world.elapsedMs >= exp) {
          delete world.activePowerups[key];
          hooks.onPowerupExpire(key);
        }
      });

      // Obstacle collisions.
      const damageImmune =
        world.elapsedMs < p.invulnerableUntilMs || !!world.activePowerups.shield || !!world.activePowerups.invincibility;

      for (const o of world.obstacles) {
        const overlapX = playerScreenX + PLAYER_SIZE > o.x && playerScreenX < o.x + o.width;
        const overlapLane = o.lane === p.lane;

        if (!o.hit && overlapX && overlapLane && verticalOverlap(o, p)) {
          o.hit = true;
          if (!o.passed) {
            o.passed = true;
            world.stats.obstaclesPassed += 1;
          }
          if (damageImmune) {
            spawnBurst(world, o.x, laneBaselineScreenY(canvasHeight, o.lane) - o.groundHeight - o.height / 2, "#60A5FA", 8);
          } else {
            p.hp -= 1;
            world.stats.hits += 1;
            p.invulnerableUntilMs = world.elapsedMs + HIT_INVULNERABILITY_MS;
            world.screenShake = 14;
            world.hitFlashUntilMs = world.elapsedMs + 220;
            const hitCx = playerScreenX + PLAYER_SIZE / 2;
            const hitCy = laneBaselineScreenY(canvasHeight, p.lane) - p.playerY - PLAYER_SIZE / 2;
            spawnBurst(world, playerScreenX, hitCy, "#F87171", 14);
            spawnSpriteBurst(world, hitCx, hitCy, EFFECT_SPRITES.hit, 480, PLAYER_SIZE * 3.2);
            hooks.onHit();
            if (p.hp <= 0) world.gameOver = true;
          }
        }

        if (!o.passed && o.x + o.width < playerScreenX) {
          o.passed = true;
          world.stats.obstaclesPassed += 1;
        }
      }

      // Collectible pickup + magnet.
      const magnetActive = !!world.activePowerups.magnet;
      for (const c of world.collectibles) {
        if (c.collected) continue;
        const sameLane = c.lane === p.lane;
        const dx = Math.abs(c.x - playerScreenX);

        if (magnetActive && dx < MAGNET_RANGE_PX) {
          if (c.magnetizedAtMs === undefined) c.magnetizedAtMs = world.elapsedMs;
          if (world.elapsedMs - c.magnetizedAtMs >= MAGNET_ATTRACT_MS) {
            collectItem(world, c, canvasHeight);
          }
        } else if (sameLane && dx < c.radius + 15) {
          collectItem(world, c, canvasHeight);
        }
      }

      // Power-up pickup.
      for (const pu of world.powerups) {
        if (pu.collected) continue;
        const sameLane = pu.lane === p.lane;
        const dx = Math.abs(pu.x - playerScreenX);
        if (sameLane && dx < pu.radius + PLAYER_SIZE / 2) {
          collectPowerup(world, pu, canvasHeight);
        }
      }

      // Checkpoints.
      const distanceMeters = world.traveledPx / PX_PER_METER;
      while (distanceMeters >= world.nextCheckpointM) {
        world.stats.checkpoints += 1;
        world.nextCheckpointM += CHECKPOINT_INTERVAL_M;
        p.invulnerableUntilMs = Math.max(p.invulnerableUntilMs, world.elapsedMs + CHECKPOINT_GRACE_MS);
        world.checkpointFlashUntilMs = world.elapsedMs + 1400;
        hooks.onCheckpoint();
      }
    },
    [nextId, spawnBurst, spawnSpriteBurst, collectItem, collectPowerup]
  );

  // --- Game loop --------------------------------------------------------
  const loop = useCallback(
    (now: number) => {
      if (phaseRef.current !== "running") {
        rafRef.current = null;
        return;
      }
      const last = lastTimeRef.current || now;
      const frameDt = Math.min((now - last) / 1000, 0.25);
      lastTimeRef.current = now;

      // Gameplay advances in deterministic 60 Hz simulation ticks.
      // Rendering may run at any refresh rate, but authoritative gameplay
      // state is never dependent on the device's frame rate.
      const FIXED_DT = 1 / 60;
      const MAX_STEPS_PER_FRAME = 8;
      fixedStepAccumulatorRef.current += frameDt;

      let steps = 0;
      while (
        fixedStepAccumulatorRef.current >= FIXED_DT &&
        steps < MAX_STEPS_PER_FRAME &&
        !worldRef.current.gameOver
      ) {
        step(FIXED_DT, sizeRef.current.height);
        fixedStepAccumulatorRef.current -= FIXED_DT;
        steps += 1;
      }

      // Never let a long tab/background stall create an unbounded catch-up.
      if (steps === MAX_STEPS_PER_FRAME) {
        fixedStepAccumulatorRef.current = Math.min(
          fixedStepAccumulatorRef.current,
          FIXED_DT,
        );
      }

      draw();

      if (worldRef.current.gameOver) {
        finishRunRef.current();
        return;
      }

      rafRef.current = requestAnimationFrame(loop);
    },
    [step, draw]
  );

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (hudIntervalRef.current != null) clearInterval(hudIntervalRef.current);
    hudIntervalRef.current = null;
    if (heartbeatIntervalRef.current != null) clearInterval(heartbeatIntervalRef.current);
    heartbeatIntervalRef.current = null;
  }, []);

  const buildStats = useCallback((world: World): RunStats => {
    return {
      distanceMeters: world.traveledPx / PX_PER_METER,
      durationMs: snapDurationToSimulationTicks(world.elapsedMs),
      coinsCollected: world.stats.coins,
      gemsCollected: world.stats.gems,
      xpOrbsCollected: world.stats.xpOrbs,
      keysCollected: world.stats.keys,
      chestsCollected: world.stats.chests,
      powerupsCollected: world.stats.powerups,
      obstaclesPassed: world.stats.obstaclesPassed,
      checkpointsReached: world.stats.checkpoints,
      bonusScore: world.bonusScore,
      hitsTaken: world.stats.hits,
      collided: world.stats.hits > 0,
      maxSpeedTierReached: Math.floor(Math.min(1, world.elapsedMs / RAMP_DURATION_MS) * SPEED_TIERS),
    };
  }, []);

  const finishRun = useCallback(() => {
    // Idempotent: a queued rAF + the gameOver flag must not double-submit
    // rewards or double-fire game-over audio. phaseRef is written first so
    // any other in-flight frame bails before touching session/rewards.
    if (finishingRef.current || phaseRef.current === "game_over") return;
    finishingRef.current = true;
    stopLoop();
    const world = worldRef.current;
    const session = sessionRef.current;
    goToPhase("game_over");
    getRunAudioHooks().onGameOver();
    if (!session) return;

    const ended = endSession(session);
    sessionRef.current = ended;

    const result = finalizeRun(buildStats(world));
    setRunResult(result);

    const rewardOutcome = processRunResult(address, ended.sessionId, result);
setOutcome(rewardOutcome);
refreshPersonalBest();

// Weekly competitive Game Rewards — fire-and-forget. sessionId makes
// this safe to have fail silently here; XP/gameplay above already
// completed successfully regardless of this call's outcome. No MPGR
// amount is ever received or displayed from this response — only
// this week's validRunCount/bestScore/eligibilityStatus, see
// WeeklyGameRewardsPanel-style consumers of useWeeklyGameStats.
void submitRunToServer(address, ended.sessionId, result, inputTraceRef.current);
}, [address, stopLoop, refreshPersonalBest, buildStats, goToPhase]);

  finishRunRef.current = finishRun;

  const startHudSync = useCallback(() => {
    if (hudIntervalRef.current != null) clearInterval(hudIntervalRef.current);
    hudIntervalRef.current = setInterval(() => {
      const world = worldRef.current;
      const provisional = finalizeRun(buildStats(world));
      const activePowerups = (Object.keys(world.activePowerups) as PowerupType[])
        .map((type) => ({ type, remainingMs: Math.max(0, (world.activePowerups[type] ?? 0) - world.elapsedMs) }))
        .filter((entry) => entry.remainingMs > 0);

      setHud({
        distance: Math.floor(provisional.distanceMeters),
        score: provisional.score,
        coins: world.stats.coins,
        gems: world.stats.gems,
        hp: world.player.hp,
        speedTier: provisional.maxSpeedTierReached,
        activePowerups,
        checkpointFlash: world.elapsedMs < world.checkpointFlashUntilMs,
      });
    }, 120);
  }, [buildStats]);

  const beginCountdown = useCallback(async () => {
    // Phase alone is insufficient here because React stays in "idle" while
    // the async session request is pending. Lock synchronously before fetch()
    // so rapid Start/Retry taps can never mint multiple server sessions.
    if (startSessionInFlightRef.current) return;
    if (phaseRef.current === "countdown" || phaseRef.current === "running" || phaseRef.current === "paused") return;

    startSessionInFlightRef.current = true;
    setStarting(true);
    setStartError(null);
    try {
      finishingRef.current = false;
      if (countdownTimerRef.current != null) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      stopLoop();
      fixedStepAccumulatorRef.current = 0;
      inputTraceRef.current = createRunInputTrace();
      worldRef.current = freshWorld();

      const requestSession = async () => {
        const res = await fetch("/api/games/mpgr-run/session", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
        });
        if (res.status === 401) {
          const signedIn = await authenticate();
          if (!signedIn) {
            throw new Error("Wallet signature required to start a run");
          }
          const retry = await fetch("/api/games/mpgr-run/session", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
          });
          if (!retry.ok) {
            throw new Error(retry.status === 429
              ? "Too many active runs. Wait a moment and try again."
              : "Unable to start secure game session");
          }
          return await retry.json() as {
            sessionId: string;
            expiresAt: string;
            seed: string;
            protocolVersion: number;
          };
        }
        if (!res.ok) {
          throw new Error(res.status === 429
            ? "Too many active runs. Wait a moment and try again."
            : "Unable to start secure game session");
        }
        return await res.json() as {
          sessionId: string;
          expiresAt: string;
          seed: string;
          protocolVersion: number;
        };
      };

      let serverSession: {
        sessionId: string;
        expiresAt: string;
        seed: string;
        protocolVersion: number;
      } | null = null;
      try {
        serverSession = await requestSession();
      } catch (error) {
        setStartError(error instanceof Error ? error.message : "Unable to start game");
        goToPhase("idle");
        return;
      }

      if (!serverSession) {
        setStartError("Unable to start game. Check your connection and try again.");
        goToPhase("idle");
        return;
      }

      if (!/^[0-9a-f]{64}$/.test(serverSession.seed)) {
        throw new Error("Invalid game session seed");
      }

      if (serverSession.protocolVersion !== 1) {
        throw new Error("Unsupported MPGR Run protocol version");
      }

      runRngRef.current = createDeterministicRng(serverSession.seed);

      sessionRef.current = startSession(MPGR_RUN_GAME_ID, address, serverSession.sessionId);
      setRunResult(null);
      setOutcome(null);
      setHud({
        distance: 0,
        score: 0,
        coins: 0,
        gems: 0,
        hp: STARTING_HP,
        speedTier: 0,
        activePowerups: [],
        checkpointFlash: false,
      });
      setCountdownValue(COUNTDOWN_SECONDS);
      goToPhase("countdown");

      let remaining = COUNTDOWN_SECONDS;
      countdownTimerRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          if (countdownTimerRef.current != null) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          // Enter PLAYING here; the effect below owns rAF start. Starting the
          // loop from this interval previously raced phaseRef (still "countdown"
          // until React committed), so the first frame bailed and never
          // rescheduled — UI visible, world frozen.
          goToPhase("running");
        } else {
          setCountdownValue(remaining);
        }
      }, 700);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Unable to start game");
      goToPhase("idle");
    } finally {
      // Once the server session has either failed or successfully entered
      // countdown, phaseRef is sufficient to block another start.
      startSessionInFlightRef.current = false;
      setStarting(false);
    }
  }, [address, authenticate, goToPhase, stopLoop]);

  // --- Input actions ------------------------------------------------------
  const jump = useCallback(() => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    const p = world.player;
    if (world.activePowerups.jetpack) return;
    if (p.playerY <= 0 && !p.sliding) {
      appendRunInputEvent(inputTraceRef.current, {
        type: "jump",
        atMs: world.elapsedMs,
      });
      p.velocityY = JUMP_VELOCITY;
      getRunAudioHooks().onJump();
    }
  }, []);

  const slide = useCallback(() => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    const p = world.player;
    if (world.activePowerups.jetpack) return;
    if (p.playerY <= 0) {
      appendRunInputEvent(inputTraceRef.current, {
        type: "slide",
        atMs: world.elapsedMs,
      });
      p.sliding = true;
      p.slideUntilMs = world.elapsedMs + SLIDE_DURATION_MS;
      getRunAudioHooks().onSlide();
    }
  }, []);

  const switchLane = useCallback((dir: -1 | 1) => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    const previousLane = world.player.lane;
    const nextLane = clamp(previousLane + dir, 0, LANE_COUNT - 1);
    if (nextLane !== previousLane) {
      appendRunInputEvent(inputTraceRef.current, {
        type: "lane",
        atMs: world.elapsedMs,
        dir,
      });
      world.player.lane = nextLane;
    }
  }, []);

  const togglePause = useCallback(() => {
    if (phaseRef.current === "running") {
      goToPhase("paused");
      stopLoop();
    } else if (phaseRef.current === "paused") {
      goToPhase("running");
    }
  }, [goToPhase, stopLoop]);

  // The game loop is started exactly when phase becomes PLAYING (after React
  // has committed and phaseRef has been synced), and torn down on any other
  // phase, unmount, or a replacement `loop` callback. This is the single
  // rAF owner — countdown/Resume/visibility must not requestAnimationFrame
  // on their own or a stale frame can early-return and kill the chain.
  useEffect(() => {
    if (phase !== "running") return;
    lastTimeRef.current = 0;
    startHudSync();
    const ping = () => {
      const sessionId = sessionRef.current?.sessionId;
      if (sessionId) void pingGameHeartbeat(sessionId);
    };
    ping();
    heartbeatIntervalRef.current = setInterval(ping, 8_000);
    rafRef.current = requestAnimationFrame(loop);
    return stopLoop;
  }, [phase, loop, startHudSync, stopLoop]);

  // Pause automatically if the tab loses focus mid-run.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && phaseRef.current === "running") {
        goToPhase("paused");
        stopLoop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [goToPhase, stopLoop]);

  // Keyboard controls (desktop): Arrows/WASD to switch lanes, Space/Up/W jump, Down/S slide.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") jump();
      else if (e.code === "ArrowDown" || e.code === "KeyS") slide();
      else if (e.code === "ArrowLeft" || e.code === "KeyA") switchLane(-1);
      else if (e.code === "ArrowRight" || e.code === "KeyD") switchLane(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [jump, slide, switchLane]);

  useEffect(() => {
    return () => {
      stopLoop();
      if (countdownTimerRef.current != null) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [stopLoop]);

  // Swipe gestures on the canvas surface — short tap still jumps.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (phase !== "running") return;
    swipeStartRef.current = { x: e.clientX, y: e.clientY };
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    if (phase !== "running") return;
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) {
      jump();
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      switchLane(dx > 0 ? 1 : -1);
    } else if (dy < -40) {
      jump();
    } else if (dy > 40) {
      slide();
    } else {
      jump();
    }
  };

  const handleShare = async () => {
    if (!runResult) return;
    const shareUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/games/mpgr-run`
        : "https://mpgrhub.xyz/games/mpgr-run";
    const text = `⚡ I survived ${Math.floor(runResult.distanceMeters)}m in MPGR Run.\n\nScore: ${formatCompactNumber(
      runResult.score
    )}\n\nCan you beat me?\n${shareUrl}\n\n🔵 MPGR HUB`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "MPGR Run", text });
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
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex shrink-0 items-center justify-between">
        {/* The full site chrome (Navbar/BottomNav) is intentionally hidden
            on this page so the game gets the full viewport — see
            app/games/mpgr-run/page.tsx and components/BottomNav.tsx. That
            removed the mobile bottom nav's "Games" tab as a way back, so
            this compact link is now shown at every breakpoint instead of
            only on desktop. */}
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
            className="ml-auto flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-white ring-1 ring-white/10 active:scale-95"
          >
            <Pause className="h-5 w-5" strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
      </div>

      <GlassCard className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          className="relative min-h-0 w-full flex-1 select-none touch-none"
          style={{ touchAction: "none" }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

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
                    <ControlButton icon={ChevronLeft} label="Left" onPress={() => switchLane(-1)} />
                    <ControlButton icon={ChevronRight} label="Right" onPress={() => switchLane(1)} />
                  </div>
                  <div className="flex gap-2">
                    <ControlButton icon={ChevronDown} label="Slide" onPress={slide} />
                    <ControlButton icon={ChevronUp} label="Jump" onPress={jump} accent />
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
                    if (containerRef.current && typeof containerRef.current.requestFullscreen === "function" && window.matchMedia("(min-width: 1024px)").matches) {
                      void containerRef.current.requestFullscreen().catch(() => undefined);
                    }
                    void beginCountdown();
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

// HudChip, ControlButton, and StatPill were extracted verbatim to
// ./RunGameHud (P2-11 modularization) — they are pure presentational
// components with no dependency on game state, so the extraction is a
// literal move with no behavior change.
