import { clsx } from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        "animate-shimmer rounded-lg bg-gradient-to-r from-surface via-border to-surface bg-[length:200%_100%]",
        className
      )}
    />
  );
}
