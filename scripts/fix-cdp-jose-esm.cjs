// Coinbase cdp-sdk's compiled CJS output does `require("jose")`, but
// jose v6 ships ESM-only. Node's native require(esm) interop (which
// would otherwise handle this on Node >=20.19.0 / >=22.12.0 / >=23.0.0)
// is NOT active on Vercel's serverless Node runtime, so this throws
// ERR_REQUIRE_ESM at request time in production regardless of the
// configured Node version. See: docs.cdp.coinbase.com jose v6 notes,
// and community reports of the same require(esm) gap on Vercel.
//
// This rewrites every synchronous `require("jose")` found anywhere in
// the installed @coinbase/cdp-sdk CJS output into a lazy dynamic
// import(), which always works from CommonJS regardless of runtime.
//
// Unlike a single-file/single-anchor patch, this:
//   1. Scans the whole cdp-sdk package tree (not one hardcoded path),
//      so it survives cdp-sdk restructuring its internal files.
//   2. Hooks EVERY async function that appears after the require in a
//      patched file, not just two hardcoded function names.
//   3. VERIFIES after patching that no synchronous require("jose")
//      remains anywhere in the package, and FAILS THE BUILD (non-zero
//      exit) if one does. A silent no-op here previously meant a
//      broken patch could deploy clean and 500 in production with no
//      signal until a real user hit the endpoint. That is no longer
//      allowed to happen quietly.
//
// Idempotent: safe to run multiple times (checks for the loader
// marker before re-patching).

const fs = require("fs");
const path = require("path");

const PKG_ROOT = path.join(
  __dirname,
  "..",
  "node_modules",
  "@coinbase",
  "cdp-sdk",
);

const MARKER = "__mpgrJoseLoader";

if (!fs.existsSync(PKG_ROOT)) {
  console.warn(
    "[fix-cdp-jose-esm] @coinbase/cdp-sdk not found at",
    PKG_ROOT,
    "- skipping (not installed, e.g. agentkit dependency changed).",
  );
  process.exit(0);
}

/** Recursively collect every .js file under a directory. */
function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const REQUIRE_JOSE_RE = /(?:const|let|var)\s+(\w+)\s*=\s*require\((["'])jose\2\);?/g;
const ASYNC_FN_RE = /async function\s+\w+\s*\([^)]*\)\s*{/g;

const allJsFiles = collectJsFiles(PKG_ROOT);
const patchedFiles = [];
const inspectedFiles = [];

for (const file of allJsFiles) {
  let src = fs.readFileSync(file, "utf8");

  if (src.includes(MARKER)) {
    inspectedFiles.push(file);
    continue;
  }

  REQUIRE_JOSE_RE.lastIndex = 0;
  const match = REQUIRE_JOSE_RE.exec(src);
  if (!match) continue;

  inspectedFiles.push(file);

  const varName = match[1];
  const requireStatement = match[0];

  const loaderBlock = [
    `let ${varName};`,
    `let ${MARKER}Promise;`,
    `function ${MARKER}() {`,
    `    if (!${MARKER}Promise) {`,
    `        ${MARKER}Promise = import("jose").then((mod) => {`,
    `            ${varName} = mod;`,
    `            return mod;`,
    `        });`,
    `    }`,
    `    return ${MARKER}Promise;`,
    `}`,
  ].join("\n");

  let patched = src.replace(requireStatement, loaderBlock);

  // Hook every async function in the file so any of them can safely
  // reference the lazily-loaded module. Cheap and over-inclusive on
  // purpose: an extra `await` on an already-resolved promise is a
  // no-op, so hooking more functions than strictly necessary is
  // harmless, while missing one is not.
  let hookedCount = 0;
  patched = patched.replace(ASYNC_FN_RE, (fnOpen) => {
    hookedCount += 1;
    return `${fnOpen}\n    await ${MARKER}();`;
  });

  if (hookedCount === 0) {
    console.warn(
      "[fix-cdp-jose-esm] " + path.relative(PKG_ROOT, file) + ": found require(\"jose\") " +
        "but no async function to hook it into - leaving unpatched, will fail verification.",
    );
    continue;
  }

  fs.writeFileSync(file, patched);
  patchedFiles.push(path.relative(PKG_ROOT, file));
}

// --- Verification pass: nothing synchronous should remain anywhere ---
const stillBroken = [];
for (const file of collectJsFiles(PKG_ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  REQUIRE_JOSE_RE.lastIndex = 0;
  if (REQUIRE_JOSE_RE.test(src)) {
    stillBroken.push(path.relative(PKG_ROOT, file));
  }
}

if (patchedFiles.length > 0) {
  console.log(
    "[fix-cdp-jose-esm] Patched " + patchedFiles.length + " file(s) to lazy-load jose via import(): " +
      patchedFiles.join(", "),
  );
} else if (inspectedFiles.length > 0) {
  console.log(
    "[fix-cdp-jose-esm] No changes needed (already patched or no matching files).",
  );
} else {
  console.warn(
    "[fix-cdp-jose-esm] No require(\"jose\") found anywhere in @coinbase/cdp-sdk. " +
      "Either cdp-sdk no longer needs this patch, or its output format changed " +
      "enough that our regex no longer matches - treating as OK since there is " +
      "nothing left to break, but worth a manual check if discovery breaks again.",
  );
}

if (stillBroken.length > 0) {
  console.error(
    "[fix-cdp-jose-esm] FATAL: synchronous require(\"jose\") still present after " +
      "patching in: " + stillBroken.join(", ") +
      "\nThis WILL throw ERR_REQUIRE_ESM in production on Vercel. Failing the build " +
      "instead of deploying broken code.",
  );
  process.exit(1);
}

process.exit(0);
