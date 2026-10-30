/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";
import { canEncodeVideo } from "mediabunny";
import { useWorld } from "@diffusionstudio/koota-solid";
import { computeOutputSize, createImageEncoder } from "@diffusionstudio/encoder";
import { Computed, Workarea, getActiveEntity, store } from "@diffusionstudio/runtime";
import { assert, isInputTarget } from "@/utils";
import { useEngineContext } from "@/engine";
import { createCapture } from "@/engine/capture";
import { useProject } from "@/context/project";
import { ExportProgress } from "@/components/sidebar-right/inspector/export-progress";
import { renderScene, renderOverlay, cancelRender, type ExportConfig } from "@/context/render";
import {
  MIME_TYPES,
  getDefaultExportTemplate,
} from "@/components/sidebar-right/inspector/export-templates";

import type { Entity } from "koota";
import type { JSX, Accessor } from "solid-js";

type ExportContextValue = {
  exportScene: (scene: Entity, config: ExportConfig) => Promise<void>;
  /** Writes the frame at the active scene's playhead as a PNG, at the scene's own size. */
  exportCurrentFrame: () => Promise<void>;
  /** Writes the frame at `scene`'s playhead as a PNG, its shorter side `resolution` px (the scene's own when left out). */
  exportFrame: (scene: Entity, resolution?: number) => Promise<void>;
  exporting: Accessor<boolean>;
};

const ExportContext = createContext<ExportContextValue>();

export function ExportProvider(props: { children: JSX.Element }) {
  const engine = useEngineContext();
  const world = useWorld();
  const project = useProject();

  const exporting = () => !!renderOverlay();

  const exportScene: ExportContextValue["exportScene"] = async (scene, config) => {
    if (!scene?.isAlive()) return;

    const format = config.format ?? "mp4";
    const mimeType = MIME_TYPES[format];

    // Fail before the save picker: an unencodable configuration is known
    // right away, and the encoder would only find out after a file was
    // picked and the render machinery spun up.
    const videoEnabled = format !== "ogg" && config.video?.enabled !== false;
    if (videoEnabled) {
      const computed = scene.get(Computed);
      const codec = config.video?.codec ?? "avc";
      const { width, height } = computeOutputSize(
        computed?.width || 1920,
        computed?.height || 1080,
        config.video?.resolution ?? 1080,
      );
      const encodable = await canEncodeVideo(codec, {
        width,
        height,
        bitrate: config.video?.bitrate ?? 10e6,
      });
      if (!encodable) {
        toast.error("Export not supported", {
          description:
            `This browser cannot encode ${codec.toUpperCase()} at ${width}×${height}. ` +
            "Choose a lower resolution, a lower bitrate, or another codec.",
        });
        return;
      }
    }

    const name = project.name().replace(/\s+/g, "-").toLowerCase();

    let target: FileSystemFileHandle;
    try {
      target = await window.showSaveFilePicker({
        suggestedName: `${name}.${format}`,
        types: [
          {
            description: format,
            accept: {
              [mimeType]: [`.${format}`],
            } as Record<`${string}/${string}`, `.${string}`[]>,
          },
        ],
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to start export", {
        description: (e as Error).message,
      });
      return;
    }

    try {
      const result = await renderScene(engine, { scene, target, config, dir: project.dir(), source: "ui" });

      if (result.type === "error") {
        console.error("Export failed:", result.error);
        toast.error("Export failed", {
          description: result.error.message,
        });
      } else if (result.type === "success") {
        toast("Export complete", {
          description: "Your video has been successfully exported",
        });
      }
    } catch (e) {
      console.error("Export failed:", e);
      toast.error("Export failed", {
        description: (e as Error).message,
      });
    }
  };

  const exportCurrentFrame: ExportContextValue["exportCurrentFrame"] = async () => {
    const scene = getActiveEntity(world);
    if (scene === null) {
      toast("No active scene to export");
      return;
    }
    await exportFrame(scene);
  };

  const exportFrame: ExportContextValue["exportFrame"] = async (scene, resolution) => {
    if (!scene?.isAlive()) return;

    // The frame under the playhead, counted the way the image encoder counts:
    // from the export's first frame, the work area's start.
    const computed = scene.get(Computed);
    const workarea = scene.get(Workarea);
    const start = workarea?.start ?? 0;
    const end = workarea?.end ?? computed?.duration ?? 0;
    const playhead = store(world, Computed).localTime[scene.id()] ?? 0;
    const frame = Math.max(0, Math.min(playhead, end - 1) - start);

    // The encoder sizes by height; a resolution names the shorter side.
    const { height } = computeOutputSize(computed?.width || 1920, computed?.height || 1080, resolution);

    const name = project.name().replace(/\s+/g, "-").toLowerCase();

    let target: FileSystemFileHandle;
    try {
      target = await window.showSaveFilePicker({
        suggestedName: `${name}.png`,
        types: [{ description: "png", accept: { "image/png": [".png"] } }],
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to start export", { description: (e as Error).message });
      return;
    }

    const progress = toast.loading("Exporting image...");
    let capture: Awaited<ReturnType<typeof createCapture>> | undefined;
    try {
      capture = await createCapture(world, scene, { dir: project.dir() });
      const encoder = await createImageEncoder(capture.world, { frames: [frame], resolution: height });
      const result = await encoder.render();
      if (result.type === "canceled") {
        toast.dismiss(progress);
        return;
      }
      if (result.type === "error") throw result.error;

      const writable = await target.createWritable();
      // Copied onto a plain ArrayBuffer, which is what a file write takes.
      await writable.write(new Uint8Array(result.data[0]!.png));
      await writable.close();
      toast.dismiss(progress);
      toast("Export complete", { description: "Your image has been successfully exported" });
    } catch (e) {
      console.error("Image export failed:", e);
      toast.dismiss(progress);
      toast.error("Export failed", { description: (e as Error).message });
    } finally {
      capture?.dispose();
    }
  };

  const exportActiveScene = () => {
    const scene = getActiveEntity(world);
    if (scene === null) {
      return toast("No active scene to export");
    }
    void exportScene(scene, getDefaultExportTemplate());
  };

  /**
   * Export is the provider's command, so its keys are bound here rather than
   * in the engine's shortcut table: ⌘E writes the active scene, ⇧⌘E the frame
   * at its playhead — the same two the File menu lists.
   */
  const handleShortcut = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "e") return;
    if (isInputTarget(event)) return;

    event.preventDefault();
    if (event.shiftKey) void exportCurrentFrame();
    else exportActiveScene();
  };

  onMount(() => window.addEventListener("keydown", handleShortcut));
  onCleanup(() => window.removeEventListener("keydown", handleShortcut));

  return (
    <ExportContext.Provider value={{ exportScene, exportCurrentFrame, exportFrame, exporting }}>
      {props.children}
      <ExportProgress
        open={!!renderOverlay()}
        audioOnly={renderOverlay()?.audioOnly ?? false}
        progress={renderOverlay()?.progress ?? 0}
        remaining={renderOverlay()?.remaining}
        onCancel={cancelRender}
      />
    </ExportContext.Provider>
  );
}

export function useExport() {
  const ctx = useContext(ExportContext);
  assert(ctx, "useExport must be used within ExportProvider");
  return ctx;
}
