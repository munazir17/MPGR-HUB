import { getRedis } from "@/lib/api/redis";

export const authRedis = {
  get: <T>(...args: Parameters<ReturnType<typeof getRedis>["get"]>) =>
    getRedis().get<T>(...args),
  set: (...args: Parameters<ReturnType<typeof getRedis>["set"]>) =>
    getRedis().set(...args),
  eval: (...args: Parameters<ReturnType<typeof getRedis>["eval"]>) =>
    getRedis().eval(...args),
};

export async function consumeAuthNonce(nonce: string): Promise<boolean> {
  const result = await getRedis().eval(
    `local v = redis.call("GET", KEYS[1]); if v == "unused" then redis.call("DEL", KEYS[1]); return 1 else return 0 end`,
    [`mpgrhub:auth:nonce:${nonce}`],
    [],
  );

  return Number(result) === 1;
}
