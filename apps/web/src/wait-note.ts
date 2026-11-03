import type { Pending } from "./api.js";

/** What the user has to do while the sidebar shows «Ждут ответа». */
export function waitNote(p: Pending, background = false): string {
  const where = background ? "Фоновая задача. " : "";
  if (p.reason === "ask_human") return `${where}${p.detail?.trim() || "Агент ждёт ваш ответ."}`;
  if (p.reason === "approval") {
    const tools = [...new Set(p.approvals.map((a) => a.tool))].filter(Boolean).join(", ");
    return `${where}Нужно одобрить${tools ? `: ${tools}` : " действие"}.`;
  }
  if (p.reason === "budget") return `${where}Бюджет хода исчерпан. Напишите сообщение, чтобы продолжить.`;
  return `${where}Супервизор остановил ход. Напишите сообщение, чтобы продолжить.`;
}
