"use client";
import { useState } from "react";
import { CircleHelp } from "lucide-react";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { swapTokenLogo } from "@/lib/swap/token-logos";
export function TokenIcon({ token, chainId = 8453 }: { token: TradeTokenRef; chainId?: number }) {
  const src = swapTokenLogo(token, chainId);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/5">
    {src && failedSrc !== src
      // Only vetted local raster assets; intentionally no remote loader or SVG.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={src} alt="" width={36} height={36} loading="lazy" decoding="async" className="h-full w-full object-contain" onError={() => setFailedSrc(src)} />
      : <CircleHelp data-testid="token-logo-fallback" size={20} className="text-zinc-400" />}
  </span>;
}
export const tokenName = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
