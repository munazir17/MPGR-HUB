import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

/** Vercel env values are often pasted with a trailing newline or wrapping quotes.
 *  Either one makes every Upstash command fail, which surfaces as a 503 before SIWE. */
function cleanSecret(value: string | undefined): string {
  if (!value) return "";
  let next = value.trim();
  if (
    (next.startsWith("\"") && next.endsWith("\"")) ||
    (next.startsWith("'") && next.endsWith("'"))
  ) {
    next = next.slice(1, -1).trim();
  }
  return next;
}

export function getRedis(): Redis {
  if (redis) return redis;

  const url = cleanSecret(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL);
  const token = cleanSecret(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN);

  if (!url || !token) {
    throw new Error(
      "Upstash Redis environment variables are missing. Expected UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  if (!url.startsWith("https://")) {
    throw new Error("UPSTASH_REDIS_REST_URL must be the REST https:// endpoint, not a redis:// URL.");
  }

  redis = new Redis({ url, token });
  return redis;
}
