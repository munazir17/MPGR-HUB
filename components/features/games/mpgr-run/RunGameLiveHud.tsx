"use client";

import { useSyncExternalStore } from "react";
import { Zap } from "lucide-react";
import { HudChip } from "./RunGameHud";
import { formatCompactNumber } from "@/lib/format";
import { COLLECTIBLE_SPRITES, POWERUP_SPRITES, UI_SPRITES } from "@/lib/games/mpgr-run/run-assets";
import { STARTING_HP, POWERUP_TYPES } from "@/lib/games/mpgr-run/run-config";
import type { RunHudStore } from "./run-hud-store";

/** Only this leaf subscribes to the 120ms HUD clock. Controls and the game
 * host stay mounted without reconciling on distance/power-up ticks. */
export function RunGameLiveHud({ store }: { store: RunHudStore }) {
  const hud = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <>
          <div
            className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3"
            style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
          >
            <div className="flex flex-wrap gap-1.5">
              <HudChip icon={Zap} label="Score" value={formatCompactNumber(hud.score)} />
              <HudChip imgSrc={COLLECTIBLE_SPRITES.coin} label="Coins" value={String(hud.coins)} />
              <HudChip imgSrc={COLLECTIBLE_SPRITES.gem} label="Gems" value={String(hud.gems)} />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white shadow-[0_0_0_1px_rgba(59,130,246,0.35)]">
                {formatCompactNumber(hud.distance)}m
              </div>
              <div className="flex items-center gap-0.5 rounded-full bg-black/70 px-2.5 py-1">
                {Array.from({ length: STARTING_HP }).map((_, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={UI_SPRITES.heart}
                    alt=""
                    className={`h-4 w-4 object-contain transition-all duration-300 ${
                      i < hud.hp ? "opacity-100 drop-shadow-[0_0_4px_rgba(244,63,94,0.7)]" : "opacity-20 grayscale"
                    }`}
                    aria-hidden="true"
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Active power-ups */}
          {hud.activePowerups.length > 0 && (
            <div className="pointer-events-none absolute left-3 top-16 flex flex-col gap-1.5">
              {hud.activePowerups.map(({ type, remainingMs }) => {
                const cfg = POWERUP_TYPES[type];
                return (
                  <div
                    key={type}
                    className="flex items-center gap-1.5 rounded-full bg-black/75 py-1 pl-1 pr-2.5"
                    style={{ boxShadow: `0 0 0 1px ${cfg.color}55, 0 0 10px 0 ${cfg.color}33` }}
                  >
                    <span className="relative flex h-6 w-6 items-center justify-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={UI_SPRITES.powerupFrame}
                        alt=""
                        className="absolute inset-0 h-full w-full object-contain opacity-80"
                        aria-hidden="true"
                      />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={POWERUP_SPRITES[type]}
                        alt=""
                        className="relative h-4 w-4 object-contain"
                        aria-hidden="true"
                      />
                    </span>
                    <span className="text-[10px] font-semibold text-white">{Math.ceil(remainingMs / 1000)}s</span>
                  </div>
                );
              })}
            </div>
          )}

  </>;
}
