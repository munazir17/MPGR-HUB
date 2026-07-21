"use client";

function hashToHue(address: string): number {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = address.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

export function AddressAvatar({ address, size = 48 }: { address: string; size?: number }) {
  const hue = hashToHue(address.toLowerCase());
  return (
    <div
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue}, 80%, 55%), hsl(${(hue + 60) % 360}, 80%, 45%))`,
      }}
      className="rounded-full border-2 border-white/10 shadow-glow"
    />
  );
}
