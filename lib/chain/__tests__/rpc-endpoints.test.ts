import { describe, expect, it } from "vitest";
import { browserRpcUrls, isUsableRpcUrl, parseEndpointList, uniqueRpcUrls } from "../rpc-endpoints";

describe("rpc endpoint lists", () => {
  it("splits commas and whitespace and drops blanks", () => {
    expect(parseEndpointList(" https://a.example ,https://b.example\nhttps://c.example ")).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
  });

  it("keeps https and local http, and rejects everything else", () => {
    expect(isUsableRpcUrl("https://mainnet.base.org")).toBe(true);
    expect(isUsableRpcUrl("http://127.0.0.1:8545")).toBe(true);
    expect(isUsableRpcUrl("http://evil.example")).toBe(false);
    expect(uniqueRpcUrls(["https://a.example", "https://a.example", "http://evil.example", "  "])).toEqual(["https://a.example"]);
  });

  it("puts the public browser URL first and always keeps a public fallback", () => {
    const urls = browserRpcUrls("https://mainnet.base.org");
    expect(urls[0]).toBe("https://mainnet.base.org");
    expect(urls).toContain("https://base.llamarpc.com");
    expect(new Set(urls).size).toBe(urls.length);
  });
});
