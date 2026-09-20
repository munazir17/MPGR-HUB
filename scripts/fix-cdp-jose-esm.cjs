// Coinbase AgentKit / CDP ship compiled CommonJS that does synchronous
// `require()` of ESM-only packages. Node's native require(esm) interop
// (on by default in Node >=20.19.0 / >=22.12.0 / >=23.0.0) hides this
// locally, but it is NOT active on Vercel's serverless Node runtime, so
// every one of these boundaries throws ERR_REQUIRE_ESM at request time
// in production regardless of the configured Node version. Because
// @coinbase/agentkit is a `serverExternalPackages` entry in
// next.config.mjs, Next does not bundle it: the built route does a plain
// `require("@coinbase/agentkit")` and Node walks the whole chain.
//
// Boundaries handled here (see TARGETS):
//   @coinbase/cdp-sdk   -> jose                                 (jose v6, ESM-only)
//   @coinbase/agentkit  -> @across-protocol/app-sdk             ("type": "module")
//   @coinbase/agentkit  -> @base-org/account/spend-permission   ("type": "module")
//   @coinbase/agentkit  -> clanker-sdk/v4                       ("type": "module")
// A fifth boundary, rpc-websockets -> uuid@14, is fixed by the
// `overrides.rpc-websockets` pin in package.json (upstream dropped the
// uuid dependency), not by rewriting.
//
// This rewrites every synchronous `require("<spec>")` found in the
// target package's CJS output into a lazy dynamic import(), which always
// works from CommonJS regardless of runtime, and hooks every async
// function/method in the patched file to await the loader first.
//
// Safety properties:
//   1. Scans the whole package tree (not one hardcoded path), so it
//      survives the packages restructuring their internal files.
//   2. Hooks EVERY async function / async method that appears in a
//      patched file, not hardcoded names.
//   3. VERIFIES after patching that no synchronous require of any
//      target specifier remains, AND actually loads @coinbase/agentkit
//      in a child Node process with require(esm) interop disabled (the
//      Vercel condition). FAILS THE INSTALL/BUILD (non-zero exit) if
//      either check fails. A silent no-op here previously meant a broken
//      patch could deploy clean and 500 in production with no signal
//      until a real user hit the endpoint.
//
// Idempotent: safe to run multiple times (a rewritten file no longer
// contains the synchronous require, so it is simply skipped).
//
// Filename note: this started life as a jose-only patch for cdp-sdk and
// is referenced by name from package.json "postinstall"; the name is
// kept to avoid churn.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");

/**
 * Packages whose CJS output synchronously requires an ESM-only package.
 * `specifiers` are the exact module specifiers used in the require().
 */
const TARGETS = [
  { pkg: "@coinbase/cdp-sdk", specifiers: ["jose"] },
  {
    pkg: "@coinbase/agentkit",
    specifiers: [
      "@across-protocol/app-sdk",
      "@base-org/account/spend-permission",
      "clanker-sdk/v4",
    ],
  },
];

/** Root package that the final load check must be able to require. */
const LOAD_CHECK_PACKAGE = "@coinbase/agentkit";

const MARKER = "__mpgrEsmLoader";

/** Recursively collect every runtime .js file under a directory. */
function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".js") &&
      // Shipped jest specs (agentkit publishes *.test.js next to the
      // sources). They are never require()d at runtime by anything, and
      // they legitimately require() the ESM package so jest.mock can
      // replace it. Rewriting them would be pointless; flagging them
      // would be a false positive.
      !entry.name.endsWith(".test.js")
    ) {
      out.push(full);
    }
  }
  return out;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loaderNameFor(specifier) {
  return MARKER + "_" + specifier.replace(/[^A-Za-z0-9]+/g, "_");
}

/**
 * Narrow auto-rewrite shape: `const x = require("spec");`
 * (what TypeScript emits for `import * as x from "spec"` /
 * `import { a } from "spec"` in CJS output).
 */
function assignmentRequireRe(specifier) {
  return new RegExp(
    "(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*require\\(([\"'])" +
      escapeRegExp(specifier) +
      "\\2\\);?",
    "g",
  );
}

/**
 * Broad, format-agnostic detection: any synchronous require("spec")
 * regardless of what wraps it. Used for VERIFICATION, not rewriting —
 * these are different questions, and conflating them is exactly how an
 * upstream output-format change could silently defeat detection.
 */
function anyRequireRe(specifier) {
  return new RegExp(
    "require\\(\\s*([\"'])" + escapeRegExp(specifier) + "\\1\\s*\\)",
    "g",
  );
}

// Every async function or async method opening:
//   async function name(args) {
//   async name(args) {            (class / object method)
// Arrow functions (`async (x) => {`) are deliberately not hooked: every
// one in the targeted files is nested inside a hooked method, and the
// loader promise has already resolved by the time they run.
const ASYNC_FN_RE = /async\s+(?:function\s+)?[\w$]+\s*\([^)]*\)\s*\{/g;

const patchedFiles = [];
const stillBroken = [];
const missingPackages = [];

for (const target of TARGETS) {
  const pkgRoot = path.join(NODE_MODULES, ...target.pkg.split("/"));

  if (!fs.existsSync(pkgRoot)) {
    missingPackages.push(target.pkg);
    continue;
  }

  for (const file of collectJsFiles(pkgRoot)) {
    let src = fs.readFileSync(file, "utf8");
    const loaderCalls = [];

    for (const specifier of target.specifiers) {
      const re = assignmentRequireRe(specifier);
      let match;
      // Rewrite every assignment-shaped require of this specifier in the
      // file, not just the first.
      while ((match = re.exec(src)) !== null) {
        const varName = match[1];
        const loaderName = loaderNameFor(specifier) + "_" + varName;

        const loaderBlock = [
          `let ${varName};`,
          `let ${loaderName}Promise;`,
          `function ${loaderName}() {`,
          `    if (!${loaderName}Promise) {`,
          `        ${loaderName}Promise = import(${JSON.stringify(specifier)}).then((mod) => {`,
          `            ${varName} = mod;`,
          `            return mod;`,
          `        });`,
          `    }`,
          `    return ${loaderName}Promise;`,
          `}`,
        ].join("\n");

        src =
          src.slice(0, match.index) +
          loaderBlock +
          src.slice(match.index + match[0].length);
        re.lastIndex = match.index + loaderBlock.length;
        loaderCalls.push(`await ${loaderName}();`);
      }
    }

    if (loaderCalls.length === 0) continue;

    // Hook every async function/method in the file so any of them can
    // safely reference the lazily-loaded module. Over-inclusive on
    // purpose: an extra `await` on an already-resolved promise is a
    // no-op, so hooking more functions than strictly necessary is
    // harmless, while missing one is not.
    let hookedCount = 0;
    const hookLine = "\n    " + loaderCalls.join("\n    ");
    src = src.replace(ASYNC_FN_RE, (fnOpen) => {
      hookedCount += 1;
      return fnOpen + hookLine;
    });

    if (hookedCount === 0) {
      console.warn(
        "[fix-cdp-jose-esm] " +
          path.relative(NODE_MODULES, file) +
          ": found a synchronous ESM require but no async function to hook " +
          "it into - leaving unpatched, will fail verification.",
      );
      continue;
    }

    fs.writeFileSync(file, src);
    patchedFiles.push(path.relative(NODE_MODULES, file));
  }

  // --- Verification pass 1: nothing synchronous should remain ---
  // Scans the FULL text of every runtime file — including files this run
  // already patched — with the format-agnostic detector and records every
  // match, not just the first. Our injected loader block never contains
  // the literal text `require(`, so it cannot produce a false positive.
  for (const file of collectJsFiles(pkgRoot)) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");

    for (const specifier of target.specifiers) {
      const re = anyRequireRe(specifier);
      let match;
      while ((match = re.exec(src)) !== null) {
        const lineNumber = src.slice(0, match.index).split("\n").length;
        const lineText = lines[lineNumber - 1]?.trim() ?? "";
        stillBroken.push({
          file: path.relative(NODE_MODULES, file),
          line: lineNumber,
          context:
            lineText.length > 200 ? lineText.slice(0, 200) + "…" : lineText,
        });
        if (match.index === re.lastIndex) re.lastIndex += 1;
      }
    }
  }
}

if (missingPackages.length > 0) {
  console.warn(
    "[fix-cdp-jose-esm] not installed, skipping: " +
      missingPackages.join(", ") +
      " (e.g. agentkit dependency changed).",
  );
}

if (patchedFiles.length > 0) {
  console.log(
    "[fix-cdp-jose-esm] Patched " +
      patchedFiles.length +
      " file(s) to lazy-load ESM-only deps via import(): " +
      patchedFiles.join(", "),
  );
} else {
  console.log(
    "[fix-cdp-jose-esm] No changes needed (already patched or no matching files).",
  );
}

if (stillBroken.length > 0) {
  const details = stillBroken
    .map((entry) => "  - " + entry.file + ":" + entry.line + "  " + entry.context)
    .join("\n");
  console.error(
    "[fix-cdp-jose-esm] FATAL: synchronous require of an ESM-only package " +
      "still present after patching (found by the format-agnostic check — " +
      "the narrow auto-rewriter did not recognize this exact wrapping shape " +
      "and could not fix it automatically):\n" +
      details +
      "\nThis WILL throw ERR_REQUIRE_ESM in production on Vercel. Failing the " +
      "install instead of deploying code that 500s at request time.",
  );
  process.exit(1);
}

// --- Verification pass 2: really load the package like Vercel does ---
//
// Text scanning only knows about the specifiers listed in TARGETS. This
// catches every OTHER boundary too (a new transitive ESM-only dep, an
// override that stopped applying, a package restructure), by requiring
// the root package in a child process with require(esm) interop
// disabled. That is the exact condition under which production failed.
// On Node builds too old to have the interop at all, the flag does not
// exist and the plain require is already the strict condition.
if (fs.existsSync(path.join(NODE_MODULES, ...LOAD_CHECK_PACKAGE.split("/")))) {
  const strictFlag = "--no-experimental-require-module";
  const nodeArgs = process.allowedNodeEnvironmentFlags.has(
    "--experimental-require-module",
  )
    ? [strictFlag]
    : [];

  const script =
    "try { require(" +
    JSON.stringify(LOAD_CHECK_PACKAGE) +
    '); process.stdout.write("LOADED"); } ' +
    'catch (e) { process.stdout.write("FAILED " + (e && e.code ? e.code : "") + " " + ' +
    '(e && e.message ? String(e.message).split("\\n")[0] : String(e))); process.exit(1); }';

  const result = spawnSync(process.execPath, [...nodeArgs, "-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    timeout: 120000,
  });

  if (result.status !== 0 || result.stdout !== "LOADED") {
    console.error(
      "[fix-cdp-jose-esm] FATAL: " +
        LOAD_CHECK_PACKAGE +
        " cannot be require()d with require(esm) interop disabled (node " +
        [...nodeArgs].join(" ") +
        "). This is the runtime condition on Vercel; POST /api/agentkit/invoke " +
        "would 500 with ERR_REQUIRE_ESM.\n" +
        (result.stdout || "") +
        "\n" +
        (result.stderr || "").split("\n").slice(0, 12).join("\n"),
    );
    process.exit(1);
  }

  console.log(
    "[fix-cdp-jose-esm] Verified: " +
      LOAD_CHECK_PACKAGE +
      " loads with require(esm) interop disabled" +
      (nodeArgs.length ? " (" + nodeArgs.join(" ") + ")" : "") +
      ".",
  );
}

process.exit(0);
