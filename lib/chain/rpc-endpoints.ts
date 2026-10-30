// Public Base endpoints and list parsing. This module must not read
// BASE_RPC_URL or any other server secret: wagmi imports it into the
// browser bundle. Server-only URLs are assembled in trade-public-client
// and executor-chain.

export const PUBLIC_BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://base.meowrpc.com",
] as const;

export function parseEndpointList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** https, or http only for local tests. Drops anything else so a bad env
 * value cannot redirect chain reads. */
export function isUsableRpcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

export function uniqueRpcUrls(urls: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const url = raw?.trim();
    if (!url || !isUsableRpcUrl(url) || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

/** Browser transport. Never includes server RPC secrets. */
export function browserRpcUrls(publicUrl: string | undefined = process.env.NEXT_PUBLIC_BASE_RPC_URL): string[] {
  return uniqueRpcUrls([publicUrl, ...PUBLIC_BASE_RPC_URLS]);
}
