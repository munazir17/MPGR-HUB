/**
 * Guards for the `real-redis` job in .github/workflows/ci.yml — the job that
 * runs the autonomy day-ledger suite (spend reservations + CSV->hash migration
 * fence) against a REAL Redis server of a pinned version.
 *
 * Pinned so the suite always exercises a concrete Redis (not a floating tag),
 * so the job cannot silently drop the REDIS_URL that arms the env-gated suite,
 * and so the job keeps running the canonical-Lua real-redis tests exactly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = path.resolve(__dirname, "../../.github/workflows/ci.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const lines = workflow.split("\n");

function topLevelBlock(key: string): string[] {
  const start = lines.findIndex((l) => l === `${key}:`);
  expect(start, `top-level key ${key}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function jobBlock(name: string): string[] {
  const jobs = topLevelBlock("jobs");
  const start = jobs.findIndex((l) => l === `  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (let i = start + 1; i < jobs.length; i += 1) {
    if (/^ {2}\S/.test(jobs[i])) break;
    out.push(jobs[i]);
  }
  return out;
}

const job = jobBlock("real-redis");
const jobText = job.join("\n");

describe("ci.yml real-redis job", () => {
  it("pins an exact Redis server image (never a floating tag)", () => {
    expect(jobText).toMatch(/image: redis:7\.4\.\d+/);
    expect(jobText).not.toMatch(/image: redis:[\^~]?latest|image: redis:\s*$/m);
  });

  it("arms the env-gated suite with REDIS_URL against the service", () => {
    expect(jobText).toContain("REDIS_URL: redis://127.0.0.1:6379");
    expect(jobText).toContain("ports:");
    expect(jobText).toContain("- 6379:6379");
  });

  it("runs exactly the canonical-Lua real-redis day-ledger suite", () => {
    expect(jobText).toContain("npx vitest run lib/autonomy/__tests__/daily-spend.redis.test.ts");
  });

  it("waits for the service to be healthy before running", () => {
    expect(jobText).toContain('--health-cmd "redis-cli ping"');
    expect(jobText).toContain("--health-retries");
  });

  it("keeps the job on the same Node/install conventions as quality", () => {
    expect(jobText).toContain("node-version: 20");
    expect(jobText).toContain("- run: npm ci");
    expect(jobText).toContain("cache: npm");
  });
});
