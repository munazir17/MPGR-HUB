"use client";

import { CountdownCard } from "@/components/ui/CountdownCard";

interface SeasonCountdownProps {
  seasonEnd: Date;
  seasonNumber: number;
}

/** Thin wrapper around the existing CountdownCard — reused as-is, not
 * duplicated, just framed with Season Pass copy. */
export function SeasonCountdown({ seasonEnd, seasonNumber }: SeasonCountdownProps) {
  return <CountdownCard target={seasonEnd} label={`Season ${seasonNumber} ends in`} />;
}
