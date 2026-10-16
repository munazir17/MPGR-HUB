import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { BASE_USDC, BASE_WETH, isNativeEthSentinel } from "@/lib/trade/trade-config";
// Locally rendered token glyphs/monograms, not fetched or invented issuer logos.
export function TokenIcon({ token }: { token: TradeTokenRef }) {
  const eth = isNativeEthSentinel(token.address), weth = token.address.toLowerCase() === BASE_WETH.toLowerCase();
  const usdc = token.address.toLowerCase() === BASE_USDC.toLowerCase();
  return <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${usdc ? "border-blue-400/30 bg-blue-500 text-white" : eth || weth ? "border-indigo-300/30 bg-indigo-300/10 text-indigo-200" : "border-emerald-300/15 bg-emerald-300/10 text-emerald-200"}`}>
    {usdc ? "$" : eth ? "◆" : weth ? "W" : token.symbol.slice(0, 2)}
  </span>;
}
export const tokenName = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
