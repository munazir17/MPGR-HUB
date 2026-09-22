/**
 * Regression/smoke tests for the ESLint toolchain (Task 10, dependency
 * family: eslint + eslint-config-next).
 *
 * Why these tests exist:
 * - The app runs Next.js 16.3.5, but the lint toolchain was pinned to
 *   eslint-config-next 15.5.24 (ESLint 8, legacy .eslintrc.json config).
 *   eslint-config-next 16.x is a flat-config-only package requiring
 *   ESLint >= 9, so the two majors cannot be mixed: the 16.x config is a
 *   flat array and the 15.x plugin set does not contain the Next 16 rules.
 * - These tests pin the upgraded behavior so a future "dependency cleanup"
 *   cannot silently drop the Next 16 rule coverage or change what the
 *   linter targets (legacy ignorePatterns must keep working).
 *
 * They intentionally FAIL while the repo still uses eslint-config-next
 * 15.5.24 / ESLint 8:
 * - the 15.x export is a legacy config object, not a flat array;
 * - @next/eslint-plugin-next 15.x has no
 *   `no-location-assign-relative-destination` rule (added in the Next 16
 *   plugin), so a `location.assign("/internal-route")` goes undetected.
 */
import { ESLint, Linter } from "eslint";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import { describe, expect, it } from "vitest";

const linter = new Linter();

function verifyFixture(code: string, filename = "fixture.tsx") {
  return linter.verify(code, nextCoreWebVitals, filename);
}

describe("eslint-config-next 16.x flat config", () => {
  it("exports a flat config (array) usable by ESLint >= 9", () => {
    expect(Array.isArray(nextCoreWebVitals)).toBe(true);
    expect(nextCoreWebVitals.length).toBeGreaterThan(0);
  });

  it("flags location.assign() to an internal Next.js route (new Next 16 rule)", () => {
    const code = [
      "export default function GoStaking() {",
      '  function go() {',
      '    location.assign("/staking");',
      "  }",
      "  void go;",
      "  return null;",
      "}",
      "",
    ].join("\n");
    const ruleIds = linter
      .verify(code, nextCoreWebVitals, "fixture.tsx")
      .map((m) => m.ruleId);
    expect(ruleIds).toContain(
      "@next/next/no-location-assign-relative-destination",
    );
  });

  it("flags assignment to location.href with a relative path", () => {
    const code = [
      "export default function GoSeason() {",
      '  function go() {',
      '    window.location.href = "/season";',
      "  }",
      "  void go;",
      "  return null;",
      "}",
      "",
    ].join("\n");
    const ruleIds = linter
      .verify(code, nextCoreWebVitals, "fixture.tsx")
      .map((m) => m.ruleId);
    expect(ruleIds).toContain(
      "@next/next/no-location-assign-relative-destination",
    );
  });

  it("does not flag location.assign() to an absolute external URL", () => {
    const code = [
      "export default function OpenDocs() {",
      '  function go() {',
      '    location.assign("https://docs.example.com/intro");',
      "  }",
      "  void go;",
      "  return null;",
      "}",
      "",
    ].join("\n");
    const ruleIds = linter
      .verify(code, nextCoreWebVitals, "fixture.tsx")
      .map((m) => m.ruleId);
    expect(ruleIds).not.toContain(
      "@next/next/no-location-assign-relative-destination",
    );
  });

  it("still lints clean TSX without false positives", () => {
    const code = [
      'import { useEffect } from "react";',
      "export function Badge({ value }: { value: number }) {",
      "  useEffect(() => {",
      "    const id = setInterval(() => {}, 1000);",
      "    return () => clearInterval(id);",
      "  }, []);",
      "  return <span data-testid=\"badge\">{value}</span>;",
      "}",
      "",
    ].join("\n");
    expect(verifyFixture(code)).toEqual([]);
  });
});

describe("eslint.config.mjs (project config file)", () => {
  it("does not ignore real app files (they are lint targets)", async () => {
    const eslint = new ESLint();
    expect(await eslint.isPathIgnored("app/layout.tsx")).toBe(false);
    expect(await eslint.isPathIgnored("lib/api/cookies.ts")).toBe(false);
    expect(await eslint.isPathIgnored("components/Navbar.tsx")).toBe(false);
  });

  it("keeps the legacy ignorePatterns (.next/, out/, coverage/, node_modules/)", async () => {
    const eslint = new ESLint();
    expect(await eslint.isPathIgnored(".next/server/index.js")).toBe(true);
    expect(await eslint.isPathIgnored("out/index.html.js")).toBe(true);
    expect(await eslint.isPathIgnored("coverage/lcov.info.js")).toBe(true);
    expect(await eslint.isPathIgnored("node_modules/left-pad/index.js")).toBe(
      true,
    );
  });

  it("lints a real repository file with the project config without errors", async () => {
    const eslint = new ESLint();
    const [result] = await eslint.lintFiles(["lib/api/cookies.ts"]);
    expect(result.messages).toEqual([]);
  });

  it("pins the react-hooks v7 migration severities (documented in eslint.config.mjs)", async () => {
    const eslint = new ESLint();
    const resolved = await eslint.calculateConfigForFile("app/layout.tsx");
    const severity = (ruleId: string): number => {
      const value = resolved.rules?.[ruleId];
      if (value == null) return 0;
      return Array.isArray(value) ? value[0] : value;
    };
    // Held at "warn" while the 52 established findings get a dedicated
    // behavior-focused fix (see eslint.config.mjs and the Task 10 PR).
    for (const ruleId of [
      "react-hooks/set-state-in-effect",
      "react-hooks/preserve-manual-memoization",
      "react-hooks/immutability",
      "react-hooks/purity",
      "react-hooks/refs",
    ]) {
      expect(severity(ruleId), ruleId).toBe(1);
    }
    // Pre-existing Next rule severities must stay at their upstream values.
    expect(severity("react-hooks/rules-of-hooks")).toBe(2);
    expect(severity("react-hooks/exhaustive-deps")).toBe(1);
    // Active in the Next 16 config (upstream severity: warn).
    expect(
      severity("@next/next/no-location-assign-relative-destination"),
    ).toBe(1);
  });
});
