// components/features/games/mpgr-run/useRunInput.ts
import { useCallback, useEffect, useRef } from "react";
import { appendRunInputEvent, type RunInputTrace } from "@/lib/games/mpgr-run/input-trace";
import { JUMP_VELOCITY, SLIDE_DURATION_MS, LANE_COUNT } from "@/lib/games/mpgr-run/run-config";
import { clamp } from "@/lib/games/mpgr-run/run-physics";
import { getRunAudioHooks } from "@/lib/games/mpgr-run/audio-hooks";
import type { World } from "@/lib/games/mpgr-run/run-world";
import type { Phase } from "./RunGameTypes";

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
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

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

  // Pointer swipe handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    if (phaseRef.current !== "running") return;
    swipeStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (phaseRef.current !== "running") return;
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

  return {
    jump,
    slide,
    switchLane,
    togglePause,
    handlePointerDown,
    handlePointerUp,
  };
}
