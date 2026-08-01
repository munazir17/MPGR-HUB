"use client";

import { useRecentPageTracking } from "@/hooks/useRecentPageTracking";

// Phase 3B Part 3 — mounted once at the app root (app/layout.tsx), same
// pattern as components/MiniAppAutoConnect.tsx: a side-effect-only
// component with no rendered output, so it never affects layout or
// styling.
export function RecentPageTracker() {
  useRecentPageTracking();
  return null;
}
