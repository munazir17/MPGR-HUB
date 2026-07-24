import { Skeleton } from "./Skeleton";
import { GlassCard } from "./GlassCard";

export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <GlassCard className="p-5">
      <Skeleton className="h-4 w-24" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="mt-3 h-3 w-full" />
      ))}
    </GlassCard>
  );
}
