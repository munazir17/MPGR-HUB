// Coinbase cdp-sdk's compiled CJS output still does `require("jose")`,
// but jose v6 ships ESM-only. On Vercel's Node runtime this throws
// ERR_REQUIRE_ESM at request time (Node's require(esm) interop isn't
// active there). This rewrites that one require() into a lazy
// dynamic import(), which always works regardless of runtime.
// Safe to no-op: if cdp-sdk's internals change shape, this just warns
// instead of failing the build, so it never blocks a deploy.
const fs = require("fs");
const path = require("path");

const target = path.join(
  __dirname,
  "..",
  "node_modules",
  "@coinbase",
  "cdp-sdk",
  "_cjs",
  "auth",
  "utils",
  "jwt.js",
);

if (!fs.existsSync(target)) {
  console.warn("[fix-cdp-jose-esm] jwt.js not found, skipping:", target);
  process.exit(0);
}

let src = fs.readFileSync(target, "utf8");
const originalSrc = src;

const requireLine = 'const jose_1 = require("jose");';
const loaderBlock = [
  "let jose_1;",
  "let __josePromise;",
  "function __loadJose() {",
  "    if (!__josePromise) {",
  '        __josePromise = import("jose").then((mod) => {',
  "            jose_1 = mod;",
  "            return mod;",
  "        });",
  "    }",
  "    return __josePromise;",
  "}",
].join("\n");

if (src.includes(requireLine)) {
  src = src.replace(requireLine, loaderBlock);
} else {
  console.warn("[fix-cdp-jose-esm] require(\"jose\") line not found — cdp-sdk may have changed, skipping.");
}

const genJwtAnchor = "async function generateJwt(options) {";
if (src.includes(genJwtAnchor)) {
  src = src.replace(genJwtAnchor, genJwtAnchor + "\n    await __loadJose();");
} else {
  console.warn("[fix-cdp-jose-esm] generateJwt() not found — skipping that hook.");
}

const genWalletJwtAnchor = "async function generateWalletJwt(options) {";
if (src.includes(genWalletJwtAnchor)) {
  src = src.replace(genWalletJwtAnchor, genWalletJwtAnchor + "\n    await __loadJose();");
} else {
  console.warn("[fix-cdp-jose-esm] generateWalletJwt() not found — skipping that hook.");
}

if (src !== originalSrc) {
  fs.writeFileSync(target, src);
  console.log("[fix-cdp-jose-esm] Patched cdp-sdk jwt.js to lazy-load jose via import().");
} else {
  console.warn("[fix-cdp-jose-esm] No changes applied.");
}
