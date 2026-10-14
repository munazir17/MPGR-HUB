import { fetchWithSession } from "@/lib/api/authenticated-fetch";
import { resolveConfiguredProviderKind } from "@/lib/architecture/ai/ai-provider-config";
import {
  autonomyAllowedTargetSymbols,
  conditionalTradeInputError,
  checkAutonomyTarget,
  detectAutonomousTradeRequest,
  validateAutonomyMatch,
  type AutonomyRequestMatch,
} from "./chat-draft";

// Extraction only. No tool catalog, wallet context, addresses, quotes, router,
// signing, or execution capability is given to the model. A percent is anchored
// later by deterministic code reading the live price, never by model output.
export const TRADE_SENTENCE_SYSTEM_PROMPT = [
  "Extract a conditional trade draft from the user's sentence. Return JSON only, or null if it is not a conditional trade.",
  'Exact shape: {"side":"buy"|"sell","symbol":string,"amount":number|string|null,"spendAsset":string,"trigger":{"kind":"price_below","price":number}|{"kind":"percent_drop","percent":number}}.',
  "For buy, spendAsset is USDC. For sell, spendAsset is the named symbol (the asset being sold) and USDC is received. Prices are always USDC per named symbol.",
  "Amount is the spend amount per trade, not the trigger price. Use null if no amount was specified. Never invent an amount or a price.",
  "A worth clause such as worth 1 USDC specifies the spend amount (1 USDC), never an absolute trigger price.",
  "A drop by a percent is percent_drop, not an absolute price. Do not calculate a reference price.",
  "Never supply token addresses, a router, minimum output, a broadcaster, tool calls, or execution instructions.",
  `Supported symbols: ${autonomyAllowedTargetSymbols().join(", ")}. Preserve an unknown symbol so code can refuse it.`,
].join("\n");

/** Narrow routing guard, not the parser: spot swaps/questions stay unchanged. */
export function isConditionalTradeSentence(prompt: string): boolean {
  return prompt.length <= 400 && /\b(?:buy|sell|purchase|accumulate)\b/i.test(prompt) &&
    /\b(?:when|whenever|if|once|falls?|drops?|dips?|below|under|down|each time|every time)\b/i.test(prompt);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Strict schema validation. Extra keys (including transaction fields) fail. */
export function validateTradeSentenceJSON(content: string): AutonomyRequestMatch | null {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (!record(value) || !exactKeys(value, ["side", "symbol", "amount", "spendAsset", "trigger"])) return null;
  if (value.side !== "buy" && value.side !== "sell") return null;
  if (typeof value.symbol !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{1,19}$/.test(value.symbol)) return null;
  if (typeof value.spendAsset !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{1,19}$/.test(value.spendAsset)) return null;
  const amount = typeof value.amount === "number" && Number.isFinite(value.amount) ? String(value.amount) : value.amount;
  if (amount !== null && (typeof amount !== "string" || !/^-?\d+(?:\.\d+)?$/.test(amount))) return null;
  const trigger = value.trigger;
  if (!record(trigger)) return null;
  let triggerPrice = "";
  let percentDrop: number | null = null;
  if (trigger.kind === "price_below" && exactKeys(trigger, ["kind", "price"]) && positiveNumber(trigger.price)) {
    triggerPrice = String(trigger.price);
    // Decimal arithmetic downstream never accepts exponent notation.
    if (!/^\d+(?:\.\d+)?$/.test(triggerPrice)) return null;
  } else if (trigger.kind === "percent_drop" && exactKeys(trigger, ["kind", "percent"]) &&
      positiveNumber(trigger.percent) && trigger.percent <= 50) {
    percentDrop = trigger.percent;
  } else return null;
  return {
    side: value.side,
    targetAsset: value.symbol,
    spendAsset: value.spendAsset,
    amountPerTrade: amount,
    triggerKind: "price_below",
    triggerPrice,
    percentDrop,
  };
}

export type TradeSentenceParseResult = { match: AutonomyRequestMatch; error?: never } | { error: string; match?: never };
type Completion = (systemPrompt: string, userPrompt: string) => Promise<string>;

async function complete(systemPrompt: string, userPrompt: string): Promise<string> {
  // Honor OpenAI only when explicitly configured. No vendor fallback chain:
  // unavailable/invalid extraction falls back to our local regex instead.
  const path = resolveConfiguredProviderKind() === "openai" ? "/api/agent/complete" : "/api/agent/complete/gemini";
  const response = await fetchWithSession(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ systemPrompt, userPrompt }),
  });
  if (!response.ok) throw new Error("Trade extraction unavailable");
  const payload: unknown = await response.json();
  if (!record(payload) || typeof payload.content !== "string") throw new Error("Missing extraction JSON");
  return payload.content;
}

export async function parseTradeSentence(prompt: string, completion: Completion = complete): Promise<TradeSentenceParseResult> {
  const inputError = conditionalTradeInputError(prompt);
  if (inputError) return { error: inputError };
  const literal = detectAutonomousTradeRequest(prompt);
  let match: AutonomyRequestMatch | null = null;
  try { match = validateTradeSentenceJSON(await completion(TRADE_SENTENCE_SYSTEM_PROMPT, prompt)); } catch { /* local fallback */ }
  // Schema-valid JSON can still misread a worth amount as a price. When the
  // literal syntax is understood, its explicit constraints cannot be changed
  // by extraction. Novel syntax still uses the validated model normally.
  if (literal && match &&
      ((checkAutonomyTarget(match.targetAsset).symbol ?? match.targetAsset).toUpperCase() !== (checkAutonomyTarget(literal.targetAsset).symbol ?? literal.targetAsset).toUpperCase() ||
       match.side !== literal.side || match.triggerKind !== literal.triggerKind ||
       match.triggerPrice !== literal.triggerPrice || match.percentDrop !== literal.percentDrop ||
       (literal.amountPerTrade !== null && match.amountPerTrade !== literal.amountPerTrade) ||
       match.spendAsset.toUpperCase() !== literal.spendAsset.toUpperCase())) match = literal;
  match ??= literal;
  if (!match) return { error: "I couldn't parse that conditional trade. Give a symbol and a price below or percent drop. Nothing was created or executed." };
  const target = checkAutonomyTarget(match.targetAsset);
  if (!target.ok) return { error: target.reason! };
  const error = validateAutonomyMatch(match);
  if (error) return { error };
  return { match: { ...match, targetAsset: target.symbol!, spendAsset: match.side === "sell" ? target.symbol! : "USDC" } };
}
