import { handleOpenAICompatibleChat } from "@/lib/architecture/ai/openai-compatible-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleOpenAICompatibleChat(request, {
    poolId: "openrouter",
    singleEnv: "OPENROUTER_API_KEY",
    listEnv: "OPENROUTER_API_KEYS",
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    missingKeyError: "OPENROUTER_API_KEY is not configured on the server.",
    unavailableError: "OpenRouter is temporarily unavailable. Please retry shortly.",
    logTag: "openrouter-complete",
    extraHeaders: {
      "HTTP-Referer": "https://mpgrhub.xyz",
      "X-Title": "MPGR HUB",
    },
  });
}
