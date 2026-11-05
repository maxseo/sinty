import { useMemo } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { parseMarkdown, type MdNode } from "./md.js";

function draw(node: MdNode, key: string): ComponentChildren {
  switch (node.kind) {
    case "text":
      return node.text;
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} />;
    case "check":
      return <input key={key} type="checkbox" checked={node.on} disabled />;
    case "pre":
      return (
        <pre key={key}>
          <code class={node.lang ? `language-${node.lang}` : undefined}>{node.text}</code>
        </pre>
      );
    case "img":
      return <img key={key} src={node.src} alt={node.alt} loading="lazy" referrerPolicy="no-referrer" />;
    case "a": {
      const external = /^https?:/i.test(node.href);
      return (
        <a key={key} href={node.href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {node.children.map((child, i) => draw(child, `${key}.${i}`))}
        </a>
      );
    }
    case "el": {
      const kids = node.children.map((child, i) => draw(child, `${key}.${i}`));
      const style = node.align ? { textAlign: node.align } : undefined;
      if (node.tag === "table") {
        return <div key={key} class="md-table"><table>{kids}</table></div>;
      }
      if (node.tag === "ol" && node.start) return <ol key={key} start={node.start}>{kids}</ol>;
      const Tag = node.tag;
      return <Tag key={key} style={style}>{kids}</Tag>;
    }
  }
}

/** Formatted agent reply: headings, lists, tables, links and code. */
export function Markdown({ text }: { text: string }) {
  const nodes = useMemo(() => parseMarkdown(text), [text]);
  return <div class="md">{nodes.map((node, i) => draw(node, String(i)))}</div>;
}
