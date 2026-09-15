"use client";

import { clsx } from "clsx";

interface AgentOrbProps {
  size?: "sm" | "lg";
  thinking?: boolean;
}

export function AgentOrb({ size = "lg", thinking }: AgentOrbProps) {
  return (
    <div
      className={clsx(
        "relative flex items-center justify-center",
        size === "lg" ? "h-28 w-28 md:h-36 md:w-36" : "h-10 w-10"
      )}
      aria-hidden="true"
    >
      <span
        className={clsx(
          "absolute inset-0 rounded-full bg-primary/20 blur-2xl",
          thinking ? "animate-glow-pulse" : "opacity-70"
        )}
      />
      <span
        className={clsx(
          "relative rounded-full border border-primary/30 bg-[radial-gradient(circle_at_35%_30%,#7dd3fc_0%,#38bdf8_38%,#1d4ed8_100%)] shadow-glow",
          size === "lg" ? "h-20 w-20 md:h-24 md:w-24" : "h-9 w-9"
        )}
      >
        <span className="absolute inset-[18%] rounded-full bg-background/25" />
        <span className="absolute left-[28%] top-[26%] h-[18%] w-[18%] rounded-full bg-white/70" />
      </span>
    </div>
  );
}
