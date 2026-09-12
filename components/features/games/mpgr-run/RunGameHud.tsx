"use client";

// components/features/games/mpgr-run/RunGameHud.tsx
//
// Pure, presentational HUD/control subcomponents extracted verbatim out of
// RunGame.tsx (P2-11 — file-size/maintainability audit item). These
// components take no dependency on game state, refs, the canvas, or the
// simulation loop — they only render from props — so moving them here
// cannot change gameplay behavior, physics, scoring, timing, or rendering
// of the game itself. They are re-exported with identical prop shapes and
// markup to what previously lived inline in RunGame.tsx.

import type { Zap } from "lucide-react";

export function HudChip({
  icon: Icon,
  imgSrc,
  label,
  value,
}: {
  icon?: typeof Zap;
  imgSrc?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 shadow-[0_0_0_1px_rgba(59,130,246,0.35)] backdrop-blur-md">
      {imgSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imgSrc} alt="" className="h-4 w-4 object-contain" aria-hidden="true" />
      ) : Icon ? (
        <Icon className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
      ) : null}
      <span className="text-xs font-semibold text-white">{value}</span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ControlButton({
  icon: Icon,
  label,
  onPress,
  accent,
}: {
  icon: typeof Zap;
  label: string;
  onPress: () => void;
  accent?: boolean;
}) {
  return (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPress();
      }}
      aria-label={label}
      className={`flex h-14 w-14 items-center justify-center rounded-full backdrop-blur-md ring-1 transition-transform active:scale-90 ${
        accent
          ? "bg-gradient-premium text-white shadow-glow-gold ring-white/20"
          : "bg-black/45 text-white ring-white/15"
      }`}
    >
      <Icon className="h-6 w-6" aria-hidden="true" />
    </button>
  );
}

export function StatPill({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-2 py-2.5">
      <p className={highlight ? "text-sm font-bold text-gold" : "text-sm font-bold text-white"}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted">{label}</p>
    </div>
  );
}
