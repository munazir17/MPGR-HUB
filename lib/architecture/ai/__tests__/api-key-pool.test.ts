import { afterEach, describe, expect, it } from "vitest";
import { isRetryableProviderStatus, readApiKeys, resetApiKeyCursorsForTests, rotateApiKeys } from "../api-key-pool";

afterEach(() => {
  resetApiKeyCursorsForTests();
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEYS;
});

describe("AI key pool", () => {
  it("reads one key and a list without duplicates", () => {
    process.env.GEMINI_API_KEY = "key-a";
    process.env.GEMINI_API_KEYS = "key-b, key-a key-c";
    expect(readApiKeys("GEMINI_API_KEY", "GEMINI_API_KEYS")).toEqual(["key-a", "key-b", "key-c"]);
  });

  it("rotates the starting key and retries a rate limit status", () => {
    expect(rotateApiKeys("gemini", ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(rotateApiKeys("gemini", ["a", "b", "c"])).toEqual(["b", "c", "a"]);
    expect(isRetryableProviderStatus(429)).toBe(true);
    expect(isRetryableProviderStatus(503)).toBe(true);
    expect(isRetryableProviderStatus(400)).toBe(false);
  });
});
