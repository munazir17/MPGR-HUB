import { execFileSync } from "node:child_process";

const allowed = new Map([
  [
    "@coinbase/agentkit",
    "Transitive Coinbase/CDP dependency; AgentKit 0.10.4 is required by MPGR AgentKit integration. npm's suggested 0.10.3 is a breaking downgrade."
  ],
  [
    "@solana/buffer-layout-utils",
    "Transitive Solana dependency of Coinbase/CDP/AgentKit. MPGR application code has no direct Solana imports."
  ],
  [
    "@solana/spl-token",
    "Transitive Solana dependency of Coinbase/CDP/AgentKit. MPGR application code has no direct Solana imports."
  ],
  [
    "bigint-buffer",
    "Transitive dependency of @solana/buffer-layout-utils. Current affected release is upstream-limited; no safe patched release is available in the dependency chain."
  ],
]);

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

const unexpected = high.filter(([name]) => !allowed.has(name));

console.log("Security audit summary:");
console.log(JSON.stringify(
  audit.metadata?.vulnerabilities ?? {},
  null,
  2,
));

for (const [name, value] of high) {
  if (allowed.has(name)) {
    console.log(`\nALLOWED TRANSITIVE FINDING: ${name}`);
    console.log(`Reason: ${allowed.get(name)}`);
    console.log(`Range: ${value.range}`);
  } else {
    console.error(`\nUNEXPECTED HIGH/CRITICAL: ${name}`);
    console.error(`Range: ${value.range}`);
  }
}

if (unexpected.length > 0) {
  console.error("\nSecurity gate FAILED.");
  process.exit(1);
}

console.log(
  "\nSecurity gate PASSED: no unexpected HIGH/CRITICAL vulnerabilities."
);
