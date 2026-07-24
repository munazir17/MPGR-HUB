"use client";

import { useEffect, useState } from "react";
import { GlassCard } from "./GlassCard";

function getTimeLeft(target: Date) {
  const diff = Math.max(0, target.getTime() - Date.now());
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return { days, hours, minutes };
}

export function CountdownCard({ target, label }: { target: Date; label: string }) {
  const [time, setTime] = useState(() => getTimeLeft(target));

  useEffect(() => {
    const id = setInterval(() => setTime(getTimeLeft(target)), 60_000);
    return () => clearInterval(id);
  }, [target]);

  return (
    <GlassCard className="p-5">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-2 flex gap-3">
        {[
          { value: time.days, unit: "d" },
          { value: time.hours, unit: "h" },
          { value: time.minutes, unit: "m" },
        ].map((t) => (
          <div key={t.unit} className="rounded-xl bg-background/50 px-3 py-1.5 text-center">
            <p className="text-lg font-semibold text-white">{t.value}</p>
            <p className="text-[10px] text-muted">{t.unit}</p>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
