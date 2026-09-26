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

/**
 * Rear-facing character set (2026-09-26, Subway-Surfers-style rear-camera
 * conversion). The classic side-view set above stays on disk and on the
 * manifest (idle overlay, game card, banner and the locked catalog tests
 * still use it), but the in-run canvas now draws the runner from BEHIND:
 * four alternating run-cycle frames (right-kick, passing, left-kick,
 * passing-mirror — frames 3/4 are built as mirrors of 1/2 with the MPGR
 * back-logo restored un-mirrored), plus rear idle/jump/fall/slide poses.
 * All eight are proper RGBA cutouts (magenta chroma-key removed at
 * authoring time), so they need no runtime background strip.
 */
export const CHARACTER_REAR_SPRITES = {
  idle: asset(`${BASE}/character/mpgr-runner-rear-idle.webp`),
  run1: asset(`${BASE}/character/mpgr-runner-rear-run-1.webp`),
  run2: asset(`${BASE}/character/mpgr-runner-rear-run-2.webp`),
  run3: asset(`${BASE}/character/mpgr-runner-rear-run-3.webp`),
  run4: asset(`${BASE}/character/mpgr-runner-rear-run-4.webp`),
  jump: asset(`${BASE}/character/mpgr-runner-rear-jump.webp`),
  fall: asset(`${BASE}/character/mpgr-runner-rear-fall.webp`),
  slide: asset(`${BASE}/character/mpgr-runner-rear-slide.webp`),
} as const;

/** The four rear run-cycle frames in cycle order. */
export const REAR_RUN_CYCLE: readonly string[] = [
  CHARACTER_REAR_SPRITES.run1,
  CHARACTER_REAR_SPRITES.run2,
  CHARACTER_REAR_SPRITES.run3,
  CHARACTER_REAR_SPRITES.run4,
];

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

// --- HUD-only art (2026-09-20, asset/performance pass) ------------------
// heart and powerupFrame are *never* drawn on the canvas. run-render.ts
// (the only canvas consumer) imports CHARACTER/OBSTACLE/COLLECTIBLE/
// POWERUP/EFFECT/CHECKPOINT/CITY art and nothing from UI_SPRITES; the two
// entries below are rendered exclusively as DOM <img> elements in the
// in-run HUD, at 16 CSS px (heart, one per HP pip) and 24 CSS px
// (powerupFrame, inside the active-powerup chip).
//
// They used to point at the full 1536x1024 originals, which meant the
// critical preload lane downloaded 995 KiB + 1.79 MiB (and the DOM had to
// decode a 6 MB RGBA bitmap per asset) to paint two 16/24 px icons. They
// now point at dedicated small variants that are aspect- and
// alpha-preserving downscales of the exact same artwork:
//   ui/mpgr-run-heart-icon.webp         96x64   (7.4 KiB)  from mpgr-run-heart.webp
//   ui/mpgr-run-powerup-frame-icon.webp 144x96  (27.2 KiB) from mpgr-run-powerup-frame.webp
// Both are lossless WebP and comfortably above the largest device-pixel
// size they are drawn at (16/24 CSS px x DPR 3 = 48x32 / 72x48).
//
// The originals stay on disk, untouched, and are still the art to start
// from if a future change needs a bigger HUD sprite. New filenames were
// used deliberately: the versioned URL is a fresh cache key, so no
// RUN_ASSET_VERSION bump (which would force every player to re-download
// all 55 sprites) is needed, and no cached full-size copy can be served.
// If an entry below is ever repointed, keep the rule: a DOM-only sprite
// must be sized for its largest rendered size x 3, with aspect ratio and
// alpha channel preserved (see lib/games/asset-loading-policy.test.ts,
// which fails if these two grow back into multi-megabyte canvas art).
export const UI_SPRITES = {
  heart: asset(`${BASE}/ui/mpgr-run-heart-icon.webp`),
  hudFrame: asset(`${BASE}/ui/mpgr-run-hud-frame.webp`),
  powerupFrame: asset(`${BASE}/ui/mpgr-run-powerup-frame-icon.webp`),
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
  ...Object.values(CHARACTER_REAR_SPRITES),
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
  // Rear-camera conversion: the in-run hero art is now the rear run cycle;
  // the rear jump/fall/slide poses ride the optional lane right behind it
  // (the renderer holds a ready rear run frame until they decode).
  ...REAR_RUN_CYCLE,
  CITY_ENVIRONMENT.background,
  CITY_ENVIRONMENT.midground,
  CITY_ENVIRONMENT.foreground,
  UI_SPRITES.heart,
  UI_SPRITES.powerupFrame,
];

const CRITICAL_SET = new Set(CRITICAL_SPRITE_PATHS);

/** Collectibles, power-ups, obstacles, VFX, unused poses — background load. */
export const OPTIONAL_SPRITE_PATHS: string[] = ALL_SPRITE_PATHS.filter((src) => !CRITICAL_SET.has(src));
