"use client";

import { Building2 } from "lucide-react";

import type { TokenizedStockReport } from "@/lib/trade/trade-types";

interface AgentTokenizedStockCardProps {
  report: TokenizedStockReport;
}

export function AgentTokenizedStockCard({ report }: AgentTokenizedStockCardProps) {
  if (report.kind === "catalog") {
    return (
      <div className="w-full rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left">
        <div className="mb-2 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-emerald-400" />
          <p className="text-xs font-semibold text-white">Coinbase Tokenized Stocks on Base</p>
        </div>
        <p className="mb-2 text-[11px] text-muted">
          {report.assets.length} official B20 assets · issuer Coinbase · secondary market permissionless
        </p>
        <ul className="grid grid-cols-2 gap-1 text-[11px] text-zinc-300 sm:grid-cols-3">
          {report.assets.map((asset) => (
            <li key={asset.address} className="truncate">
              {asset.symbol}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const { catalog, onchain, execution, liquidity } = report.report;
  return (
    <div className="w-full rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left">
      <div className="mb-2 flex items-center gap-2">
        <Building2 className="h-4 w-4 text-emerald-400" />
        <p className="text-xs font-semibold text-white">
          {catalog.symbol} · {catalog.underlyingTicker}
        </p>
      </div>
      <dl className="space-y-1 text-[11px]">
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Oracle price</dt>
          <dd className="text-white">
            {onchain.impliedTokenPriceUsd ? `$${onchain.impliedTokenPriceUsd}` : "unavailable"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Multiplier</dt>
          <dd className="text-white">{onchain.multiplier ?? "unread"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">DEX liquidity</dt>
          <dd className="text-white">
            {liquidity.liquidityAvailable === true
              ? "CDP reports liquidity"
              : liquidity.liquidityAvailable === false
                ? "none reported"
                : "not probed"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Execution</dt>
          <dd className="text-white">{execution.available ? "swap via CDP (confirm)" : "research only"}</dd>
        </div>
      </dl>
    </div>
  );
}
