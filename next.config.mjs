/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  // AgentKit and its CDP/x402 stack are Node-only. Keep them out of the
  // Next bundler so the browser never receives CDP secrets, signers, or
  // the x402 payment clients.
  serverExternalPackages: [
    "@coinbase/agentkit",
    "@coinbase/coinbase-sdk",
    "@coinbase/x402",
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
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
