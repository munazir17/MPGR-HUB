"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { formatCompactNumber } from "@/lib/format";
import { startSession, endSession, type GameSessionMeta } from "@/lib/games/game-session";
import { finalizeRun, type RunResult, type RunStats } from "@/lib/games/mpgr-run/run-score";
import { processRunResult, type ProcessRunResultOutcome } from "@/lib/games/mpgr-run/run-rewards";
import { getGameStats } from "@/lib/games/game-storage";
import { resolveDifficulty } from "@/lib/games/mpgr-run/difficulty";
import {
  maybeSpawnObstacles,
  maybeSpawnCollectible,
  maybeSpawnPowerup,
  type ObstacleEntity,
  type CollectibleEntity,
  type PowerupEntity,
} from "@/lib/games/mpgr-run/spawn-manager";
import { getRunAudioHooks } from "@/lib/games/mpgr-run/audio-hooks";
import {
  CHARACTER_SPRITES,
  OBSTACLE_SPRITES,
  COLLECTIBLE_SPRITES,
  POWERUP_SPRITES,
  CHECKPOINT_SPRITE,
  UI_SPRITES,
  CITY_ENVIRONMENT,
  EFFECT_SPRITES,
  BACKGROUND_STRIP_TARGETS,
  ALL_SPRITE_PATHS,
} from "@/lib/games/mpgr-run/run-assets";
import {
  MPGR_RUN_GAME_ID,
  LANE_COUNT,
  LANE_CENTER_Y,
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
  SLIDE_HITBOX_SCALE,
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

type Phase = "idle" | "countdown" | "running" | "paused" | "game_over";

interface PlayerState {
  lane: number;
  laneOffset: number; // smoothed screen-space vertical offset toward the current lane's baseline
  playerY: number; // px above the current lane's ground line, 0 = grounded
  velocityY: number;
  sliding: boolean;
  slideUntilMs: number;
  hp: number;
  invulnerableUntilMs: number;
}

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

/** A brief real-artwork overlay (hit explosion, coin/gem burst) — separate from the tiny procedural dot particles above. */
interface SpriteBurst {
  id: number;
  x: number;
  y: number;
  sprite: string;
  startMs: number;
  durationMs: number;
  maxSize: number;
}

type ActivePowerups = Partial<Record<PowerupType, number>>; // value = world.elapsedMs when the effect expires

interface RunStatsAccum {
  coins: number;
  gems: number;
  xpOrbs: number;
  keys: number;
  chests: number;
  powerups: number;
  obstaclesPassed: number;
  checkpoints: number;
  hits: number;
}

interface World {
  player: PlayerState;
  speed: number;
  effectiveSpeed: number;
  elapsedMs: number;
  traveledPx: number;
  obstacles: ObstacleEntity[];
  collectibles: CollectibleEntity[];
  powerups: PowerupEntity[];
  particles: Particle[];
  spriteBursts: SpriteBurst[];
  activePowerups: ActivePowerups;
  stats: RunStatsAccum;
  bonusScore: number;
  nextCheckpointM: number;
  screenShake: number;
  checkpointFlashUntilMs: number;
  hitFlashUntilMs: number;
  gameOver: boolean;
}

function freshWorld(): World {
  return {
    player: {
      lane: 1,
      laneOffset: 0,
      playerY: 0,
      velocityY: 0,
      sliding: false,
      slideUntilMs: 0,
      hp: STARTING_HP,
      invulnerableUntilMs: 0,
    },
    speed: BASE_SPEED,
    effectiveSpeed: BASE_SPEED,
    elapsedMs: 0,
    traveledPx: 0,
    obstacles: [],
    collectibles: [],
    powerups: [],
    particles: [],
    spriteBursts: [],
    activePowerups: {},
    stats: { coins: 0, gems: 0, xpOrbs: 0, keys: 0, chests: 0, powerups: 0, obstaclesPassed: 0, checkpoints: 0, hits: 0 },
    bonusScore: 0,
    nextCheckpointM: CHECKPOINT_INTERVAL_M,
    screenShake: 0,
    checkpointFlashUntilMs: -Infinity,
    hitFlashUntilMs: -Infinity,
    gameOver: false,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function laneBaselineScreenY(canvasHeight: number, lane: number): number {
  return canvasHeight * LANE_CENTER_Y + (lane - 1) * LANE_GAP_PX;
}

/** Vertical hazard-band overlap. tnt/barrier have no vertical escape — only a lane switch avoids them. */
function verticalOverlap(o: ObstacleEntity, p: PlayerState): boolean {
  if (o.type === "tnt" || o.type === "barrier") return true;
  const playerHeight = p.sliding ? PLAYER_SIZE * SLIDE_HITBOX_SCALE : PLAYER_SIZE;
  const playerBottom = p.playerY;
  const playerTop = playerBottom + playerHeight;
  const obstacleBottom = o.groundHeight;
  const obstacleTop = o.groundHeight + o.height;
  return playerTop > obstacleBottom && playerBottom < obstacleTop;
}

/**
 * Removes a baked-in solid (or near-solid) background from an asset that
 * has no real alpha channel, via a flood fill seeded from all four edges —
 * NOT a blanket color match. That distinction matters: a genuinely dark
 * interior detail (a boot, a chest's iron trim, a checkpoint flag's black
 * outline) is surrounded by non-background pixels on every side, so the
 * fill never reaches it and it survives untouched; only background that's
 * actually connected to the border gets cleared. Runs once per asset (see
 * BACKGROUND_STRIP_TARGETS in run-assets.ts) and the resulting canvas is
 * cached — never re-run per frame.
 */
function stripBackgroundToTransparent(img: HTMLImageElement, tolerance = 26): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx || width === 0 || height === 0) return canvas;

  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const toleranceSq = tolerance * tolerance;

  const seed = 0;
  const bgR = data[seed];
  const bgG = data[seed + 1];
  const bgB = data[seed + 2];
  const matchesBackground = (i: number): boolean => {
    const dr = data[i] - bgR;
    const dg = data[i + 1] - bgG;
    const db = data[i + 2] - bgB;
    return dr * dr + dg * dg + db * db <= toleranceSq;
  };

  const visited = new Uint8Array(width * height);
  const stackX: number[] = [];
  const stackY: number[] = [];
  for (let x = 0; x < width; x++) {
    stackX.push(x, x);
    stackY.push(0, height - 1);
  }
  for (let y = 0; y < height; y++) {
    stackX.push(0, width - 1);
    stackY.push(y, y);
  }

  while (stackX.length > 0) {
    const x = stackX.pop() as number;
    const y = stackY.pop() as number;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const p = y * width + x;
    if (visited[p]) continue;
    const i = p * 4;
    if (!matchesBackground(i)) continue;
    visited[p] = 1;
    data[i + 3] = 0;
    stackX.push(x + 1, x - 1, x, x);
    stackY.push(y, y, y + 1, y - 1);
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

const COLORS = {
  bg: "#0A0B0D",
  laneLine: "#3B82F6",
  player: "#60A5FA",
  playerCore: "#3B82F6",
};

const OBSTACLE_COLOR: Record<ObstacleEntity["type"], { fill: string; dark: string }> = {
  spikes: { fill: "#F87171", dark: "#7F1D1D" },
  crate: { fill: "#F0B90B", dark: "#92600A" },
  tnt: { fill: "#FB923C", dark: "#7C2D12" },
  saw: { fill: "#E5E7EB", dark: "#4B5563" },
  drone: { fill: "#A78BFA", dark: "#4C1D95" },
  barrier: { fill: "#38BDF8", dark: "#0C4A6E" },
};

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
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(freshWorld());
  const sessionRef = useRef<GameSessionMeta | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const hudIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const phaseRef = useRef<Phase>("idle");
  const idRef = useRef(1);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const rawImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const readySpritesRef = useRef<Map<string, CanvasImageSource>>(new Map());

  const [phase, setPhase] = useState<Phase>("idle");
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
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { width: rect.width, height: rect.height };
    };

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
  // Loads every real asset under public/games/mpgr-run/ once on mount.
  // draw() below reads straight from the "ready" cache and simply skips
  // drawing (falling back to the procedural shape) for any sprite not yet
  // decoded, so the very first frame or two of a cold load never shows a
  // blank gap. The handful of assets in BACKGROUND_STRIP_TARGETS get run
  // through stripBackgroundToTransparent() once their raw <img> finishes
  // loading, and it's that processed (transparent) canvas — not the raw
  // image — that lands in the ready cache for those specific paths.
  //
  // Loading order: ALL_SPRITE_PATHS is ~69MB of uncompressed artwork
  // (city environment + every obstacle/collectible/powerup/effect frame)
  // and was previously requested all-at-once via `new Image()` on mount —
  // competing for bandwidth and main-thread decode time with the very
  // first render, which is what made the game feel slow to open. Nothing
  // here removes or downgrades any asset; it only changes the order they
  // arrive in. CRITICAL_SPRITES (the idle character pose + small UI
  // icons) are requested immediately since they're the only sprites the
  // idle/countdown screen actually needs. Everything else loads in small
  // chunks scheduled with requestIdleCallback so it doesn't block the
  // initial paint or input handling; draw() already tolerates any of
  // these arriving late.
  useEffect(() => {
    const CRITICAL_SPRITES: string[] = [CHARACTER_SPRITES.idle, CHARACTER_SPRITES.run, UI_SPRITES.heart, UI_SPRITES.powerupFrame];
    const deferredSprites = ALL_SPRITE_PATHS.filter((src) => !CRITICAL_SPRITES.includes(src));

    let cancelled = false;

    const loadSprite = (src: string) => {
      if (rawImagesRef.current.has(src)) return;
      const img = new window.Image();
      img.decoding = "async";
      img.onload = () => {
        if (cancelled) return;
        if (BACKGROUND_STRIP_TARGETS.includes(src)) {
          readySpritesRef.current.set(src, stripBackgroundToTransparent(img));
        } else {
          readySpritesRef.current.set(src, img);
        }
      };
      img.src = src;
      rawImagesRef.current.set(src, img);
    };

    CRITICAL_SPRITES.forEach(loadSprite);

    // requestIdleCallback only fires during genuine main-thread idle
    // time — but this game runs a continuous requestAnimationFrame loop
    // once a run starts, which can starve idle callbacks indefinitely on
    // real devices (never truly "idle"). The `timeout` option forces the
    // callback to run within that many ms regardless, so deferred art
    // still gets idle-time scheduling when the thread is free, but is
    // guaranteed to keep making progress instead of stalling mid-run.
    const scheduleIdle: (cb: () => void) => number =
      typeof window.requestIdleCallback === "function"
        ? (cb) => window.requestIdleCallback(cb, { timeout: 300 })
        : (cb) => window.setTimeout(cb, 32);
    const cancelIdle: (handle: number) => void =
      typeof window.cancelIdleCallback === "function"
        ? (handle) => window.cancelIdleCallback(handle)
        : (handle) => window.clearTimeout(handle);

    const CHUNK_SIZE = 4;
    let index = 0;
    let handle = 0;
    const loadNextChunk = () => {
      if (cancelled) return;
      deferredSprites.slice(index, index + CHUNK_SIZE).forEach(loadSprite);
      index += CHUNK_SIZE;
      if (index < deferredSprites.length) {
        handle = scheduleIdle(loadNextChunk);
      }
    };
    handle = scheduleIdle(loadNextChunk);

    return () => {
      cancelled = true;
      cancelIdle(handle);
    };
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
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width, height } = sizeRef.current;
    if (width === 0 || height === 0) return;

    const world = worldRef.current;
    const p = world.player;
    const playerScreenX = width * PLAYER_X;

    ctx.save();
    if (world.screenShake > 0.5) {
      ctx.translate((Math.random() - 0.5) * world.screenShake, (Math.random() - 0.5) * world.screenShake);
    }

    // Background — premium electric-blue city-run environment.
    ctx.clearRect(-20, -20, width + 40, height + 40);
    const skyGradient = ctx.createLinearGradient(0, 0, 0, height);
    skyGradient.addColorStop(0, "#0A0B0D");
    skyGradient.addColorStop(0.55, "#0D1420");
    skyGradient.addColorStop(1, "#111826");
    ctx.fillStyle = skyGradient;
    ctx.fillRect(0, 0, width, height);

    // Real "City Run" artwork, three depth layers scrolling at different
    // rates tied to actual distance traveled (so it pauses correctly and
    // never drifts out of sync with the game clock).
    const cityBg = getSprite(CITY_ENVIRONMENT.background);
    const cityMid = getSprite(CITY_ENVIRONMENT.midground);
    const cityFg = getSprite(CITY_ENVIRONMENT.foreground);
    const drawParallaxLayer = (img: CanvasImageSource | null, speedFactor: number, alpha: number) => {
      if (!img) return;
      const offset = (world.traveledPx * speedFactor) % width;
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, -offset, 0, width, height);
      ctx.drawImage(img, width - offset, 0, width, height);
      ctx.globalAlpha = 1;
    };
    drawParallaxLayer(cityBg, 0.05, 0.9);
    drawParallaxLayer(cityMid, 0.15, 0.85);
    drawParallaxLayer(cityFg, 0.35, 0.8);

    // Procedural skyline glow strips — fallback only, while the real
    // background artwork is still decoding on a cold load.
    if (!cityBg) {
      const scroll = (world.elapsedMs / 40) % width;
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#3B82F6";
      for (let i = -1; i < 6; i++) {
        const bx = ((i * 140 - scroll) % (width + 140)) - 70;
        ctx.fillRect(bx, height * 0.18, 44, height * 0.32);
      }
      ctx.globalAlpha = 1;
    }

    // Three lane tracks.
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const laneY = laneBaselineScreenY(height, lane);
      const isCurrent = lane === p.lane;
      ctx.strokeStyle = COLORS.laneLine;
      ctx.globalAlpha = isCurrent ? 0.55 : 0.18;
      ctx.lineWidth = isCurrent ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(0, laneY);
      ctx.lineTo(width, laneY);
      ctx.stroke();
      if (isCurrent) {
        const glow = ctx.createLinearGradient(0, laneY - 10, 0, laneY + 4);
        glow.addColorStop(0, "rgba(59,130,246,0.16)");
        glow.addColorStop(1, "rgba(59,130,246,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, laneY - 10, width, 14);
      }
    }
    ctx.globalAlpha = 1;

    // Checkpoint flash.
    if (world.elapsedMs < world.checkpointFlashUntilMs) {
      const elapsedSinceStart = 1400 - (world.checkpointFlashUntilMs - world.elapsedMs);
      const remaining = (world.checkpointFlashUntilMs - world.elapsedMs) / 1400;
      const flashAlpha = clamp(remaining, 0, 1);
      ctx.globalAlpha = flashAlpha * 0.5;
      ctx.fillStyle = "#FBBF24";
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;

      const checkpointImg = getSprite(CHECKPOINT_SPRITE);
      if (checkpointImg) {
        // Ease-out scale-in over the first 260ms, then hold, then fade with the flash alpha.
        const growT = clamp(elapsedSinceStart / 260, 0, 1);
        const easedGrow = 1 - Math.pow(1 - growT, 3);
        const baseSize = Math.min(width, height) * 0.28;
        const size = baseSize * (0.7 + easedGrow * 0.3);
        const cx = width / 2;
        const cy = height * 0.22;

        // Radiating ring pulse behind the badge.
        const ringT = clamp(elapsedSinceStart / 700, 0, 1);
        ctx.globalAlpha = (1 - ringT) * 0.5;
        ctx.strokeStyle = "#FBBF24";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, baseSize * 0.4 + ringT * baseSize * 0.6, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = flashAlpha;
        ctx.drawImage(checkpointImg, cx - size / 2, cy - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
    }

    // Power-up pickups.
    for (const pu of world.powerups) {
      if (pu.collected) continue;
      const laneY = laneBaselineScreenY(height, pu.lane);
      const bob = Math.sin(world.elapsedMs / 260 + pu.id) * 5;
      const cfg = POWERUP_TYPES[pu.type];
      const puImg = getSprite(POWERUP_SPRITES[pu.type]);
      const puCy = laneY - 20 + bob;
      ctx.shadowColor = cfg.color;
      ctx.shadowBlur = 12;
      if (puImg) {
        const size = pu.radius * 2.6;
        ctx.drawImage(puImg, pu.x - size / 2, puCy - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(pu.x, puCy, pu.radius, 0, Math.PI * 2);
        ctx.fillStyle = cfg.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Collectibles.
    for (const c of world.collectibles) {
      if (c.collected) continue;
      const laneY = laneBaselineScreenY(height, c.lane);
      const bob = Math.sin(world.elapsedMs / 300 + c.id) * 6;
      const attracting = c.magnetizedAtMs !== undefined;
      const shrink = attracting ? clamp(1 - (world.elapsedMs - c.magnetizedAtMs!) / MAGNET_ATTRACT_MS, 0.25, 1) : 1;
      const color = COLLECTIBLE_TYPES[c.type].color;
      const cImg = getSprite(COLLECTIBLE_SPRITES[c.type]);
      const cCy = laneY - 14 + bob;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      if (cImg) {
        const size = c.radius * 2.4 * shrink;
        ctx.drawImage(cImg, c.x - size / 2, cCy - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(c.x, cCy, c.radius * shrink, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      if (attracting) {
        ctx.strokeStyle = "rgba(34,211,238,0.5)";
        ctx.beginPath();
        ctx.moveTo(c.x, cCy);
        ctx.lineTo(playerScreenX + PLAYER_SIZE / 2, laneBaselineScreenY(height, p.lane) - p.playerY - PLAYER_SIZE / 2);
        ctx.stroke();
      }
    }

    // Obstacles.
    for (const o of world.obstacles) {
      const laneY = laneBaselineScreenY(height, o.lane);
      const top = laneY - o.groundHeight - o.height;
      const bottom = laneY - o.groundHeight;
      const palette = OBSTACLE_COLOR[o.type];
      const oImg = getSprite(OBSTACLE_SPRITES[o.type]);
      ctx.save();
      if (o.type === "saw") {
        const cx = o.x + o.width / 2;
        const cy = (top + bottom) / 2;
        ctx.translate(cx, cy);
        ctx.rotate(world.elapsedMs / 120);
        ctx.translate(-cx, -cy);
      }
      ctx.globalAlpha = o.hit ? 0.55 : 1;
      if (oImg) {
        const drawW = o.width * 1.5;
        const drawH = o.height + o.groundHeight + 8;
        ctx.shadowColor = palette.fill;
        ctx.shadowBlur = o.hit ? 0 : 6;
        if (o.type === "saw") {
          ctx.drawImage(oImg, -drawW / 2, -drawH / 2, drawW, drawH);
        } else {
          ctx.drawImage(oImg, o.x + o.width / 2 - drawW / 2, bottom - drawH, drawW, drawH);
        }
        ctx.shadowBlur = 0;
      } else {
        const gradient = ctx.createLinearGradient(o.x, top, o.x, bottom);
        gradient.addColorStop(0, palette.fill);
        gradient.addColorStop(1, palette.dark);
        ctx.fillStyle = gradient;
        ctx.shadowColor = palette.fill;
        ctx.shadowBlur = o.hit ? 0 : 6;
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(o.x + r, top);
        ctx.lineTo(o.x + o.width - r, top);
        ctx.quadraticCurveTo(o.x + o.width, top, o.x + o.width, top + r);
        ctx.lineTo(o.x + o.width, bottom);
        ctx.lineTo(o.x, bottom);
        ctx.lineTo(o.x, top + r);
        ctx.quadraticCurveTo(o.x, top, o.x + r, top);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Particles.
    for (const part of world.particles) {
      const alpha = clamp(part.life / part.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = part.color;
      ctx.beginPath();
      ctx.arc(part.x, part.y, part.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Sprite bursts — real explosion/coin/gem artwork, growing and fading out.
    for (const burst of world.spriteBursts) {
      const img = getSprite(burst.sprite);
      if (!img) continue;
      const t = clamp((world.elapsedMs - burst.startMs) / burst.durationMs, 0, 1);
      const size = burst.maxSize * (0.5 + t * 0.6);
      ctx.globalAlpha = 1 - t;
      ctx.drawImage(img, burst.x - size / 2, burst.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    // Player — drawn from the smoothed lane offset so switching lanes glides
    // instead of snapping (collision above always uses the logical p.lane).
    const baselineY = height * LANE_CENTER_Y + p.laneOffset;
    const playerHeight = p.sliding ? PLAYER_SIZE * SLIDE_HITBOX_SCALE : PLAYER_SIZE;
    const playerBottom = baselineY - p.playerY;
    const playerTop = playerBottom - playerHeight;
    const invulnerable = world.elapsedMs < p.invulnerableUntilMs;
    const shielded = !!world.activePowerups.shield || !!world.activePowerups.invincibility;

    if (shielded) {
      ctx.beginPath();
      ctx.arc(playerScreenX + PLAYER_SIZE / 2, (playerTop + playerBottom) / 2, PLAYER_SIZE * 0.9, 0, Math.PI * 2);
      ctx.strokeStyle = world.activePowerups.invincibility ? "#F472B6" : "#34D399";
      ctx.globalAlpha = 0.6 + Math.sin(world.elapsedMs / 90) * 0.2;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (world.activePowerups.jetpack) {
      // Layered flicker flame — richer than a single triangle, still pure procedural VFX.
      for (let layer = 0; layer < 2; layer++) {
        const flicker = Math.random() * 8;
        const len = 14 + layer * 8 + flicker;
        ctx.beginPath();
        ctx.moveTo(playerScreenX + 2, playerBottom - 2 - layer * 3);
        ctx.lineTo(playerScreenX - len, playerBottom + 4 + layer * 2);
        ctx.lineTo(playerScreenX + 2, playerBottom + 8 + layer * 3);
        ctx.closePath();
        ctx.fillStyle = layer === 0 ? "#FDE68A" : "#FB923C";
        ctx.shadowColor = "#FB923C";
        ctx.shadowBlur = 14 - layer * 4;
        ctx.globalAlpha = 0.85 - layer * 0.2;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    if (world.activePowerups.speed) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = COLORS.player;
      for (let i = 1; i <= 3; i++) {
        ctx.fillRect(playerScreenX - i * 10, playerTop + 4, 6, playerHeight - 8);
      }
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = invulnerable && !shielded ? 0.4 + Math.sin(world.elapsedMs / 60) * 0.3 : 1;

    const jetpackActiveNow = !!world.activePowerups.jetpack;
    // A gentle vertical bob while grounded and running — cosmetic only, applied
    // solely to where the sprite is drawn, never to playerTop/playerBottom (which
    // stay authoritative for collision, the shield ring, and every other effect).
    const grounded = p.playerY <= 0 && !p.sliding && !jetpackActiveNow;
    const runBob = grounded ? Math.abs(Math.sin(world.elapsedMs / 120)) * 2.5 : 0;

    let spriteSrc: string = CHARACTER_SPRITES.run;
    // NOTE: mpgr-runner-fly.png is intentionally excluded from run-assets.ts
    // (baked non-uniform sky background, unsafe to auto-cutout — see the
    // audit note there), so jetpack reuses the properly transparent `jump`
    // pose plus the flame VFX above and a forward flight tilt below.
    if (jetpackActiveNow) spriteSrc = CHARACTER_SPRITES.jump;
    else if (p.sliding) spriteSrc = CHARACTER_SPRITES.slide;
    else if (p.playerY > 0) spriteSrc = p.velocityY > 0 ? CHARACTER_SPRITES.jump : CHARACTER_SPRITES.fall;
    else spriteSrc = Math.floor(world.elapsedMs / 120) % 2 === 0 ? CHARACTER_SPRITES.run : CHARACTER_SPRITES.run2;
    const playerImg = getSprite(spriteSrc);

    if (playerImg) {
      const drawW = PLAYER_SIZE * 1.9;
      const drawH = playerHeight * 1.9;
      const cx = playerScreenX + PLAYER_SIZE / 2;
      const cy = playerBottom - drawH / 2 - runBob;
      ctx.save();
      ctx.translate(cx, cy);
      if (jetpackActiveNow) ctx.rotate(-0.12);
      ctx.shadowColor = "rgba(59,130,246,0.55)";
      ctx.shadowBlur = 14;
      ctx.drawImage(playerImg, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.shadowBlur = 0;
      ctx.restore();
    } else {
      const grad = ctx.createLinearGradient(0, playerTop, 0, playerBottom);
      grad.addColorStop(0, COLORS.player);
      grad.addColorStop(1, COLORS.playerCore);
      ctx.fillStyle = grad;
      ctx.shadowColor = "rgba(59,130,246,0.55)";
      ctx.shadowBlur = 14;
      const pr = 7;
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
      ctx.fillStyle = "#0A0B0D";
      ctx.fillRect(playerScreenX + PLAYER_SIZE * 0.45, playerTop + playerHeight * 0.28, PLAYER_SIZE * 0.4, playerHeight * 0.22);
    }
    ctx.globalAlpha = 1;

    // Cinematic vignette — a constant, subtle cyberpunk framing so the
    // premium mood holds even where no sprite/particle is on screen.
    const vignette = ctx.createRadialGradient(
      width / 2,
      height / 2,
      Math.min(width, height) * 0.35,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.7
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,0,0.38)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);

    // Hit-damage flash — a brief red pulse over the whole frame, on top of
    // everything else, so a hit always reads clearly even mid-chaos.
    if (world.elapsedMs < world.hitFlashUntilMs) {
      const hitT = clamp((world.hitFlashUntilMs - world.elapsedMs) / 220, 0, 1);
      ctx.globalAlpha = hitT * 0.35;
      ctx.fillStyle = "#DC2626";
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }, [getSprite]);

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
      const { width } = sizeRef.current;
      if (width === 0) return;
      const playerScreenX = width * PLAYER_X;
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
      const newObstacles = maybeSpawnObstacles(world.obstacles, width, band, nextId);
      if (newObstacles.length) world.obstacles.push(...newObstacles);
      const newCollectible = maybeSpawnCollectible(world.collectibles, width, band, nextId);
      if (newCollectible) world.collectibles.push(newCollectible);
      const newPowerup = maybeSpawnPowerup(world.powerups, width, band, nextId);
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
        const dx = c.x - (playerScreenX + PLAYER_SIZE / 2);

        if (magnetActive && Math.abs(dx) < MAGNET_RANGE_PX) {
          if (c.magnetizedAtMs === undefined) c.magnetizedAtMs = world.elapsedMs;
          if (world.elapsedMs - c.magnetizedAtMs >= MAGNET_ATTRACT_MS) {
            collectItem(world, c, canvasHeight);
          }
        } else if (sameLane && Math.abs(dx) < c.radius + PLAYER_SIZE / 2) {
          collectItem(world, c, canvasHeight);
        }
      }

      // Power-up pickup.
      for (const pu of world.powerups) {
        if (pu.collected) continue;
        const sameLane = pu.lane === p.lane;
        const overlapX = playerScreenX + PLAYER_SIZE > pu.x - pu.radius && playerScreenX < pu.x + pu.radius;
        if (sameLane && overlapX) {
          collectPowerup(world, pu, canvasHeight);
        }
      }

      // Checkpoints.
      const distanceMeters = world.traveledPx / PX_PER_METER;
      if (distanceMeters >= world.nextCheckpointM) {
        world.stats.checkpoints += 1;
        world.nextCheckpointM += CHECKPOINT_INTERVAL_M;
        p.invulnerableUntilMs = Math.max(p.invulnerableUntilMs, world.elapsedMs + CHECKPOINT_GRACE_MS);
        world.checkpointFlashUntilMs = world.elapsedMs + 1400;
        hooks.onCheckpoint();
      }
    },
    [nextId, spawnBurst, collectItem, collectPowerup]
  );

  // --- Game loop --------------------------------------------------------
  const loop = useCallback(
    (now: number) => {
      if (phaseRef.current !== "running") return;
      const last = lastTimeRef.current || now;
      const dt = Math.min((now - last) / 1000, 0.05);
      lastTimeRef.current = now;

      step(dt, sizeRef.current.height);
      draw();

      if (worldRef.current.gameOver) {
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

  const buildStats = useCallback((world: World): RunStats => {
    return {
      distanceMeters: world.traveledPx / PX_PER_METER,
      durationMs: Math.round(world.elapsedMs),
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
    stopLoop();
    const world = worldRef.current;
    const session = sessionRef.current;
    setPhase("game_over");
    getRunAudioHooks().onGameOver();
    if (!session) return;

    const ended = endSession(session);
    sessionRef.current = ended;

    const result = finalizeRun(buildStats(world));
    setRunResult(result);

    const rewardOutcome = processRunResult(address, ended.sessionId, result);
    setOutcome(rewardOutcome);
    refreshPersonalBest();
  }, [address, stopLoop, refreshPersonalBest, buildStats]);

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

  const beginCountdown = useCallback(() => {
    worldRef.current = freshWorld();
    sessionRef.current = startSession(MPGR_RUN_GAME_ID, address);
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

  // --- Input actions ------------------------------------------------------
  const jump = useCallback(() => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    const p = world.player;
    if (world.activePowerups.jetpack) return;
    if (p.playerY <= 0 && !p.sliding) {
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
      p.sliding = true;
      p.slideUntilMs = world.elapsedMs + SLIDE_DURATION_MS;
      getRunAudioHooks().onSlide();
    }
  }, []);

  const switchLane = useCallback((dir: -1 | 1) => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    world.player.lane = clamp(world.player.lane + dir, 0, LANE_COUNT - 1);
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

  useEffect(() => stopLoop, [stopLoop]);

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
    const text = `⚡ I survived ${Math.floor(runResult.distanceMeters)}m in MPGR Run.\n\nScore: ${formatCompactNumber(
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
    <div className="flex min-h-0 flex-1 flex-col gap-2 sm:block sm:flex-none sm:space-y-3">
      <div className="flex shrink-0 items-center justify-between">
        {/* BottomNav already has a Games tab on mobile, so this link is
            redundant there and only wastes header space — kept for
            desktop, where there's no bottom nav. */}
        <Link
          href="/games"
          className="hidden items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-white sm:flex"
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

      <GlassCard className="relative min-h-0 flex-1 overflow-hidden p-0 sm:flex-none">
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          className="relative h-full min-h-[360px] w-full select-none touch-none sm:h-[62vh] sm:max-h-[560px]"
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
  imgSrc,
  label,
  value,
}: {
  icon?: typeof Zap;
  imgSrc?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 shadow-[0_0_0_1px_rgba(59,130,246,0.35)] backdrop-blur-md">
      {imgSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imgSrc} alt="" className="h-4 w-4 object-contain" aria-hidden="true" />
      ) : Icon ? (
        <Icon className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
      ) : null}
      <span className="text-xs font-semibold text-white">{value}</span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function ControlButton({
  icon: Icon,
  label,
  onPress,
  accent,
}: {
  icon: typeof Zap;
  label: string;
  onPress: () => void;
  accent?: boolean;
}) {
  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPress();
      }}
      aria-label={label}
      className={`flex h-14 w-14 items-center justify-center rounded-full backdrop-blur-md ring-1 transition-transform active:scale-90 ${
        accent
          ? "bg-gradient-premium text-white shadow-glow-gold ring-white/20"
          : "bg-black/45 text-white ring-white/15"
      }`}
    >
      <Icon className="h-6 w-6" aria-hidden="true" />
    </button>
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
