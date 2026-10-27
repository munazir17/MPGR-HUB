import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, toHex, type Address, type Hex } from "viem";
import { VERIFIED_HISTORICAL_AGENT_TRADES } from "@/lib/agent/agent-volume-history";
import { BASE_MAINNET_USDC } from "@/lib/executor/executor-config";
import { HUB_VOLUME_CHECKPOINT } from "@/lib/agent/hub-volume-checkpoint";
import { PRICED_WETH_LEG_TRADES } from "@/lib/agent/hub-weth-legs";
import { anchorFromCursor, decodeEthUsdAnswer, foldPricedWethLegs, HUB_VOLUME_RPC, HUB_VOLUME_RPCS, hubVolumeSources, parseUsdPrice8, scanHubVolume, settleHubVolume, tokenAmountToUsdcAtomic, wethWeiToUsdcAtomic, type VolumeAnchor } from "./hub-volume";

const EVENT = parseAbiItem(
  "event SwapExecuted(address indexed taker,address indexed router,bytes32 indexed intentId,address tokenIn,address tokenOut,uint256 grossAmountIn,uint256 feeAmount,uint256 swapAmountIn,uint256 amountOut,address feeRecipient,uint16 feeBps,uint8 routerKind,uint8 flags)",
);
const TAKER = "0x1111111111111111111111111111111111111111" as Address;
const ROUTER = "0x2222222222222222222222222222222222222222" as Address;
const OTHER = "0x3333333333333333333333333333333333333333" as Address;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" as Address;
const INTENT = `0x${"ab".repeat(32)}` as Hex;
const SEEDS = VERIFIED_HISTORICAL_AGENT_TRADES.map((trade) => trade.txHash.toLowerCase());

function log(hash: string, tokenIn: Address, tokenOut: Address, gross: bigint, out: bigint) {
  const topics = encodeEventTopics({
    abi: [EVENT],
    eventName: "SwapExecuted",
    args: { taker: TAKER, router: ROUTER, intentId: INTENT },
  });
  const data = encodeAbiParameters(
    [
      { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint16" },
      { type: "uint8" }, { type: "uint8" },
    ],
    [tokenIn, tokenOut, gross, 0n, gross, out, TAKER, 25, 1, 0],
  );
  return { transactionHash: hash, topics, data };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function anchorAt(throughBlock: bigint, totalUsdcAtomic = 5_000_000n, tradeCount = 4): VolumeAnchor {
  return { throughBlock, totalUsdcAtomic, tradeCount, seedTxHashes: SEEDS };
}

afterEach(() => vi.unstubAllGlobals());

function dex(token: Address, priceUsd: string) {
  return json({ pairs: [{ chainId: "base", baseToken: { address: token }, priceUsd, liquidity: { usd: 1_000_000 } }] });
}

describe("scanHubVolume", () => {
  it("sums every executor, including a non-USDC token at its USD price", async () => {
    const sources = hubVolumeSources();
    expect(sources.map((source) => source.address.toLowerCase())).toEqual([
      "0xd982726e28275661f8ab64054e6b17a70a63505a",
      "0xbc4de809b4b72bce8f61c87dac6be12e3f7c6b3e",
      "0x4be1154440b26145d76608d41d403a33e76b9d0a",
    ]);
    const head = sources.reduce((max, source) => source.fromBlock > max ? source.fromBlock : max, 0n) + 10n;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("dexscreener.com")) return dex(CBBTC, "100");
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ address?: string; fromBlock?: string }] };
      if (body.method === "eth_blockNumber") return json({ result: toHex(head) });
      const address = body.params[0].address?.toLowerCase();
      const fromBlock = body.params[0].fromBlock;
      const source = sources.find((item) => item.address.toLowerCase() === address);
      if (!source || fromBlock !== toHex(source.fromBlock)) return json({ result: [] });
      if (address === sources[0].address.toLowerCase()) {
        return json({ result: [
          log("0x" + "11".repeat(32), BASE_MAINNET_USDC, OTHER, 2_000_000n, 1n),
          log("0x" + "22".repeat(32), CBBTC, OTHER, 50_000_000n, 1n),
        ] });
      }
      if (address === sources[1].address.toLowerCase()) {
        return json({ result: [log("0x" + "33".repeat(32), OTHER, BASE_MAINNET_USDC, 5n, 500_000n)] });
      }
      return json({ result: [] });
    });
    const volume = await scanHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch);
    expect(volume?.tradeCount).toBe(3 + 3);
    expect(volume?.totalValueTradedUsd).toBeCloseTo((2_000_000 + 500_000 + 50_000_000 + 2_000_000 + 1_000_000 + 267_304) / 1_000_000, 6);
    expect(fetchImpl.mock.calls.filter(([url]) => !String(url).includes("dexscreener.com")).every(([url]) => url === HUB_VOLUME_RPC)).toBe(true);
  });

  it("does not publish a total when the archive read fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => json({ error: { message: "rate limit" } }, 429));
    expect(await scanHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch)).toBeNull();
    expect(fetchImpl.mock.calls.every(([url]) => (HUB_VOLUME_RPCS as readonly string[]).includes(url))).toBe(true);
  });
});

describe("settleHubVolume", () => {
  it("adds only blocks after the anchor and does not count historical seeds twice", async () => {
    const sources = hubVolumeSources();
    const through = sources[sources.length - 1].fromBlock;
    const head = through + 10n;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ address?: string; fromBlock?: string }] };
      if (body.method === "eth_blockNumber") return json({ result: toHex(head) });
      const fromBlock = BigInt(body.params[0].fromBlock ?? "0x0");
      expect(fromBlock > through).toBe(true);
      if (body.params[0].address?.toLowerCase() === sources[0].address.toLowerCase()) {
        return json({ result: [
          log("0x" + "44".repeat(32), BASE_MAINNET_USDC, OTHER, 2_000_000n, 1n),
          log("0x" + "55".repeat(32), USDT, OTHER, 1_000_000n, 1n),
        ] });
      }
      return json({ result: [] });
    });
    const settled = await settleHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch, anchorAt(through));
    expect(settled?.done).toBe(true);
    if (!settled?.done) return;
    expect(settled.volume.tradeCount).toBe(6);
    expect(settled.volume.totalValueTradedUsd).toBeCloseTo(8, 6);
    expect(settled.anchor.throughBlock).toBe(head);
  });

  it("uses the second archive when the first is rate limited", async () => {
    const sources = hubVolumeSources();
    const through = sources[sources.length - 1].fromBlock;
    const head = through + 4n;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ address?: string }] };
      if (body.method === "eth_blockNumber") return json({ result: toHex(head) });
      if (url === HUB_VOLUME_RPC) return json({ error: { message: "rate limit" } }, 429);
      if (body.params[0].address?.toLowerCase() === sources[0].address.toLowerCase()) {
        return json({ result: [log("0x" + "66".repeat(32), OTHER, BASE_MAINNET_USDC, 1n, 250_000n)] });
      }
      return json({ result: [] });
    });
    const settled = await settleHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch, anchorAt(through, 1_000_000n, 1));
    expect(settled?.done).toBe(true);
    if (!settled?.done) return;
    expect(settled.volume.tradeCount).toBe(2);
    expect(settled.volume.totalValueTradedUsd).toBeCloseTo(1.25, 6);
    expect(fetchImpl.mock.calls.some(([url]) => url === HUB_VOLUME_RPCS[1])).toBe(true);
  });

  it("keeps a hole-free prefix but does not call it done when a later wave fails", async () => {
    const sources = hubVolumeSources();
    const through = sources[sources.length - 1].fromBlock;
    const head = through + 5_010n;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ fromBlock?: string }] };
      if (body.method === "eth_blockNumber") return json({ result: toHex(head) });
      const fromBlock = BigInt(body.params[0].fromBlock ?? "0x0");
      if (fromBlock > through + 5_000n) return json({ error: { message: "rate limit" } }, 429);
      return json({ result: [log("0x" + "77".repeat(32), BASE_MAINNET_USDC, OTHER, 100_000n, 1n)] });
    });
    const settled = await settleHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch, anchorAt(through, 0n, 0));
    expect(settled?.done).toBe(false);
    if (!settled || settled.done) return;
    expect(settled.anchor.throughBlock).toBe(through + 5_000n);
    expect(settled.anchor.totalUsdcAtomic).toBe(300_000n);
    expect(settled.anchor.tradeCount).toBe(3);
  });

  it("ignores a cursor behind the checkpoint or with a smaller total", () => {
    const checkpoint = anchorAt(100n, 5n, 2);
    expect(anchorFromCursor(checkpoint, null)).toBe(checkpoint);
    expect(anchorFromCursor(checkpoint, anchorAt(90n, 9n, 4)).throughBlock).toBe(100n);
    expect(anchorFromCursor(checkpoint, anchorAt(120n, 4n, 3)).throughBlock).toBe(100n);
    const ahead = anchorFromCursor(checkpoint, { ...anchorAt(120n, 8n, 3), seedTxHashes: [] });
    expect(ahead.throughBlock).toBe(120n);
    expect(ahead.totalUsdcAtomic).toBe(8n);
    expect(ahead.seedTxHashes).toEqual(expect.arrayContaining(SEEDS));
  });
});

describe("HUB_VOLUME_CHECKPOINT", () => {
  it("is a completed archive total at or after every executor deployment", () => {
    expect(HUB_VOLUME_CHECKPOINT.throughBlock).toBe(52_991_695n);
    expect(HUB_VOLUME_CHECKPOINT.totalUsdcAtomic).toBe(38_024_442n);
    expect(HUB_VOLUME_CHECKPOINT.tradeCount).toBe(32);
    expect(HUB_VOLUME_CHECKPOINT.wethLegTxHashes).toHaveLength(7);
    expect(HUB_VOLUME_CHECKPOINT.seedTxHashes.map((hash) => hash.toLowerCase())).toEqual(SEEDS);
    for (const source of hubVolumeSources()) {
      expect(HUB_VOLUME_CHECKPOINT.throughBlock >= source.fromBlock).toBe(true);
    }
  });

  it("includes each sealed WETH leg once", () => {
    const delta = PRICED_WETH_LEG_TRADES.reduce((sum, trade) => sum + trade.usdcAtomic, 0n);
    expect(23_428_317n + delta).toBe(HUB_VOLUME_CHECKPOINT.totalUsdcAtomic);
    expect(25 + PRICED_WETH_LEG_TRADES.length).toBe(HUB_VOLUME_CHECKPOINT.tradeCount);
    const folded = foldPricedWethLegs(anchorAt(10n, 1_000_000n, 2));
    expect(folded.totalUsdcAtomic).toBe(1_000_000n + delta);
    expect(folded.tradeCount).toBe(2 + PRICED_WETH_LEG_TRADES.length);
    expect(foldPricedWethLegs(folded)).toBe(folded);
    expect(wethWeiToUsdcAtomic(10n ** 18n, 2_000n * 10n ** 8n)).toBe(2_000_000_000n);
    const answer = (2_000n * 10n ** 8n).toString(16).padStart(64, "0");
    expect(decodeEthUsdAnswer(`0x${"0".repeat(64)}${answer}${"0".repeat(64 * 3)}`)).toBe(2_000n * 10n ** 8n);
  });
});

describe("WETH-leg pricing", () => {
  const WETH = "0x4200000000000000000000000000000000000006" as Address;

  it("adds a new WETH leg at the Chainlink price and skips a sealed hash", async () => {
    const sources = hubVolumeSources();
    const through = sources[sources.length - 1].fromBlock;
    const head = through + 4n;
    const hash = "0x" + "99".repeat(32);
    const price = (2_000n * 10n ** 8n).toString(16).padStart(64, "0");
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ address?: string }] };
      if (body.method === "eth_blockNumber") return json({ result: toHex(head) });
      if (body.method === "eth_call") return json({ result: `0x${"0".repeat(64)}${price}${"0".repeat(192)}` });
      if (body.params[0].address?.toLowerCase() === sources[1].address.toLowerCase()) {
        return json({ result: [log(hash, WETH, OTHER, 10n ** 18n, 1n)] });
      }
      return json({ result: [] });
    });
    const settled = await settleHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch, anchorAt(through, 1_000_000n, 1));
    expect(settled?.done).toBe(true);
    if (!settled?.done) return;
    expect(settled.volume.tradeCount).toBe(2);
    expect(settled.volume.totalValueTradedUsd).toBeCloseTo(2001, 6);

    const again = await settleHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch, {
      ...settled.anchor,
      throughBlock: through,
      wethLegTxHashes: [hash],
    });
    expect(again?.done).toBe(true);
    if (!again?.done) return;
    expect(again.volume.tradeCount).toBe(2);
    expect(again.volume.totalValueTradedUsd).toBeCloseTo(2001, 6);
  });
});

describe("any-token pricing", () => {
  it("converts a token amount at an 8-decimal USD price", () => {
    expect(parseUsdPrice8("100")).toBe(100n * 10n ** 8n);
    expect(parseUsdPrice8("2.5")).toBe(250_000_000n);
    expect(parseUsdPrice8("")).toBeNull();
    expect(parseUsdPrice8("-1")).toBeNull();
    expect(tokenAmountToUsdcAtomic(50_000_000n, 8, 100n * 10n ** 8n)).toBe(50_000_000n);
    expect(tokenAmountToUsdcAtomic(2n * 10n ** 8n, 8, 250_000_000n)).toBe(5_000_000n);
  });

  it("prices an unlisted token from decimals() and does not advance when the price is missing", async () => {
    const sources = hubVolumeSources();
    const through = sources[sources.length - 1].fromBlock;
    const head = through + 4n;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("dexscreener.com")) return dex(OTHER, "2.5");
      const body = JSON.parse(String(init?.body)) as { method: string; params: [{ address?: string; data?: string }] };
      if (body.method === "eth_blockNumber") return json({ result: toHex(head) });
      if (body.method === "eth_call") return json({ result: toHex(8n) });
      if (body.params[0].address?.toLowerCase() === sources[1].address.toLowerCase()) {
        return json({ result: [log("0x" + "ab".repeat(32), OTHER, CBBTC, 2n * 10n ** 8n, 1n)] });
      }
      return json({ result: [] });
    });
    const settled = await settleHubVolume(Date.now() + 5_000, fetchImpl as typeof fetch, anchorAt(through, 1_000_000n, 1));
    expect(settled?.done).toBe(true);
    if (!settled?.done) return;
    expect(settled.volume.tradeCount).toBe(2);
    expect(settled.volume.totalValueTradedUsd).toBeCloseTo(6, 6);

    const blocked = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("dexscreener.com")) return json({ pairs: [] }, 200);
      return fetchImpl(url, init);
    });
    expect(await settleHubVolume(Date.now() + 5_000, blocked as typeof fetch, anchorAt(through, 1_000_000n, 1))).toBeNull();
  });
});
