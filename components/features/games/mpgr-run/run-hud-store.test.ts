import { describe, expect, it, vi } from "vitest";
import { createRunHudStore } from "./run-hud-store";
import type { HudSnapshot } from "./RunGameTypes";

const initial: HudSnapshot = { distance: 0, score: 0, coins: 0, gems: 0, hp: 3, speedTier: 0, activePowerups: [], checkpointFlash: false };

describe("isolated Run HUD subscription", () => {
  it("keeps snapshots stable and skips unchanged ticks", () => {
    const store = createRunHudStore(initial), listener = vi.fn();
    store.subscribe(listener);
    for (let i = 0; i < 80; i++) store.publish({ ...initial, activePowerups: [] });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(initial);
  });
  it("notifies only its subscribers and supports unsubscribe", () => {
    const store = createRunHudStore(initial), listener = vi.fn();
    const stop = store.subscribe(listener);
    store.publish({ ...initial, score: 10 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().score).toBe(10);
    stop(); store.publish({ ...initial, score: 20 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("only repaints a power-up timer when the displayed second changes", () => {
    const snapshot: HudSnapshot = { ...initial, activePowerups: [{ type: "shield", remainingMs: 2900 }] };
    const store = createRunHudStore(snapshot), listener = vi.fn(); store.subscribe(listener);
    store.publish({ ...snapshot, activePowerups: [{ type: "shield", remainingMs: 2100 }] });
    expect(listener).not.toHaveBeenCalled();
    store.publish({ ...snapshot, activePowerups: [{ type: "shield", remainingMs: 2000 }] });
    expect(listener).toHaveBeenCalledTimes(1);
    store.publish({ ...initial });
    expect(listener).toHaveBeenCalledTimes(2);
  });
  for (const key of ["distance", "score", "coins", "gems", "hp", "speedTier"] as const) {
    it(`does not miss ${key} updates`, () => {
      const store = createRunHudStore(initial), listener = vi.fn(); store.subscribe(listener);
      store.publish({ ...initial, [key]: initial[key] + 1 });
      expect(listener).toHaveBeenCalledOnce();
    });
  }
});
