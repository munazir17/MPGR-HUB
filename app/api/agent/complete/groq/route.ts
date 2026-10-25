import { handleOpenAICompatibleChat } from "@/lib/architecture/ai/openai-compatible-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleOpenAICompatibleChat(request, {
    poolId: "groq",
    singleEnv: "GROQ_API_KEY",
    listEnv: "GROQ_API_KEYS",
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelEnv: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile",
    missingKeyError: "GROQ_API_KEY is not configured on the server.",
    unavailableError: "Groq is temporarily unavailable. Please retry shortly.",
    logTag: "groq-complete",
    jsonMode: true,
  });
}
