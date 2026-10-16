// No connector/provider/key/transport. Calls are recorded in memory only.
const record = (method: string) => {
  const log = ((window as unknown as { simulatedWalletCalls?: string[] }).simulatedWalletCalls ??= []);
  log.push(method);
};
export async function readContract(_config: unknown, params: { functionName: string }) { record(params.functionName); return params.functionName === "allowance" ? 0n : 100_000_000n; }
export async function sendTransaction() { record("simulated-send"); return ("0x" + "ab".repeat(32)) as `0x${string}`; }
export async function signTypedData() { record("simulated-permit"); return ("0x" + "cd".repeat(65)) as `0x${string}`; }
export async function waitForTransactionReceipt() { record("simulated-receipt"); return { status: "success" }; }
export const config = {};
