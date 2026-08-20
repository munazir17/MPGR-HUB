import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../agent-tool-schema-validator";
import type { AgentToolSchema } from "../agent-tool";

const walletSchema: AgentToolSchema = {
  type: "object",
  properties: {
    walletAddress: { type: "string" },
    limit: { type: "number" },
  },
  required: ["walletAddress"],
};

describe("validateAgainstSchema", () => {
  it("accepts valid input", () => {
    const result = validateAgainstSchema({ walletAddress: "0xabc" }, walletSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a missing required field", () => {
    const result = validateAgainstSchema({}, walletSchema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("walletAddress"))).toBe(true);
  });

  it("rejects the wrong type for a field", () => {
    const result = validateAgainstSchema({ walletAddress: 123 }, walletSchema);
    expect(result.valid).toBe(false);
  });

  it("rejects non-object input entirely", () => {
    const result = validateAgainstSchema("not an object", walletSchema);
    expect(result.valid).toBe(false);
  });

  it("enforces enum membership", () => {
    const schema: AgentToolSchema = {
      type: "object",
      properties: { scope: { type: "string", enum: ["overview", "trending"] } },
      required: ["scope"],
    };
    expect(validateAgainstSchema({ scope: "trending" }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ scope: "nonsense" }, schema).valid).toBe(false);
  });

  it("ignores optional fields that are absent", () => {
    const result = validateAgainstSchema({ walletAddress: "0xabc" }, walletSchema);
    expect(result.valid).toBe(true);
  });
});

