/**
 * Guards for .github/workflows/smoke-delegated-executor-base-mainnet.yml — the
 * dedicated MPGRExecutorDelegated Base Mainnet smoke/canary workflow.
 *
 * Its `live` job signs and broadcasts a real mainnet transaction, so these
 * tests pin the parts that keep that safe:
 * - the workflow is SEPARATE from the v1 smoke workflow, and both the trigger
 *   shape and the target differ (delegated executor, Permit2 path, fresh wallet);
 * - nothing may reach the live job unless BOTH the fork rehearsal and the
 *   read-only preflight succeeded, and the live job is additionally gated by
 *   the `base-mainnet` environment approval;
 * - the smoke key is available to exactly one step of the live job, the wallet
 *   pin comes from a non-secret variable, and no job may deploy anything;
 * - the one-shot ledger cache is restored before the broadcast and saved after
 *   it (even on failure), and every job ends by propagating the script's status.
 *
 * The job `if:` expressions are read from the shipped file and run through a
 * small evaluator for the GitHub Actions expression subset they use, so the
 * tests check the real conditions rather than a copy of them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = path.resolve(__dirname, "../../.github/workflows/smoke-delegated-executor-base-mainnet.yml");
const V1_WORKFLOW_PATH = path.resolve(__dirname, "../../.github/workflows/smoke-executor-base-mainnet.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const v1Workflow = readFileSync(V1_WORKFLOW_PATH, "utf8");
const lines = workflow.split("\n");

const LABEL = "smoke-delegated-base-mainnet";
const V1_SMOKE_WALLET = "0xB54900f2c355CB0A61c62f8220191D3aAA6f4455";
const DELEGATED_EXECUTOR = "0x39B1C6Ea88A01e70cbF4899BF3cEfB2c43cD32Bb";
const V1_EXECUTOR = "0xD982726e28275661F8aB64054E6b17a70a63505A";
const KEY_SECRET = "BASE_MAINNET_DELEGATED_SMOKE_PRIVATE_KEY";
const LEDGER_PATH = ".mpgr-delegated-smoke";

// ---------------------------------------------------------------------------
// Minimal structural helpers (no YAML dependency).
// ---------------------------------------------------------------------------

/** Lines of a top-level block such as `on:` (until the next top-level key). */
function topLevelBlock(key: string): string[] {
  const start = lines.findIndex((l) => l === `${key}:`);
  expect(start, `top-level key ${key}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** Lines belonging to a job under `jobs:` (2-space indented key). */
function jobBlock(name: string): string[] {
  const jobs = topLevelBlock("jobs");
  const start = jobs.findIndex((l) => l === `  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < jobs.length; i++) {
    if (/^ {2}\S/.test(jobs[i])) break;
    out.push(jobs[i]);
  }
  return out;
}

function jobKey(job: string[], key: string): string | undefined {
  const line = job.find((l) => l.startsWith(`    ${key}: `));
  return line?.slice(`    ${key}: `.length).trim();
}

function jobIf(name: string): string {
  const cond = jobKey(jobBlock(name), "if");
  expect(cond, `${name}.if`).toBeTruthy();
  return cond as string;
}

const jobText = (name: string) => jobBlock(name).join("\n");

/** The `- name:` steps of a job, with their bodies. */
function stepNames(name: string): string[] {
  return jobBlock(name)
    .filter((l) => /^ {6}- name: /.test(l))
    .map((l) => l.slice("      - name: ".length));
}

// ---------------------------------------------------------------------------
// Evaluator for the GitHub Actions expression subset used by this workflow:
// property paths, 'string' literals, == != && || ! and parentheses.
// ---------------------------------------------------------------------------

type Value = string | number | boolean | null;
type Context = Record<string, unknown>;

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot tokenize at ${pos}: ${src.slice(pos)}`);
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

function lookup(ctx: Context, dotted: string): Value {
  let cur: unknown = ctx;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? null : (cur as Value);
}

function truthy(v: Value): boolean {
  return !(v === null || v === false || v === 0 || v === "" || Number.isNaN(v));
}

function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  return v.trim() === "" ? 0 : Number(v);
}

/** GitHub: strings compare case-insensitively; mixed types coerce to number. */
function looseEquals(a: Value, b: Value): boolean {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  const na = toNumber(a);
  const nb = toNumber(b);
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
}

function evaluate(expression: string, ctx: Context): Value {
  const src = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const take = (expected?: string) => {
    const tok = t[i++];
    if (expected !== undefined && tok !== expected) throw new Error(`expected ${expected}, got ${tok}`);
    return tok;
  };
  const primary = (): Value => {
    const tok = take();
    if (tok === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (tok === "!") return !truthy(primary());
    if (tok.startsWith("'")) return tok.slice(1, -1).replace(/''/g, "'");
    if (tok === "true" || tok === "false") return tok === "true";
    if (tok === "null") return null;
    return lookup(ctx, tok);
  };
  const cmp = (): Value => {
    let left = primary();
    while (peek() === "==" || peek() === "!=") {
      const op = take();
      const right = primary();
      left = op === "==" ? looseEquals(left, right) : !looseEquals(left, right);
    }
    return left;
  };
  const and = (): Value => {
    let left = cmp();
    while (peek() === "&&") {
      take();
      const right = cmp();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const or = (): Value => {
    let left = and();
    while (peek() === "||") {
      take();
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };
  const result = or();
  if (i !== t.length) throw new Error(`unexpected token ${t[i]} in ${expression}`);
  return result;
}

// ---------------------------------------------------------------------------
// Event contexts.
// ---------------------------------------------------------------------------

const REPO = "munazir17/MPGR-HUB";

function prLabeled(opts: { label?: string; headRepo?: string; headSha?: string } = {}): Context {
  return {
    github: {
      event_name: "pull_request",
      repository: REPO,
      ref: "refs/pull/100/merge",
      sha: "mergecommitsha",
      event: {
        action: "labeled",
        label: { name: opts.label ?? LABEL },
        pull_request: { number: 100, head: { sha: opts.headSha ?? "prheadsha", repo: { full_name: opts.headRepo ?? REPO } } },
      },
    },
    inputs: {},
  };
}

function dispatch(opts: { ref?: string; confirm?: string | null } = {}): Context {
  const confirm = opts.confirm === undefined ? LABEL : opts.confirm;
  return {
    github: {
      event_name: "workflow_dispatch",
      repository: REPO,
      ref: opts.ref ?? "refs/heads/main",
      sha: "mainsha",
      event: { inputs: confirm === null ? {} : { confirm }, ref: opts.ref ?? "refs/heads/main" },
    },
    inputs: confirm === null ? {} : { confirm },
  };
}

function withNeeds(ctx: Context, results: Record<string, string>): Context {
  return { ...ctx, needs: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { result: v }])) };
}

const allGreen = (ctx: Context) => withNeeds(ctx, { rehearse: "success", preflight: "success" });
const runs = (job: string, ctx: Context) => truthy(evaluate(jobIf(job), ctx));

// ---------------------------------------------------------------------------
describe("delegated smoke workflow: triggers and shape", () => {
  it("triggers only on the delegated label and a confirmed manual dispatch", () => {
    const on = topLevelBlock("on").filter((l) => l.trim() !== "");
    const events = on.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
    expect(events).toEqual(["pull_request:", "workflow_dispatch:"]);
    expect(on).toContain("    types: [labeled]");
    expect(workflow).not.toMatch(/^\s+(push|schedule|workflow_run|pull_request_target|repository_dispatch):/m);
    const onText = on.join("\n");
    expect(onText).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}confirm:\n/);
    expect(onText).toMatch(/\n {8}required: true\n/);
    expect(onText).toMatch(/ {8}type: string(?:\n|$)/);
    expect(onText).toContain(`description: Type ${LABEL}`);
    // Every job re-states the delegated label; the v1 label must never trigger this one.
    expect(workflow.match(/github\.event\.label\.name == 'smoke-delegated-base-mainnet'/g)?.length).toBe(3);
    expect(workflow.match(/github\.event\.label\.name == 'smoke-base-mainnet'/g)?.length).toBeUndefined();
  });

  it("has its own name, concurrency group and PR-comment markers", () => {
    expect(workflow).toContain("name: Delegated executor smoke test (Base Mainnet)");
    expect(topLevelBlock("concurrency")).toEqual(["  group: smoke-delegated-executor-base-mainnet", "  cancel-in-progress: false", ""]);
    expect(topLevelBlock("concurrency").join(" ")).not.toContain("group: smoke-executor-base-mainnet");
    for (const marker of ["rehearsal", "preflight", "live"]) {
      expect(workflow).toContain(`<!-- mpgr-smoke-delegated-base-mainnet-${marker} -->`);
      // The v1 workflow comments under different markers, so neither overwrites the other.
      expect(v1Workflow).not.toContain(`mpgr-smoke-delegated-base-mainnet-${marker}`);
    }
  });

  it("keeps read-only contents plus PR comment rights, and the non-secret wallet pin in env", () => {
    expect(topLevelBlock("permissions")).toEqual(["  contents: read", "  pull-requests: write", "  issues: write", ""]);
    const envBlock = topLevelBlock("env").join("\n");
    expect(envBlock).toContain("SMOKE_DELEGATED_WALLET_ADDRESS: ${{ vars.SMOKE_DELEGATED_WALLET_ADDRESS }}");
    expect(envBlock).not.toContain("secrets.");
    expect(envBlock).not.toContain("PRIVATE_KEY");
  });

  it("is a distinct workflow that never invokes the v1 smoke script", () => {
    expect(workflow).not.toContain("script/smoke-executor-base-mainnet.mjs");
    expect(workflow.match(/node script\/smoke-delegated-executor-base-mainnet\.mjs/g)?.length).toBe(3);
    // The v1 workflow keeps its own script, mode variables and target, untouched.
    expect(v1Workflow).toContain("node script/smoke-executor-base-mainnet.mjs");
    expect(v1Workflow).toContain("SMOKE_MODE: live");
    expect(v1Workflow).toContain(V1_EXECUTOR);
    expect(v1Workflow).not.toContain(DELEGATED_EXECUTOR);
  });

  it("never deploys, redeploys or reconfigures anything", () => {
    expect(workflow).not.toMatch(/forge (script|deploy|create)/);
    expect(workflow).not.toMatch(/DeployMPGRExecutor|deploy-delegated|deploy-base-mainnet/);
    expect(workflow).not.toMatch(/--broadcast/);
    expect(workflow).not.toMatch(/VERIFY|ETHERSCAN_API_KEY/);
    expect(stepNames("rehearse").join(" ")).toContain("anvil");
  });
});

describe("delegated smoke workflow: target and route pins", () => {
  it("documents the delegated executor (not the v1 one) as the target", () => {
    const header = lines.slice(0, 40).join("\n");
    expect(header).toContain(DELEGATED_EXECUTOR);
    expect(header).toContain("swapOnBehalfOfUniswapV3");
    expect(header).toContain("Permit2");
    expect(header).toContain(V1_SMOKE_WALLET); // named as the wallet that must NOT be reused
    expect(header).toContain("0.50 USDC");
  });

  it("refuses to run any job without the fresh-wallet pin or with the v1 key", () => {
    expect(workflow).not.toContain("BASE_MAINNET_DEPLOYER_PRIVATE_KEY");
    expect(workflow).toContain("SMOKE_DELEGATED_WALLET_ADDRESS must be set");
    expect(workflow).toContain("BASE_MAINNET_DELEGATED_SMOKE_PRIVATE_KEY is not configured");
  });
});

describe("delegated smoke workflow: job graph", () => {
  it("runs rehearse -> preflight -> live, each gated on the one before", () => {
    const jobs = topLevelBlock("jobs").filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().replace(":", ""));
    expect(jobs).toEqual(["rehearse", "preflight", "live"]);
    expect(jobKey(jobBlock("rehearse"), "needs")).toBeUndefined();
    expect(jobKey(jobBlock("preflight"), "needs")).toBe("rehearse");
    expect(jobKey(jobBlock("live"), "needs")).toBe("[rehearse, preflight]");
    expect(jobIf("preflight")).toContain("needs.rehearse.result == 'success' &&");
    expect(jobIf("live")).toContain("needs.rehearse.result == 'success' && needs.preflight.result == 'success' &&");
  });

  it("gates only the live job behind the base-mainnet environment approval", () => {
    expect(jobKey(jobBlock("live"), "environment")).toBe("base-mainnet");
    for (const job of ["rehearse", "preflight"]) {
      expect(jobKey(jobBlock(job), "environment"), job).toBeUndefined();
      expect(jobText(job), job).not.toContain("environment:");
    }
  });

  it.each([
    ["same-repo PR labeled for the delegated smoke", () => prLabeled(), true],
    ["fork PR", () => prLabeled({ headRepo: "attacker/MPGR-HUB" }), false],
    ["the v1 smoke label instead", () => prLabeled({ label: "smoke-base-mainnet" }), false],
    ["an unrelated label", () => prLabeled({ label: "deploy-base-mainnet" }), false],
    ["manual dispatch from main with the exact phrase", () => dispatch(), true],
    ["manual dispatch from a feature branch", () => dispatch({ ref: "refs/heads/feature/x" }), false],
    ["manual dispatch from a tag", () => dispatch({ ref: "refs/tags/v1.0.0" }), false],
    ["manual dispatch with a wrong phrase", () => dispatch({ confirm: "yes" }), false],
    ["manual dispatch with an empty phrase", () => dispatch({ confirm: "" }), false],
    ["manual dispatch with no phrase", () => dispatch({ confirm: null }), false],
  ])("%s -> rehearse runs=%s", (_label, ctx, expected) => {
    expect(runs("rehearse", ctx())).toBe(expected);
    expect(runs("preflight", withNeeds(ctx(), { rehearse: "success" }))).toBe(expected);
    expect(runs("live", allGreen(ctx()))).toBe(expected);
  });

  it("skips preflight and live unless the earlier jobs actually succeeded", () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      expect(runs("preflight", withNeeds(prLabeled(), { rehearse: result })), `preflight after ${result}`).toBe(false);
      expect(runs("live", withNeeds(prLabeled(), { rehearse: "success", preflight: result })), `live after ${result}`).toBe(false);
      expect(runs("live", withNeeds(dispatch(), { rehearse: result, preflight: "success" })), `live after rehearse ${result}`).toBe(false);
    }
    // A skipped rehearsal must not let a "not-run" preflight look green to live.
    expect(runs("live", withNeeds(prLabeled(), { rehearse: "skipped", preflight: "success" }))).toBe(false);
  });

  it("checks out the PR head for PR events and the dispatched commit for manual runs", () => {
    for (const job of ["rehearse", "preflight", "live"]) {
      const refLine = jobBlock(job).find((l) => l.trim().startsWith("ref: ")) as string;
      const expr = refLine.trim().slice("ref: ".length);
      expect(evaluate(expr, prLabeled({ headSha: "abc123" })), job).toBe("abc123");
      expect(evaluate(expr, dispatch()), job).toBe("mainsha");
    }
  });
});

describe("delegated smoke workflow: secrets and modes", () => {
  it("gives the key to exactly one step of the live job", () => {
    expect(workflow.match(new RegExp(`secrets\\.${KEY_SECRET}`, "g"))?.length).toBe(2); // existence guard + the one step
    const live = jobText("live");
    expect(live).toContain(`SMOKE_DELEGATED_PRIVATE_KEY: \${{ secrets.${KEY_SECRET} }}`);
    expect(live).toContain("CANDIDATE_KEY: ${{ secrets." + KEY_SECRET + " }}");
    for (const job of ["rehearse", "preflight"]) {
      expect(jobText(job), job).not.toContain("PRIVATE_KEY");
      expect(jobText(job), job).not.toContain("secrets.BASE_MAINNET_DEPLOYER");
    }
  });

  it("the optional RPC may be a secret, but only for read access in preflight/rehearsal", () => {
    expect(jobText("preflight")).toContain("SMOKE_DELEGATED_RPC_URL: ${{ secrets.BASE_MAINNET_RPC_URL }}");
    expect(jobText("rehearse")).toContain("SECRET_RPC: ${{ secrets.BASE_MAINNET_RPC_URL }}");
    // No job reads a signing secret anywhere except live.
    expect(workflow.match(/secrets\.[A-Z_]+/g)?.filter((s) => !/BASE_MAINNET_RPC_URL|DELEGATED_SMOKE_PRIVATE_KEY/.test(s))).toEqual([]);
  });

  it("runs each job in its own mode, and only live may broadcast", () => {
    const rehearse = jobText("rehearse");
    expect(rehearse).toContain("SMOKE_DELEGATED_MODE=rehearsal SMOKE_DELEGATED_RPC_URL=http://127.0.0.1:8545");
    expect(rehearse).toContain("anvil --fork-url");
    expect(rehearse).toContain("--fork-block-number");
    expect(rehearse).not.toContain("SMOKE_DELEGATED_MODE: live");
    expect(jobText("preflight")).toContain("SMOKE_DELEGATED_MODE: preflight");
    expect(jobText("preflight")).not.toMatch(/PRIVATE_KEY|anvil/);
    expect(jobText("live")).toContain("SMOKE_DELEGATED_MODE: live");
    expect(jobText("live")).not.toContain("anvil");
  });

  it("rehearses the offline gate suite before touching the fork", () => {
    expect(stepNames("rehearse")[0]).toContain("Offline safety-gate suite");
    expect(jobText("rehearse")).toContain("npx vitest run scripts/delegated-smoke-gates.test.ts test/workflows/smoke-delegated-executor-base-mainnet.test.ts");
  });

  it("passes a second confirmation into the live step, sourced from the trigger itself", () => {
    const live = jobText("live");
    expect(live).toContain("SMOKE_DELEGATED_CONFIRM: ${{ github.event.label.name || inputs.confirm }}");
    expect(evaluate("${{ github.event.label.name || inputs.confirm }}", prLabeled())).toBe(LABEL);
    expect(evaluate("${{ github.event.label.name || inputs.confirm }}", dispatch())).toBe(LABEL);
    // A dispatch that did not type the phrase yields no confirmation value at all.
    expect(truthy(evaluate("${{ github.event.label.name || inputs.confirm }}", dispatch({ confirm: null })))).toBe(false);
  });
});

describe("delegated smoke workflow: one-shot ledger and reporting", () => {
  it("restores the ledger before the broadcast and always saves it afterwards", () => {
    const live = jobText("live");
    const restoreAt = live.indexOf("actions/cache/restore@v4");
    const broadcastAt = live.indexOf("node script/smoke-delegated-executor-base-mainnet.mjs");
    const saveAt = live.indexOf("Save the one-shot smoke ledger");
    expect(restoreAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeLessThan(broadcastAt);
    expect(broadcastAt).toBeLessThan(saveAt);
    expect(live.match(new RegExp(`path: ${LEDGER_PATH}`, "g"))?.length).toBe(2);
    expect(live).toContain("restore-keys: mpgr-delegated-smoke-");
    // The save key must be unique per attempt (cache keys are immutable) while the
    // restore key is the stable one keyed by the wallet, so the guard survives.
    const saveBlock = live.slice(saveAt, saveAt + 400);
    expect(saveBlock).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
    expect(saveBlock).toContain("if: always()");
    // The live job must not cancel mid-broadcast.
    expect(topLevelBlock("concurrency").join(" ")).toContain("cancel-in-progress: false");
  });

  it("refuses to run the live job without the secret or the pin, before any transaction", () => {
    const live = jobText("live");
    const guardAt = live.indexOf("Refuse to run without the dedicated smoke key");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(live.indexOf("node script/smoke-delegated-executor-base-mainnet.mjs"));
    expect(live.slice(guardAt, live.indexOf("node script/smoke-delegated-executor-base-mainnet.mjs"))).toMatch(/exit 1/);
  });

  it("annotates, summarizes and uploads each report, and always ends with the script status", () => {
    for (const [job, file, step] of [
      ["rehearse", "smoke-delegated-rehearsal", "rehearse"],
      ["preflight", "smoke-delegated-preflight", "preflight"],
      ["live", "smoke-delegated-live", "live"],
    ] as const) {
      const text = jobText(job);
      expect(text, job).toContain(`${file}.json`);
      expect(text, job).toContain(`${file}.md`);
      expect(text, job).toContain(`if: always() && hashFiles('${file}.json') != ''`);
      expect(text, job).toContain(`echo "status=$?" >> "$GITHUB_OUTPUT"`);
      expect(text, job).toContain(`exit "\${{ steps.${step}.outputs.status || 1 }}"`);
      expect(text, job).toContain("actions/upload-artifact@v4");
      // Every PR comment is upserted behind a PR-number guard and a marker lookup.
      const guards = text.match(/if \[ -n "\$PR" \]; then/g) ?? [];
      const apiCalls = text.match(/gh api [^\n]*issues/g) ?? [];
      expect(guards.length, `${job} PR guard`).toBe(1);
      expect(apiCalls.length, `${job} gh api calls`).toBe(3);
      expect(text.indexOf('if [ -n "$PR" ]; then')).toBeLessThan(text.indexOf("gh api"));
    }
  });

  it("never annotates the rehearsal's informational mainnet-readiness notes as failures", () => {
    const rehearse = jobText("rehearse");
    // The fork principals are derived fresh from public labels, so on real
    // mainnet they hold 0 USDC and have approved Permit2 nothing — recorded as
    // informational notes, which must never raise an ::error annotation.
    expect(rehearse).toContain("map(select((.ok | not) and (.informational | not)))");
    expect(rehearse).toContain("informational note(s) about real mainnet state the fork provisions locally");
    // Every genuine failure is still annotated, and the job's verdict is still
    // the script's own exit code.
    expect(rehearse).toContain("::error title=Delegated fork rehearsal FAILED");
    expect(rehearse).toContain('exit "${{ steps.rehearse.outputs.status || 1 }}"');
    // preflight and live keep the strict `.ok | not` filter: they audit the
    // REAL wallet, where these same preconditions are fatal, and the runner's
    // rehearsalNote() aborts outside rehearsal so no note can exist there.
    for (const job of ["preflight", "live"] as const) {
      expect(jobText(job), job).toContain("map(select(.ok | not))");
      expect(jobText(job), job).not.toContain("informational");
    }
  });

  it("keeps the key and RPC secrets out of argv and out of logs", () => {
    // Keys are injected as env for one step; never echoed, never on a command line.
    expect(workflow).not.toMatch(/echo[^\n]*\$\{\{ secrets\./);
    expect(workflow).not.toMatch(/echo[^\n]*\$\{?(CANDIDATE_KEY|SMOKE_DELEGATED_PRIVATE_KEY)\}?/);
    expect(workflow).not.toMatch(/(printf|echo)[^\n]*\$KEY\b/);
    expect(workflow).not.toMatch(/node script\/smoke-delegated-executor-base-mainnet\.mjs[^\n]*(PRIVATE_KEY|0x[0-9a-f]{6})/);
    expect(workflow).toContain("set +e");
    expect(jobText("rehearse")).toContain("grep -v -iE 'private key|0x[0-9a-f]{64}' anvil.log");
  });
});
