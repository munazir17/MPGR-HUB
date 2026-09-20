// Flat ESLint config (ESLint 9+) for Next.js 16.
//
// Replaces .eslintrc.json. eslint-config-next 16.x only ships flat-config
// exports (an array of config objects) and requires eslint >= 9, so the
// legacy `extends: ["next/core-web-vitals"]` form no longer works.
//
// NOTE (2026-09-20, Task 10): the previous toolchain (ESLint 8 +
// eslint-config-next 15.5.24, eslintrc mode) did NOT lint this TypeScript
// codebase at all — `eslint .` in eslintrc mode only visits .js files and
// this repo has none. This flat config is the first real lint coverage for
// the codebase.
//
// The ignore list mirrors the legacy ignorePatterns exactly
// (.next/, out/, coverage/, node_modules/) — do not drop entries without
// updating test/eslint-config.test.ts.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// Migration overrides for the eslint-plugin-react-hooks v7 "compiler" rules
// (new in v6/v7, shipped as "error" by the plugin's recommended config and
// adopted verbatim by eslint-config-next 16.x). The codebase predates them
// and contains 52 established findings (40 set-state-in-effect,
// 5 preserve-manual-memoization, 3 immutability, 3 purity, 1 refs — see the
// Task 10 PR body for the file list). These patterns need a behavior-focused
// follow-up task with regression tests before they can be fixed without
// risk to the live app, so they are held at "warn": every finding stays
// visible in CI output, but the dependency upgrade itself does not block on
// a 30-file client refactor. Do NOT promote these to "error" (or delete
// them from this list) without also updating test/eslint-config.test.ts.
const reactHooksV7Migration = {
  name: "mpgr-hub/react-hooks-v7-migration",
  files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
  rules: {
    "react-hooks/set-state-in-effect": "warn",
    "react-hooks/preserve-manual-memoization": "warn",
    "react-hooks/immutability": "warn",
    "react-hooks/purity": "warn",
    "react-hooks/refs": "warn",
  },
};

const config = [
  {
    ignores: [".next/**", "out/**", "coverage/**", "node_modules/**"],
  },
  ...nextCoreWebVitals,
  reactHooksV7Migration,
];

export default config;
