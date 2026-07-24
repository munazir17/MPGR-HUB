export function formatAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const num = Math.abs(value);

  if (num < 1000) return `${sign}${Math.round(num * 100) / 100}`;

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

// Converts a raw ERC20 bigint balance into a display value using the
// token's actual decimals, then compact-formats it. Never shows the
// raw on-chain integer. Integer part is computed via BigInt division
// (exact, no precision loss) — only the fractional remainder passes
// through Number, which is safe since it's always < 1.
export function formatTokenBalance(raw: bigint | undefined, decimals: number | undefined): string {
  if (raw === undefined || decimals === undefined) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  const asNumber = Number(whole) + Number(remainder) / Number(divisor);
  return formatCompactNumber(asNumber);
}

// "Today" / "Yesterday" / "3 days ago" / short date beyond that.
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfEntry = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfEntry.getTime()) / 86_400_000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
