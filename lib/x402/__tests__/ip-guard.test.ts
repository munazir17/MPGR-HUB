// lib/x402/__tests__/ip-guard.test.ts
//
// Range-by-range coverage for the SSRF address classifier.
//
// These are regression tests for a real gap: before ip-guard.ts,
// `new URL("https://[::1]/").hostname` returned "[::1]" (brackets
// included), so every IPv6 check in x402-discover.ts silently never
// matched, and several IPv4 special-purpose ranges were not checked at
// all.

import { describe, expect, it } from "vitest";

import {
  isBlockedHostnameLiteral,
  isPublicIpAddress,
  normalizeHostname,
  parseIpLiteral,
} from "../ip-guard";

describe("normalizeHostname", () => {
  it("strips the brackets URL.hostname keeps on an IPv6 literal", () => {
    expect(new URL("https://[::1]/x").hostname).toBe("[::1]");
    expect(normalizeHostname(new URL("https://[::1]/x").hostname)).toBe("::1");
    expect(normalizeHostname("[FD00::1]")).toBe("fd00::1");
  });

  it("leaves a normal hostname alone (lowercased)", () => {
    expect(normalizeHostname("API.Example.COM")).toBe("api.example.com");
  });
});

describe("parseIpLiteral", () => {
  it("parses IPv4 and IPv6 into fixed-width byte arrays", () => {
    expect(parseIpLiteral("1.2.3.4")).toEqual({
      version: 4,
      bytes: [1, 2, 3, 4],
    });
    expect(parseIpLiteral("::1")?.bytes).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseIpLiteral("::ffff:127.0.0.1")?.bytes).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
    ]);
    expect(parseIpLiteral("2001:db8::1")?.bytes.slice(0, 4)).toEqual([
      0x20, 0x01, 0x0d, 0xb8,
    ]);
  });

  it("returns null for a DNS name and for malformed literals", () => {
    expect(parseIpLiteral("api.example.com")).toBeNull();
    expect(parseIpLiteral("1.2.3")).toBeNull();
    expect(parseIpLiteral("1.2.3.4.5")).toBeNull();
    expect(parseIpLiteral("256.1.1.1")).toBeNull();
    expect(parseIpLiteral("1::2::3")).toBeNull();
    expect(parseIpLiteral("")).toBeNull();
  });

  it("rejects octal and hex IPv4 forms rather than mis-parsing them", () => {
    // 0177.0.0.1 is 127.0.0.1 to a resolver that accepts octal, and
    // 0x7f.0.0.1 is the hex equivalent. We refuse to parse either, and
    // deny-by-default means they are not public.
    expect(parseIpLiteral("0177.0.0.1")).toBeNull();
    expect(parseIpLiteral("0x7f.0.0.1")).toBeNull();
    expect(isPublicIpAddress("0177.0.0.1")).toBe(false);
    expect(isPublicIpAddress("0x7f.0.0.1")).toBe(false);
    expect(isPublicIpAddress("2130706433")).toBe(false);
  });
});

describe("isPublicIpAddress — IPv4 blocked ranges", () => {
  const blocked: Array<[string, string]> = [
    ["0.0.0.0/8 this-host (routed to loopback on Linux)", "0.0.0.0"],
    ["0.0.0.0/8 upper", "0.255.255.255"],
    ["10.0.0.0/8 private", "10.0.0.1"],
    ["100.64.0.0/10 CGNAT lower", "100.64.0.0"],
    ["100.64.0.0/10 CGNAT upper", "100.127.255.255"],
    ["127.0.0.0/8 loopback", "127.0.0.1"],
    ["127.0.0.0/8 loopback alt", "127.1.2.3"],
    ["169.254.0.0/16 link-local / cloud metadata", "169.254.169.254"],
    ["172.16.0.0/12 private lower", "172.16.0.1"],
    ["172.16.0.0/12 private upper", "172.31.255.255"],
    ["192.0.0.0/24 IETF protocol assignments", "192.0.0.8"],
    ["192.0.2.0/24 TEST-NET-1", "192.0.2.5"],
    ["192.31.196.0/24 AS112-v4", "192.31.196.1"],
    ["192.52.193.0/24 AMT", "192.52.193.1"],
    ["192.88.99.0/24 6to4 relay anycast", "192.88.99.1"],
    ["192.168.0.0/16 private", "192.168.0.5"],
    ["192.175.48.0/24 AS112 direct delegation", "192.175.48.1"],
    ["198.18.0.0/15 benchmarking lower", "198.18.0.1"],
    ["198.18.0.0/15 benchmarking upper", "198.19.255.255"],
    ["198.51.100.0/24 TEST-NET-2", "198.51.100.7"],
    ["203.0.113.0/24 TEST-NET-3", "203.0.113.7"],
    ["224.0.0.0/4 multicast", "224.0.0.1"],
    ["224.0.0.0/4 multicast upper", "239.255.255.255"],
    ["240.0.0.0/4 reserved", "240.0.0.1"],
    ["255.255.255.255 broadcast", "255.255.255.255"],
  ];

  for (const [label, ip] of blocked) {
    it(`blocks ${label} (${ip})`, () => {
      expect(isPublicIpAddress(ip)).toBe(false);
    });
  }

  it("still allows genuinely public IPv4 addresses", () => {
    for (const ip of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.215.14",
      "100.128.0.1", // just above CGNAT
      "198.20.0.1", // just above benchmarking
      "223.255.255.255", // just below multicast
    ]) {
      expect(isPublicIpAddress(ip)).toBe(true);
    }
  });
});

describe("isPublicIpAddress — IPv6 blocked ranges", () => {
  const blocked: Array<[string, string]> = [
    [":: unspecified", "::"],
    ["::1 loopback", "::1"],
    ["::1 in bracket form as URL.hostname yields it", "[::1]"],
    ["fc00::/7 unique local (fc)", "fc00::1"],
    ["fc00::/7 unique local (fd)", "fd00::1"],
    ["fd00::/8 typical ULA", "fd12:3456:789a::1"],
    ["fe80::/10 link-local", "fe80::1"],
    ["fe80::/10 link-local upper", "febf:ffff::1"],
    ["fe80::/10 link-local with zone", "fe80::1%eth0"],
    ["fec0::/10 deprecated site-local", "fec0::1"],
    ["ff00::/8 multicast", "ff02::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["IPv4-mapped loopback, hextet form", "::ffff:7f00:1"],
    ["IPv4-compatible loopback (deprecated)", "::127.0.0.1"],
    ["NAT64 64:ff9b::/96 to loopback", "64:ff9b::7f00:1"],
    ["100::/64 discard-only", "100::1"],
    ["2001:db8::/32 documentation", "2001:db8::1"],
    ["2001::/23 IETF protocol assignments (Teredo)", "2001:0:1::1"],
    ["6to4 wrapping loopback", "2002:7f00:1::"],
    ["6to4 wrapping private", "2002:c0a8:1::"],
  ];

  for (const [label, ip] of blocked) {
    it(`blocks ${label} (${ip})`, () => {
      expect(isPublicIpAddress(ip)).toBe(false);
    });
  }

  it("still allows genuinely public IPv6 addresses", () => {
    for (const ip of [
      "2606:4700:4700::1111", // Cloudflare
      "2001:4860:4860::8888", // Google
      "2a00:1450:4001:80e::200e",
      "::ffff:8.8.8.8", // IPv4-mapped but public
      "2002:0808:0808::", // 6to4 wrapping 8.8.8.8
    ]) {
      expect(isPublicIpAddress(ip)).toBe(true);
    }
  });
});

describe("isBlockedHostnameLiteral", () => {
  it("blocks loopback-ish and internal suffixes", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "printer.local",
      "db.internal",
      "box.localdomain",
      "metadata.google.internal",
      "",
    ]) {
      expect(isBlockedHostnameLiteral(host)).toBe(true);
    }
  });

  it("blocks every non-public IP literal, in bracket form too", () => {
    for (const host of ["127.0.0.1", "[::1]", "[fd00::1]", "169.254.169.254"]) {
      expect(isBlockedHostnameLiteral(host)).toBe(true);
    }
  });

  it("allows an ordinary public hostname", () => {
    expect(isBlockedHostnameLiteral("api.example.com")).toBe(false);
    expect(isBlockedHostnameLiteral("mpgrhub.xyz")).toBe(false);
  });
});
