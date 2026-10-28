import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNvidiaAsrModel, transcriptFromNvidiaBody, transcribeWithNvidia } from "./nvidia-asr";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("NVIDIA Parakeet ASR", () => {
  it("defaults to the free hosted Parakeet model", () => {
    vi.stubEnv("NVIDIA_ASR_MODEL", "");
    expect(resolveNvidiaAsrModel()).toBe("nvidia/parakeet-ctc-1.1b-asr");
    expect(resolveNvidiaAsrModel(" nvidia/nemotron-speech ")).toBe("nvidia/nemotron-speech");
  });

  it("reads text or transcript and ignores empty bodies", () => {
    expect(transcriptFromNvidiaBody({ text: "  buy 10 USDC of AAPLc  " })).toBe("buy 10 USDC of AAPLc");
    expect(transcriptFromNvidiaBody({ transcript: "sell MPGR" })).toBe("sell MPGR");
    expect(transcriptFromNvidiaBody({ text: "  " })).toBeNull();
    expect(transcriptFromNvidiaBody(null)).toBeNull();
  });

  it("posts audio to NVIDIA and never puts the key in the thrown error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "sell 5 MPGR for ETH" }), { status: 200 }));
    const result = await transcribeWithNvidia(new Blob(["abc"], { type: "audio/webm" }), "nvapi-secret", fetchImpl);
    expect(result).toEqual({ transcript: "sell 5 MPGR for ETH", model: "nvidia/parakeet-ctc-1.1b-asr" });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://integrate.api.nvidia.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer nvapi-secret");
    fetchImpl.mockResolvedValueOnce(new Response("no", { status: 429 }));
    await expect(transcribeWithNvidia(new Blob(["abc"]), "nvapi-secret", fetchImpl)).rejects.toThrow(/transcription failed/);
  });
});
