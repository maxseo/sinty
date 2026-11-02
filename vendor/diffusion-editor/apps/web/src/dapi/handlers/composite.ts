/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Draws every layer of the open scene into JPEG frames on disk.
 *
 * The mp4 encoder needs SharedArrayBuffer, which this frame cannot have.
 * The picture is the same step an export takes — assets, playback, motion,
 * transform, render — and ffmpeg turns the frames into the file afterwards.
 * Sound is not mixed here: that mix is the part that needed the buffer.
 */

import {
	setActive, framesToSeconds, store,
	assetSystem, playbackSystem, motionSystem, transformSystem, renderSystem,
	Silent, Workarea, Playback, Computed,
	Time, FrameRate, RenderSurface, AudioEngine,
} from "@diffusionstudio/runtime";
import { captureScene, normalizeSceneTransform, resolverSystem, warmupAssets } from "@diffusionstudio/encoder";
import { MAIN_CHANNELS } from "@desktop/main-channels";

import { createCapture } from "@/engine/capture";
import { mainBridge } from "@/lib/ipc";

import type { Entity, World } from "koota";

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
	const { id } = await mainBridge.call(MAIN_CHANNELS.FILE_WRITE_OPEN, { path });
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	await mainBridge.call(MAIN_CHANNELS.FILE_WRITE_CHUNK, { id, data: btoa(binary), position: 0 });
	await mainBridge.call(MAIN_CHANNELS.FILE_WRITE_CLOSE, { id });
}

function jpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(async (blob) => {
			if (!blob) {
				reject(new Error("кадр не собрался"));
				return;
			}
			resolve(new Uint8Array(await blob.arrayBuffer()));
		}, "image/jpeg", 0.85);
	});
}

/** Renders the workarea of `scene` into `<dirname(file)>/frames/f-000001.jpg` and so on. */
export async function renderFrames(source: World, scene: Entity, file: string, dir: string): Promise<{
	path: string;
	framesDir: string;
	fps: number;
	width: number;
	height: number;
	duration: number;
	frames: number;
	size: number;
	config: { format: "mp4" };
}> {
	const capture = await createCapture(source, scene, { dir });
	try {
		const world = capture.world;
		const node = captureScene(world);
		const sceneId = node.id();
		const canvas = world.get(RenderSurface)?.canvas;
		if (!(canvas instanceof HTMLCanvasElement)) throw new Error("нет холста для сборки");

		world.set(AudioEngine, { context: new OfflineAudioContext(2, 1, 48000) });
		world.add(Silent);
		await warmupAssets(world);

		const computed = store(world, Computed);
		const playback = store(world, Playback);

		const frameRate = world.get(FrameRate)?.value ?? 30;
		const sceneWidth = computed.width[sceneId] ?? 1920;
		const sceneHeight = computed.height[sceneId] ?? 1080;
		const sceneEnd = computed.end[sceneId] ?? 0;
		const workarea = node.get(Workarea);
		const workareaStart = workarea ? Math.max(0, Math.min(sceneEnd, workarea.start)) : 0;
		const workareaEnd = workarea ? Math.max(workareaStart, Math.min(sceneEnd, workarea.end || sceneEnd)) : sceneEnd;
		const total = workareaEnd - workareaStart;
		if (total < 1) throw new Error("у сцены нет длины");

		canvas.width = sceneWidth;
		canvas.height = sceneHeight;
		world.set(RenderSurface, { resolution: 1 });
		setActive(world, node);
		playback.playing[sceneId] = true;
		playback.loop[sceneId] = false;
		playback.speed[sceneId] = 1;

		const framesDir = file.replace(/[/\\][^/\\]+$/, "") + "/frames";
		const frameDuration = 1 / frameRate;
		const playheadStartSeconds = framesToSeconds(workareaStart, frameRate);

		for (let frame = 0; frame < total; frame++) {
			const playheadSeconds = playheadStartSeconds + frame * frameDuration;
			computed.localTimeInSeconds[sceneId] = playheadSeconds;
			computed.localTime[sceneId] = Math.round(playheadSeconds * frameRate);
			const time = world.get(Time);
			world.set(Time, { delta: frameDuration * 1000, now: (time?.now ?? 0) + frameDuration * 1000 });

			assetSystem(world);
			playbackSystem(world);
			await resolverSystem(world);
			motionSystem(world);
			normalizeSceneTransform(world, sceneId);
			transformSystem(world);
			renderSystem(world);

			const name = String(frame + 1).padStart(6, "0");
			await writeBytes(`${framesDir}/f-${name}.jpg`, await jpeg(canvas));
		}

		return {
			path: file,
			framesDir,
			fps: frameRate,
			width: sceneWidth,
			height: sceneHeight,
			duration: total / frameRate,
			frames: total,
			size: 0,
			config: { format: "mp4" },
		};
	} finally {
		capture.dispose();
	}
}
