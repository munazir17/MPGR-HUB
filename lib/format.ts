export function formatAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

// Matches: 999→999, 1000→1K, 1500→1.5K, 12500→12.5K,
// 1000000→1M, 1250000→1.25M, 1000000000→1B
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const num = Math.abs(value);

  if (num < 1000) return `${sign}${num}`;

  const units: { value: number; symbol: string }[] = [
    { value: 1e9, symbol: "B" },
    { value: 1e6, symbol: "M" },
    { value: 1e3, symbol: "K" },
  ];

  for (const unit of units) {
    if (num >= unit.value) {
      const scaled = Math.round((num / unit.value) * 100) / 100;
      return `${sign}${scaled}${unit.symbol}`;
    }
  }

  return `${sign}${num}`;
}

export function formatTokenAmount(value: string | number, decimals = 4): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return "0";
  return num.toLocaleString("en-US", { maximumFractionDigits: decimals });
}
