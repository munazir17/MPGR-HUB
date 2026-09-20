// lib/x402/ip-guard.ts
//
// SSRF address classification shared by every server-side outbound
// fetch gate (today: lib/x402/x402-discover.ts).
//
// Why this exists as its own module:
//
//   `new URL("https://[::1]/").hostname` returns "[::1]" — WITH the
//   brackets. Any check that compares the hostname against "::1" or
//   uses startsWith("fc") therefore never matched an IPv6 literal, so
//   loopback (::1), unique-local (fd00::), link-local (fe80::) and
//   IPv4-mapped (::ffff:127.0.0.1) targets were all reachable.
//
//   The previous IPv4 check also only covered RFC1918 + loopback +
//   link-local, leaving 0.0.0.0/8 ("this host", routed to 127.0.0.1 by
//   Linux), 100.64.0.0/10 (CGNAT), 192.0.0.0/24 (IETF protocol
//   assignments), 198.18.0.0/15 (benchmarking) and 224.0.0.0/4
//   (multicast) reachable.
//
// Everything here is pure and synchronous: it classifies an ADDRESS,
// not a hostname. DNS resolution and the "every resolved A/AAAA must
// be public" rule live in x402-discover.ts, which calls into this.
//
// Policy is deny-by-default: an address we cannot parse is treated as
// non-public.

export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  /** 4 bytes for IPv4, 16 bytes for IPv6. */
  bytes: number[];
}

/**
 * Strips the RFC 3986 brackets URL.hostname keeps around an IPv6
 * literal and lowercases the result. Safe to call on any hostname.
 */
export function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    // Reject empty, non-decimal, and leading-zero forms: "0177.0.0.1"
    // is octal 127.0.0.1 to many resolvers, and "0x7f.0.0.1" is hex.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }

  return octets;
}

function parseIpv6(value: string): number[] | null {
  let text = value;

  // Zone index (fe80::1%eth0) is not part of the address.
  const zoneIndex = text.indexOf("%");
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);

  if (text.length === 0) return null;

  // A trailing dotted-quad (::ffff:127.0.0.1) supplies the final four
  // bytes directly; the hextet part before it must then be 6 hextets.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const afterLastColon = lastColon === -1 ? "" : text.slice(lastColon + 1);
  if (afterLastColon.includes(".")) {
    const embedded = parseIpv4(afterLastColon);
    if (!embedded) return null;
    tail = embedded;
    const withColon = text.slice(0, lastColon + 1);
    // Keep a trailing "::" intact (as in "::1.2.3.4"); otherwise drop
    // the separator that preceded the dotted quad.
    text = withColon.endsWith("::") ? withColon : withColon.slice(0, -1);
  }

  const doubleColonCount = text.split("::").length - 1;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let rest: string[];

  if (doubleColonCount === 1) {
    const [left, right] = text.split("::");
    head = left.length > 0 ? left.split(":") : [];
    rest = right.length > 0 ? right.split(":") : [];
  } else {
    head = text.split(":");
    rest = [];
  }

  const hextets = [...head, ...rest];
  for (const hextet of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
  }

  // A trailing dotted-quad already accounts for the last 2 hextets.
  const expected = 8 - (tail.length > 0 ? 2 : 0);
  if (doubleColonCount === 1) {
    if (hextets.length > expected) return null;
  } else if (hextets.length !== expected) {
    return null;
  }

  const fill = expected - hextets.length;
  const full: string[] = [
    ...head,
    ...Array.from({ length: fill }, () => "0"),
    ...rest,
  ];

  const bytes: number[] = [];
  for (const hextet of full) {
    const word = Number.parseInt(hextet, 16);
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  bytes.push(...tail);

  return bytes.length === 16 ? bytes : null;
}

/**
 * Parses a bare IP literal (no brackets, no port). Returns null when
 * `value` is not an IP literal at all — e.g. a DNS name.
 */
export function parseIpLiteral(value: string): ParsedIp | null {
  const host = normalizeHostname(value);
  if (host.length === 0) return null;

  if (host.includes(":")) {
    const bytes = parseIpv6(host);
    return bytes ? { version: 6, bytes } : null;
  }

  const bytes = parseIpv4(host);
  return bytes ? { version: 4, bytes } : null;
}

/**
 * True when the IPv4 address is outside every special-purpose range in
 * the IANA IPv4 Special-Purpose Address Registry that an SSRF probe
 * could use to reach infrastructure (plus multicast and reserved).
 */
function isPublicIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;

  // 0.0.0.0/8 — "this host on this network". Linux routes 0.0.0.0 to
  // the loopback interface, so this IS an SSRF vector.
  if (a === 0) return false;
  // 10.0.0.0/8 — private.
  if (a === 10) return false;
  // 100.64.0.0/10 — carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return false;
  // 169.254.0.0/16 — link-local, incl. the 169.254.169.254 cloud
  // instance-metadata endpoint.
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12 — private.
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24 — IETF protocol assignments.
  if (a === 192 && b === 0 && c === 0) return false;
  // 192.0.2.0/24 — TEST-NET-1.
  if (a === 192 && b === 0 && c === 2) return false;
  // 192.31.196.0/24 — AS112-v4.
  if (a === 192 && b === 31 && c === 196) return false;
  // 192.52.193.0/24 — AMT.
  if (a === 192 && b === 52 && c === 193) return false;
  // 192.88.99.0/24 — deprecated 6to4 relay anycast.
  if (a === 192 && b === 88 && c === 99) return false;
  // 192.168.0.0/16 — private.
  if (a === 192 && b === 168) return false;
  // 192.175.48.0/24 — direct delegation AS112.
  if (a === 192 && b === 175 && c === 48) return false;
  // 198.18.0.0/15 — benchmarking.
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 198.51.100.0/24 — TEST-NET-2.
  if (a === 198 && b === 51 && c === 100) return false;
  // 203.0.113.0/24 — TEST-NET-3.
  if (a === 203 && b === 0 && c === 113) return false;
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved (incl. 255.255.255.255).
  if (a >= 224) return false;

  return true;
}

function isPublicIpv6(bytes: number[]): boolean {
  const [b0, b1] = bytes;

  const allZeroFirst10 = bytes.slice(0, 10).every((byte) => byte === 0);

  // ::  (unspecified) and ::1 (loopback), plus the deprecated
  // IPv4-compatible ::a.b.c.d block — all sit in ::/104-ish space.
  if (allZeroFirst10 && bytes[10] === 0 && bytes[11] === 0) {
    const embedded = bytes.slice(12);
    // :: and ::1
    if (embedded.every((byte) => byte === 0)) return false;
    if (embedded[0] === 0 && embedded[1] === 0 && embedded[2] === 0) {
      return false;
    }
    // ::a.b.c.d — deprecated IPv4-compatible. Classify by the v4 part.
    return isPublicIpv4(embedded);
  }

  // ::ffff:0:0/96 — IPv4-mapped. Classify by the embedded IPv4 address
  // so ::ffff:127.0.0.1 and ::ffff:169.254.169.254 are blocked.
  if (allZeroFirst10 && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytes.slice(12));
  }

  // 64:ff9b::/96 and 64:ff9b:1::/48 — NAT64. Classify by embedded v4.
  if (b0 === 0x00 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    return isPublicIpv4(bytes.slice(12));
  }

  // 100::/64 — discard-only.
  if (b0 === 0x01 && b1 === 0x00 && bytes.slice(2, 8).every((x) => x === 0)) {
    return false;
  }

  // 2001:db8::/32 — documentation.
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return false;
  }

  // 2001::/23 — IETF protocol assignments (Teredo 2001::/32, ORCHIDv2,
  // etc.). Teredo in particular embeds an arbitrary IPv4 target.
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] <= 0x01) return false;

  // 2002::/16 — 6to4. Bytes 2..5 are the embedded IPv4 address.
  if (b0 === 0x20 && b1 === 0x02) {
    return isPublicIpv4(bytes.slice(2, 6));
  }

  // fc00::/7 — unique local (fc00:: and fd00::).
  if ((b0 & 0xfe) === 0xfc) return false;

  // fe80::/10 — link-local (fe80..febf).
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return false;

  // fec0::/10 — deprecated site-local.
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return false;

  // ff00::/8 — multicast.
  if (b0 === 0xff) return false;

  return true;
}

/**
 * Deny-by-default public-address test for a bare IP literal or a
 * resolved address string. Anything unparseable is NOT public.
 */
export function isPublicIpAddress(value: string): boolean {
  const parsed = parseIpLiteral(value);
  if (!parsed) return false;
  return parsed.version === 4
    ? isPublicIpv4(parsed.bytes)
    : isPublicIpv6(parsed.bytes);
}

/**
 * Hostnames that must never be resolved at all, independent of what
 * DNS happens to answer today.
 */
export function isBlockedHostnameLiteral(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host.length === 0) return true;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }

  // An IP literal is decided entirely by its address class.
  const parsed = parseIpLiteral(host);
  if (parsed) return !isPublicIpAddress(host);

  return false;
}
