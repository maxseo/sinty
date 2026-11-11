"use strict";

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const babel = require("@babel/core");

const t = babel.types;

/** Same names the film compiler stamps, in the same walk order, so a saved cut reloads onto the same sources. */
const TAGS = new Set([
  "stage", "scene", "group", "rect", "ellipse", "polygon", "path", "video", "image", "audio", "text",
  "textRange", "sequence", "captions", "adjustmentLayer", "solidPaint", "linearGradientPaint",
  "radialGradientPaint", "angularGradientPaint", "imagePaint", "videoPaint", "colorStop", "stroke",
  "shadow", "effect", "clipPath", "mask", "animation", "keyframeTrack", "keyframe", "htmlPaint",
  "html", "shaderPaint", "surfacePaint", "surface",
]);

const SVG_SHARED = new Set(["rect", "ellipse", "polygon", "path", "text", "image", "mask", "clipPath"]);

function lowerTag(name) {
  const raw = typeof name === "string" && name ? name : "group";
  return raw.charAt(0).toLowerCase() + raw.slice(1);
}

function isComposition(tag, inSvg) {
  const lower = lowerTag(tag);
  if (!TAGS.has(tag) && !TAGS.has(lower)) return false;
  return !(inSvg && SVG_SHARED.has(lower));
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type === "JSXElement") {
    visit(node);
    return;
  }
  for (const key of ["program", "body", "declaration", "argument", "expression", "children"]) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
    } else if (value && typeof value === "object" && value.type) walk(value, visit);
  }
}

function collect(ast) {
  const nodes = [];
  const visit = (node, inSvg) => {
    const opening = node.openingElement;
    const name = opening && opening.name;
    const tag = name && name.type === "JSXIdentifier" ? name.name : "";
    if (name && name.type === "JSXIdentifier" && isComposition(tag, inSvg)) nodes.push(node);
    const lower = lowerTag(tag);
    const next = inSvg ? lower !== "foreignobject" : lower === "svg";
    for (const child of node.children || []) {
      if (child && child.type === "JSXElement") visit(child, next);
    }
  };
  walk(ast, (node) => {
    if (node.type === "JSXElement") visit(node, false);
  });
  return nodes;
}

function valueAst(value) {
  if (typeof value === "string") return t.stringLiteral(value);
  if (typeof value === "number" && Number.isFinite(value)) return t.numericLiteral(value);
  if (typeof value === "boolean") return t.booleanLiteral(value);
  if (value === null) return t.nullLiteral();
  if (Array.isArray(value)) return t.arrayExpression(value.map((item) => valueAst(item)));
  if (typeof value === "object") {
    return t.objectExpression(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => t.objectProperty(t.stringLiteral(key), valueAst(item))),
    );
  }
  return t.stringLiteral(String(value));
}

function attrValue(value) {
  if (value === true) return null;
  if (typeof value === "string") return t.stringLiteral(value);
  return t.jsxExpressionContainer(valueAst(value));
}

function setAttr(opening, name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === undefined) return;
  const attrs = opening.attributes;
  const index = attrs.findIndex((attr) => attr.type === "JSXAttribute" && attr.name && attr.name.name === name);
  if (value === null) {
    if (index >= 0) attrs.splice(index, 1);
    return;
  }
  const attr = t.jsxAttribute(t.jsxIdentifier(name), attrValue(value));
  if (index >= 0) attrs[index] = attr;
  else attrs.push(attr);
}

function openUp(node) {
  if (!node.openingElement.selfClosing) return;
  node.openingElement.selfClosing = false;
  node.closingElement = t.jsxClosingElement(t.cloneNode(node.openingElement.name));
  node.children = [];
}

function makeElement(tag, props, text) {
  const lower = lowerTag(tag);
  const id = t.jsxIdentifier(TAGS.has(lower) ? lower : "group");
  const opening = t.jsxOpeningElement(id, [], !text);
  const node = t.jsxElement(opening, text ? t.jsxClosingElement(t.cloneNode(id)) : null, text ? [t.jsxText(text)] : [], !text);
  if (props && typeof props === "object") {
    for (const [key, value] of Object.entries(props)) setAttr(opening, key, value);
  }
  return node;
}

function insertChild(parent, child, before) {
  openUp(parent);
  const kids = parent.children;
  const at = before ? kids.indexOf(before) : -1;
  const piece = [t.jsxText("\n"), child];
  if (at >= 0) kids.splice(at, 0, ...piece);
  else kids.push(...piece);
}

function removeNode(root, node) {
  let removed = false;
  const scan = (parent) => {
    if (removed || !Array.isArray(parent.children)) return;
    const index = parent.children.indexOf(node);
    if (index >= 0) {
      parent.children.splice(index, 1);
      removed = true;
      return;
    }
    for (const child of parent.children) {
      if (child && child.type === "JSXElement") scan(child);
    }
  };
  walk(root, scan);
  return removed;
}

function blank(skipped) {
  return { skipped, ids: {}, unrolled: [] };
}

/** Writes canvas edits into the film's JSX. Returns the source stamps the compiler will assign, so the open film keeps the clip. */
function apply(dir, edits) {
  const fileName = ["index.tsx", "index.ts", "index.jsx", "index.js"].find((name) => existsSync(join(dir, name)));
  if (!fileName) return blank(["file"]);
  const source = readFileSync(join(dir, fileName), "utf8");
  const ast = babel.parseSync(source, {
    filename: fileName,
    sourceType: "module",
    parserOpts: { plugins: ["typescript", "jsx"] },
    babelrc: false,
    configFile: false,
  });
  if (!ast) return blank(["parse"]);

  const bySource = new Map();
  collect(ast).forEach((node, index) => bySource.set(`${fileName}:${index + 1}`, node));
  const pending = new Map();
  const skipped = [];
  let changed = false;
  const list = Array.isArray(edits) ? edits : [];

  const resolve = (id) => (typeof id === "string" ? bySource.get(id) || pending.get(id) || null : null);

  for (const edit of list) {
    if (!edit || typeof edit !== "object") continue;
    if (edit.kind === "insert") {
      const parent = resolve(edit.parent);
      if (!parent) {
        skipped.push(String(edit.source || "insert"));
        continue;
      }
      const node = makeElement(edit.tag, edit.props, typeof edit.text === "string" ? edit.text : undefined);
      insertChild(parent, node, edit.before ? resolve(edit.before) : null);
      if (typeof edit.source === "string") pending.set(edit.source, node);
      changed = true;
      continue;
    }
    if (edit.kind === "set") {
      const node = resolve(edit.source);
      if (!node) {
        skipped.push(String(edit.source || "set"));
        continue;
      }
      if (edit.props && typeof edit.props === "object") {
        for (const [key, value] of Object.entries(edit.props)) setAttr(node.openingElement, key, value);
      }
      if (typeof edit.text === "string") {
        openUp(node);
        node.children = [t.jsxText(edit.text)];
      }
      changed = true;
      continue;
    }
    if (edit.kind === "remove") {
      const node = resolve(edit.source);
      if (!node || !removeNode(ast, node)) {
        skipped.push(String(edit.source || "remove"));
        continue;
      }
      changed = true;
      continue;
    }
    if (edit.kind === "move") {
      const node = resolve(edit.source);
      const parent = resolve(edit.parent);
      if (!node || !parent || !removeNode(ast, node)) {
        skipped.push(String(edit.source || "move"));
        continue;
      }
      insertChild(parent, node, edit.before ? resolve(edit.before) : null);
      changed = true;
      continue;
    }
    if (edit.kind === "unroll" || edit.kind === "variable") skipped.push(String(edit.source || edit.file || edit.kind));
  }

  if (!changed) return { skipped, ids: {}, unrolled: [] };

  const printed = babel.transformFromAstSync(ast, undefined, {
    filename: fileName,
    babelrc: false,
    configFile: false,
    code: true,
    ast: false,
    compact: false,
    comments: true,
    plugins: [],
  });
  if (!printed || typeof printed.code !== "string" || !printed.code.includes("<")) return blank(["print"]);
  writeFileSync(join(dir, fileName), printed.code.endsWith("\n") ? printed.code : `${printed.code}\n`, "utf8");

  const ids = {};
  collect(ast).forEach((node, index) => {
    for (const [key, value] of pending) {
      if (value === node) ids[key] = `${fileName}:${index + 1}`;
    }
  });
  for (const key of pending.keys()) if (!ids[key]) ids[key] = key;
  return { skipped, ids, unrolled: [] };
}

module.exports = apply;
