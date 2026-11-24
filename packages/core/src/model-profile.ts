import { z, type ProviderEndpoint } from "@sinty/sdk";

const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const modelProfileSchema = z.object({
  maxOutputTokens: positiveInt.optional(),
  advanced: z.literal(true).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  top_k: positiveInt.optional(),
  repeat_penalty: z.number().gt(0).max(100).optional(),
  repetition_penalty: z.number().gt(0).max(100).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  reasoningEffort: z.enum(["off", "low", "medium", "high"]).optional(),
  thinkingBudgetTokens: positiveInt.min(1024).optional(),
  promptCache: z.boolean().optional(),
  cacheTtl: z.enum(["5m", "1h"]).optional(),
  promptCacheKey: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if (Object.keys(v).some(k => k !== "maxOutputTokens" && k !== "advanced") && !v.advanced)
    ctx.addIssue({ code: "custom", message: "Advanced parameters require explicit acknowledgement of unknown model support" });
  if (v.repeat_penalty !== undefined && v.repetition_penalty !== undefined)
    ctx.addIssue({ code: "custom", message: "Choose the penalty name required by the server, not both" });
  if (v.promptCache === false && v.cacheTtl !== undefined)
    ctx.addIssue({ code: "custom", message: "Cache TTL cannot be set while Anthropic cache breakpoints are disabled" });
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export const modelProfilesSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*\/\S+$/), modelProfileSchema)
  .refine(v => Object.keys(v).length <= 256, "At most 256 model profiles per agent");
export type ModelProfiles = z.infer<typeof modelProfilesSchema>;
type Provider = { protocol: string; baseUrl?: string | undefined; options?: ProviderEndpoint["options"] };
const numeric = ["temperature", "top_p", "top_k", "repeat_penalty", "repetition_penalty", "frequency_penalty", "presence_penalty"] as const;

function isDeepseekEndpoint(baseUrl: string | undefined): boolean {
  try { return new URL(baseUrl ?? "").hostname === "api.deepseek.com"; } catch { return false; }
}

/** Protocol acceptance is NOT a claim that an individual model supports these parameters. */
export function generationControls(provider: Provider) {
  const protocol = provider.protocol;
  const numericFields = protocol === "openai-compat" ? [...numeric]
    : protocol === "anthropic" ? ["temperature", "top_p", "top_k"]
    : protocol === "openai-responses" ? ["temperature", "top_p"] : [];
  return { protocol, numericFields, reasoning: protocol === "openai-compat" || protocol === "openai-responses",
    reasoningOff: protocol === "openai-compat" && isDeepseekEndpoint(provider.baseUrl),
    thinkingBudget: protocol === "anthropic", cacheBreakpoints: protocol === "anthropic",
    cacheRoutingKey: protocol === "openai-compat" || protocol === "openai-responses", modelSupport: "unknown" as const };
}

export function validateProfile(profile: ModelProfile, provider: Provider, defaultOutput: number): void {
  const controls = generationControls(provider);
  const allowed = new Set<string>(["maxOutputTokens", "advanced", ...controls.numericFields,
    ...(controls.reasoning ? ["reasoningEffort"] : []), ...(controls.thinkingBudget ? ["thinkingBudgetTokens"] : []),
    ...(controls.cacheBreakpoints ? ["promptCache", "cacheTtl"] : []), ...(controls.cacheRoutingKey ? ["promptCacheKey"] : [])]);
  for (const key of Object.keys(profile)) if (!allowed.has(key)) throw new Error("Parameter " + key + " is not implemented for protocol " + provider.protocol);
  if (profile.reasoningEffort === "off" && !controls.reasoningOff) throw new Error("Reasoning off is not implemented for this endpoint");
  if (provider.protocol === "anthropic") {
    const inheritedThinking = provider.options?.thinking;
    const thinking = inheritedThinking && typeof inheritedThinking === "object" && !Array.isArray(inheritedThinking) ? inheritedThinking as Record<string, unknown> : undefined;
    const manualSampling = ["temperature", "top_p", "top_k"].some(key => profile[key as "temperature" | "top_p" | "top_k"] !== undefined);
    if (profile.thinkingBudgetTokens !== undefined && ["temperature", "top_p", "top_k"].some(key => provider.options?.[key] !== undefined))
      throw new Error("Explicit thinking conflicts with configured provider sampling defaults");
    if ((thinking?.type === "enabled" || thinking?.type === "adaptive") && manualSampling)
      throw new Error("Manual sampling conflicts with inherited Anthropic thinking");
    const budget = profile.thinkingBudgetTokens ?? (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : undefined);
    if (Object.keys(profile).some(k => k !== "advanced") && budget !== undefined && budget >= (profile.maxOutputTokens ?? defaultOutput))
      throw new Error("Inherited thinking budget must be smaller than the effective output limit");
    if (profile.temperature !== undefined && profile.temperature > 1) throw new Error("Anthropic temperature must be between 0 and 1");
    if (profile.thinkingBudgetTokens !== undefined && profile.thinkingBudgetTokens >= (profile.maxOutputTokens ?? defaultOutput))
      throw new Error("Thinking budget must be smaller than the effective output limit");
    if (profile.thinkingBudgetTokens !== undefined && (profile.temperature !== undefined || profile.top_p !== undefined || profile.top_k !== undefined))
      throw new Error("Do not combine manual sampling with explicitly enabled Anthropic thinking");
  }
}

/** Empty / absent profiles preserve the old payload, including provider-specific options, exactly. */
export function resolveModelProfile(provider: Provider, profiles: ModelProfiles | undefined, route: string, defaultOutput: number) {
  const profile = profiles?.[route];
  if (!profile || Object.keys(profile).every(k => k === "advanced")) return { maxOutputTokens: defaultOutput, options: provider.options };
  modelProfileSchema.parse(profile);
  validateProfile(profile, provider, defaultOutput);
  const maxOutputTokens = profile.maxOutputTokens ?? defaultOutput;
  const options: Record<string, unknown> = { ...provider.options };
  for (const key of numeric) if (profile[key] !== undefined) options[key] = profile[key];
  if (profile.repeat_penalty !== undefined) delete options.repetition_penalty;
  if (profile.repetition_penalty !== undefined) delete options.repeat_penalty;
  // Native Anthropic spreads endpoint.options after req.maxOutputTokens. Active profiles must agree with reservation.
  if (provider.protocol === "anthropic") options.max_tokens = maxOutputTokens;
  if (profile.reasoningEffort !== undefined) {
    if (provider.protocol === "openai-responses") {
      const old = options.reasoning;
      options.reasoning = { ...(old && typeof old === "object" && !Array.isArray(old) ? old : {}), effort: profile.reasoningEffort, summary: "auto" };
    } else if (profile.reasoningEffort === "off") {
      delete options.reasoning_effort;
      options.thinking = { type: "disabled" };
    } else {
      options.reasoning_effort = profile.reasoningEffort;
      if (generationControls(provider).reasoningOff) options.thinking = { type: "enabled" };
    }
  }
  if (profile.thinkingBudgetTokens !== undefined) options.thinking = { type: "enabled", budget_tokens: profile.thinkingBudgetTokens };
  if (profile.promptCache !== undefined) options.promptCache = profile.promptCache;
  if (profile.cacheTtl !== undefined) options.cacheTtl = profile.cacheTtl;
  if (profile.promptCacheKey !== undefined) options.promptCacheKey = profile.promptCacheKey;
  return { maxOutputTokens, options };
}
