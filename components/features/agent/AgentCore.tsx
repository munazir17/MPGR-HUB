"use client";

// components/features/agent/AgentCore.tsx
//
// The MPGR Agent's ONE physical object — the equivalent of the reference
// sites' hero mascot, rebuilt in MPGR's material language:
//
//   dark-navy precision core · blue rim light (#4DA3FF) · gold inner
//   filament (#E2C073) · real contact shadow · slow 6s float (±6px)
//
// It is a VISUAL ONLY asset (pure CSS — no GL, no image fetches, no
// canvas): not an NFT, not a token, not a game, not a route. Two sizes:
//
//   hero  — the empty-state object (240–300px desktop, 160–200 mobile,
//           shrinking toward 140px on tight viewports via clamp())
//   jewel — the 28px badge the core shrinks into inside the stage top
//           bar once a thread exists
//
// Behavior hooks (all presentation):
//   state="thinking"  → the gold filament brightens and spins faster
//   squashSignal      → increment to fire the ~200ms send squash
//   prefers-reduced-motion → static poster pose (globals.css freezes
//   the float classes; framer's useReducedMotion skips the squash)
//
// The hero variant is centered by its parent; this component only draws
// the object and its shadow.

import { useEffect, useRef, type CSSProperties } from "react";
import { motion, useAnimationControls, useReducedMotion } from "framer-motion";
import { clsx } from "clsx";

export type AgentCoreState = "idle" | "thinking";

export interface AgentCoreProps {
  /** "hero" = full object + contact shadow; "jewel" = compact top-bar badge. */
  variant?: "hero" | "jewel";
  state?: AgentCoreState;
  /** Increment to fire the send squash (hero variant only). */
  squashSignal?: number;
  className?: string;
}

/**
 * A masked gradient ring, flattened by rotateX() into a torus arc.
 * `inset` sizes it relative to its container (negative = larger than
 * the sphere, Saturn-style).
 */
function torusArc(opts: {
  color: string;
  thickness: number;
  tilt: number;
  spin?: number;
  inset: string;
  opacity: number;
  glow?: string;
}): CSSProperties {
  return {
    position: "absolute",
    inset: opts.inset,
    borderRadius: "50%",
    opacity: opts.opacity,
    transform: `rotateX(${opts.tilt}deg) rotateZ(${opts.spin ?? 0}deg)`,
    background: `linear-gradient(90deg, transparent 2%, ${opts.color} 30%, ${opts.color} 70%, transparent 98%)`,
    WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${opts.thickness}px), #000 calc(100% - ${opts.thickness - 1}px))`,
    mask: `radial-gradient(farthest-side, transparent calc(100% - ${opts.thickness}px), #000 calc(100% - ${opts.thickness - 1}px))`,
    filter: opts.glow ? `drop-shadow(${opts.glow})` : undefined,
  };
}

export function AgentCore({
  variant = "hero",
  state = "idle",
  squashSignal,
  className,
}: AgentCoreProps) {
  const reduceMotion = useReducedMotion();
  const controls = useAnimationControls();
  const lastSignal = useRef(0);
  const thinking = state === "thinking";

  // Send squash — ~200ms compress-and-settle on the whole object.
  useEffect(() => {
    if (squashSignal && squashSignal !== lastSignal.current && !reduceMotion) {
      controls.start({
        scaleY: [1, 0.84, 1.04, 1],
        scaleX: [1, 1.1, 0.97, 1],
        transition: { duration: 0.28, ease: "easeOut" },
      });
    }
    lastSignal.current = squashSignal ?? 0;
  }, [squashSignal, controls, reduceMotion]);

  if (variant === "jewel") {
    // 28px badge: same material, minimal layers — a shrunken core with
    // its blue rim and a gold filament dot that brightens on "thinking".
    return (
      <motion.span
        animate={controls}
        className={clsx("relative inline-block h-7 w-7 shrink-0", className)}
        aria-hidden="true"
      >
        <span
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle at 34% 28%, #22334f 0%, #0d1524 52%, #070c16 82%)",
            boxShadow: thinking
              ? "0 0 0 1px rgba(77,163,255,0.55), 0 0 14px rgba(77,163,255,0.45), inset 0 -6px 10px rgba(3,6,14,0.85)"
              : "0 0 0 1px rgba(77,163,255,0.4), 0 0 8px rgba(77,163,255,0.25), inset 0 -6px 10px rgba(3,6,14,0.85)",
          }}
        />
        <span
          className={clsx(
            "absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-200",
            thinking && "animate-pulse",
          )}
          style={{
            background:
              "radial-gradient(circle, #f3da9b 0%, #e2c073 60%, transparent 100%)",
            opacity: thinking ? 1 : 0.65,
            boxShadow: thinking
              ? "0 0 6px rgba(226,192,115,0.9)"
              : "0 0 3px rgba(226,192,115,0.4)",
          }}
        />
      </motion.span>
    );
  }

  return (
    <motion.div
      animate={controls}
      className={clsx(
        "relative aspect-square select-none",
        // 160–200px on phones, 240–300px on desktop, ≥140px when tight.
        "h-[clamp(140px,44vw,300px)] md:h-[clamp(220px,26vw,300px)]",
        className,
      )}
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      {/* Contact shadow — sits under the object, breathes against the float. */}
      <span
        className={clsx(
          "agent-core-shadow absolute bottom-[-7%] left-1/2 h-[9%] w-[62%] -translate-x-1/2 rounded-[50%] bg-black/80 blur-[10px]",
          !reduceMotion && "animate-core-shadow",
        )}
      />

      {/* Floating object */}
      <span
        className={clsx(
          "agent-core-float absolute inset-0 block",
          !reduceMotion && "animate-core-float",
        )}
      >
        {/* Far half of the blue equatorial torus (behind the sphere) */}
        <span className="absolute inset-0" style={{ clipPath: "inset(0 0 50% 0)" }}>
          <span
            style={torusArc({
              color: "rgba(77,163,255,0.30)",
              thickness: 3,
              tilt: 74,
              inset: "-9%",
              opacity: 0.85,
            })}
          />
        </span>

        {/* The core sphere — dark navy, lit by its rim */}
        <span
          className="absolute inset-[7%] block rounded-full"
          style={{
            background:
              "radial-gradient(circle at 34% 26%, #223350 0%, #101a2e 38%, #0a101b 62%, #060a13 100%)",
            boxShadow: thinking
              ? "0 0 0 1px rgba(77,163,255,0.45), 0 0 64px -8px rgba(77,163,255,0.5), inset 0 -26px 44px rgba(3,6,14,0.85), inset 0 14px 30px rgba(77,163,255,0.14)"
              : "0 0 0 1px rgba(77,163,255,0.34), 0 0 48px -10px rgba(77,163,255,0.38), inset 0 -26px 44px rgba(3,6,14,0.85), inset 0 14px 30px rgba(77,163,255,0.10)",
            transition: "box-shadow 400ms cubic-bezier(.23,1,.32,1)",
          }}
        >
          {/* Specular highlight — one top-left light source */}
          <span className="absolute left-[20%] top-[13%] block h-[13%] w-[22%] rotate-[-20deg] rounded-[50%] bg-white/60 blur-[5px]" />
          {/* Terminator sheen along the lower-right rim */}
          <span
            className="absolute inset-0 block rounded-full"
            style={{
              background:
                "radial-gradient(circle at 68% 78%, rgba(77,163,255,0.16) 0%, transparent 42%)",
            }}
          />

          {/* Gold inner filament — a gyroscope ring inside the sphere.
              The animated wrapper rotates in screen space while the
              inner arc keeps its tilt, so the ring slowly tumbles.
              Thinking brightens it and spins it faster. */}
          <span
            className={clsx("block h-full w-full", !reduceMotion && "animate-core-filament")}
            style={{
              animationDuration: thinking ? "3.6s" : "9s",
              opacity: thinking ? 1 : 0.6,
              filter: thinking
                ? "drop-shadow(0 0 10px rgba(226,192,115,0.75))"
                : "drop-shadow(0 0 5px rgba(226,192,115,0.35))",
              transition: "opacity 400ms, filter 400ms",
            }}
          >
            <span
              style={torusArc({
                color: "#e2c073",
                thickness: 2,
                tilt: 58,
                spin: 24,
                inset: "16%",
                opacity: 1,
              })}
            />
          </span>

          {/* Filament core dot */}
          <span
            className={clsx(
              "absolute left-1/2 top-1/2 block h-[7%] w-[7%] -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-500",
              thinking && "animate-pulse",
            )}
            style={{
              background:
                "radial-gradient(circle, #f3da9b 0%, #e2c073 55%, rgba(226,192,115,0) 100%)",
              boxShadow: thinking
                ? "0 0 18px rgba(226,192,115,0.95)"
                : "0 0 10px rgba(226,192,115,0.5)",
            }}
          />
        </span>

        {/* Near half of the blue equatorial torus (in front of the
            sphere's lower edge) — brighter, with its own glow */}
        <span className="absolute inset-0 z-10" style={{ clipPath: "inset(50% 0 0 0)" }}>
          <span
            style={torusArc({
              color: "rgba(96,173,255,0.9)",
              thickness: 3,
              tilt: 74,
              inset: "-9%",
              opacity: 1,
              glow: "0 2px 10px rgba(77,163,255,0.45)",
            })}
          />
        </span>
      </span>
    </motion.div>
  );
}
