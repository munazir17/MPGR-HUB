// lib/games/mpgr-run/run-assets.ts
//
// Pure asset-path configuration for MPGR Run. No gameplay logic lives here
// — every path below points at real artwork already committed under
// public/games/mpgr-run/. Swapping or extending the art later only ever
// touches this file; RunGame.tsx (rendering) and run-config.ts (gameplay
// tuning) never need to change alongside it.
//
// Only the "city" environment set is wired up here — it's the only one
// with real files in public/games/mpgr-run/environment/ today (desert,
// ice, neon-city, and sky-islands have full 3-6 layer sets too and are
// ready for a future multi-environment pass; space/volcanic are empty
// folders with no art yet, so they're intentionally left out to avoid
// referencing a path that 404s).
//
// --- Transparency audit (Part 2) --------------------------------------
// Every PNG under public/games/mpgr-run/ was inspected for its color mode
// and corner-pixel alpha before being wired into rendering:
//
// - The vast majority are proper RGBA cutouts with alpha=0 at the edges —
//   used directly, no processing needed.
// - Three assets are baked onto a solid near-black background with NO
//   alpha channel at all: character run-2 (the second run-cycle frame),
//   the treasure chest collectible, and the checkpoint badge. These are
//   listed in BACKGROUND_STRIP_TARGETS below — RunGame.tsx flood-fills
//   the background out from the edges (not a blanket color match, so
//   genuinely dark interior details like shoes/trim survive) once on
//   load and caches the resulting transparent canvas.
// - Two assets — the character "fly" pose and the "powerup-collection"
//   effect — are baked onto a full non-uniform night-sky scene (not a
//   flat color), so a safe automatic cutout isn't possible without
//   risking artifacts. They are intentionally NOT exported/used as
//   direct sprites below; jetpack reuses the (properly transparent)
//   jump pose instead, and the powerup pickup burst uses procedural VFX
//   only. Both real files remain on disk for a future manual crop pass.
//
// --- Cache / versioning ------------------------------------------------
// Browser + CDN caches key off the full URL. Replacing a PNG in
// public/games/mpgr-run/ without changing the filename used to leave
// phones drawing the OLD bytes until the cache expired, then popping to
// the new artwork mid-run. Every exported path is stamped with
// RUN_ASSET_VERSION via `asset()` so a new art drop is a new URL.
// Bump RUN_ASSET_VERSION whenever you replace artwork under
// public/games/mpgr-run/. Do not scatter ad-hoc query strings elsewhere.

import type { ObstacleType, CollectibleType, PowerupType } from "./run-config";

/**
 * Bump this when MPGR Run artwork files are replaced (same filename, new
 * bytes). Format is free-form; it only needs to change. Long-lived
 * Cache-Control on `/games/mpgr-run/*` is safe because this query string
 * makes each art generation a distinct URL.
 */
export const RUN_ASSET_VERSION = "2026-08-22a";

const VERSION_PARAM = "v";

/** Append (or replace) the asset version query param on a same-origin path. */
export function withAssetVersion(path: string, version: string = RUN_ASSET_VERSION): string {
  if (!path) return path;
  const hashIndex = path.indexOf("#");
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const qIndex = withoutHash.indexOf("?");
  const pathname = qIndex >= 0 ? withoutHash.slice(0, qIndex) : withoutHash;
  const search = qIndex >= 0 ? withoutHash.slice(qIndex + 1) : "";
  const params = new URLSearchParams(search);
  params.set(VERSION_PARAM, version);
  return `${pathname}?${params.toString()}${hash}`;
}

function asset(path: string): string {
  return withAssetVersion(path);
}

const BASE = "/games/mpgr-run";

export const CHARACTER_SPRITES = {
  idle: asset(`${BASE}/character/mpgr-runner-idle.png`),
  run: asset(`${BASE}/character/mpgr-runner-run.png`),
  run2: asset(`${BASE}/character/mpgr-runner-run-2.png`),
  jump: asset(`${BASE}/character/mpgr-runner-jump.png`),
  fall: asset(`${BASE}/character/mpgr-runner-fall.png`),
  slide: asset(`${BASE}/character/mpgr-runner-slide.png`),
  land: asset(`${BASE}/character/mpgr-runner-land.png`),
  victory: asset(`${BASE}/character/mpgr-runner-victory.png`),
  // NOTE: mpgr-runner-fly.png exists on disk but is baked onto a full sky
  // scene with no alpha channel — see the audit note above. Not exported
  // here on purpose; jetpack visually reuses `jump` instead.
} as const;

export const OBSTACLE_SPRITES: Record<ObstacleType, string> = {
  spikes: asset(`${BASE}/obstacles/mpgr-run-spikes.png`),
  crate: asset(`${BASE}/obstacles/mpgr-run-crate.png`),
  tnt: asset(`${BASE}/obstacles/mpgr-run-tnt.png`),
  saw: asset(`${BASE}/obstacles/mpgr-run-saw.png`),
  drone: asset(`${BASE}/obstacles/mpgr-run-drone.png`),
  barrier: asset(`${BASE}/obstacles/mpgr-run-barrier.png`),
};

export const COLLECTIBLE_SPRITES: Record<CollectibleType, string> = {
  coin: asset(`${BASE}/collectibles/mpgr-run-coin.png`),
  gem: asset(`${BASE}/collectibles/mpgr-run-gem.png`),
  xpOrb: asset(`${BASE}/collectibles/mpgr-run-xp.png`),
  key: asset(`${BASE}/collectibles/mpgr-run-key.png`),
  chest: asset(`${BASE}/collectibles/mpgr-run-treasure-chest.png`),
};

export const POWERUP_SPRITES: Record<PowerupType, string> = {
  magnet: asset(`${BASE}/powerups/mpgr-run-magnet.png`),
  shield: asset(`${BASE}/powerups/mpgr-run-shield.png`),
  speed: asset(`${BASE}/powerups/mpgr-run-speed-boost.png`),
  jetpack: asset(`${BASE}/powerups/mpgr-run-jetpack.png`),
  score2x: asset(`${BASE}/powerups/mpgr-run-score-2x.png`),
  invincibility: asset(`${BASE}/powerups/mpgr-run-invincibility.png`),
};

export const CHECKPOINT_SPRITE = asset(`${BASE}/checkpoints/mpgr-run-checkpoint.png`);

export const UI_SPRITES = {
  heart: asset(`${BASE}/ui/mpgr-run-heart.png`),
  hudFrame: asset(`${BASE}/ui/mpgr-run-hud-frame.png`),
  powerupFrame: asset(`${BASE}/ui/mpgr-run-powerup-frame.png`),
} as const;

// Real hit/pickup burst artwork — both confirmed proper RGBA cutouts
// (alpha=0 at every corner). "powerup-collection" is deliberately
// excluded — see the audit note above.
export const EFFECT_SPRITES = {
  hit: asset(`${BASE}/effects/mpgr-run-explosion-hit.png`),
  coinBurst: asset(`${BASE}/effects/mpgr-run-coin-collection.png`),
  gemBurst: asset(`${BASE}/effects/mpgr-run-gem-collection.png`),
} as const;

export const CITY_ENVIRONMENT = {
  background: asset(`${BASE}/environment/city/city-background.png`),
  midground: asset(`${BASE}/environment/city/city-midground.png`),
  foreground: asset(`${BASE}/environment/city/city-foreground.png`),
} as const;

/**
 * Assets confirmed to be baked onto a solid (near-uniform) background with
 * no alpha channel. RunGame.tsx runs a one-time edge flood-fill on exactly
 * these paths after they load, replacing the raw <img> in its sprite cache
 * with a transparent canvas — everything else loads and renders as-is.
 */
export const BACKGROUND_STRIP_TARGETS: string[] = [
  CHARACTER_SPRITES.run2,
  COLLECTIBLE_SPRITES.chest,
  CHECKPOINT_SPRITE,
];

/** Every sprite path used by the live render loop, flattened for a one-time preload on mount. */
export const ALL_SPRITE_PATHS: string[] = [
  ...Object.values(CHARACTER_SPRITES),
  ...Object.values(OBSTACLE_SPRITES),
  ...Object.values(COLLECTIBLE_SPRITES),
  ...Object.values(POWERUP_SPRITES),
  ...Object.values(EFFECT_SPRITES),
  CHECKPOINT_SPRITE,
  UI_SPRITES.heart,
  UI_SPRITES.powerupFrame,
  ...Object.values(CITY_ENVIRONMENT),
];

/**
 * First-paint / in-run hero art. Loaded immediately with bounded
 * concurrency — never gated on requestIdleCallback. Gameplay does NOT
 * wait for these; the canvas uses the existing procedural fallback until
 * each one is load+decode ready.
 */
export const CRITICAL_SPRITE_PATHS: string[] = [
  CHARACTER_SPRITES.idle,
  CHARACTER_SPRITES.run,
  CHARACTER_SPRITES.run2,
  CHARACTER_SPRITES.jump,
  CHARACTER_SPRITES.fall,
  CHARACTER_SPRITES.slide,
  CITY_ENVIRONMENT.background,
  CITY_ENVIRONMENT.midground,
  CITY_ENVIRONMENT.foreground,
  UI_SPRITES.heart,
  UI_SPRITES.powerupFrame,
];

const CRITICAL_SET = new Set(CRITICAL_SPRITE_PATHS);

/** Collectibles, power-ups, obstacles, VFX, unused poses — background load. */
export const OPTIONAL_SPRITE_PATHS: string[] = ALL_SPRITE_PATHS.filter((src) => !CRITICAL_SET.has(src));
