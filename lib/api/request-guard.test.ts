import { describe, expect, it } from "vitest";
import { readJsonBody, requestIdFromRequest } from "./request-guard";

describe("request guard", () => {
  it("rejects a body larger than the byte limit", async () => {
    const request = new Request("http://localhost/api/xp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(17 * 1024),
    });
    const parsed = await readJsonBody(request, 16 * 1024);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(413);
  });

  it("rejects invalid JSON inside the size limit", async () => {
    const request = new Request("http://localhost/api/xp", {
      method: "POST",
      body: "{not-json",
    });
    const parsed = await readJsonBody(request);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(400);
  });

  it("accepts a valid JSON object and prefers a well-formed request id", async () => {
    const request = new Request("http://localhost/api/xp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-123" },
      body: JSON.stringify({ action: "DAILY_CHECK_IN" }),
    });
    const parsed = await readJsonBody<{ action: string }>(request);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.action).toBe("DAILY_CHECK_IN");
    expect(requestIdFromRequest(request)).toBe("req-123");
  });
});
