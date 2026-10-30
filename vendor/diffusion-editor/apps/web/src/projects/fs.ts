/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The asset library's view of a project folder on desktop: the main process
// reads and writes the manifest (as YAML) and lists and stats files; bytes
// come in as real Files (see ElectronFileHandle) and go out through the
// streaming FILE_WRITE_* channels.

import { MAIN_CHANNELS } from '@desktop/main-channels';
import { mainBridge } from '@/lib/ipc';
import { ElectronFileHandle } from '@/lib/electron-file-handle';
import { ElectronWritableFileHandle } from '@/lib/electron-file-writable';
import { isAbsoluteSource } from '@diffusionstudio/assets';

import type { Manifest, ProjectFS } from '@diffusionstudio/assets';

function inHarness(): boolean {
	return window.desktop?.harness === true;
}

/** Copies bytes into the film. `path` is project-relative (`assets/clip.mp4`). */
async function putMedia(dir: string, path: string, blob: Blob): Promise<void> {
	const url = `/p/diffusion/media?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`;
	const res = await fetch(url, { method: 'PUT', body: blob });
	if (!res.ok) {
		const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
		throw new Error(body?.error?.message || 'Не удалось записать файл');
	}
}

/** Reads a file of the film back as a browser File. */
async function getMedia(dir: string, source: string): Promise<File> {
	const url = `/p/diffusion/media?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(source)}`;
	const res = await fetch(url);
	if (!res.ok) {
		const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
		throw new Error(body?.error?.message || 'Не удалось прочитать файл');
	}
	const blob = await res.blob();
	const name = source.split(/[\\/]/).pop() || 'media';
	return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

/** Streams `blob` to an absolute path in chunks. */
async function writeBlob(path: string, blob: Blob): Promise<void> {
	const target = new ElectronWritableFileHandle(path);
	const writable = await target.createWritable();
	const writer = writable.getWriter();
	try {
		let position = 0;
		const reader = blob.stream().getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await writer.write({ type: 'write', data: value, position });
			position += value.byteLength;
		}
		await writer.close();
	} catch (error) {
		await writer.abort().catch(() => {});
		throw error;
	}
}

/** The `ProjectFS` of the project folder at `dir`. */
export function createProjectFS(dir: string): ProjectFS {
	const separator = dir.includes('\\') ? '\\' : '/';
	const absolute = (source: string): string =>
		isAbsoluteSource(source) ? source : `${dir}${separator}${source.split('/').join(separator)}`;

	return {
		absolute,
		readManifest: () => mainBridge.call(MAIN_CHANNELS.PROJECTS_MANIFEST_READ, { dir }),
		writeManifest: (manifest: Manifest) => mainBridge.call(MAIN_CHANNELS.PROJECTS_MANIFEST_WRITE, { dir, manifest }),
		list: (source) => mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_LIST, { dir, source }),
		stat: (source) => mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_STAT, { dir, source }),
		file: (source) => inHarness() ? getMedia(dir, source) : new ElectronFileHandle(absolute(source)).getFile(),
		write: (path, blob) => inHarness() ? putMedia(dir, path, blob) : writeBlob(absolute(path), blob),
		remove: (path) => mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_REMOVE, { dir, path }),
		realPath: (source) => mainBridge.call(MAIN_CHANNELS.PROJECTS_FS_REAL_PATH, { dir, source }),
		pathOf: (file) => window.desktop?.getPathForFile(file) || null,
	};
}
