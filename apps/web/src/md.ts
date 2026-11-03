import { lexer, type Token, type Tokens } from "marked";

export type MdTag =
  | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "ul" | "ol" | "li" | "strong" | "em" | "del" | "blockquote" | "code"
  | "table" | "thead" | "tbody" | "tr" | "th" | "td";

export type MdNode =
  | { kind: "text"; text: string }
  | { kind: "br" }
  | { kind: "hr" }
  | { kind: "check"; on: boolean }
  | { kind: "pre"; text: string; lang?: string }
  | { kind: "img"; alt: string; src: string }
  | { kind: "a"; href: string; children: MdNode[] }
  | { kind: "el"; tag: MdTag; start?: number; align?: "left" | "center" | "right"; children: MdNode[] };

const BLOCK = new Set(["paragraph", "heading", "list", "list_item", "code", "blockquote", "table", "hr", "html", "space"]);

/** A link the chat may open. Anything else, including script URLs, is dropped. */
export function safeHref(href: string): string | null {
  const raw = href.trim();
  if (!raw || /[\u0000-\u001F\u007F]/.test(raw) || raw.startsWith("//")) return null;
  if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return raw;
  } catch {
    return null;
  }
  return null;
}

function safeImage(href: string): string | null {
  const raw = safeHref(href);
  return raw && /^https?:/i.test(raw) ? raw : null;
}

function langOf(lang: string | undefined): string | undefined {
  const clean = lang?.trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z0-9_+-]+$/.test(clean) ? clean : undefined;
}

function text(value: string): MdNode[] {
  return value ? [{ kind: "text", text: value }] : [];
}

function inline(tok: Token): MdNode[] {
  switch (tok.type) {
    case "text":
    case "escape": {
      const t = tok as Tokens.Text | Tokens.Escape;
      return "tokens" in t && t.tokens?.length ? t.tokens.flatMap(inline) : text(t.text);
    }
    case "strong":
    case "em":
    case "del": {
      const t = tok as Tokens.Strong | Tokens.Em | Tokens.Del;
      const tag = tok.type === "strong" ? "strong" : tok.type === "em" ? "em" : "del";
      return [{ kind: "el", tag, children: t.tokens.flatMap(inline) }];
    }
    case "codespan":
      return [{ kind: "el", tag: "code", children: text((tok as Tokens.Codespan).text) }];
    case "br":
      return [{ kind: "br" }];
    case "link": {
      const t = tok as Tokens.Link;
      const children = t.tokens.flatMap(inline);
      const href = safeHref(t.href);
      if (!href) return children.length ? children : text(t.text);
      return [{ kind: "a", href, children }];
    }
    case "image": {
      const t = tok as Tokens.Image;
      const src = safeImage(t.href);
      return src ? [{ kind: "img", alt: t.text, src }] : text(t.text);
    }
    case "checkbox":
    case "html":
      return tok.type === "html" ? text((tok as Tokens.HTML).text) : [];
    default:
      if ("tokens" in tok && Array.isArray(tok.tokens)) return tok.tokens.flatMap(inline);
      if ("text" in tok && typeof tok.text === "string") return text(tok.text);
      return [];
  }
}

function block(tok: Token): MdNode[] {
  switch (tok.type) {
    case "space":
    case "def":
      return [];
    case "paragraph":
      return [{ kind: "el", tag: "p", children: (tok as Tokens.Paragraph).tokens.flatMap(inline) }];
    case "heading": {
      const t = tok as Tokens.Heading;
      const depth = Math.min(6, Math.max(1, t.depth));
      return [{ kind: "el", tag: `h${depth}` as MdTag, children: t.tokens.flatMap(inline) }];
    }
    case "code": {
      const t = tok as Tokens.Code;
      const lang = langOf(t.lang);
      return [lang ? { kind: "pre", text: t.text, lang } : { kind: "pre", text: t.text }];
    }
    case "blockquote":
      return [{ kind: "el", tag: "blockquote", children: (tok as Tokens.Blockquote).tokens.flatMap(nodes) }];
    case "hr":
      return [{ kind: "hr" }];
    case "list": {
      const t = tok as Tokens.List;
      const start = t.ordered && typeof t.start === "number" && t.start !== 1 ? t.start : undefined;
      return [{
        kind: "el",
        tag: t.ordered ? "ol" : "ul",
        ...(start ? { start } : {}),
        children: t.items.map((item): MdNode => ({
          kind: "el",
          tag: "li",
          children: [
            ...(item.task ? [{ kind: "check" as const, on: item.checked === true }] : []),
            ...item.tokens.flatMap(nodes),
          ],
        })),
      }];
    }
    case "table": {
      const t = tok as Tokens.Table;
      const cell = (c: Tokens.TableCell, tag: "th" | "td"): MdNode => ({
        kind: "el",
        tag,
        ...(c.align ? { align: c.align } : {}),
        children: c.tokens.flatMap(inline),
      });
      return [{
        kind: "el",
        tag: "table",
        children: [
          { kind: "el", tag: "thead", children: [{ kind: "el", tag: "tr", children: t.header.map((c) => cell(c, "th")) }] },
          { kind: "el", tag: "tbody", children: t.rows.map((row) => ({ kind: "el", tag: "tr", children: row.map((c) => cell(c, "td")) })) },
        ],
      }];
    }
    case "html":
      return [{ kind: "el", tag: "p", children: text((tok as Tokens.HTML).text) }];
    default:
      return inline(tok);
  }
}

function nodes(tok: Token): MdNode[] {
  return BLOCK.has(tok.type) ? block(tok) : inline(tok);
}

/** Turns an agent reply into a tree of plain elements. Raw HTML stays text. */
export function parseMarkdown(src: string): MdNode[] {
  try {
    const out = lexer(src, { gfm: true, breaks: true }).flatMap((tok) => block(tok));
    if (out.length || !src.trim()) return out;
    return [{ kind: "el", tag: "p", children: text(src) }];
  } catch {
    return [{ kind: "el", tag: "p", children: text(src) }];
  }
}
