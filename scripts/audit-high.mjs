import { execFileSync } from "node:child_process";

// Advisories with no patched release on the majors this repo is locked to.
// A package is allowed only when EVERY high/critical advisory on it is one
// of these. Any other advisory fails the gate.
const ALLOWED_ADVISORIES = new Map([
  [
    "https://github.com/advisories/GHSA-3gc7-fjrx-p6mg",
    "bigint-buffer overflow is transitive through Coinbase/CDP/AgentKit's Solana packages. No patched release exists in that chain, and MPGR application code does not import Solana.",
  ],
  [
    "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5",
    "Zod memory exhaustion (CVE-2023-54404) is fixed in zod 4.6.6+. Zod 3 has no backport, and viem/wagmi/AgentKit require Zod 3. Nested Zod 4 copies are overridden to 4.6.7. Request bodies are platform-size-limited.",
  ],
  [
    "https://github.com/advisories/GHSA-qr28-fpjm-wq7f",
    "decode-uri-component <=0.5.0 is a quadratic DoS. The patched release is 0.5.1, which is ESM-only, so it cannot replace the CJS 0.2.2 copy locked by WalletConnect/Reown via query-string. MPGR application code does not import decode-uri-component.",
  ],
]);

function advisoryUrls(vulnerabilities, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const value = vulnerabilities[name];
  if (!value) return [];
  const urls = [];
  for (const via of value.via ?? []) {
    if (typeof via === "string") {
      const child = vulnerabilities[via];
      if (child && (child.severity === "high" || child.severity === "critical")) {
        urls.push(...advisoryUrls(vulnerabilities, via, seen));
      }
    } else if (via?.url && (via.severity === "high" || via.severity === "critical")) urls.push(via.url);
  }
  return urls;
}

let raw = "";

try {
  raw = execFileSync("npm", ["audit", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  raw = error.stdout?.toString() ?? "";
}

if (!raw.trim()) {
  console.error("npm audit returned no JSON output.");
  process.exit(1);
}

let audit;
try {
  audit = JSON.parse(raw);
} catch {
  console.error("npm audit returned invalid JSON.");
  process.exit(1);
}

const vulnerabilities = audit.vulnerabilities ?? {};
const high = Object.entries(vulnerabilities).filter(
  ([, value]) => value.severity === "high" || value.severity === "critical",
);

function installedZodVersions() {
  let listing = "";
  try {
    listing = execFileSync("npm", ["ls", "zod", "--all", "--json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    listing = error.stdout?.toString() ?? "";
  }
  const versions = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.name === "zod" && typeof node.version === "string") versions.add(node.version);
    for (const child of Object.values(node.dependencies ?? {})) walk(child);
  };
  if (listing.trim()) walk(JSON.parse(listing));
  return [...versions];
}

function unpatchedZod4(version) {
  const [major, minor = 0, patch = 0] = version.split(".").map((part) => Number(part));
  return major === 4 && (minor < 6 || (minor === 6 && patch < 6));
}

const zod4 = installedZodVersions().filter(unpatchedZod4);
if (zod4.length > 0) {
  console.error(`\nSecurity gate FAILED: Zod 4 below 4.6.6 is installed (${zod4.join(", ")}).`);
  process.exit(1);
}

console.log("Security audit summary:");
console.log(JSON.stringify(audit.metadata?.vulnerabilities ?? {}, null, 2));

const unexpected = [];

for (const [name, value] of high) {
  const urls = [...new Set(advisoryUrls(vulnerabilities, name))];
  const unknown = urls.filter((url) => !ALLOWED_ADVISORIES.has(url));
  if (urls.length === 0 || unknown.length > 0) {
    unexpected.push(name);
    console.error(`\nUNEXPECTED HIGH/CRITICAL: ${name}`);
    console.error(`Range: ${value.range}`);
    console.error(`Advisories: ${unknown.join(", ") || "(none parsed)"}`);
  } else {
    console.log(`\nALLOWED TRANSITIVE FINDING: ${name}`);
    for (const url of urls) console.log(`Reason: ${ALLOWED_ADVISORIES.get(url)}`);
    console.log(`Range: ${value.range}`);
  }
}

if (unexpected.length > 0) {
  console.error("\nSecurity gate FAILED.");
  process.exit(1);
}

console.log(
  "\nSecurity gate PASSED: no unexpected HIGH/CRITICAL vulnerabilities."
);
