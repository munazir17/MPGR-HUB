// No connector/provider/key/transport. Calls are recorded in memory only.
const record = (method: string) => {
  const log = ((window as unknown as { simulatedWalletCalls?: string[] }).simulatedWalletCalls ??= []);
  log.push(method);
};
const scenario = () => (window as unknown as { simulatedWalletScenario?: string }).simulatedWalletScenario;
export async function readContract(_config: unknown, params: { functionName: string }) { record(params.functionName); return params.functionName === "allowance" || scenario() === "insufficient" ? 0n : 100_000_000n; }
export async function sendTransaction() { record("simulated-send"); if (scenario() === "wallet-rejected") throw Object.assign(new Error("User rejected request"), { code: 4001 }); return ("0x" + "ab".repeat(32)) as `0x${string}`; }
export async function signTypedData() { record("simulated-permit"); return ("0x" + "cd".repeat(65)) as `0x${string}`; }
export async function waitForTransactionReceipt() { record("simulated-receipt"); return { status: scenario() === "reverted" ? "reverted" : "success" }; }
export const config = {};
