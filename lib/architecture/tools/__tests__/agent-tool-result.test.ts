import { describe, expect, it } from "vitest";
import { toolError, toolSuccess } from "../agent-tool-result";

describe("AgentToolResult builders", () => {
  it("builds a successful result", () => {
    const result = toolSuccess("wallet_analyzer", { balance: 100 });
    expect(result.success).toBe(true);
    expect(result.toolId).toBe("wallet_analyzer");
    expect(result.data).toEqual({ balance: 100 });
    expect(result.error).toBeUndefined();
    expect(typeof result.metadata.timestamp).toBe("string");
  });

  it("builds a structured error result", () => {
    const result = toolError("token_analyzer", { code: "DATA_UNAVAILABLE", message: "No price feed for this token." });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("DATA_UNAVAILABLE");
    expect(result.error?.message).toBe("No price feed for this token.");
  });

  it("marks a retryable error explicitly", () => {
    const result = toolError("market_intelligence", { code: "RATE_LIMITED", message: "Too many requests.", retryable: true });
    expect(result.error?.retryable).toBe(true);
  });

  it("defaults retryable to undefined (not true) for a deterministic failure", () => {
    const result = toolError("token_analyzer", { code: "INVALID_ADDRESS", message: "Not a valid address." });
    expect(result.error?.retryable).toBeUndefined();
  });

  it("represents an unavailable/not-implemented tool honestly", () => {
    const result = toolError("base_research", {
      code: "TOOL_NOT_IMPLEMENTED",
      message: '"Base Research" is defined but not yet implemented.',
      retryable: false,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_IMPLEMENTED");
    expect(result.data).toBeUndefined();
  });

  it("every metadata object carries a timestamp even when the caller supplies partial metadata", () => {
    const result = toolSuccess("token_analyzer", { price: 1 }, { source: "test-source" });
    expect(result.metadata.source).toBe("test-source");
    expect(result.metadata.timestamp).toBeTruthy();
  });
});
