import type { ModelInfo } from "./plugin.js";

type WireModel = Record<string, unknown> & { id?: unknown; top_provider?: Record<string, unknown> };

/**
 * `GET /models` → ids and, when the server says so, the context window. OpenAI and DeepSeek send ids only; other
 * OpenAI-compatible servers add one of: `context_length` (OpenRouter, Together), `context_window` (Groq),
 * `max_model_len` (vLLM), `max_context_length` (Mistral), `max_input_tokens`.
 */
export function openAIModelList(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  return (data as WireModel[])
    .filter((m) => m && typeof m.id === "string")
    .map((m) => {
      const contextWindow = num(m.max_input_tokens) ?? num(m.context_length) ?? num(m.top_provider?.context_length) ?? num(m.context_window) ?? num(m.max_model_len) ?? num(m.max_context_length);
      const maxOutputTokens = num(m.max_completion_tokens) ?? num(m.top_provider?.max_completion_tokens) ?? num(m.max_output_tokens);
      return { id: m.id as string, ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}) };
    });
}
