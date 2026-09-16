import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_PROMPT_LIMITS, compactPromptInputs, isPromptLimitError, validatePromptInputs } from "../server-policy";
import { sendCompletion } from "../openai-ai-provider";

describe("OpenAI prompt budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("compacts oversized system and history without dropping the head", () => {
    const system = "SAFETY FIRST.\n" + "x".repeat(AI_PROMPT_LIMITS.systemChars + 4000);
    const user = "old history ".repeat(4000) + "\nLATEST USER QUESTION";
    const compacted = compactPromptInputs(system, user);
    expect(compacted.compacted).toBe(true);
    expect(compacted.systemPrompt.startsWith("SAFETY FIRST.")).toBe(true);
    expect(compacted.systemPrompt.length).toBeLessThanOrEqual(AI_PROMPT_LIMITS.systemChars);
    expect(compacted.userPrompt.length).toBeLessThanOrEqual(AI_PROMPT_LIMITS.userChars);
    expect(compacted.userPrompt).toContain("LATEST USER QUESTION");
    expect(validatePromptInputs(compacted.systemPrompt, compacted.userPrompt)).toBeNull();
  });

  it("never returns a user prompt longer than 8000 characters", () => {
    const compacted = compactPromptInputs("ok", "y".repeat(20_000) + "END");
    expect(compacted.userPrompt.length).toBeLessThanOrEqual(8000);
    expect(compacted.userPrompt.length).toBe(8000);
    expect(compacted.userPrompt.endsWith("END")).toBe(true);
  });

  it("retries once when the server reports a prompt limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Prompt exceeds server limits" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: "{\"intent\":\"general_help\",\"reply\":\"ok\"}" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const content = await sendCompletion("sys", "user question");
    expect(content).toContain("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after compact retry still fails so fallback can run", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Prompt exceeds server limits" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendCompletion("sys", "user")).rejects.toThrow(/Prompt exceeds server limits/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("detects provider limit errors", () => {
    expect(isPromptLimitError("Prompt exceeds server limits")).toBe(true);
    expect(isPromptLimitError("context_length_exceeded")).toBe(true);
    expect(isPromptLimitError("Authentication required")).toBe(false);
  });
});
