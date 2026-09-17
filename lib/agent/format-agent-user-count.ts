/** Compact count for the Agent visitor line. 1,247 stays grouped; 10k+ uses K/M. */
export function formatAgentUserCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const value = Math.floor(count);
  if (value < 10_000) return value.toLocaleString("en-US");
  if (value < 1_000_000) {
    const k = value / 1_000;
    const rounded = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return `${rounded.replace(/\.0$/, "")}K`;
  }
  const m = value / 1_000_000;
  const rounded = m >= 100 ? m.toFixed(0) : m.toFixed(1);
  return `${rounded.replace(/\.0$/, "")}M`;
}
