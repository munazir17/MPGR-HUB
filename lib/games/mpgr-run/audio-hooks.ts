// lib/games/mpgr-run/audio-hooks.ts
//
// Clean SFX interface for MPGR Run. No audio files exist in this repository
// (public/ only has icon.png, splash.png, image.png), so every hook below
// is a documented no-op by default — the render loop already calls the
// right hook at the right moment for every event in the game design brief
// (jump, slide, hit, pickups per collectible/power-up type, checkpoint,
// game over). Wiring real sound later is a matter of calling
// setRunAudioHooks({...}) once (e.g. from a client provider) with real
// implementations — RunGame.tsx itself never changes.

import type { PowerupType } from "./run-config";

export interface RunAudioHooks {
  onJump: () => void;
  onSlide: () => void;
  onLand: () => void;
  onHit: () => void;
  onCoinPickup: () => void;
  onGemPickup: () => void;
  onPowerupPickup: (type: PowerupType) => void;
  onPowerupExpire: (type: PowerupType) => void;
  onCheckpoint: () => void;
  onLevelUp: () => void;
  onGameOver: () => void;
  onButtonClick: () => void;
}

const noop = () => {};

export const noopAudioHooks: RunAudioHooks = {
  onJump: noop,
  onSlide: noop,
  onLand: noop,
  onHit: noop,
  onCoinPickup: noop,
  onGemPickup: noop,
  onPowerupPickup: noop,
  onPowerupExpire: noop,
  onCheckpoint: noop,
  onLevelUp: noop,
  onGameOver: noop,
  onButtonClick: noop,
};

let activeHooks: RunAudioHooks = noopAudioHooks;

/** Register real SFX implementations. Any hook omitted stays a no-op. */
export function setRunAudioHooks(hooks: Partial<RunAudioHooks>): void {
  activeHooks = { ...noopAudioHooks, ...hooks };
}

export function getRunAudioHooks(): RunAudioHooks {
  return activeHooks;
}
