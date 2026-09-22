import { clsx } from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        "animate-shimmer rounded-md bg-gradient-to-r from-white/[0.04] via-white/[0.09] to-white/[0.04] bg-[length:200%_100%]",
        className
      )}
    />
  );
}
