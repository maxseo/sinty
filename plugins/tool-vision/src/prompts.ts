export type VisionMode = "describe" | "ocr" | "find";

const BASE =
  "You are looking at one image provided by the user. Answer in the same language as the human prompt when one is given; otherwise use the language of any text visible in the image, or English if there is none. Be concrete. Do not invent details that are not visible.";

export function buildPrompt(mode: VisionMode, prompt?: string): string {
  const extra = prompt?.trim() ?? "";
  if (mode === "ocr") {
    return [
      BASE,
      "Extract all readable text from the image. Preserve reading order roughly top-to-bottom, left-to-right. Keep line breaks where they matter. If there is no text, say so in one short sentence.",
      extra ? `Extra instructions from the agent:\n${extra}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (mode === "find") {
    return [
      BASE,
      "Search the image for what the agent asks. Say whether it is present, where (rough region), and what you see. If absent, say that clearly.",
      extra ? `Look for / answer:\n${extra}` : "Describe anything notable; the agent did not name a target.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    BASE,
    "Describe the image: subject, layout, notable text, UI chrome if any, and anything that would help an agent decide next steps. Keep it under ~20 short sentences unless the agent asks for more.",
    extra ? `Focus / extra instructions:\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

