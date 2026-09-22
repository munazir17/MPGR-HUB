import type { ReactNode } from "react";
import { clsx } from "clsx";

// components/layout/PageContainer.tsx
//
// The one shared responsive page container for the app's major screens
// (Rewards, Profile, Games, Leaderboard, Staking, Token Lock, …).
//
// Before this existed every page hardcoded its own `mx-auto max-w-*`
// — several at phone-ish widths (max-w-2xl/3xl/4xl), which is exactly
// why desktop felt like a stretched mobile page. One primitive now
// defines the desktop contract:
//
//   mobile  — full width, 16px gutters, comfortable touch stacking
//   tablet  — 24px gutters, content still centered
//   desktop — up to 1120px of real content width with 32px gutters,
//             so grids/cards use the screen properly
//
// Pages keep their own vertical rhythm via className overrides.

interface PageContainerProps {
  children: ReactNode;
  className?: string;
  /** Narrow the container for reading-focused pages (leaderboard, season). */
  size?: "default" | "narrow";
}

export function PageContainer({ children, className, size = "default" }: PageContainerProps) {
  return (
    <main
      className={clsx(
        "mx-auto w-full px-4 py-10 sm:px-6 md:py-14 lg:px-8",
        size === "narrow" ? "max-w-4xl" : "max-w-[1120px]",
        className,
      )}
    >
      {children}
    </main>
  );
}
