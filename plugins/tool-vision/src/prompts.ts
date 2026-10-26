export type VisionMode = "describe" | "ocr" | "find";

const BASE =
  "You are looking at one image provided by the user. Answer in the same language as the human prompt when one is given; otherwise use the language of any text visible in the image, or English if there is none. Be concrete. Do not invent details that are not visible.";

export function buildPrompt(mode: VisionMode, prompt?: string, paths?: string[]): string {
  const extra = prompt?.trim() ?? "";
  const body =
    mode === "ocr"
      ? [
          BASE,
          "Extract all readable text from the image. Preserve reading order roughly top-to-bottom, left-to-right. Keep line breaks where they matter. If there is no text, say so in one short sentence.",
          extra ? `Extra instructions from the agent:\n${extra}` : "",
        ]
      : mode === "find"
        ? [
            BASE,
            "Search the image for what the agent asks. Say whether it is present, where (rough region), and what you see. If absent, say that clearly.",
            extra ? `Look for / answer:\n${extra}` : "Describe anything notable; the agent did not name a target.",
          ]
        : [
            BASE,
            "Describe the image: subject, layout, notable text, UI chrome if any, and anything that would help an agent decide next steps. Keep it under ~20 short sentences unless the agent asks for more.",
            extra ? `Focus / extra instructions:\n${extra}` : "",
          ];
  const text = body.filter(Boolean).join("\n\n");
  if (!paths || paths.length <= 1) return text;
  const list = paths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  return [
    text.replace("You are looking at one image", `You are looking at ${paths.length} images, in the order listed below`),
    `Images, in order:\n${list}`,
    "Answer every image separately. Begin each answer with a heading that is the exact path from the list. Do not skip an image and do not merge two images into one answer.",
  ].join("\n\n");
}
