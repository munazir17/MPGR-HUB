type LogLevel = "info" | "warn" | "error";

function redactWallet(value: unknown): unknown {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function logApi(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  for (const [key, value] of Object.entries(context)) {
    payload[key] = key.toLowerCase().includes("wallet") ? redactWallet(value) : value;
  }
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
