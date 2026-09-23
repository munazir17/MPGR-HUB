import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { AssetPriceChart } from "./AssetPriceChart";

// components/markets/AssetPriceChart.render.test.ts
//
// The chart draws ONLY observations it was handed. Fewer than two real
// points renders an explanation instead of a line — a chart must never
// fill a gap with invented data.

function render(props: Parameters<typeof AssetPriceChart>[0]): string {
  return renderToString(createElement(AssetPriceChart, props));
}

describe("AssetPriceChart", () => {
  it("explains the wait instead of drawing a line with one point", () => {
    const html = render({
      points: [{ t: 1_790_000_000, price: 341.05 }],
      label: "Chainlink equity feed rounds",
      source: "Chainlink Coinbase equity feed (official)",
    });
    expect(html).toContain("Collecting live samples");
    expect(html).not.toContain("<polyline");
    expect(html).not.toContain("<svg");
  });

  it("draws the real series, its range and its source", () => {
    const html = render({
      points: [
        { t: 1_790_000_000, price: 338.1 },
        { t: 1_790_090_000, price: 341.05 },
      ],
      label: "Chainlink equity feed rounds",
      source: "Chainlink Coinbase equity feed (official)",
    });
    expect(html).toContain("<polyline");
    expect(html).toContain("$338.10");
    expect(html).toContain("$341.05");
    expect(html).toContain("Chainlink Coinbase equity feed (official)");
    // React interleaves text nodes with comment markers, so assert the
    // rendered sentence pieces rather than one contiguous string.
    expect(html).toContain("real observation");
    expect(html).toContain("2 observations from Chainlink Coinbase equity feed (official)");
  });

  it("flags a stale feed without hiding the observations", () => {
    const html = render({
      points: [
        { t: 1, price: 1 },
        { t: 1_000, price: 2 },
      ],
      label: "Live DEX samples",
      source: "DexScreener (Aerodrome · Base)",
      stale: true,
    });
    expect(html).toContain("feed flagged stale");
    expect(html).toContain("<polyline");
  });
});
