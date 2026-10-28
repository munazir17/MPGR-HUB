import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { enforceRateLimit, requestIdFromRequest, verifyTrustedOrigin, withRequestId } from "@/lib/api/request-guard";
import { readApiKeys, rotateApiKeys } from "@/lib/architecture/ai/api-key-pool";
import { resolveNvidiaAsrModel, transcribeWithNvidia } from "@/lib/agent/nvidia-asr";

// Mic → NVIDIA Parakeet. Returns text only. The existing agent composer
// decides whether that text is a buy or a sell, and the wallet still signs.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 2_000_000;

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const auth = await authenticateRequest(request);
  if (!auth) return respond({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401 });
  const rateError = await enforceRateLimit(request, "ai-voice", 12, 60);
  if (rateError) return withRequestId(rateError, requestId);

  const keys = rotateApiKeys("nvidia", readApiKeys("NVIDIA_API_KEY", "NVIDIA_API_KEYS"));
  if (keys.length === 0) {
    return respond(
      { error: "NVIDIA speech is not configured. Nothing was traded.", code: "VOICE_UNCONFIGURED" },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return respond({ error: "Send an audio recording.", code: "INVALID_INPUT" }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size < 80 || audio.size > MAX_AUDIO_BYTES) {
    return respond({ error: "Recording was empty or too long. Nothing was traded.", code: "INVALID_INPUT" }, { status: 400 });
  }
  if (audio.type && !audio.type.startsWith("audio/") && audio.type !== "application/octet-stream") {
    return respond({ error: "Recording must be audio.", code: "INVALID_INPUT" }, { status: 400 });
  }

  try {
    const result = await transcribeWithNvidia(audio, keys[0]);
    return respond({ transcript: result.transcript, model: result.model });
  } catch {
    return respond(
      { error: "Could not transcribe that. Nothing was traded.", code: "VOICE_UNAVAILABLE", model: resolveNvidiaAsrModel() },
      { status: 502 },
    );
  }
}
