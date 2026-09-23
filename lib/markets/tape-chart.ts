// lib/markets/tape-chart.ts
//
// Pure geometry for the asset-detail price chart. Kept out of the
// component so the maths is unit-testable and the component stays a
// renderer.
//
// Rules:
//   - points are real observations only; nothing is interpolated,
//     smoothed or back-filled
//   - non-finite / non-positive prices are dropped (never plotted as 0)
//   - output is an SVG path in a normalised viewBox, so the same numbers
//     work on a 360px phone and a 400px desktop drawer

export interface ChartPoint {
  /** Unix seconds. */
  t: number;
  price: number;
}

export const CHART_MAX_POINTS = 120;

/** Drops unusable points and returns them oldest → newest. */
export function sanitizeChartPoints(points: readonly ChartPoint[]): ChartPoint[] {
  return points
    .filter(
      (point) =>
        Number.isFinite(point.t) && Number.isFinite(point.price) && point.price > 0,
    )
    .slice()
    .sort((a, b) => a.t - b.t);
}

/**
 * The series to draw: the fetched history plus (optionally) the live tape
 * price as the newest point. A live point that is not newer than the last
 * observation is ignored, so a chart never jitters between two readings
 * of the same moment.
 */
export function mergeChartPoints(
  history: readonly ChartPoint[],
  live: ChartPoint | null | undefined,
  maxPoints = CHART_MAX_POINTS,
): ChartPoint[] {
  const merged = sanitizeChartPoints(history);
  if (
    live &&
    Number.isFinite(live.t) &&
    Number.isFinite(live.price) &&
    live.price > 0
  ) {
    const last = merged[merged.length - 1];
    if (!last || live.t > last.t) merged.push({ t: live.t, price: live.price });
  }
  return merged.length > maxPoints ? merged.slice(merged.length - maxPoints) : merged;
}

export interface ChartGeometry {
  /** SVG polyline `points` attribute in the viewBox coordinate space. */
  line: string;
  /** Closed area path under the line (for the gradient fill). */
  area: string;
  min: number;
  max: number;
  /** True when the series is flat — the renderer draws a centred line. */
  flat: boolean;
}

export function chartGeometry(
  points: readonly ChartPoint[],
  width = 320,
  height = 96,
  padding = 6,
): ChartGeometry | null {
  const usable = sanitizeChartPoints(points);
  if (usable.length < 2) return null;

  const values = usable.map((point) => point.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const flat = span <= 0;
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);

  const xOf = (index: number) =>
    padding + (usable.length === 1 ? innerWidth / 2 : (index / (usable.length - 1)) * innerWidth);
  const yOf = (price: number) =>
    flat ? height / 2 : padding + (1 - (price - min) / span) * innerHeight;

  const coords = usable.map((point, index) => [xOf(index), yOf(point.price)] as const);
  const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `M ${first[0].toFixed(2)} ${height - padding} L ${coords
    .map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" L ")} L ${last[0].toFixed(2)} ${height - padding} Z`;

  return { line, area, min, max, flat };
}
