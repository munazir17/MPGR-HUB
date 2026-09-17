import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithSession } from "./authenticated-fetch";

describe("fetchWithSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always sends the HttpOnly session cookie (credentials: include)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithSession("/api/trade/stocks/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "AAPLc", amount: "50" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
  });
});
