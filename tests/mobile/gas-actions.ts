// Base fee-estimation transport boundary. Always simulated, never an RPC.
export async function estimateTotalFee() { return 1_000_000_000_000n; }
