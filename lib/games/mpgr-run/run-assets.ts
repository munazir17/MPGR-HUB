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

import type { ObstacleType, CollectibleType, PowerupType } from "./run-config";

const BASE = "/games/mpgr-run";

export const CHARACTER_SPRITES = {
  idle: `${BASE}/character/mpgr-runner-idle.png`,
  run: `${BASE}/character/mpgr-runner-run.png`,
  run2: `${BASE}/character/mpgr-runner-run-2.png`,
  jump: `${BASE}/character/mpgr-runner-jump.png`,
  fall: `${BASE}/character/mpgr-runner-fall.png`,
  slide: `${BASE}/character/mpgr-runner-slide.png`,
  fly: `${BASE}/character/mpgr-runner-fly.png`,
  land: `${BASE}/character/mpgr-runner-land.png`,
  victory: `${BASE}/character/mpgr-runner-victory.png`,
} as const;

export const OBSTACLE_SPRITES: Record<ObstacleType, string> = {
  spikes: `${BASE}/obstacles/mpgr-run-spikes.png`,
  crate: `${BASE}/obstacles/mpgr-run-crate.png`,
  tnt: `${BASE}/obstacles/mpgr-run-tnt.png`,
  saw: `${BASE}/obstacles/mpgr-run-saw.png`,
  drone: `${BASE}/obstacles/mpgr-run-drone.png`,
  barrier: `${BASE}/obstacles/mpgr-run-barrier.png`,
};

export const COLLECTIBLE_SPRITES: Record<CollectibleType, string> = {
  coin: `${BASE}/collectibles/mpgr-run-coin.png`,
  gem: `${BASE}/collectibles/mpgr-run-gem.png`,
  xpOrb: `${BASE}/collectibles/mpgr-run-xp.png`,
  key: `${BASE}/collectibles/mpgr-run-key.png`,
  chest: `${BASE}/collectibles/mpgr-run-treasure-chest.png`,
};

export const POWERUP_SPRITES: Record<PowerupType, string> = {
  magnet: `${BASE}/powerups/mpgr-run-magnet.png`,
  shield: `${BASE}/powerups/mpgr-run-shield.png`,
  speed: `${BASE}/powerups/mpgr-run-speed-boost.png`,
  jetpack: `${BASE}/powerups/mpgr-run-jetpack.png`,
  score2x: `${BASE}/powerups/mpgr-run-score-2x.png`,
  invincibility: `${BASE}/powerups/mpgr-run-invincibility.png`,
};

export const CHECKPOINT_SPRITE = `${BASE}/checkpoints/mpgr-run-checkpoint.png`;

export const UI_SPRITES = {
  heart: `${BASE}/ui/mpgr-run-heart.png`,
  hudFrame: `${BASE}/ui/mpgr-run-hud-frame.png`,
  powerupFrame: `${BASE}/ui/mpgr-run-powerup-frame.png`,
} as const;

export const CITY_ENVIRONMENT = {
  background: `${BASE}/environment/city/city-background.png`,
  midground: `${BASE}/environment/city/city-midground.png`,
  foreground: `${BASE}/environment/city/city-foreground.png`,
} as const;

/** Every sprite path used by the live render loop, flattened for a one-time preload on mount. */
export const ALL_SPRITE_PATHS: string[] = [
  ...Object.values(CHARACTER_SPRITES),
  ...Object.values(OBSTACLE_SPRITES),
  ...Object.values(COLLECTIBLE_SPRITES),
  ...Object.values(POWERUP_SPRITES),
  CHECKPOINT_SPRITE,
  UI_SPRITES.heart,
  ...Object.values(CITY_ENVIRONMENT),
];
