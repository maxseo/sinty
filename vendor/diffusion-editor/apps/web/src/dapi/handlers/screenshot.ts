/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createImageEncoder } from "@diffusionstudio/encoder";
import { TIME_FPS } from "@diffusionstudio/jsx";
import { Computed, FrameRate, getActiveEntity } from "@diffusionstudio/runtime";
import { DapiError } from "@diffusionstudio/dapi";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { createCapture } from "@/engine/capture";
import { resolveNode } from "../lib/nodes";

import type { ToolHandler } from "../handler";
import type { ToolResult } from "@diffusionstudio/dapi";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** The harness has no separate app window. Render the open scene at the playhead and hand the PNG back as base64; the plugin writes the file. */
async function harnessShot(ctx: Parameters<ToolHandler<"screenshot">>[1]): Promise<ToolResult<"screenshot"> & { pngBase64: string }> {
  const { world, project } = ctx.requireSession();
  const scene = resolveNode(world);
  const fps = world.get(FrameRate)?.value || TIME_FPS;
  const active = getActiveEntity(world);
  const seconds = active ? (active.get(Computed)?.localTime ?? 0) / fps : 0;
  const target = await createCapture(world, scene, { dir: project.dir() });
  try {
    const encoder = await createImageEncoder(target.world, { frames: [Math.round(seconds * TIME_FPS)], resolution: 720 });
    const result = await encoder.render();
    if (result.type === "canceled") throw new DapiError("canceled", "Capture canceled");
    if (result.type === "error") throw result.error;
    const png = result.data[0]?.png;
    if (!png) throw new DapiError("unavailable", "Кадр не собрался.");
    return { path: "", width: encoder.bounds.width, height: encoder.bounds.height, pngBase64: bytesToBase64(png) };
  } finally {
    target.dispose();
  }
}

export const screenshot: ToolHandler<"screenshot"> = async (_args, ctx) => {
  if (window.desktop?.harness) return harnessShot(ctx);
  return mainBridge.call(MAIN_CHANNELS.WINDOW_CAPTURE, undefined);
};
