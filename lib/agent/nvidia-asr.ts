// NVIDIA hosted Parakeet ASR. The browser never sees NVIDIA_API_KEY.
// A transcript is text for the existing agent composer. This module does
// not quote, sign, or broadcast a swap.

export const DEFAULT_NVIDIA_ASR_MODEL = "nvidia/parakeet-ctc-1.1b-asr";
const DEFAULT_BASE = "https://integrate.api.nvidia.com/v1";

export function resolveNvidiaAsrModel(model = process.env.NVIDIA_ASR_MODEL): string {
  const value = model?.trim();
  return value && value.length > 0 ? value : DEFAULT_NVIDIA_ASR_MODEL;
}

export function nvidiaAsrUrl(base = process.env.NVIDIA_BASE_URL): string {
  const value = base?.trim().replace(/\/$/, "");
  return `${value && value.length > 0 ? value : DEFAULT_BASE}/audio/transcriptions`;
}

export function transcriptFromNvidiaBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["text", "transcript"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 500);
  }
  return null;
}

export async function transcribeWithNvidia(
  audio: Blob,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ transcript: string; model: string }> {
  const model = resolveNvidiaAsrModel();
  const form = new FormData();
  form.set("file", audio, "speech.webm");
  form.set("model", model);
  form.set("language", "en-US");
  form.set("response_format", "json");
  const response = await fetchImpl(nvidiaAsrUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    body: form,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("NVIDIA speech transcription failed");
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  const transcript = transcriptFromNvidiaBody(payload);
  if (!transcript) throw new Error("NVIDIA speech transcription was empty");
  return { transcript, model };
}
