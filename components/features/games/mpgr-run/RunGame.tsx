"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletAuth } from "@/hooks/useWalletAuth";
import Link from "next/link";
import { ArrowLeft, Pause } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { formatCompactNumber } from "@/lib/format";
import { startSession, endSession, type GameSessionMeta } from "@/lib/games/game-session";
import { finalizeRun, type RunResult } from "@/lib/games/mpgr-run/run-score";
import { processRunResult, type ProcessRunResultOutcome } from "@/lib/games/mpgr-run/run-rewards";
import { submitRunToServer, pingGameHeartbeat } from "@/lib/games/mpgr-run/submit-server-reward";
import { getGameStats } from "@/lib/games/game-storage";
import { createDeterministicRng, type DeterministicRng } from "@/lib/games/mpgr-run/deterministic-rng";
import { getRunAudioHooks } from "@/lib/games/mpgr-run/audio-hooks";
import {
  MPGR_RUN_GAME_ID,
  COUNTDOWN_SECONDS,
  STARTING_HP,
  type PowerupType,
} from "@/lib/games/mpgr-run/run-config";
import { type World, freshWorld } from "@/lib/games/mpgr-run/run-world";
import { drawRunFrame, runViewScale } from "@/lib/games/mpgr-run/run-render";
import { createRunInputTrace, type RunInputTrace } from "@/lib/games/mpgr-run/input-trace";

import type { Phase, HudSnapshot, RunGameProps } from "./RunGameTypes";
import { stepSimulation, buildRunStats } from "./RunGameSimulation";
import { useRunInput } from "./useRunInput";
import {
  BACKGROUND_STRIP_TARGETS,
  CRITICAL_SPRITE_PATHS,
  OPTIONAL_SPRITE_PATHS,
} from "@/lib/games/mpgr-run/run-assets";
import { startRunAssetPipeline } from "@/lib/games/mpgr-run/asset-loader";
import { stripBackgroundToTransparent } from "@/lib/games/mpgr-run/run-render";
import { RunGameOverlays } from "./RunGameOverlays";

export function RunGame({ address }: RunGameProps) {
  const { authenticate, authenticating } = useWalletAuth();

  const [phase, setPhase] = useState<Phase>("idle");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
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

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const phaseRef = useRef<Phase>("idle");
  const worldRef = useRef<World>(freshWorld());
  const inputTraceRef = useRef<RunInputTrace>(createRunInputTrace());
  const sessionRef = useRef<GameSessionMeta | null>(null);
  const runRngRef = useRef<DeterministicRng | null>(null);

  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const fixedStepAccumulatorRef = useRef<number>(0);
  const hudIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const resizeRef = useRef<(() => void) | null>(null);
  const idRef = useRef(1);
  const nextId = useCallback(() => idRef.current++, []);

  const startSessionInFlightRef = useRef(false);
  const finishingRef = useRef(false);
  const finishRunRef = useRef<() => void>(() => {});

  const readySpritesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const inflightSpritesRef = useRef<Set<string>>(new Set());
  const failedSpritesRef = useRef<Set<string>>(new Set());

  const goToPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const refreshPersonalBest = useCallback(() => {
    const stats = getGameStats(MPGR_RUN_GAME_ID, address);
    setPersonalBest(stats.bestScore);
  }, [address]);

  useEffect(() => {
    refreshPersonalBest();
  }, [refreshPersonalBest]);

  // Canvas sizing
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      ctxRef.current = ctx;
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { width: rect.width, height: rect.height };
    };

    resizeRef.current = resize;
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const settleTimeouts = [50, 200, 500].map((ms) => window.setTimeout(resize, ms));
    const rafId = window.requestAnimationFrame(resize);

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

  // Sprite preloading via two-tier asset pipeline:
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

  // Render a single frame
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

  useEffect(() => {
    resizeRef.current?.();
    draw();
  }, [phase, draw]);

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (hudIntervalRef.current != null) clearInterval(hudIntervalRef.current);
    hudIntervalRef.current = null;
    if (heartbeatIntervalRef.current != null) clearInterval(heartbeatIntervalRef.current);
    heartbeatIntervalRef.current = null;
  }, []);

  const finishRun = useCallback(() => {
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

    const result = finalizeRun(buildRunStats(world));
    setRunResult(result);

    const rewardOutcome = processRunResult(address, ended.sessionId, result);
    setOutcome(rewardOutcome);
    refreshPersonalBest();

    void submitRunToServer(address, ended.sessionId, result, inputTraceRef.current);
  }, [address, stopLoop, refreshPersonalBest, goToPhase]);

  finishRunRef.current = finishRun;

  const step = useCallback(
    (dt: number, canvasHeight: number) => {
      stepSimulation(worldRef.current, dt, canvasHeight, nextId, runRngRef.current);
    },
    [nextId]
  );

  const loop = useCallback(
    (now: number) => {
      if (phaseRef.current !== "running") {
        rafRef.current = null;
        return;
      }

      const last = lastTimeRef.current || now;
      const frameDt = Math.min((now - last) / 1000, 0.25);
      lastTimeRef.current = now;

      const FIXED_DT = 1 / 60;
      const MAX_STEPS_PER_FRAME = 8;
      fixedStepAccumulatorRef.current += frameDt;

      let steps = 0;
      while (
        fixedStepAccumulatorRef.current >= FIXED_DT &&
        steps < MAX_STEPS_PER_FRAME &&
        !worldRef.current.gameOver
      ) {
        // canvasHeight is used ONLY for visual spawn positions (bursts),
        // never physics/collision — the renderer draws in a uniform
        // design space (canvas px / runViewScale), so the simulation
        // must see that same design height to stay aligned.
        step(FIXED_DT, sizeRef.current.height / runViewScale(sizeRef.current.width));
        fixedStepAccumulatorRef.current -= FIXED_DT;
        steps += 1;
      }

      if (steps === MAX_STEPS_PER_FRAME) {
        fixedStepAccumulatorRef.current = Math.min(
          fixedStepAccumulatorRef.current,
          FIXED_DT
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

  const startHudSync = useCallback(() => {
    if (hudIntervalRef.current != null) clearInterval(hudIntervalRef.current);
    hudIntervalRef.current = setInterval(() => {
      const world = worldRef.current;
      const provisional = finalizeRun(buildRunStats(world));
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
  }, []);

  const beginCountdown = useCallback(async () => {
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
          goToPhase("running");
        } else {
          setCountdownValue(remaining);
        }
      }, 700);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Unable to start game");
      goToPhase("idle");
    } finally {
      startSessionInFlightRef.current = false;
      setStarting(false);
    }
  }, [address, authenticate, goToPhase, stopLoop]);

  // Input bindings
  const {
    jump,
    slide,
    switchLane,
    togglePause,
    handlePointerDown,
    handlePointerUp,
  } = useRunInput({
    worldRef,
    phaseRef,
    inputTraceRef,
    goToPhase,
    stopLoop,
  });

  // Game loop trigger
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

  useEffect(() => {
    return () => {
      stopLoop();
      if (countdownTimerRef.current != null) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [stopLoop]);

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
      // User cancelled
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex shrink-0 items-center justify-between">
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

          <RunGameOverlays
            phase={phase}
            hud={hud}
            countdownValue={countdownValue}
            starting={starting}
            authenticating={authenticating}
            startError={startError}
            personalBest={personalBest}
            runResult={runResult}
            outcome={outcome}
            shareCopied={shareCopied}
            containerRef={containerRef}
            onBeginCountdown={beginCountdown}
            onTogglePause={togglePause}
            onJump={jump}
            onSlide={slide}
            onSwitchLane={switchLane}
            onShare={handleShare}
          />
        </div>
      </GlassCard>
    </div>
  );
}
