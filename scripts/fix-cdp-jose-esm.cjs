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

// Broader, format-agnostic detection: any synchronous require("jose")
// call anywhere in a file, regardless of what wraps it — a bare
// assignment, a namespace-import helper like __importStar(...), an
// inline call, or anything else. (__importStar is one example of a
// wrapping shape a TypeScript-compiled CJS build can produce for a
// namespace import; it has NOT been confirmed as the actual pattern in
// the installed @coinbase/cdp-sdk — no network/install access was
// available to check the real package when this was written. This
// regex deliberately does not assume any specific wrapping shape, so
// it does not matter which one turns out to be real.)
// REQUIRE_JOSE_RE above only recognizes ONE specific wrapping shape
// and is what this script uses to decide *how* to auto-rewrite a
// match; this second, wider regex is what the verification pass below
// uses to decide *whether any unsafe call remains at all* — those are
// different questions, and conflating them (as an earlier version of
// this script's verification did) is exactly how a cdp-sdk
// output-format change could silently defeat detection: zero matches
// for the narrow shape was being read as "nothing to patch," when it
// can also mean "still there, just wrapped differently."
const REQUIRE_JOSE_ANY_RE = /require\(\s*(["'])jose\1\s*\)/g;

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
//
// Uses REQUIRE_JOSE_ANY_RE (format-agnostic) rather than REQUIRE_JOSE_RE
// (the narrow auto-rewrite shape). Scans the FULL text of every file —
// including files this run already patched — and collects every
// remaining match, not just the first.
//
// Two important corrections from an earlier version of this pass:
//
// 1. It no longer skips a whole file just because it contains MARKER.
//    REQUIRE_JOSE_RE.exec() above only ever finds and rewrites the
//    FIRST require("jose") in a file; a second, separate occurrence
//    elsewhere in that same file (a different import site, a
//    different function) would be left as a live synchronous require
//    while the file now also contains MARKER from the first rewrite —
//    skipping verification on MARKER's mere presence would let that
//    second occurrence go completely undetected. Our own injected
//    loader block never contains the literal text "require(" (it only
//    ever calls `import("jose")`), so scanning a patched file's full
//    text for REQUIRE_JOSE_ANY_RE cannot produce a false positive from
//    our own rewrite — there is no reason to skip anything.
//
// 2. It records every match in a file (via a manual exec loop), not
//    only the first, so a file with multiple remaining occurrences is
//    fully reported instead of stopping at the first one found.
const stillBroken = [];
for (const file of collectJsFiles(PKG_ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");

  REQUIRE_JOSE_ANY_RE.lastIndex = 0;
  let match;
  while ((match = REQUIRE_JOSE_ANY_RE.exec(src)) !== null) {
    const lineNumber = src.slice(0, match.index).split("\n").length;
    const lineText = lines[lineNumber - 1]?.trim() ?? "";

    stillBroken.push({
      file: path.relative(PKG_ROOT, file),
      line: lineNumber,
      context: lineText.length > 200 ? lineText.slice(0, 200) + "…" : lineText,
    });

    // A zero-width-safe guard: REQUIRE_JOSE_ANY_RE always consumes at
    // least the literal `require("jose")` text, so lastIndex always
    // advances — this loop cannot spin forever — but keep the guard
    // explicit rather than relying on that being true forever.
    if (match.index === REQUIRE_JOSE_ANY_RE.lastIndex) {
      REQUIRE_JOSE_ANY_RE.lastIndex += 1;
    }
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
} else if (stillBroken.length === 0) {
  console.log(
    "[fix-cdp-jose-esm] No require(\"jose\") found anywhere in @coinbase/cdp-sdk " +
      "(checked with the format-agnostic detector, not just the narrow auto-rewrite " +
      "shape). cdp-sdk genuinely does not need this patch right now.",
  );
}

if (stillBroken.length > 0) {
  const details = stillBroken
    .map((entry) => "  - " + entry.file + ":" + entry.line + "  " + entry.context)
    .join("\n");
  console.error(
    "[fix-cdp-jose-esm] FATAL: synchronous require(\"jose\") still present after " +
      "patching (found by the format-agnostic check — this app's narrow " +
      "auto-rewriter did not recognize this exact wrapping shape and could not " +
      "fix it automatically):\n" + details +
      "\nThis WILL throw ERR_REQUIRE_ESM in production on Vercel. Failing the build " +
      "instead of deploying code that would silently fall back to degraded " +
      "discovery at runtime.",
  );
  process.exit(1);
}

process.exit(0);
