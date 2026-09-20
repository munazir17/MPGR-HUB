// Origins allowed to embed page routes in an <iframe> (CSP frame-ancestors).
// Owner-approved list (2026-09-20): our own origin plus the Farcaster web
// client, which iframes Mini Apps (its mobile app uses a WebView instead).
// Keep entries explicit — full https origins only, never "*" or a bare
// scheme like "https:". Changing this list must update
// lib/__tests__/next-config.test.ts (APPROVED_FRAME_ANCESTORS).
const FRAME_ANCESTORS = ["'self'", "https://farcaster.xyz"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Intentionally empty. `/_next/image` exists in every Next app and will
    // fetch + re-serve any remote URL matching these patterns; a wildcard
    // hostname made the production origin an open image proxy (bandwidth /
    // Vercel image-optimisation quota abuse, confused-deputy fetches).
    // The repo was audited: nothing imports `next/image` and every image
    // is a local /public file rendered with <img>, so no remote host is
    // needed. Add hosts here explicitly (protocol + full hostname, never
    // "*"/"**") if a remote next/image source is ever introduced, and
    // extend lib/__tests__/next-config.test.ts accordingly.
    remotePatterns: [],
  },
  // Next.js 16 defaults production builds to Turbopack and fails if a
  // webpack() config exists without a turbopack key. Empty config here
  // acknowledges Turbopack; Vercel still runs webpack (see vercel.json)
  // so the isServer-gated AgentKit/x402 aliases below keep applying.
  turbopack: {},
  // AgentKit and its CDP/x402 stack are Node-only. Keep them out of the
  // Next bundler so the browser never receives CDP secrets, signers, or
  // the x402 payment clients.
  serverExternalPackages: [
    "@coinbase/agentkit",
    "@coinbase/coinbase-sdk",
    "@coinbase/x402",
    "@coinbase/cdp-sdk",
],
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // These are optional peer deps pulled in transitively by
      // @metamask/sdk (React Native storage, never used in a browser
      // build) and pino (a pretty-printer for Node dev logging, never
      // used in the browser bundle either). Both only ever produce a
      // harmless "Module not found" compile warning — aliasing them out
      // silences the noise without touching any wallet/Wagmi behavior.
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };

    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@x402/evm/upto/client": false,
        "@x402/evm/exact/client": false,
        "@x402/core/client": false,
        "@x402/svm/exact/client": false,
        "@x402/evm": false,
        "@coinbase/agentkit": false,
      };
    }

    return config;
  },
  async headers() {
    return [
      {
        // Versioned URLs (`?v=` from RUN_ASSET_VERSION) make each art
        // generation unique, so a long-lived cache here is correct and
        // prevents phones from drawing a previous PNG under the same
        // filename. Bump RUN_ASSET_VERSION when replacing artwork.
        source: "/games/mpgr-run/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      // Framing policy (owner-approved 2026-09-20). The two sources below are
      // exact complements of each other, so every path gets exactly one of
      // them regardless of how the host applies overlapping header rules.
      {
        // API routes never render in a frame: keep the legacy header and its
        // CSP equivalent.
        source: "/api/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
      {
        // Pages and static assets. The Farcaster WEB client loads Mini Apps in
        // an <iframe> (mobile clients use a WebView and ignore framing headers),
        // and X-Frame-Options cannot express an allowlist (ALLOW-FROM is
        // obsolete), so CSP frame-ancestors replaces it here. No X-Frame-Options
        // on these paths: browsers without CSP2 would otherwise still refuse
        // the Farcaster host. This CSP sets ONLY frame-ancestors — adding other
        // directives (script-src, connect-src, ...) would affect wallet SDKs
        // and must be a deliberate separate change.
        source: "/((?!api(?:/|$)).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${FRAME_ANCESTORS.join(" ")}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
