import { describe, expect, it } from "vitest";
import {
  AGENT_GENERIC_USER_ERROR,
  AGENT_REQUEST_TOO_LARGE_USER_ERROR,
  sanitizeAgentUserError,
} from "./sanitize-agent-user-error";

describe("sanitizeAgentUserError", () => {
  it("hides raw NVIDIA provider errors from the frontend banner", () => {
    expect(sanitizeAgentUserError("[nvidia] Request body too large")).toBe(
      AGENT_REQUEST_TOO_LARGE_USER_ERROR,
    );
    expect(sanitizeAgentUserError("[nvidia] Request body too large")).not.toMatch(/nvidia/i);
  });

  it("hides Gemini failure / fallback copy from users", () => {
    const raw =
      "MPGR Agent's gemini connection is currently failing — replies are falling back to the on-device engine.";
    expect(sanitizeAgentUserError(raw)).toBe(AGENT_GENERIC_USER_ERROR);
    expect(sanitizeAgentUserError(raw)).not.toMatch(/gemini|on-device|429|502/i);
  });

  it("does not rewrite a successful Agent-style user message", () => {
    const reply = "Prepared a Coinbase B20 tokenized-stock swap preview for AAPLc.";
    expect(sanitizeAgentUserError(reply)).toBe(reply);
  });
});
