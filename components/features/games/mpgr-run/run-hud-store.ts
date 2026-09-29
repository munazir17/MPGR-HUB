import type { HudSnapshot } from "./RunGameTypes";

/** UI-only store: publishing a HUD tick must not rerender the game host,
 * canvas, pointer surface, controls, or phase overlays. No simulation writes.
 */
export function createRunHudStore(initial: HudSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next: HudSnapshot) {
      if (sameVisibleHud(snapshot, next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

export type RunHudStore = ReturnType<typeof createRunHudStore>;

function sameVisibleHud(a: HudSnapshot, b: HudSnapshot): boolean {
  if (a.distance !== b.distance || a.score !== b.score || a.coins !== b.coins ||
      a.gems !== b.gems || a.hp !== b.hp || a.speedTier !== b.speedTier ||
      a.checkpointFlash !== b.checkpointFlash || a.activePowerups.length !== b.activePowerups.length) return false;
  for (let i = 0; i < a.activePowerups.length; i++) {
    const x = a.activePowerups[i], y = b.activePowerups[i];
    if (x.type !== y.type || Math.ceil(x.remainingMs / 1000) !== Math.ceil(y.remainingMs / 1000)) return false;
  }
  return true;
}
