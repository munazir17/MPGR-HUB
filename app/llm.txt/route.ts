// /llm.txt — machine-readable MPGR Agent summary (public config only, no secrets).
import { buildLlmTxt } from "@/lib/mcp/llm-txt";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(buildLlmTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
