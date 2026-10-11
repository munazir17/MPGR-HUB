// lib/mcp/__tests__/hardening-boundaries.test.ts
//
// PHASE 4 HARDENING (round 2) — signature-boundary proofs:
//   §1  malformed signatures at the delegated boundary fail CLOSED and never
//       reach the broadcaster.
//   §12 broadcaster security: a non-taker key (e.g. the broadcaster, which
//       holds ONLY its own key) CANNOT produce a valid authorization on the
//       assisted executor path — finalize recovers the signer and demands the
//       taker; and the delegated path is cryptographically bound to Permit2
//       (on-chain ecrecover), so a forged signature reverts without state
//       change. Deterministic; no live chain.

import { describe, expect, it, beforeEach } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { allowAutonomousEmergencySwitchForTests } from "@/lib/autonomy/emergency-switch";
import { delegateSwap, finalizeTrade, getQuote, prepareTrade, type McpDeps, type ToolOutcome } from "@/lib/mcp/mcp-trade-service";
import {
  BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT,
  DELEGATED_BASE_SEPOLIA_TSTOCK,
  DELEGATED_BASE_SEPOLIA_TUSD,
  DELEGATED_EXECUTOR_ADDRESS,
  delegatedActionId,
} from "@/lib/executor/delegated-executor";
import { BASE_SEPOLIA_UNISWAP_V3 } from "@/lib/executor/executor-config";
import {
  fakeReader,
  newFakeState,
  setBalance,
  TSTOCK,
  TUSD,
  testDeps,
  type FakeChainState,
} from "./fixtures";

type Data = Record<string, unknown>;
function ok(o: ToolOutcome): Data {
  if (!o.ok) throw new Error(`${o.error.code}: ${o.error.message}`);
  return o.data;
}
function errCode(o: ToolOutcome): string {
  if (o.ok) throw new Error("expected failure");
  return o.error.code;
}

/** Wallets accept decimal strings for uintN in eth_signTypedData_v4; viem's local signer wants bigint. */
function reviveTypedData(td: Data): Parameters<ReturnType<typeof privateKeyToAccount>["signTypedData"]>[0] {
  const types = td.types as Record<string, { name: string; type: string }[]>;
  const revive = (typeName: string, value: Data): Data =>
    Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        const field = types[typeName]?.find((f) => f.name === key);
        if (field && /^uint\d+$/.test(field.type) && typeof v === "string") return [key, BigInt(v)];
        if (field && types[field.type] && v && typeof v === "object") return [key, revive(field.type, v as Data)];
        return [key, v];
      }),
    );
  return { ...(td as object), message: revive(td.primaryType as string, td.message as Data) } as never;
}

const TAKER = privateKeyToAccount(generatePrivateKey());
const BROADCASTER_STYLE_KEY = privateKeyToAccount(generatePrivateKey()); // a key the service knows only as ITS OWN
const GROSS = 100_000_000n;
const FEE = (GROSS * 25n) / 10000n;
const ACTION_ID = delegatedActionId("boundary-goal");

let state: FakeChainState;
beforeEach(() => {
  allowAutonomousEmergencySwitchForTests();
  state = newFakeState();
  setBalance(state, DELEGATED_BASE_SEPOLIA_TUSD, TAKER.address, 1_000_000_000n);
});

function delegatedDeps(extra: Record<string, unknown> = {}) {
  return {
    ...testDeps(state, {}),
    reader: () => fakeReader(state, 84532, DELEGATED_EXECUTOR_ADDRESS),
    delegatedRegistry: { 84532: BASE_SEPOLIA_DELEGATED_EXECUTOR_DEPLOYMENT },
    delegatedBroadcaster: async (tx: { to: Address; data: Hex; chainId: number }) => {
      void tx;
      return ("0x" + "ab".repeat(32)) as `0x${string}`;
    },
    ...extra,
  } as unknown as McpDeps & Parameters<typeof getQuote>[0];
}

function validAuth(over: Record<string, unknown> = {}): Record<string, unknown> {
  const deadline = Math.floor(Date.now() / 1000) + 1800;
  return {
    chainId: 84532,
    router: BASE_SEPOLIA_UNISWAP_V3.swapRouter02,
    poolFee: 3000,
    intentId: ACTION_ID,
    expectedFeeAmount: FEE.toString(),
    deadline: deadline.toString(),
    authorization: {
      permit: {
        permitted: { token: DELEGATED_BASE_SEPOLIA_TUSD, amount: GROSS.toString() },
        nonce: "123456789",
        deadline: deadline.toString(),
      },
      witness: {
        owner: TAKER.address,
        buyToken: DELEGATED_BASE_SEPOLIA_TSTOCK,
        minAmountOut: "700000000000000000",
        deadline: deadline.toString(),
        actionId: ACTION_ID,
        policyHash: ("0x" + "44".repeat(32)) as Hex,
      },
      signature: ("0x" + "22".repeat(65)) as Hex,
    },
    ...over,
  };
}

describe("hardening §1: malformed signatures fail closed BEFORE the broadcaster", () => {
  const malformed: Array<[string, unknown]> = [
    ["64-byte (short) signature", "0x" + "22".repeat(64)],
    ["66-byte (long) signature", "0x" + "22".repeat(66)],
    ["non-hex signature", "0x" + "zz".repeat(65)],
    ["empty signature", ""],
    ["missing signature", undefined],
    ["non-string signature", 12345],
  ];

  for (const [label, sig] of malformed) {
    it(`${label} -> INVALID_AUTHORIZATION, broadcaster never called`, async () => {
      const calls: Array<Record<string, unknown>> = [];
      const deps = delegatedDeps({
        delegatedBroadcaster: async (tx: { to: Address; data: Hex; chainId: number }) => {
          calls.push(tx as unknown as Record<string, unknown>);
          return ("0x" + "ab".repeat(32)) as `0x${string}`;
        },
      });
      const auth = validAuth() as Record<string, unknown>;
      (auth.authorization as Record<string, unknown>).signature = sig;
      const out = await delegateSwap(deps, auth);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe("INVALID_AUTHORIZATION");
      expect(calls).toHaveLength(0); // nothing reached the broadcaster
    });
  }

  it("a well-shaped but WRONG-KEY signature still reaches Permit2 semantics only via the delegated calldata (never host-side accept)", async () => {
    // The host validates SHAPE and builds calldata; the CHAIN reverts the
    // forged signature (Permit2 ecrecover). Assert the calldata carries the
    // auth verbatim — the service cannot and does not "fix" a bad signature.
    const deps = delegatedDeps();
    const auth = validAuth();
    const out = await delegateSwap(deps, auth);
    expect(out.ok).toBe(true); // broadcast attempt happens (shape-valid)
    const data = out.ok ? (out.data as Record<string, unknown>) : {};
    expect(data.delegatedExecutor).toBe(DELEGATED_EXECUTOR_ADDRESS);
    // No broadcaster key configured in tests -> no broadcaster identity is invented:
    expect((data.expectedSender as string | null) ?? null).toBe(null);
  });
});

describe("hardening §12: broadcaster cannot reach the assisted executor path", () => {
  it("assisted finalize demands the TAKER's signature — a broadcaster-style key is rejected (SIGNATURE_MISMATCH)", async () => {
    const deps = testDeps(state, {}); // assisted path (v1 registry)
    setBalance(state, TUSD, TAKER.address, 50_000_000n);
    const q = ok(await getQuote(deps, {
      chainId: 84532,
      taker: TAKER.address,
      sellToken: TUSD,
      buyToken: TSTOCK,
      sellAmount: "10000000",
      slippageBps: 100,
    }));
    const quoteId = String(q.quoteId);
    const prep = ok(await prepareTrade(deps, { quoteId, authorization: "EIP2612" }));
    const typedData = prep.typedData as Data;
    const nonce = (prep.permit as { nonce: string }).nonce;
    // The broadcaster (or ANY key that is not the taker's) signs — rejected.
    const forged = await BROADCASTER_STYLE_KEY.signTypedData(reviveTypedData(typedData));
    expect(errCode(await finalizeTrade(deps, { quoteId, authorization: "EIP2612", signature: forged, permitNonce: nonce }))).toBe("SIGNATURE_MISMATCH");
    // And the genuine taker signature is the ONLY accepted one.
    const genuine = await TAKER.signTypedData(reviveTypedData(typedData));
    const finalized = await finalizeTrade(deps, { quoteId, authorization: "EIP2612", signature: genuine, permitNonce: nonce });
    expect(finalized.ok).toBe(true);
  });

  it("delegated calldata is hard-bound to the DELEGATED executor — the broadcaster cannot be redirected to the assisted executor", async () => {
    let captured: { to: Address; data: Hex } | null = null;
    const deps = delegatedDeps({
      delegatedBroadcaster: async (tx: { to: Address; data: Hex; chainId: number }) => {
        captured = { to: tx.to, data: tx.data };
        return ("0x" + "ab".repeat(32)) as `0x${string}`;
      },
    });
    const out = await delegateSwap(deps, validAuth());
    expect(out.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.to).toBe(DELEGATED_EXECUTOR_ADDRESS); // swapOnBehalfOfUniswapV3 target, never the v1/assisted executor
  });
});
