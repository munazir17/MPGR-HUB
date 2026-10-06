/**
 * Guards for .github/workflows/smoke-executor-base-mainnet.yml.
 *
 * The workflow sends real Base Mainnet transactions from its `live` job, so
 * these tests pin the trigger and gating behavior:
 * - the labeled-PR path must behave exactly as before (same condition, same
 *   PR head checkout, same PR comments);
 * - the manual `workflow_dispatch` path only runs from `main` with the typed
 *   confirmation, and still goes rehearse -> base-mainnet environment
 *   approval -> live;
 * - the signer key only appears in the environment-gated `live` job.
 *
 * The job `if:` expressions are read from the real workflow file and run
 * through a small evaluator for the GitHub Actions expression subset they
 * use, so the tests check the shipped conditions, not a copy of them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = path.resolve(
  __dirname,
  "../../.github/workflows/smoke-executor-base-mainnet.yml",
);
const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const lines = workflow.split("\n");

// The condition the labeled-PR path used before workflow_dispatch was added.
const ORIGINAL_PR_CONDITION =
  "github.event.label.name == 'smoke-base-mainnet' && github.event.pull_request.head.repo.full_name == github.repository";

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
      ref: "refs/pull/99/merge",
      sha: "mergecommitsha",
      event: {
        action: "labeled",
        label: { name: opts.label ?? "smoke-base-mainnet" },
        pull_request: {
          number: 99,
          head: { sha: opts.headSha ?? "prheadsha", repo: { full_name: opts.headRepo ?? REPO } },
        },
      },
    },
    inputs: {},
  };
}

function dispatch(opts: { ref?: string; confirm?: string | null } = {}): Context {
  const confirm = opts.confirm === undefined ? "smoke-base-mainnet" : opts.confirm;
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

function withRehearse(ctx: Context, result: string): Context {
  return { ...ctx, needs: { rehearse: { result } } };
}

const runs = (job: string, ctx: Context) => truthy(evaluate(jobIf(job), ctx));

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("smoke-executor-base-mainnet workflow: triggers", () => {
  it("keeps pull_request [labeled] and adds only workflow_dispatch", () => {
    const on = topLevelBlock("on").filter((l) => l.trim() !== "");
    const events = on.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
    expect(events).toEqual(["pull_request:", "workflow_dispatch:"]);
    expect(on).toContain("    types: [labeled]");
    expect(workflow).not.toMatch(/^\s+(push|schedule|workflow_run|pull_request_target|repository_dispatch):/m);
  });

  it("requires a typed string confirmation for manual runs", () => {
    const on = topLevelBlock("on").join("\n");
    expect(on).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}confirm:\n/);
    expect(on).toMatch(/ {8}required: true\n/);
    expect(on).toMatch(/ {8}type: string\n/);
  });

  it("keeps permissions and the shared concurrency lock unchanged", () => {
    expect(topLevelBlock("permissions")).toEqual([
      "  contents: read",
      "  pull-requests: write",
      "  issues: write",
      "",
    ]);
    expect(topLevelBlock("concurrency")).toEqual([
      "  group: smoke-executor-base-mainnet",
      "  cancel-in-progress: false",
      "",
    ]);
  });
});

describe("smoke-executor-base-mainnet workflow: labeled PR path is unchanged", () => {
  it("embeds the original PR condition verbatim in both jobs", () => {
    expect(jobIf("rehearse")).toContain(
      `(github.event_name == 'pull_request' && ${ORIGINAL_PR_CONDITION})`,
    );
    expect(jobIf("live")).toMatch(/^needs\.rehearse\.result == 'success' && \(/);
    expect(jobIf("live")).toContain(`(github.event_name == 'pull_request' && ${ORIGINAL_PR_CONDITION})`);
  });

  it.each([
    ["same-repo PR labeled smoke-base-mainnet", prLabeled(), true],
    ["fork PR", prLabeled({ headRepo: "attacker/MPGR-HUB" }), false],
    ["other label", prLabeled({ label: "deploy-base-mainnet" }), false],
  ])("rehearse: %s -> runs=%s", (_name, ctx, expected) => {
    // Same answer as the pre-change condition for every PR event.
    expect(runs("rehearse", ctx)).toBe(expected);
    expect(truthy(evaluate(ORIGINAL_PR_CONDITION, ctx))).toBe(expected);
  });

  it("live runs for a qualifying PR only after rehearse succeeded", () => {
    expect(runs("live", withRehearse(prLabeled(), "success"))).toBe(true);
    for (const r of ["failure", "cancelled", "skipped"]) {
      expect(runs("live", withRehearse(prLabeled(), r))).toBe(false);
    }
    expect(runs("live", withRehearse(prLabeled({ headRepo: "attacker/MPGR-HUB" }), "success"))).toBe(false);
    expect(runs("live", withRehearse(prLabeled({ label: "other" }), "success"))).toBe(false);
  });

  it("still checks out the PR head commit for PR events in both jobs", () => {
    for (const job of ["rehearse", "live"]) {
      const ref = jobBlock(job).find((l) => l.trim().startsWith("ref: "));
      expect(ref, `${job} checkout ref`).toBeDefined();
      const expr = (ref as string).trim().slice("ref: ".length);
      expect(evaluate(expr, prLabeled({ headSha: "abc123" }))).toBe("abc123");
    }
  });
});

describe("smoke-executor-base-mainnet workflow: manual dispatch path", () => {
  it("runs rehearse from main with the exact confirmation", () => {
    expect(runs("rehearse", dispatch())).toBe(true);
  });

  it.each([
    ["feature branch", dispatch({ ref: "refs/heads/feature/x" })],
    ["tag", dispatch({ ref: "refs/tags/v1.0.0" })],
    ["wrong confirmation", dispatch({ confirm: "yes" })],
    ["empty confirmation", dispatch({ confirm: "" })],
    ["missing confirmation", dispatch({ confirm: null })],
  ])("skips both jobs: %s", (_name, ctx) => {
    expect(runs("rehearse", ctx)).toBe(false);
    expect(runs("live", withRehearse(ctx, "success"))).toBe(false);
  });

  it("live only runs after a successful rehearse", () => {
    expect(runs("live", withRehearse(dispatch(), "success"))).toBe(true);
    for (const r of ["failure", "cancelled", "skipped"]) {
      expect(runs("live", withRehearse(dispatch(), r))).toBe(false);
    }
  });

  it("checks out the dispatched main commit (github.sha) in both jobs", () => {
    for (const job of ["rehearse", "live"]) {
      const ref = (jobBlock(job).find((l) => l.trim().startsWith("ref: ")) as string).trim();
      expect(evaluate(ref.slice("ref: ".length), dispatch())).toBe("mainsha");
    }
  });

  it("does not try to comment on a PR when there is no PR number", () => {
    for (const job of ["rehearse", "live"]) {
      const body = jobBlock(job).join("\n");
      const guards = body.match(/if \[ -n "\$PR" \]; then/g) ?? [];
      const ghCalls = body.match(/gh api [^\n]*issues/g) ?? [];
      expect(guards.length, `${job} PR guard`).toBe(1);
      expect(ghCalls.length).toBe(3);
      const guardAt = body.indexOf('if [ -n "$PR" ]; then');
      expect(body.indexOf("gh api")).toBeGreaterThan(guardAt);
    }
  });
});

describe("smoke-executor-base-mainnet workflow: mainnet approval gate", () => {
  it("live depends on rehearse and always uses the base-mainnet environment", () => {
    const live = jobBlock("live");
    expect(jobKey(live, "needs")).toBe("rehearse");
    expect(jobKey(live, "environment")).toBe("base-mainnet");
  });

  it("only the environment-gated live job receives the signer key", () => {
    const rehearse = jobBlock("rehearse").join("\n");
    const live = jobBlock("live").join("\n");
    expect(rehearse).not.toContain("PRIVATE_KEY");
    expect(rehearse).not.toContain("environment:");
    expect(live).toContain("SMOKE_PRIVATE_KEY: ${{ secrets.BASE_MAINNET_DEPLOYER_PRIVATE_KEY }}");
    expect(workflow.match(/BASE_MAINNET_DEPLOYER_PRIVATE_KEY/g)?.length).toBe(1);
  });

  it("rehearse stays in rehearsal mode against the local anvil fork", () => {
    const rehearse = jobBlock("rehearse").join("\n");
    expect(rehearse).toContain("SMOKE_MODE=rehearsal SMOKE_RPC_URL=http://127.0.0.1:8545");
    expect(rehearse).not.toContain("SMOKE_MODE: live");
  });
});

describe("expression evaluator self-check", () => {
  it("follows GitHub semantics for the operators used", () => {
    const ctx = { a: { b: "X" }, n: null };
    expect(evaluate("a.b == 'x'", ctx)).toBe(true);
    expect(evaluate("a.missing == 'x'", ctx)).toBe(false);
    expect(evaluate("n || 'fallback'", ctx)).toBe("fallback");
    expect(evaluate("${{ a.b || 'fallback' }}", ctx)).toBe("X");
    expect(evaluate("!(a.b == 'y') && a.b != 'z'", ctx)).toBe(true);
  });
});
