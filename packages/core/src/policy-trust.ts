/** Detect user phrases that grant session-scoped policy trust (skip `ask`, keep `deny`). */

const PHRASES: RegExp[] = [
  /не\s+(надо\s+|нужно\s+)?спрашива/i,
  /можно\s+не\s+спрашива/i,
  /без\s+подтвержден/i,
  /разрешаю\s+вс[её]/i,
  /делай\s+вс[её]\s+что\s+(нужно|требуется|надо)/i,
  /\bdon'?t\s+ask\b/i,
  /\bdo\s+not\s+ask\b/i,
  /\bjust\s+do\s+it\b/i,
  /\bno\s+need\s+to\s+ask\b/i,
  /\bwithout\s+confirm/i,
  /\ballow\s+everything\b/i,
  /\bdo\s+whatever\s+you\s+(need|want)\b/i,
];

export function detectPolicyTrustPhrase(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return false;
  return PHRASES.some((re) => re.test(t));
}
