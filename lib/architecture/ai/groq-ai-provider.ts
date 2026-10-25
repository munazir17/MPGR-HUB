import { OpenAIAIProvider } from "./openai-ai-provider";

/** Groq's free OpenAI-compatible API. The key stays on /api/agent/complete/groq. */
export class GroqAIProvider extends OpenAIAIProvider {
  constructor() {
    super("groq", "/api/agent/complete/groq");
  }
}
