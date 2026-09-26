import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { resolveSwapToken } from "../trade-token-resolution";
import { hydrateTradeSwapArguments, parseTradeSwapRequest } from "../trade-request";
import { discoverBaseTokens, resetTokenDiscoveryCache } from "../trade-token-discovery";
import { resolveTradeToken } from "../trade-tokens";

const rpc = vi.hoisted(() => ({ getCode: vi.fn(), readContract: vi.fn() }));
vi.mock("../trade-public-client", () => ({ getTradePublicClient: () => rpc }));
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const SECOND = "0x2222222222222222222222222222222222222222";
const TAKER = "0x3333333333333333333333333333333333333333";
const fetchMock = vi.fn();
function list(tokens: unknown[]) { fetchMock.mockResolvedValue(new Response(JSON.stringify({ tokens }))); }
function token(address = ADDRESS, chainId = 8453) { return { address, chainId, symbol: "DEGEN", name: "Degen", decimals: 18 }; }

beforeEach(() => {
  vi.clearAllMocks(); resetTokenDiscoveryCache(); vi.stubGlobal("fetch", fetchMock);
  rpc.getCode.mockResolvedValue("0x6000");
  rpc.readContract.mockImplementation(async ({ functionName }) => ({ decimals: 6, symbol: "DEGEN", name: "Degen", totalSupply: 100000000n, balanceOf: 0n })[functionName as "decimals"]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("direct Base contract validation", () => {
  it("accepts a valid non-catalog mixed-case address, checks code and reads real metadata", async () => {
    const result = await resolveSwapToken(ADDRESS.toUpperCase().replace("0X", "0x"));
    expect(result).toEqual({ ok: true, token: { address: getAddress(ADDRESS), symbol: "DEGEN", name: "Degen", decimals: 6, kind: "erc20", verified: false } });
    expect(rpc.getCode).toHaveBeenCalledWith({ address: getAddress(ADDRESS) });
    expect(rpc.readContract.mock.calls.map(([arg]) => arg.functionName)).toEqual(expect.arrayContaining(["decimals", "symbol", "name", "totalSupply", "balanceOf"]));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["0x4ed4E862860beD51a9570b96d89aF5E1B0Efeed", "0x123", `0x${"g".repeat(40)}`, `0x${"a".repeat(41)}`])("rejects malformed address without RPC or guessing a replacement: %s", async address => {
    expect(await resolveSwapToken(address)).toMatchObject({ ok: false, error: { code: "INVALID_ADDRESS" } });
    expect(rpc.getCode).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([undefined, "0x"])("distinguishes EOA/no contract: %s", async code => {
    rpc.getCode.mockResolvedValue(code);
    expect(await resolveSwapToken(ADDRESS)).toMatchObject({ ok: false, error: { code: "TOKEN_NOT_CONTRACT" } });
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it("distinguishes a deployed non-ERC20 from a wallet", async () => {
    rpc.readContract.mockRejectedValue(Object.assign(new Error("RPC internals must never appear"), { name: "ContractFunctionRevertedError" }));
    expect(await resolveSwapToken(ADDRESS)).toMatchObject({ ok: false, error: { code: "TOKEN_NOT_ERC20" } });
  });
  it("does not mistake an RPC outage for a non-token contract", async () => {
    rpc.readContract.mockRejectedValue(new Error("https://rpc.test?key=secret"));
    const result = await resolveSwapToken(ADDRESS);
    expect(result).toMatchObject({ ok: false, error: { code: "PROVIDER_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("does not fabricate decimals or render hostile metadata", async () => {
    rpc.readContract.mockImplementation(async ({ functionName }) => functionName === "symbol" ? '{"apiKey":"secret"}' : functionName === "decimals" ? 6 : 0n);
    expect(await resolveSwapToken(ADDRESS)).toMatchObject({ ok: false, error: { code: "TOKEN_METADATA_UNAVAILABLE" } });
  });
  it("uses symbol as the display label if optional name() is unavailable", async () => {
    const original = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(arg => arg.functionName === "name" ? Promise.reject(new Error("optional")) : original(arg));
    expect(await resolveSwapToken(ADDRESS)).toMatchObject({ ok: true, token: { name: "DEGEN", decimals: 6 } });
  });
  it("deduplicates concurrent metadata reads but does not cache between trades", async () => {
    await Promise.all([resolveSwapToken(ADDRESS), resolveSwapToken(ADDRESS)]);
    expect(rpc.getCode).toHaveBeenCalledTimes(1);
    await resolveSwapToken(ADDRESS);
    expect(rpc.getCode).toHaveBeenCalledTimes(2);
  });
});

describe("Uniswap Base discovery is separate from verification/liquidity", () => {
  it.each(["DEGEN", "Degen"])("resolves a unique name/symbol through RPC, never trusts list decimals: %s", async query => {
    list([token()]);
    expect(await resolveSwapToken(query)).toMatchObject({ ok: true, token: { address: getAddress(ADDRESS), decimals: 6, verified: false } });
    expect(fetchMock).toHaveBeenCalledWith("https://tokens.uniswap.org", expect.objectContaining({ redirect: "error" }));
  });
  it("does not guess when multiple Base contracts match", async () => {
    list([token(), token(SECOND)]);
    const result = await resolveSwapToken("DEGEN");
    expect(result).toMatchObject({ ok: false, error: { code: "TOKEN_AMBIGUOUS" } });
    if (!result.ok) { expect(result.error.message).toContain(getAddress(ADDRESS)); expect(result.error.message).toContain(SECOND); }
    expect(rpc.getCode).not.toHaveBeenCalled();
  });
  it("ignores other chains and deduplicates identical contract entries", async () => {
    list([token(), token(), token(SECOND, 1)]);
    expect(await discoverBaseTokens("degen")).toHaveLength(1);
  });
  it("absent listing is not an invalid address or a no-liquidity claim", async () => {
    list([]);
    expect(await resolveSwapToken("DEGEN")).toMatchObject({ ok: false, error: { code: "TOKEN_NOT_FOUND" } });
  });
  it("fails discovery cleanly and leaves exact-contract lookup available", async () => {
    fetchMock.mockRejectedValue(new Error("Bearer secret"));
    const result = await resolveSwapToken("DEGEN");
    expect(result).toMatchObject({ ok: false, error: { code: "PROVIDER_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect((await resolveSwapToken(ADDRESS)).ok).toBe(true);
  });
  it("bounds the list and never follows user-controlled URLs", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(2_000_001)));
    await expect(discoverBaseTokens("DEGEN")).rejects.toThrow("limit");
    expect(fetchMock.mock.calls[0][0]).toBe("https://tokens.uniswap.org");
  });
  it("shares a list fetch, expires it, and does not reuse failed fetches", async () => {
    vi.useFakeTimers(); list([token()]);
    await Promise.all([discoverBaseTokens("DEGEN"), discoverBaseTokens("Degen")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_001); list([token()]);
    await discoverBaseTokens("DEGEN"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("normalization and amount units", () => {
  it("keeps full contract addresses through repeated tool hydration and reaches quote inputs", async () => {
    const once = hydrateTradeSwapArguments({ fromToken: "USDC", toToken: ADDRESS, amount: "0.08" }, TAKER);
    const twice = hydrateTradeSwapArguments(once, TAKER);
    expect(twice).toEqual(once);
    expect(twice.toToken).toBe(getAddress(ADDRESS));
    expect(await parseTradeSwapRequest(twice)).toMatchObject({ ok: true, value: { fromAmount: "80000", to: { symbol: "DEGEN", decimals: 6 } } });
  });
  it("never reinterprets 80000 atomic USDC as 80000 human USDC", async () => {
    let args = { fromToken: "USDC", toToken: "MPGR", amount: "0.08" } as Record<string, unknown>;
    for (let i = 0; i < 4; i++) args = hydrateTradeSwapArguments(args, TAKER);
    expect(args.fromAmount).toBe("80000");
    expect(await parseTradeSwapRequest(args)).toMatchObject({ ok: true, value: { fromAmount: "80000" } });
    expect(await parseTradeSwapRequest({ ...args, amount: undefined, fromAmount: "1" })).toMatchObject({ ok: true, value: { fromAmount: "1" } });
  });
  it("retains explicit address identity even for a known token", () => {
    const token = resolveTradeToken("USDC"); if (!token.ok) throw Error("fixture");
    expect(hydrateTradeSwapArguments({ fromToken: token.token.address, toToken: "WETH", amount: "1" }, TAKER).fromToken).toBe(token.token.address);
  });
});
