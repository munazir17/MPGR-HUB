import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_MAX_GAP_MS,
  heartbeatsCoverDuration,
  type ServerGameSession,
} from "./server-session";

function session(overrides: Partial<ServerGameSession> = {}): ServerGameSession {
  const created = Date.now() - 5_000;
  return {
    sessionId: "session-1",
    wallet: "0x1111111111111111111111111111111111111111",
    gameId: "mpgr-run",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + 15 * 60 * 1000).toISOString(),
    heartbeats: [created],
    ...overrides,
  };
}

describe("game session heartbeats", () => {
  it("accepts short runs inside the grace window without extra pings", () => {
    expect(heartbeatsCoverDuration(session(), 4_000)).toBe(true);
  });

  it("rejects a long claimed duration with a gap larger than the max heartbeat interval", () => {
    const created = Date.now() - 40_000;
    const beats = [created, created + HEARTBEAT_MAX_GAP_MS + 5_000];
    expect(
      heartbeatsCoverDuration(
        session({
          createdAt: new Date(created).toISOString(),
          heartbeats: beats,
        }),
        40_000,
      ),
    ).toBe(false);
  });

  it("accepts a long run whose pings stay inside the max gap", () => {
    const created = Date.now() - 24_000;
    const beats = [created, created + 8_000, created + 16_000, created + 24_000];
    expect(
      heartbeatsCoverDuration(
        session({
          createdAt: new Date(created).toISOString(),
          heartbeats: beats,
        }),
        20_000,
      ),
    ).toBe(true);
  });
});
