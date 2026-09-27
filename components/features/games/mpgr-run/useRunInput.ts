// components/features/games/mpgr-run/useRunInput.ts
import { useCallback, useEffect, useRef } from "react";
import { appendRunInputEvent, type RunInputTrace } from "@/lib/games/mpgr-run/input-trace";
import { JUMP_VELOCITY, SLIDE_DURATION_MS, LANE_COUNT } from "@/lib/games/mpgr-run/run-config";
import { clamp } from "@/lib/games/mpgr-run/run-physics";
import { getRunAudioHooks } from "@/lib/games/mpgr-run/audio-hooks";
import type { World } from "@/lib/games/mpgr-run/run-world";
import type { Phase } from "./RunGameTypes";

/**
 * Pure pointer-session classifier (extracted 2026-09-27 input-bug fix).
 *
 * Bug history: the old handler stored a single swipe start and treated a
 * pointerup WITHOUT a matching pointerdown (`start === null`) as a tap-jump.
 * On-screen control buttons stop pointerdown propagation (so no start is
 * recorded) but their pointerup still bubbles to the play surface — every
 * left/right/slide button press therefore also triggered a jump. The same
 * fallback misfired for second fingers and cancelled pointers.
 *
 * Rules now:
 *   - a pointerup only classifies if its pointerId matches the stored down;
 *   - unmatched/missing downs are ignored (NEVER jump);
 *   - horizontal swipes change lane, vertical swipes jump/slide,
 *     a small-movement tap on the play surface jumps (intended convenience).
 */
export type RunPointerAction = "jump" | "slide" | "lane-left" | "lane-right" | null;

export interface RunPointerSession {
  down(x: number, y: number, pointerId: number): void;
  cancel(pointerId: number): void;
  up(x: number, y: number, pointerId: number): RunPointerAction;
}

export function createRunPointerSession(thresholdPx = 40): RunPointerSession {
  let start: { x: number; y: number; id: number } | null = null;
  return {
    down(x, y, pointerId) {
      start = { x, y, id: pointerId };
    },
    cancel(pointerId) {
      if (start && start.id === pointerId) start = null;
    },
    up(x, y, pointerId) {
      // Unmatched releases (control buttons, other fingers) are ignored
      // WITHOUT destroying the active session of the owning pointer.
      if (!start || start.id !== pointerId) return null;
      const s = start;
      start = null;
      const dx = x - s.x;
      const dy = y - s.y;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > thresholdPx) {
        return dx > 0 ? "lane-right" : "lane-left";
      }
      if (dy < -thresholdPx) return "jump";
      if (dy > thresholdPx) return "slide";
      return "jump"; // deliberate tap on the play surface
    },
  };
}

interface UseRunInputOptions {
  worldRef: React.RefObject<World>;
  phaseRef: React.RefObject<Phase>;
  inputTraceRef: React.RefObject<RunInputTrace>;
  goToPhase: (next: Phase) => void;
  stopLoop: () => void;
}

export function useRunInput({
  worldRef,
  phaseRef,
  inputTraceRef,
  goToPhase,
  stopLoop,
}: UseRunInputOptions) {
  const pointerSessionRef = useRef<RunPointerSession | null>(null);
  if (pointerSessionRef.current === null) {
    pointerSessionRef.current = createRunPointerSession();
  }

  const jump = useCallback(() => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    if (!world) return;
    const p = world.player;
    if (world.activePowerups.jetpack) return;
    const inputTrace = inputTraceRef.current;
    if (p.playerY <= 0 && !p.sliding) {
      if (inputTrace) {
        appendRunInputEvent(inputTrace, {
          type: "jump",
          atMs: world.elapsedMs,
        });
      }
      p.velocityY = JUMP_VELOCITY;
      getRunAudioHooks().onJump();
    }
  }, [worldRef, phaseRef, inputTraceRef]);

  const slide = useCallback(() => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    if (!world) return;
    const p = world.player;
    if (world.activePowerups.jetpack) return;
    const inputTrace = inputTraceRef.current;
    if (p.playerY <= 0) {
      if (inputTrace) {
        appendRunInputEvent(inputTrace, {
          type: "slide",
          atMs: world.elapsedMs,
        });
      }
      p.sliding = true;
      p.slideUntilMs = world.elapsedMs + SLIDE_DURATION_MS;
      getRunAudioHooks().onSlide();
    }
  }, [worldRef, phaseRef, inputTraceRef]);

  const switchLane = useCallback((dir: -1 | 1) => {
    if (phaseRef.current !== "running") return;
    const world = worldRef.current;
    if (!world) return;
    const previousLane = world.player.lane;
    const nextLane = clamp(previousLane + dir, 0, LANE_COUNT - 1);
    if (nextLane !== previousLane) {
      const inputTrace = inputTraceRef.current;
      if (inputTrace) {
        appendRunInputEvent(inputTrace, {
          type: "lane",
          atMs: world.elapsedMs,
          dir,
        });
      }
      world.player.lane = nextLane;
    }
  }, [worldRef, phaseRef, inputTraceRef]);

  const togglePause = useCallback(() => {
    if (phaseRef.current === "running") {
      goToPhase("paused");
      stopLoop();
    } else if (phaseRef.current === "paused") {
      goToPhase("running");
    }
  }, [phaseRef, goToPhase, stopLoop]);

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
  }, [phaseRef, goToPhase, stopLoop]);

  // Pointer swipe handlers (play surface). Control buttons stop their own
  // pointerdown/up propagation, and unmatched releases are ignored here, so
  // a lane button can never trigger a jump.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (phaseRef.current !== "running") return;
    pointerSessionRef.current?.down(e.clientX, e.clientY, e.pointerId);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (phaseRef.current !== "running") return;
    const action = pointerSessionRef.current?.up(e.clientX, e.clientY, e.pointerId) ?? null;
    if (action === "jump") jump();
    else if (action === "slide") slide();
    else if (action === "lane-left") switchLane(-1);
    else if (action === "lane-right") switchLane(1);
  };

  const handlePointerCancel = (e: React.PointerEvent) => {
    pointerSessionRef.current?.cancel(e.pointerId);
  };

  return {
    jump,
    slide,
    switchLane,
    togglePause,
    handlePointerDown,
    handlePointerUp,
    handlePointerCancel,
  };
}
