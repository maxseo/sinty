/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Draws every layer of the open scene into JPEG frames, and mixes the
 * timeline audio into a wav beside them.
 *
 * The mp4 encoder needs SharedArrayBuffer, which this frame cannot have.
 * The picture is the same step an export takes. The sound is scheduled into
 * an offline context while that step runs, then rendered in one pass: the
 * worklet that paced the old encoder is the only part that needed the buffer.
 * ffmpeg muxes the frames and the wav.
 */

import {
	setActive, framesToSeconds, store,
	assetSystem, playbackSystem, motionSystem, transformSystem, renderSystem,
	Workarea, Playback, Computed, AudioPlayback, AudioBusHandle,
	Time, FrameRate, RenderSurface, AudioEngine,
} from "@diffusionstudio/runtime";
import { captureScene, normalizeSceneTransform, resolverSystem, warmupAssets } from "@diffusionstudio/encoder";
import { MAIN_CHANNELS } from "@desktop/main-channels";

import { createCapture } from "@/engine/capture";
import { mainBridge } from "@/lib/ipc";

import type { Entity, World } from "koota";

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
	const { id } = await mainBridge.call(MAIN_CHANNELS.FILE_WRITE_OPEN, { path });
	const piece = 256 * 1024;
	for (let pos = 0; pos < bytes.length; pos += piece) {
		const slice = bytes.subarray(pos, pos + piece);
		let binary = "";
		for (let i = 0; i < slice.length; i += 0x8000) {
			binary += String.fromCharCode(...slice.subarray(i, i + 0x8000));
		}
		await mainBridge.call(MAIN_CHANNELS.FILE_WRITE_CHUNK, { id, data: btoa(binary), position: pos });
	}
	await mainBridge.call(MAIN_CHANNELS.FILE_WRITE_CLOSE, { id });
}

/** 16-bit stereo (or whatever the buffer is) PCM in a wav container. */
function wavBytes(buffer: AudioBuffer): Uint8Array {
	const channels = buffer.numberOfChannels;
	const rate = buffer.sampleRate;
	const frames = buffer.length;
	const pcm = new Int16Array(frames * channels);
	for (let i = 0; i < frames; i++) {
		for (let c = 0; c < channels; c++) {
			const sample = Math.max(-1, Math.min(1, buffer.getChannelData(c)[i] ?? 0));
			pcm[i * channels + c] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		}
	}
	const bytes = new Uint8Array(44 + pcm.byteLength);
	const view = new DataView(bytes.buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + pcm.byteLength, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, pcm.byteLength, true);
	bytes.set(new Uint8Array(pcm.buffer), 44);
	return bytes;
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
	wav?: string;
	audioError?: string;
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

		const duration = total / frameRate;
		const sampleRate = 48000;
		const offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
		world.set(AudioEngine, { context: offline });
		await warmupAssets(world);

		canvas.width = sceneWidth;
		canvas.height = sceneHeight;
		world.set(RenderSurface, { resolution: 1 });
		setActive(world, node);
		playback.playing[sceneId] = true;
		playback.loop[sceneId] = false;
		playback.speed[sceneId] = 1;
		if (!node.has(AudioPlayback)) node.add(AudioPlayback);
		const audioPlayback = store(world, AudioPlayback);
		const playheadStartSeconds = framesToSeconds(workareaStart, frameRate);
		audioPlayback.contextOffsetInSeconds[sceneId] = 0;
		audioPlayback.timelineOffsetInSeconds[sceneId] = playheadStartSeconds;

		const framesDir = file.replace(/[/\\][^/\\]+$/, "") + "/frames";
		const frameDuration = 1 / frameRate;
		const levels = new Map<number, { at: number; gain: number }[]>();

		for (let frame = 0; frame < total; frame++) {
			const playheadSeconds = playheadStartSeconds + frame * frameDuration;
			computed.localTimeInSeconds[sceneId] = playheadSeconds;
			computed.localTime[sceneId] = Math.round(playheadSeconds * frameRate);
			const time = world.get(Time);
			world.set(Time, { delta: frameDuration * 1000, now: (time?.now ?? 0) + frameDuration * 1000 });

			assetSystem(world);
			playbackSystem(world);
			await resolverSystem(world);
			for (const entity of world.query(AudioBusHandle)) {
				const bus = entity.get(AudioBusHandle);
				if (!bus) continue;
				const curve = levels.get(entity.id()) ?? [];
				curve.push({ at: frame * frameDuration, gain: bus.getGain().gain.value });
				levels.set(entity.id(), curve);
			}
			motionSystem(world);
			normalizeSceneTransform(world, sceneId);
			transformSystem(world);
			renderSystem(world);

			const name = String(frame + 1).padStart(6, "0");
			await writeBytes(`${framesDir}/f-${name}.jpg`, await jpeg(canvas));
		}

		let wav: string | undefined;
		let audioError: string | undefined;
		try {
			for (const entity of world.query(AudioBusHandle)) {
				const bus = entity.get(AudioBusHandle);
				const curve = levels.get(entity.id());
				if (!bus || !curve?.length) continue;
				const param = bus.getGain().gain;
				param.cancelScheduledValues(0);
				for (const point of curve) param.setValueAtTime(point.gain, point.at);
			}
			const mixed = await offline.startRendering();
			wav = framesDir.replace(/\/frames$/, "") + "/audio.wav";
			await writeBytes(wav, wavBytes(mixed));
		} catch (error) {
			audioError = error instanceof Error ? error.message : "звук не свелся";
		}

		return {
			path: file,
			framesDir,
			fps: frameRate,
			width: sceneWidth,
			height: sceneHeight,
			duration,
			frames: total,
			...(wav ? { wav } : {}),
			...(audioError ? { audioError } : {}),
			size: 0,
			config: { format: "mp4" },
		};
	} finally {
		capture.dispose();
	}
}
