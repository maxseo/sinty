/** Turns composition tags into the PascalCase components the editor mounts. A lowercase tag is HTML, which the stage refuses. Inside <svg>, the names both sides share stay SVG. */

const TAGS = new Set([
  "stage", "scene", "group", "rect", "ellipse", "polygon", "path", "video", "image", "audio", "text",
  "textRange", "sequence", "captions", "adjustmentLayer", "solidPaint", "linearGradientPaint",
  "radialGradientPaint", "angularGradientPaint", "imagePaint", "videoPaint", "colorStop", "stroke",
  "shadow", "effect", "clipPath", "mask", "animation", "keyframeTrack", "keyframe", "htmlPaint",
  "html", "shaderPaint", "surfacePaint", "surface",
]);

const SVG_SHARED = new Set(["rect", "ellipse", "polygon", "path", "text", "image", "mask", "clipPath"]);

module.exports = function compositionTags(babel) {
  const t = babel.types;
  return {
    visitor: {
      Program(program) {
        const used = new Set();
        const stack = [];
        program.traverse({
          JSXElement: {
            enter(path) {
              const opening = path.node.openingElement.name;
              const inSvg = stack.length ? stack[stack.length - 1] : false;
              if (opening.type !== "JSXIdentifier") {
                stack.push(inSvg);
                return;
              }
              let tag = opening.name;
              if (TAGS.has(tag) && !(inSvg && SVG_SHARED.has(tag))) {
                const pascal = tag.charAt(0).toUpperCase() + tag.slice(1);
                opening.name = pascal;
                const closing = path.node.closingElement;
                if (closing && closing.name.type === "JSXIdentifier") closing.name.name = pascal;
                used.add(pascal);
                tag = pascal;
              }
              const lower = tag.charAt(0).toLowerCase() + tag.slice(1);
              stack.push(inSvg ? lower !== "foreignobject" : lower === "svg");
            },
            exit() {
              stack.pop();
            },
          },
        });
        const specs = [...used].filter((name) => !program.scope.hasBinding(name));
        if (!specs.length) return;
        const decl = program.node.body.find((node) => t.isImportDeclaration(node) && node.source.value === "@diffusionstudio/jsx");
        const added = specs.map((name) => t.importSpecifier(t.identifier(name), t.identifier(name)));
        if (decl) decl.specifiers.push(...added);
        else program.node.body.unshift(t.importDeclaration(added, t.stringLiteral("@diffusionstudio/jsx")));
      },
    },
  };
};
