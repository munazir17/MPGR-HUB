"use client";

import { useSyncExternalStore } from "react";
import { Music2, VolumeX } from "lucide-react";
import type { RunMusic } from "@/lib/games/mpgr-run/run-music";

/** Stop game hotkeys, not native Space/Enter activation of this button. */
export function isolateMusicKeys(event: Pick<KeyboardEvent, "stopPropagation">) {
  event.stopPropagation();
}

/** Header control, outside the swipe surface. Only audio events rerender it. */
export function RunGameMusic({ music }: { music: RunMusic }) {
  const state = useSyncExternalStore(music.subscribe, music.getSnapshot, music.getSnapshot);
  const Icon = state.enabled ? Music2 : VolumeX;
  return (
    <button
      type="button"
      aria-label={state.enabled ? "Turn music off" : "Turn music on"}
      aria-pressed={state.enabled}
      title={state.status === "blocked" ? "Browser blocked music. Toggle off/on to retry." : state.status === "unavailable" ? "Music unavailable; gameplay is unaffected." : "Background music"}
      onKeyDown={isolateMusicKeys}
      onClick={(event) => {
        music.setEnabled(!state.enabled);
        // Pointer clicks should not leave keyboard lane controls trapped on
        // this button. Keyboard activation retains focus for accessibility.
        if (event.detail > 0) event.currentTarget.blur();
      }}
      className="ml-auto flex min-h-10 whitespace-nowrap items-center gap-1.5 rounded-full px-3 text-xs text-white ring-1 ring-white/10 active:scale-95"
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      Music {state.enabled ? "on" : "off"}
      {state.enabled && (state.status === "blocked" || state.status === "unavailable") && <span className="text-amber-300" aria-hidden="true">!</span>}
    </button>
  );
}
