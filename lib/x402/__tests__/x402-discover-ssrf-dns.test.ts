// lib/x402/__tests__/x402-discover-ssrf-dns.test.ts
//
// Regression tests for the SSRF gate in lib/x402/x402-discover.ts.
//
// Two classes of bug are covered:
//
//   1. Literal hosts that were NOT blocked before ip-guard.ts, because
//      URL.hostname returns "[::1]" (with brackets) for an IPv6
//      literal, and because several IPv4 special-purpose ranges were
//      never checked.
//
//   2. A perfectly ordinary public hostname whose DNS answer points at
//      a private address. Nothing resolved DNS before, so this reached
//      internal infrastructure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

type X402DiscoveryErrorType =
  import("../x402-discover").X402DiscoveryError;

const {
  assertPublicHttpsUrl,
  resolveDiscoveryTarget,
  discoverX402Resource,
  X402DiscoveryError,
} = await import("../x402-discover");

function publicAnswer() {
  return [{ address: "93.184.215.14", family: 4 }];
}

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue(publicAnswer());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assertPublicHttpsUrl — literal hosts (synchronous gate)", () => {
  it("keeps accepting a public https URL (happy path unchanged)", () => {
    const url = assertPublicHttpsUrl("https://api.example.com/paid");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.example.com");
  });

  it("rejects non-https schemes", () => {
    for (const value of [
      "http://example.com/paid",
      "file:///etc/passwd",
      "gopher://example.com/",
      "not-a-url",
    ]) {
      expect(() => assertPublicHttpsUrl(value)).toThrow(X402DiscoveryError);
    }
  });

  const blockedLiterals: Array<[string, string]> = [
    // --- IPv6: none of these were blocked before, because
    //     URL.hostname returned them wrapped in brackets. ---
    ["IPv6 loopback", "https://[::1]/paid"],
    ["IPv6 unspecified", "https://[::]/paid"],
    ["IPv6 unique-local fd00::", "https://[fd00::1]/paid"],
    ["IPv6 unique-local fc00::", "https://[fc00::1]/paid"],
    ["IPv6 link-local fe80::", "https://[fe80::1]/paid"],
    ["IPv6 site-local fec0::", "https://[fec0::1]/paid"],
    ["IPv6 multicast", "https://[ff02::1]/paid"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/paid"],
    ["IPv4-mapped metadata", "https://[::ffff:169.254.169.254]/paid"],
    ["IPv4-mapped hextet loopback", "https://[::ffff:7f00:1]/paid"],
    ["6to4 wrapping loopback", "https://[2002:7f00:1::]/paid"],
    ["NAT64 wrapping loopback", "https://[64:ff9b::7f00:1]/paid"],
    ["documentation range", "https://[2001:db8::1]/paid"],

    // --- IPv4 ranges that were previously unblocked. ---
    ["0.0.0.0/8 this-host", "https://0.0.0.0/paid"],
    ["0.0.0.0/8 other", "https://0.1.2.3/paid"],
    ["100.64.0.0/10 CGNAT", "https://100.64.0.1/paid"],
    ["192.0.0.0/24 protocol assignments", "https://192.0.0.8/paid"],
    ["198.18.0.0/15 benchmarking", "https://198.18.0.1/paid"],
    ["multicast", "https://224.0.0.1/paid"],
    ["reserved 240/4", "https://240.0.0.1/paid"],
    ["broadcast", "https://255.255.255.255/paid"],

    // --- Ranges that were already blocked; must stay blocked. ---
    ["loopback", "https://127.0.0.1/paid"],
    ["RFC1918 10/8", "https://10.0.0.1/paid"],
    ["RFC1918 172.16/12", "https://172.16.0.1/paid"],
    ["RFC1918 192.168/16", "https://192.168.0.5/paid"],
    ["link-local metadata", "https://169.254.169.254/latest/meta-data/"],
    ["localhost", "https://localhost/paid"],
    ["*.localhost", "https://app.localhost/paid"],
    ["*.local", "https://printer.local/paid"],
    ["*.internal", "https://metadata.google.internal/paid"],
  ];

  for (const [label, url] of blockedLiterals) {
    it(`blocks ${label}`, () => {
      let thrown: unknown;
      try {
        assertPublicHttpsUrl(url);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(X402DiscoveryError);
      expect((thrown as X402DiscoveryErrorType).code).toBe("BLOCKED_HOST");
    });
  }
});

describe("resolveDiscoveryTarget — DNS-level SSRF", () => {
  it("rejects a public hostname that resolves to loopback", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(
      resolveDiscoveryTarget("https://evil.example.com/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("rejects a public hostname that resolves to cloud metadata", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    await expect(
      resolveDiscoveryTarget("https://metadata.evil.example/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("rejects a public hostname that resolves to an IPv6 ULA", async () => {
    mockLookup.mockResolvedValue([{ address: "fd00::1", family: 6 }]);

    await expect(
      resolveDiscoveryTarget("https://evil.example.com/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("rejects when ANY record is private, even if another is public", async () => {
    // Split-answer attack: one good record to pass a naive
    // "first address" check, one private record to actually hit.
    mockLookup.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);

    await expect(
      resolveDiscoveryTarget("https://split.example.com/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("rejects an empty DNS answer", async () => {
    mockLookup.mockResolvedValue([]);

    await expect(
      resolveDiscoveryTarget("https://nowhere.example.com/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("maps a DNS failure to a generic FETCH_FAILED, not BLOCKED_HOST", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(
      resolveDiscoveryTarget("https://down.example.com/paid"),
    ).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });

  it("accepts a public hostname and pins its first address", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    const target = await resolveDiscoveryTarget("https://api.example.com/paid");

    expect(target.hostname).toBe("api.example.com");
    expect(target.pinnedAddress).toBe("93.184.215.14");
    expect(target.pinnedFamily).toBe(4);
  });

  it("does not resolve DNS for an IP literal — it pins the literal", async () => {
    const target = await resolveDiscoveryTarget("https://93.184.215.14/paid");

    expect(mockLookup).not.toHaveBeenCalled();
    expect(target.pinnedAddress).toBe("93.184.215.14");
  });
});

describe("discoverX402Resource — redirects are re-validated and re-resolved", () => {
  function redirectThenJson(location: string) {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location },
        });
      }
      return new Response(JSON.stringify({ x402Version: 1, accepts: [] }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("blocks a redirect to an IPv6 loopback literal", async () => {
    vi.stubGlobal("fetch", redirectThenJson("https://[::1]/internal"));

    await expect(
      discoverX402Resource("https://api.example.com/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("blocks a redirect to cloud metadata", async () => {
    vi.stubGlobal(
      "fetch",
      redirectThenJson("https://169.254.169.254/latest/meta-data/"),
    );

    await expect(
      discoverX402Resource("https://api.example.com/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("blocks a redirect to a public name that resolves privately", async () => {
    mockLookup.mockImplementation(async (hostname: string) =>
      hostname === "internal.example.com"
        ? [{ address: "10.0.0.7", family: 4 }]
        : publicAnswer(),
    );

    vi.stubGlobal(
      "fetch",
      redirectThenJson("https://internal.example.com/secret"),
    );

    await expect(
      discoverX402Resource("https://api.example.com/paid"),
    ).rejects.toMatchObject({ code: "BLOCKED_HOST" });
  });

  it("still follows a redirect to another public host (happy path)", async () => {
    const fetchMock = redirectThenJson("https://cdn.example.com/paid");
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverX402Resource("https://api.example.com/paid");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(402);
    expect(result.finalUrl).toBe("https://cdn.example.com/paid");
  });

  it("returns a 402 body from a plain public host (happy path unchanged)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ x402Version: 1, accepts: [] }), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await discoverX402Resource("https://api.example.com/paid");

    expect(result.status).toBe(402);
    expect(result.body).toEqual({ x402Version: 1, accepts: [] });
    expect(result.finalUrl).toBe("https://api.example.com/paid");
  });
});
