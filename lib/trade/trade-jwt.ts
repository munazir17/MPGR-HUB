import "server-only";

// lib/trade/trade-jwt.ts
//
// CDP Secret API Key JWT for Trade API v2.
// Spec: https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
//
// Header: { alg, kid, nonce, typ: "JWT" }
// Payload: { iss: "cdp", sub: kid, nbf, exp, uri, aud: ["cdp_service"] }
// uri: "METHOD host/path"  (no query string)
//
// Algorithms:
//   Ed25519 secret (base64 64-byte seed||pub) → EdDSA   [recommended]
//   EC P-256 PEM                               → ES256  [legacy]
//
// Implemented with node:crypto so we do not import @coinbase/cdp-sdk
// (AgentKit already had a jose ESM issue on Vercel; keep Trade API
// independent of that package).

import { createPrivateKey, randomBytes, sign as nodeSign, type KeyObject } from "node:crypto";

export interface CdpJwtRequest {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: "GET" | "POST";
  requestHost: string;
  requestPath: string;
  expiresInSeconds?: number;
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function looksLikePem(secret: string): boolean {
  return secret.includes("BEGIN") && secret.includes("PRIVATE KEY");
}

function normalizePem(secret: string): string {
  return secret.includes("\\n") ? secret.replace(/\\n/g, "\n") : secret;
}

function ed25519KeyFromCdpSecret(secret: string): KeyObject {
  const raw = Buffer.from(secret.trim(), "base64");
  if (raw.length < 32) {
    throw new Error("CDP Ed25519 secret is not a valid base64 key.");
  }
  const seed = raw.subarray(0, 32);
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function ecKeyFromPem(secret: string): KeyObject {
  return createPrivateKey({ key: normalizePem(secret), format: "pem" });
}

export function detectCdpJwtAlg(apiKeySecret: string): "EdDSA" | "ES256" {
  return looksLikePem(apiKeySecret) ? "ES256" : "EdDSA";
}

export function buildCdpJwtUri(
  method: string,
  host: string,
  path: string,
): string {
  return `${method.toUpperCase()} ${host}${path}`;
}

export function generateCdpJwt(request: CdpJwtRequest): string {
  const apiKeyId = request.apiKeyId.trim();
  const apiKeySecret = request.apiKeySecret.trim();
  if (!apiKeyId || !apiKeySecret) {
    throw new Error("CDP API key id and secret are required.");
  }

  const alg = detectCdpJwtAlg(apiKeySecret);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (request.expiresInSeconds ?? 120);
  const uri = buildCdpJwtUri(
    request.requestMethod,
    request.requestHost,
    request.requestPath,
  );

  const header = {
    alg,
    kid: apiKeyId,
    nonce: randomBytes(16).toString("hex"),
    typ: "JWT",
  };
  const payload = {
    iss: "cdp",
    sub: apiKeyId,
    nbf: now,
    exp,
    uri,
    aud: ["cdp_service"],
  };

  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const key =
    alg === "EdDSA"
      ? ed25519KeyFromCdpSecret(apiKeySecret)
      : ecKeyFromPem(apiKeySecret);

  const signature = nodeSign(
    null,
    Buffer.from(signingInput, "utf8"),
    alg === "ES256"
      ? { key, dsaEncoding: "ieee-p1363" }
      : key,
  );

  return `${signingInput}.${base64Url(signature)}`;
}
