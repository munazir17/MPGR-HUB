// lib/x402/x402-tape-info.ts
//
// Plain constants describing the paid tape endpoint. Deliberately free
// of `server-only` and any imports so BOTH sides can share one source
// of truth:
//   - the resource server (lib/x402/x402-tape-resource.ts, server-only)
//   - client-side agent tools/UI (stocks-tool-definitions.ts is in the
//     browser import graph — a server-only import there breaks the
//     Next.js build, same incident class as tokenized-stock-order.ts).

/** Public path of the x402-gated live tape snapshot. */
export const X402_TAPE_PATH = "/api/x402/tape";

/** Product description advertised in the 402 payment requirements. */
export const X402_TAPE_DESCRIPTION = "MPGR / Base Stocks live tape snapshot";

/** MIME type of the paid resource. */
export const X402_TAPE_MIME_TYPE = "application/json";
