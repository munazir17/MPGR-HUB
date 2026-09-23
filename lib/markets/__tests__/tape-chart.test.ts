import { describe, expect, it } from "vitest";

import {
  CHART_MAX_POINTS,
  chartGeometry,
  mergeChartPoints,
  sanitizeChartPoints,
} from "../tape-chart";

describe("sanitizeChartPoints", () => {
  it("drops non-finite and non-positive prices instead of plotting them", () => {
    const cleaned = sanitizeChartPoints([
      { t: 3, price: 2 },
      { t: 1, price: 0 },
      { t: 2, price: Number.NaN },
      { t: 4, price: -5 },
      { t: 5, price: Number.POSITIVE_INFINITY },
    ]);
    expect(cleaned).toEqual([{ t: 3, price: 2 }]);
  });

  it("orders observations oldest → newest", () => {
    expect(sanitizeChartPoints([{ t: 3, price: 3 }, { t: 1, price: 1 }])).toEqual([
      { t: 1, price: 1 },
      { t: 3, price: 3 },
    ]);
  });
});

describe("mergeChartPoints", () => {
  it("appends a live price only when it is newer than the last observation", () => {
    const history = [{ t: 100, price: 2 }];
    expect(mergeChartPoints(history, { t: 130, price: 2.5 })).toEqual([
      { t: 100, price: 2 },
      { t: 130, price: 2.5 },
    ]);
    // Same or older timestamp → not a new observation, so no extra point.
    expect(mergeChartPoints(history, { t: 100, price: 9 })).toEqual(history);
    expect(mergeChartPoints(history, { t: 90, price: 9 })).toEqual(history);
  });

  it("ignores a missing live price and caps the series length", () => {
    expect(mergeChartPoints([{ t: 1, price: 1 }], null)).toEqual([{ t: 1, price: 1 }]);
    const many = Array.from({ length: CHART_MAX_POINTS + 25 }, (_, index) => ({
      t: index + 1,
      price: index + 1,
    }));
    const capped = mergeChartPoints(many, null);
    expect(capped).toHaveLength(CHART_MAX_POINTS);
    // Keeps the NEWEST points.
    expect(capped[capped.length - 1].t).toBe(CHART_MAX_POINTS + 25);
  });
});

describe("chartGeometry", () => {
  it("returns null for a series that cannot be drawn", () => {
    expect(chartGeometry([])).toBeNull();
    expect(chartGeometry([{ t: 1, price: 1 }])).toBeNull();
  });

  it("maps the series into the viewBox with the first point on the left", () => {
    const geometry = chartGeometry(
      [
        { t: 1, price: 10 },
        { t: 2, price: 20 },
      ],
      320,
      96,
      6,
    );
    expect(geometry).not.toBeNull();
    expect(geometry?.min).toBe(10);
    expect(geometry?.max).toBe(20);
    expect(geometry?.flat).toBe(false);
    const first = geometry!.line.split(" ")[0].split(",");
    const last = geometry!.line.split(" ")[1].split(",");
    expect(Number(first[0])).toBe(6);
    expect(Number(last[0])).toBe(314);
    // Higher price must be drawn higher up (smaller y).
    expect(Number(first[1])).toBeGreaterThan(Number(last[1]));
    expect(geometry!.area.startsWith("M ")).toBe(true);
  });

  it("centres a flat series instead of dividing by a zero range", () => {
    const geometry = chartGeometry([
      { t: 1, price: 5 },
      { t: 2, price: 5 },
    ]);
    expect(geometry?.flat).toBe(true);
    for (const pair of geometry!.line.split(" ")) {
      expect(Number(pair.split(",")[1])).toBe(48);
    }
  });
});
