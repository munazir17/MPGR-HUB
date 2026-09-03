import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildCdpJwtUri, detectCdpJwtAlg, generateCdpJwt } from "../trade-jwt";

describe("CDP JWT", () => {
  it("builds the documented METHOD host/path uri", () => {
    expect(buildCdpJwtUri("POST", "api.cdp.coinbase.com", "/platform/v2/evm/swaps")).toBe(
      "POST api.cdp.coinbase.com/platform/v2/evm/swaps",
    );
  });

  it("detects PEM as ES256 and raw base64 as EdDSA", () => {
    expect(detectCdpJwtAlg("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(
      "ES256",
    );
    expect(detectCdpJwtAlg(randomBytes(32).toString("base64"))).toBe("EdDSA");
  });

  it("signs an EdDSA JWT with iss=cdp and a uri claim", () => {
    const token = generateCdpJwt({
      apiKeyId: "organizations/test/apiKeys/key",
      apiKeySecret: randomBytes(32).toString("base64"),
      requestMethod: "GET",
      requestHost: "api.cdp.coinbase.com",
      requestPath: "/platform/v2/evm/swaps",
    });
    const [headerB64, payloadB64, sig] = token.split(".");
    expect(sig.length).toBeGreaterThan(20);
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");
    expect(payload.iss).toBe("cdp");
    expect(payload.aud).toEqual(["cdp_service"]);
    expect(payload.uri).toBe("GET api.cdp.coinbase.com/platform/v2/evm/swaps");
  });

  it("signs an ES256 JWT from a P-256 PEM", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const token = generateCdpJwt({
      apiKeyId: "key-id",
      apiKeySecret: pem,
      requestMethod: "POST",
      requestHost: "api.cdp.coinbase.com",
      requestPath: "/platform/v2/evm/swaps",
    });
    const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    expect(header.alg).toBe("ES256");
  });
});
