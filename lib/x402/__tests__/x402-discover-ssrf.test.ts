import { describe, expect, it } from "vitest";

import {
  assertPublicHttpsUrl,
  X402DiscoveryError,
} from "../x402-discover";

describe("assertPublicHttpsUrl", () => {
  it("accepts a public https URL", () => {
    const url = assertPublicHttpsUrl("https://api.example.com/paid");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.example.com");
  });

  it("rejects http and private hosts", () => {
    expect(() => assertPublicHttpsUrl("http://example.com/paid")).toThrow(
      X402DiscoveryError,
    );
    expect(() => assertPublicHttpsUrl("https://127.0.0.1/paid")).toThrow(
      X402DiscoveryError,
    );
    expect(() => assertPublicHttpsUrl("https://localhost/paid")).toThrow(
      X402DiscoveryError,
    );
    expect(() => assertPublicHttpsUrl("https://192.168.0.5/paid")).toThrow(
      X402DiscoveryError,
    );
    expect(() => assertPublicHttpsUrl("not-a-url")).toThrow(X402DiscoveryError);
  });
});
