// lib/games/mpgr-run/run-environments.ts
//
// Presentation-only world theming for the rear-camera runner (PR #62
// follow-up). The simulation has NO level/world state — runs are endless
// and distance-based — so the environment the renderer draws cycles with
// distance traveled: city -> ice -> desert -> city ...
//
// This module is pure presentation: it never reads or writes gameplay
// state, never influences spawns/collisions/scoring, and the authoritative
// replay never imports it. It only answers "which world looks like it is
// being run through right now, and how foggy is the transition".

import type { RunWorldId } from "./run-assets";
import { PX_PER_METER } from "./run-config";

/** Visual length of one world before the next one fades in (meters). */
export const RUN_WORLD_LENGTH_M = 450;
/** Full fog-transition window in meters, centered on the world boundary. */
export const RUN_WORLD_FADE_M = 70;

export const RUN_WORLD_ORDER: readonly RunWorldId[] = ["city", "ice", "desert"];

export interface RunWorldTheme {
  id: RunWorldId;
  /** Sky gradient stops: zenith -> mid -> horizon. */
  sky: [string, string, string];
  /** Emissive band hugging the horizon (rgba). */
  horizonGlow: string;
  /** Off-track ground gradient (far -> near). */
  groundFar: string;
  groundNear: string;
  /** Playable track surface gradient (far -> near). */
  trackFar: string;
  trackNear: string;
  /** Emissive rail / lane-line color. */
  rail: string;
  /** Center-lane chevron markings color. */
  chevron: string;
  /** Horizon haze color that melts the track into the skyline. */
  haze: string;
  /** Fog-wall color used during world transitions. */
  fog: string;
  particle: "motes" | "snow" | "dust";
  particleColor: string;
  /** Sidewalk/shoulder strip colors that embed the road in the world. */
  curb: string;
  curbEdge: string;
  /** Blinking window/sign light colors on the skyline. */
  twinkle: [string, string];
}

export const RUN_WORLD_THEMES: Record<RunWorldId, RunWorldTheme> = {
  city: {
    id: "city",
    sky: ["#04060D", "#0A1424", "#16294A"],
    horizonGlow: "rgba(64,148,255,0.46)",
    groundFar: "#1E2A3A",
    groundNear: "#121B28",
    trackFar: "#202C3E",
    trackNear: "#2A3850",
    rail: "#3B82F6",
    chevron: "#38BDF8",
    haze: "rgba(12,22,40,0.94)",
    fog: "#33547F",
    particle: "motes",
    particleColor: "rgba(125,195,255,0.55)",
    curb: "#232F42",
    curbEdge: "#3B82F6",
    twinkle: ["#7DD3FC", "#F0ABFC"],
  },
  ice: {
    id: "ice",
    sky: ["#08111F", "#123049", "#3E7FA0"],
    horizonGlow: "rgba(150,235,255,0.4)",
    groundFar: "#CFE4EF",
    groundNear: "#9DBDD2",
    trackFar: "#1B2E3F",
    trackNear: "#24394B",
    rail: "#67E8F9",
    chevron: "#7DD3FC",
    haze: "rgba(186,222,238,0.9)",
    fog: "#E6F4FA",
    particle: "snow",
    particleColor: "rgba(255,255,255,0.8)",
    curb: "#DDEDF6",
    curbEdge: "#67E8F9",
    twinkle: ["#A5F3FC", "#E0F2FE"],
  },
  desert: {
    id: "desert",
    sky: ["#20090a", "#7A3A12", "#E8863C"],
    horizonGlow: "rgba(255,178,88,0.45)",
    groundFar: "#C79A5F",
    groundNear: "#A5763F",
    trackFar: "#2B2118",
    trackNear: "#35291D",
    rail: "#FBBF24",
    chevron: "#38BDF8",
    haze: "rgba(233,168,92,0.88)",
    fog: "#F0C084",
    particle: "dust",
    particleColor: "rgba(255,214,150,0.5)",
    curb: "#C99A62",
    curbEdge: "#FBBF24",
    twinkle: ["#FCD34D", "#FDBA74"],
  },
};

export interface RunWorldState {
  current: RunWorldId;
  next: RunWorldId;
  /** 0 = clear, 1 = full fog wall (exactly at the world boundary). */
  fade: number;
}

/**
 * Resolve which world is being run through at a distance, plus the
 * transition fog intensity. Symmetric window: fog rises over the last
 * RUN_WORLD_FADE_M/2 meters of a world and dissipates over the first
 * RUN_WORLD_FADE_M/2 of the next, peaking exactly at the boundary so the
 * environment swap is hidden inside an atmospheric fog wall.
 */
export function resolveRunWorld(distanceMeters: number): RunWorldState {
  const span = RUN_WORLD_ORDER.length * RUN_WORLD_LENGTH_M;
  const d = ((distanceMeters % span) + span) % span;
  const index = Math.min(RUN_WORLD_ORDER.length - 1, Math.floor(d / RUN_WORLD_LENGTH_M));
  const into = d - index * RUN_WORLD_LENGTH_M;
  const half = RUN_WORLD_FADE_M / 2;
  let fade = 0;
  if (into >= RUN_WORLD_LENGTH_M - half) {
    fade = (into - (RUN_WORLD_LENGTH_M - half)) / half;
  } else if (into < half) {
    fade = 1 - into / half;
  }
  return {
    current: RUN_WORLD_ORDER[index],
    next: RUN_WORLD_ORDER[(index + 1) % RUN_WORLD_ORDER.length],
    fade: Math.max(0, Math.min(1, fade)),
  };
}

/** Convenience for the renderer: distance in px (sim units) -> world state. */
export function resolveRunWorldFromPx(traveledPx: number): RunWorldState {
  return resolveRunWorld(traveledPx / PX_PER_METER);
}
