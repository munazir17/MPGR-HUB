"use client";

import { useEffect, useState } from "react";

export function useAgentVisitorCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const posted = await fetch("/api/agent/visitors", {
          method: "POST",
          credentials: "include",
        });
        if (posted.ok) {
          const data = (await posted.json()) as { count?: unknown };
          if (!cancelled && typeof data.count === "number") {
            setCount(data.count);
            return;
          }
        }
        const read = await fetch("/api/agent/visitors", { credentials: "include" });
        if (!read.ok) return;
        const data = (await read.json()) as { count?: unknown };
        if (!cancelled && typeof data.count === "number") setCount(data.count);
      } catch {
        // Counter is optional — hide it if tracking is unavailable.
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}
