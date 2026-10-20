/**
 * Masks what must not end up in incident memory, notices or the supervisor view: secret-looking fields, text typed
 * into pages (web.interact "type" actions can be passwords), secret query parameters and long contents.
 * Used on tool arguments before they are summarized (maskArgs) and on stored text (scrubText).
 */

export const HIDDEN = "[hidden]";

const SECRET_WORDS = ["password", "passwd", "passphrase", "secret", "token", "apikey", "authorization", "cookie", "credential", "privatekey", "sessionid", "otp", "cvv", "pincode"];
const SECRET_EXACT = new Set(["pass", "pwd", "pin", "auth", "key", "sig", "signature"]);

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_\s.]/g, "");
  return SECRET_EXACT.has(k) || SECRET_WORDS.some((w) => k.includes(w));
}

/** Action kinds whose `text`/`value` is typed into a page. */
const TYPING = new Set(["type", "fill", "input", "insert", "settext", "setvalue"]);

/** A copy of tool arguments with secrets hidden and long strings cut to `maxString` characters. */
export function maskArgs(args: unknown, maxString = 120): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return cutString(scrubText(v), maxString);
    if (v === null || typeof v !== "object" || depth > 8) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const kind = [o.type, o.action, o.kind, o.op].find((x) => typeof x === "string") as string | undefined;
    const typing = kind !== undefined && TYPING.has(kind.toLowerCase());
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (isSecretKey(k) && x !== null && x !== undefined && x !== "") out[k] = HIDDEN;
      else if (typing && (k === "text" || k === "value") && typeof x === "string" && x !== "") out[k] = HIDDEN;
      else out[k] = walk(x, depth + 1);
    }
    return out;
  };
  return walk(args, 0);
}

function cutString(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[${s.length} chars]` : s;
}

/** A JSON string literal, possibly cut off at the end of the text. */
const STR = String.raw`"(?:[^"\\]|\\.)*(?:"|$)`;
const KEY_VALUE = new RegExp(String.raw`"([A-Za-z0-9_\-. ]{1,40})"(\s*:\s*)(${STR})`, "g");
const TYPED_AFTER = new RegExp(String.raw`("(?:type|action|kind)"\s*:\s*"(?:type|fill|input|insert)"[^{}]*?"(?:text|value)"\s*:\s*)${STR}`, "gi");
const TYPED_BEFORE = new RegExp(String.raw`("(?:text|value)"\s*:\s*)${STR}([^{}]*?"(?:type|action|kind)"\s*:\s*"(?:type|fill|input|insert)")`, "gi");
const QUERY = /([?&](?:password|passwd|pass|pwd|token|access_token|refresh_token|api_key|apikey|key|secret|auth|sig|signature|session|sessionid)=)[^&#\s"']+/gi;
const PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_]{20,}\b/g,
  /\bsnt_[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
];

/**
 * Masks secrets inside free text that may contain JSON (fix summaries, notices, old journal rows): values of
 * secret-looking keys, typed text of page actions, secret query parameters, known token shapes; JSON string values
 * longer than `maxValue` are cut. Idempotent.
 */
export function scrubText(text: string, maxValue = 160): string {
  let t = text.replace(TYPED_AFTER, `$1"${HIDDEN}"`).replace(TYPED_BEFORE, `$1"${HIDDEN}"$2`);
  t = t.replace(KEY_VALUE, (m, key: string, sep: string, value: string) => {
    if (isSecretKey(key) && value !== '""') return `"${key}"${sep}"${HIDDEN}"`;
    const inner = value.endsWith('"') && value.length > 1 ? value.slice(1, -1) : value.slice(1);
    if (inner.length > maxValue) return `"${key}"${sep}"${inner.slice(0, Math.min(80, maxValue)).replace(/\\+$/, "")}…[${inner.length} chars]"`;
    return m;
  });
  t = t.replace(QUERY, `$1${HIDDEN}`);
  for (const re of PATTERNS) t = t.replace(re, (m, p1?: string) => (typeof p1 === "string" && p1.startsWith("Bearer") ? `${p1}${HIDDEN}` : HIDDEN));
  return t;
}
