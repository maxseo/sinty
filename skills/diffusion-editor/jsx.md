# The film source

`index.tsx` is the film. One default export, a function that returns `<stage>`. Tags are lowercase. Do not write `__source`, and do not invent `id` attributes. After a write, `context` reports ids such as `index.tsx:2`; those are positions in the file and they move when the file changes.

A clip the person dropped on the timeline is stored as a `<rect>` with `<videoPaint>` or `<imagePaint>`. When you write the file yourself, use `<video>`, `<image>`, `<audio>`, and `<text>`. Keep one scene marked `active`, or the timeline, `capture`, and `export` have nothing to point at.

```tsx
export default function Project() {
  return (
    <stage background="#161616">
      <scene name="Scene 1" width={1080} height={1920} fill="#000000" active>
        <video src="@11.mov" x={0} y={0} width={1080} height={1920} />
        <text color="#ffffff" fontSize={72} width={1080} textAlign="center">
          Hello
        </text>
      </scene>
    </stage>
  );
}
```

## Stage and scene

`<stage>` is the only root. `background` is the canvas color, not part of the export. `camera` is the viewport, a matrix `[scaleX, 0, 0, scaleY, x, y]`. A 1080×1920 frame opens near `[0.25, 0, 0, 0.25, 235, 70]`. A 1920×1080 frame opens near `[0.3, 0, 0, 0.3, 85, 150]`.

`<scene>` is the only child of stage that has a timeline and exports. `width` and `height` are the frame. `fill` is the background (a CSS color; alpha is ignored). `name` is the label. `active` marks the scene the playhead uses; at most one. `workarea={[in, out]}` is the only part that plays and exports. Leave `playhead`, `timeline`, `selected` off; the editor writes those.

## Media

`src` is a library path from `context` (`@11.mov`), an asset id, or a path `diffusion.source` `import` just returned. A new file from the chat project goes in with `import` first; there is no command that downloads.

`<video src width height>` plays the file. Without timing it lasts as long as the file. `volume` is decibels: `0` is full, `-6` is about half, `-Infinity` is silent. `muted` drops the audio. `objectFit` is `cover` (default), `contain`, or `fill`.

`<image src>` is a still. With no `end` it lasts 16 seconds.

`<audio src>` has no picture. Same `volume` and timing as video.

## Timing

`start` / `end` place the clip on the scene timeline. `sourceIn` / `sourceOut` choose which part of the file plays. Set `end` or `sourceOut`, not both as if they meant different things: the earlier one wins. Moving `start` alone slides the clip; it does not trim. To trim the head, raise `sourceIn`. A number is seconds (`2.2`). `"45f"` is frames. `"1:30"` is clock. `playbackRate={2}` plays twice as much source in the same timeline span.

## Text and shapes

`<text color fontSize width textAlign>` — the words are the children, not a `content` prop. No `color` means no glyphs. `fontFamily` defaults to Inter; `fonts` lists other names. `textAlign` is `left`, `center`, or `right`.

`<rect>`, `<ellipse>` take `x`, `y`, `width`, `height`, and `fill`, or a paint child:

```tsx
<rect x={0} y={0} width={1080} height={400}>
  <solidPaint color="#000000" />
</rect>
```

`<videoPaint src>` and `<imagePaint src>` paint media into a rect. That is how a clip dropped by hand is stored. A paint on a `<video>` draws over the picture.

## What to leave alone

Do not author `camera` numbers beyond the two frames above. Do not add a second `<stage>`. Do not nest scenes. A node sitting on the stage but outside a scene draws on the canvas and exports nowhere.
