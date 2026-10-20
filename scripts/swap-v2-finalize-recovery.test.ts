import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Regression suite for the V2 finalization recovery after trusted run
// 39294717599: the deploy broadcast succeeded but the seal step failed with
// "contract ... does not have any code" from a lagging public-RPC replica.
//
// Three layers of evidence, all OFFLINE (no RPC, no GitHub, no key, no tx):
//   1. finalize-manifest.test.sh  - bounded propagation polling, missing code,
//      receipt/address mismatch, retry exhaustion, second-RPC disagreement;
//   2. recover-finalize.test.sh   - the recovery refuses anything that is not
//      exactly the failed run's recorded deployment, is keyless, and preserves
//      evidence on failure;
//   3. structural assertions      - the recovery workflow is dispatch-gated,
//      read-only (no environment, no deployer secret), uses SHA-pinned actions,
//      and neither V1 nor V2 routing can be changed by this path.
//
// Nothing here deploys, broadcasts or activates routing.

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };

const INCIDENT_RUN = "39294717599";
const INCIDENT_TX = "0xb8682c025c17ab8322040dfeec58dfe1fa62a880f5ba7edf7972e84ed10bc35b";
const INCIDENT_EXECUTOR = "0x4be1154440b26145d76608D41d403a33e76b9d0A";
const TRUSTED_PIN = "da73b567cdb052ff2bc05456f0a73d9e37ca8299";
const V1_EXECUTOR = "0xBC4dE809b4b72bCe8f61c87daC6Be12e3F7c6b3E";

const recoveryWorkflowText = readFileSync(
  ".github/workflows/recover-swap-executor-v2-finalize.yml",
  "utf8",
);
const trustedV2Text = readFileSync(".github/workflows/deploy-swap-executor-v2-trusted.yml", "utf8");
const finalizeText = readFileSync("scripts/swap-deploy-v2/finalize-manifest.sh", "utf8");
const recoverText = readFileSync("scripts/swap-deploy-v2/recover-finalize.sh", "utf8");
const v1FinalizeText = readFileSync("scripts/swap-deploy/finalize-manifest.sh", "utf8");
const libConfigText = readFileSync("lib/swap/swap-executor-config.ts", "utf8");
const v2DiscoveryText = readFileSync("lib/swap/v2/discovery.ts", "utf8");
const v1Manifest = JSON.parse(
  readFileSync("deployments/base-mainnet/mpgr-swap-executor.json", "utf8"),
);

type Workflow = {
  on?: unknown;
  permissions?: Record<string, string>;
  jobs?: Record<string, { environment?: unknown; permissions?: unknown; if?: string; steps?: unknown[] }>;
};

const recoveryWorkflow = yaml.load(recoveryWorkflowText) as Workflow;
const trustedV2 = yaml.load(trustedV2Text) as Workflow;

function runSuite(path: string): string {
  return execFileSync("bash", [path], {
    encoding: "utf8",
    timeout: 600_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "" },
  });
}

describe("V2 seal RPC resilience (offline mock-cast suite)", () => {
  it(
    "finalize-manifest.test.sh: propagation delay, missing code, mismatch, retry exhaustion, cross-RPC disagreement",
    { timeout: 600_000 },
    () => {
      const out = runSuite("scripts/swap-deploy-v2/finalize-manifest.test.sh");
      expect(out).toMatch(/finalize-manifest: \d+ passed, 0 failed/);
      // The exact incident shape must be covered by an explicit scenario.
      expect(out).toContain("# RPC propagation delay: code appears after two empty polls");
      expect(out).toContain("# missing code: never appears within the bounded window");
      expect(out).toContain("# receipt/address mismatch");
      expect(out).toContain("# retry exhaustion (bounded, never infinite)");
      expect(out).toContain("# independent second RPC disagreement");
    },
  );

  it(
    "recover-finalize.test.sh: read-only recovery refuses anything not exactly the failed run's deployment",
    { timeout: 600_000 },
    () => {
      const out = runSuite("scripts/swap-deploy-v2/recover-finalize.test.sh");
      expect(out).toMatch(/recover-finalize: \d+ passed, 0 failed/);
      expect(out).toContain("# keyless guard");
      expect(out).toContain("# artifact integrity guards (never recover an unlisted deployment)");
      expect(out).toContain("# finalize failure inside recovery preserves evidence and claims nothing");
    },
  );
});

describe("finalize hardening markers (bounded, fail-closed, cross-checked)", () => {
  it("waits for runtime-code propagation with bounded polling before any eth_call", () => {
    expect(finalizeText).toContain("wait_for_code");
    expect(finalizeText).toContain("FINALIZE_CODE_WAIT_ATTEMPTS");
    expect(finalizeText).toContain("still has NO runtime code");
    // The gate must run BEFORE the first pin read.
    expect(finalizeText.indexOf('wait_for_code "$RPC"')).toBeLessThan(
      finalizeText.indexOf("FEE_BPS=\"$(pin_pair"),
    );
  });

  it("retries every RPC read a bounded number of times and fails closed on exhaustion", () => {
    expect(finalizeText).toContain("rpc_read()");
    expect(finalizeText).toContain("FINALIZE_RPC_ATTEMPTS");
    expect(finalizeText).toContain("failed all $RPC_ATTEMPTS bounded attempts");
  });

  it("cross-checks an independently configured second RPC and fails closed on disagreement", () => {
    expect(finalizeText).toContain("BASE_MAINNET_RPC_URL_ALT");
    expect(finalizeText).toContain("RPC DISAGREEMENT");
    expect(finalizeText).toContain("refusing a self-cross-check");
    expect(finalizeText).toContain("crossCheckedWithSecondRpc");
  });

  it("tries several independent endpoints and refuses to seal when none answer", () => {
    expect(finalizeText).toContain("ALT_CANDIDATES");
    expect(finalizeText).toContain("did not answer the cross-check probe");
    expect(finalizeText).toContain("refusing to seal without an independent cross-check");
    // Disagreement must NOT be treated as unavailability (no silent fallback).
    expect(finalizeText).toContain("RPC DISAGREEMENT");
  });

  it("requires an exact CREATE receipt (contractAddress, from, tx hash) instead of tolerating a missing one", () => {
    expect(finalizeText).toContain("has no contractAddress");
    expect(finalizeText).toContain("receipt contractAddress");
    expect(finalizeText).toContain("receipt transactionHash");
    expect(finalizeText).toContain("compute-address");
  });

  it("is read-only: no broadcast, send or private-key capability", () => {
    for (const text of [finalizeText, recoverText]) {
      expect(text).not.toMatch(/--broadcast|--private-key|forge script|cast send/);
    }
    expect(recoverText).toContain("must NOT be in scope");
  });
});

describe("recovery workflow is dispatch-gated and structurally read-only", () => {
  it("runs only via a confirmed dispatch or a same-repo PR label (never on a plain push)", () => {
    const triggers = recoveryWorkflow.on as Record<string, unknown>;
    expect(Object.keys(triggers).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    // Dispatch path: explicit confirmation string required.
    expect(recoveryWorkflowText).toContain("RECOVER_SEAL_ONE_MPGR_SWAP_EXECUTOR_V2");
    expect(recoveryWorkflowText).toContain(
      "inputs.confirm_recovery == 'RECOVER_SEAL_ONE_MPGR_SWAP_EXECUTOR_V2'",
    );
    // PR path: only the dedicated label, only from a same-repository head.
    const prTrigger = (triggers as { pull_request?: { types?: string[] } }).pull_request;
    expect(prTrigger?.types).toEqual(["labeled"]);
    expect(recoveryWorkflowText).toContain("github.event.label.name == 'recover-swap-v2-finalize'");
    expect(recoveryWorkflowText).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(recoveryWorkflowText).toContain("Event gate (defense in depth");
    expect(recoveryWorkflowText).not.toMatch(/^\s*push:/m);
  });

  it("declares no environment and no production secret anywhere", () => {
    for (const [name, job] of Object.entries(recoveryWorkflow.jobs ?? {})) {
      expect(job.environment, `job ${name} must not declare an environment`).toBeUndefined();
    }
    // The deployer secret may only be NAMED by the runtime keyless assertion;
    // it must never be mapped from the secrets context (there is none here).
    expect(recoveryWorkflowText).not.toMatch(/BASE_MAINNET_DEPLOYER_PRIVATE_KEY:\s*\$\{\{/);
    expect(recoveryWorkflowText).not.toContain("secrets.");
    expect(recoverText).toContain(`for v in BASE_MAINNET_DEPLOYER_PRIVATE_KEY PRIVATE_KEY`);
  });

  it("has least-privilege permissions and SHA-pinned actions", () => {
    const perms = recoveryWorkflow.permissions ?? {};
    expect(perms.contents).toBe("read");
    expect(perms.actions).toBe("read");
    // The only write scope is the PR summary comment (no repository writes).
    expect(perms["pull-requests"]).toBe("write");
    for (const [scope, level] of Object.entries(perms)) {
      if (scope !== "pull-requests") expect(level, `scope ${scope} must be read-only`).toBe("read");
    }
    // No job may widen permissions beyond the workflow-level block.
    for (const [name, job] of Object.entries(recoveryWorkflow.jobs ?? {})) {
      expect(job.permissions, `job ${name} must not override permissions`).toBeUndefined();
    }
    for (const m of recoveryWorkflowText.matchAll(/uses:\s*(\S+)/g)) {
      expect(m[1], `action ${m[1]} must be pinned to a full commit SHA`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("defaults pin the exact existing deployment (run, tx, executor, trusted commit)", () => {
    expect(recoveryWorkflowText).toContain(`default: "${INCIDENT_RUN}"`);
    expect(recoveryWorkflowText).toContain(`default: "${INCIDENT_TX}"`);
    expect(recoveryWorkflowText).toContain(`default: "${INCIDENT_EXECUTOR}"`);
    expect(recoveryWorkflowText).toContain(`default: "${TRUSTED_PIN}"`);
  });

  it("seals from the existing deployment data only and never re-runs deployment steps", () => {
    const steps = (recoveryWorkflow.jobs?.["recover-finalize"]?.steps ?? []) as { run?: string }[];
    const runs = steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("recover-finalize.sh");
    // No step may invoke a broadcast-capable command (the guard step merely
    // greps for such strings; an invocation would start with the command).
    expect(runs).not.toMatch(/^\s*(forge\s+(script|create)|cast\s+send)/m);
    expect(recoveryWorkflowText).toContain("no sealed V2 manifest on main");
  });

  it("ships several independent public endpoints for the cross-check by default", () => {
    expect(recoveryWorkflowText).toContain("base-rpc.publicnode.com");
    expect(recoveryWorkflowText).toContain("base.llamarpc.com");
    expect(recoveryWorkflowText).toContain("base.drpc.org");
  });

  it("asserts V1 and V2 routing stay untouched and requires owners to activate manually", () => {
    expect(recoveryWorkflowText).toContain("V1 untouched audit");
    expect(recoveryWorkflowText).toContain("export const V2_DEPLOYMENT = null;");
    expect(recoveryWorkflowText).toContain("routing NOT activated");
  });
});

describe("trusted V2 workflow hardening for future pins", () => {
  it("passes an independent second RPC to the seal step", () => {
    expect(trustedV2Text).toContain("BASE_MAINNET_RPC_URL_ALT");
    expect(trustedV2Text).toContain(
      'bash scripts/swap-deploy-v2/finalize-manifest.sh "$BASE_MAINNET_RPC_URL" "$BASE_MAINNET_RPC_URL_ALT"',
    );
  });

  it("still keeps the seal step after the single broadcast and keeps V2 routing manual", () => {
    expect(trustedV2Text).toContain("--broadcast --slow");
    expect(trustedV2Text).toContain("Routing is NOT");
    const deployJob = trustedV2.jobs?.["deploy"];
    expect(deployJob?.environment).toBeDefined();
  });
});

describe("V1 and V2 activation state are untouched by this change", () => {
  it("V1 finalize script keeps its original single-RPC contract", () => {
    expect(v1FinalizeText).not.toContain("FINALIZE_RPC_ATTEMPTS");
    expect(v1FinalizeText).not.toContain("RPC DISAGREEMENT");
    expect(v1FinalizeText).toContain("grep -q 'pending-record'");
  });

  it("V1 sealed manifest still pins the deployed V1 executor and its receipt", () => {
    expect(v1Manifest.executor).toBe(V1_EXECUTOR);
    expect(v1Manifest.deployTx).toBe(
      "0x549a54c25a31c0fd47dff625bdfba821c27d892b5cb437473b1decc751efa4cc",
    );
    expect(v1Manifest.deployBlock).toBe(52799525);
  });

  it("active routing stays on V1 and V2 routing stays dormant", () => {
    expect(libConfigText).toContain(`executor: "${V1_EXECUTOR}"`);
    expect(v2DiscoveryText).toContain("export const V2_DEPLOYMENT = null;");
  });
});
