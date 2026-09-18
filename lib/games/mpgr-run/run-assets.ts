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
// --- Format note (2026-09-18) ------------------------------------------
// Every image asset under public/games/mpgr-run/ was recompressed from its
// original PNG bytes to lossless WebP (libwebp, max effort) as part of a
// size-only optimization pass. The conversion is pixel-exact for every
// visible pixel and the full alpha channel; dimensions and aspect ratios
// are unchanged, so all hitboxes, draw scaling, and the background
// flood-fill behave exactly as before. Only the file extension changed.
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
export const RUN_ASSET_VERSION = "2026-09-18a";

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
  idle: asset(`${BASE}/character/mpgr-runner-idle.webp`),
  run: asset(`${BASE}/character/mpgr-runner-run.webp`),
  run2: asset(`${BASE}/character/mpgr-runner-run-2.webp`),
  jump: asset(`${BASE}/character/mpgr-runner-jump.webp`),
  fall: asset(`${BASE}/character/mpgr-runner-fall.webp`),
  slide: asset(`${BASE}/character/mpgr-runner-slide.webp`),
  land: asset(`${BASE}/character/mpgr-runner-land.webp`),
  victory: asset(`${BASE}/character/mpgr-runner-victory.webp`),
  // NOTE: mpgr-runner-fly.webp exists on disk but is baked onto a full sky
  // scene with no alpha channel — see the audit note above. Not exported
  // here on purpose; jetpack visually reuses `jump` instead.
} as const;

export const OBSTACLE_SPRITES: Record<ObstacleType, string> = {
  spikes: asset(`${BASE}/obstacles/mpgr-run-spikes.webp`),
  crate: asset(`${BASE}/obstacles/mpgr-run-crate.webp`),
  tnt: asset(`${BASE}/obstacles/mpgr-run-tnt.webp`),
  saw: asset(`${BASE}/obstacles/mpgr-run-saw.webp`),
  drone: asset(`${BASE}/obstacles/mpgr-run-drone.webp`),
  barrier: asset(`${BASE}/obstacles/mpgr-run-barrier.webp`),
};

export const COLLECTIBLE_SPRITES: Record<CollectibleType, string> = {
  coin: asset(`${BASE}/collectibles/mpgr-run-coin.webp`),
  gem: asset(`${BASE}/collectibles/mpgr-run-gem.webp`),
  xpOrb: asset(`${BASE}/collectibles/mpgr-run-xp.webp`),
  key: asset(`${BASE}/collectibles/mpgr-run-key.webp`),
  chest: asset(`${BASE}/collectibles/mpgr-run-treasure-chest.webp`),
};

export const POWERUP_SPRITES: Record<PowerupType, string> = {
  magnet: asset(`${BASE}/powerups/mpgr-run-magnet.webp`),
  shield: asset(`${BASE}/powerups/mpgr-run-shield.webp`),
  speed: asset(`${BASE}/powerups/mpgr-run-speed-boost.webp`),
  jetpack: asset(`${BASE}/powerups/mpgr-run-jetpack.webp`),
  score2x: asset(`${BASE}/powerups/mpgr-run-score-2x.webp`),
  invincibility: asset(`${BASE}/powerups/mpgr-run-invincibility.webp`),
};

export const CHECKPOINT_SPRITE = asset(`${BASE}/checkpoints/mpgr-run-checkpoint.webp`);

export const UI_SPRITES = {
  heart: asset(`${BASE}/ui/mpgr-run-heart.webp`),
  hudFrame: asset(`${BASE}/ui/mpgr-run-hud-frame.webp`),
  powerupFrame: asset(`${BASE}/ui/mpgr-run-powerup-frame.webp`),
} as const;

// Real hit/pickup burst artwork — both confirmed proper RGBA cutouts
// (alpha=0 at every corner). "powerup-collection" is deliberately
// excluded — see the audit note above.
export const EFFECT_SPRITES = {
  hit: asset(`${BASE}/effects/mpgr-run-explosion-hit.webp`),
  coinBurst: asset(`${BASE}/effects/mpgr-run-coin-collection.webp`),
  gemBurst: asset(`${BASE}/effects/mpgr-run-gem-collection.webp`),
} as const;

export const CITY_ENVIRONMENT = {
  background: asset(`${BASE}/environment/city/city-background.webp`),
  midground: asset(`${BASE}/environment/city/city-midground.webp`),
  foreground: asset(`${BASE}/environment/city/city-foreground.webp`),
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
