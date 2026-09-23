import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// components/markets/PairSheet.requirements.test.ts
//
// Requirement lock for the asset-detail sheet (source-level, like the
// other filesystem assertions in this repo — the sheet's body only
// renders after a fetch, so the markup cannot be asserted statically):
//
//   1. the old "Official list" button/section is gone — no link, no
//      label, no `officialListUrl` reference
//   2. it is replaced by a "View Asset Details" section carrying the
//      verified metadata fields
//   3. that section renders a price chart fed from the per-symbol
//      history endpoint, so two different assets can never share one
//      chart's data

const SOURCE = fs.readFileSync(path.join(__dirname, "PairSheet.tsx"), "utf8");

describe("Asset detail sheet requirements", () => {
  it("removes the official-list button/section entirely", () => {
    expect(SOURCE.toLowerCase()).not.toContain("official list");
    expect(SOURCE).not.toContain("officialListUrl");
  });

  it("replaces it with View Asset Details", () => {
    expect(SOURCE).toContain("View Asset Details");
    expect(SOURCE).toContain('data-testid="asset-details"');
  });

  it("shows the verified metadata fields", () => {
    for (const label of [
      "Asset name",
      "Symbol",
      "Contract",
      "Asset type",
      "Company",
      "Current price",
      "Official feed price",
      "24H change",
      "Freshness",
      "Last update",
      "Equity feed",
      "Verified against",
    ]) {
      expect(SOURCE).toContain(label);
    }
  });

  it("feeds the chart from the selected symbol's own history", () => {
    expect(SOURCE).toContain("/api/market/history?symbol=");
    expect(SOURCE).toContain("AssetPriceChart");
    // The chart prop comes from the fetched series for THIS symbol.
    expect(SOURCE).toContain("mergeChartPoints(series.points, livePoint)");
  });

  it("keeps the asset metadata sourced from the typed allowlist", () => {
    expect(SOURCE).toContain("OFFICIAL_LIST_SOURCES");
    expect(SOURCE).toContain("BASE_STOCKS_DISCLAIMER");
  });
});
