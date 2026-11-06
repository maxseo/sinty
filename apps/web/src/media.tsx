import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { token } from "./api.js";
import type { MediaRef } from "./media-ref.js";

function fileName(path: string): string {
  const clean = path.split("?")[0] ?? path;
  const seg = clean.split("/").pop() || path;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function useObjectUrl(sessionId: string, path: string): { url: string; failed: boolean } {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (/^https?:\/\//i.test(path)) {
      setUrl(path);
      setFailed(false);
      return;
    }
    let dead = false;
    let object = "";
    setUrl("");
    setFailed(false);
    void fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/media?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${token.get()}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        object = URL.createObjectURL(blob);
        if (!dead) setUrl(object);
      })
      .catch(() => {
        if (!dead) setFailed(true);
      });
    return () => {
      dead = true;
      if (object) URL.revokeObjectURL(object);
    };
  }, [sessionId, path]);
  return { url, failed };
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function PlayIcon({ pause }: { pause?: boolean }) {
  if (pause) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path fill="currentColor" d="M4 3h3v10H4zM9 3h3v10H9z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M5 3.2v9.6L13 8z" />
    </svg>
  );
}

type SizeCb = (path: string, w: number, h: number) => void;

function AudioCard({ sessionId, path }: { sessionId: string; path: string }) {
  const { url, failed } = useObjectUrl(sessionId, path);
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const toggle = (): void => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };
  if (failed) return <p class="media-miss">{fileName(path)}</p>;
  return (
    <div class="media-audio">
      <button type="button" class="media-play" aria-label={on ? "Пауза" : "Слушать"} disabled={!url} onClick={toggle}>
        <PlayIcon pause={on} />
      </button>
      <div class={`eq${on ? " on" : ""}`} aria-hidden="true">
        <i /><i /><i /><i /><i />
      </div>
      <span class="media-name">{fileName(path)}</span>
      <audio
        ref={audio}
        src={url || undefined}
        preload="metadata"
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => setOn(false)}
      />
    </div>
  );
}

function VideoCard({ sessionId, path, onSize, fill }: { sessionId: string; path: string; onSize?: SizeCb; fill?: boolean }) {
  const { url, failed } = useObjectUrl(sessionId, path);
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [dur, setDur] = useState(0);
  const [full, setFull] = useState(false);
  const toggle = (): void => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };
  const seek = (value: string): void => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Number(value);
    setAt(el.currentTime);
  };
  const fullscreen = (): void => {
    const el = box.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  };
  useEffect(() => {
    const sync = (): void => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  if (failed) return <p class="media-miss">{fileName(path)}</p>;
  return (
    <div class={`media-stage${full ? " full" : ""}${fill ? " fill" : ""}`} ref={box}>
      <video
        ref={video}
        src={url || undefined}
        preload="metadata"
        playsInline
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => setOn(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          setDur(el.duration);
          if (el.videoWidth > 0 && el.videoHeight > 0) onSize?.(path, el.videoWidth, el.videoHeight);
        }}
        onClick={toggle}
      />
      <div class="media-bar">
        <button type="button" class="media-play" aria-label={on ? "Пауза" : "Смотреть"} disabled={!url} onClick={toggle}>
          <PlayIcon pause={on} />
        </button>
        <input type="range" min="0" max={dur || 0} step="0.1" value={at} aria-label="Место в ролике" onInput={(e) => seek(e.currentTarget.value)} />
        <span class="media-time">{clock(at)} / {clock(dur)}</span>
        <button type="button" class="media-full" aria-label={full ? "Свернуть" : "На весь экран"} onClick={fullscreen}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="1.6" d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ImageCard({ sessionId, path, onSize, fill }: { sessionId: string; path: string; onSize?: SizeCb; fill?: boolean }) {
  const { url, failed } = useObjectUrl(sessionId, path);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (failed) return <p class="media-miss">{fileName(path)}</p>;
  return (
    <>
      <button type="button" class={`media-shot${fill ? " fill" : ""}`} aria-label="Открыть картинку" disabled={!url} onClick={() => setOpen(true)}>
        {url && (
          <img
            src={url}
            alt={fileName(path)}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) onSize?.(path, el.naturalWidth, el.naturalHeight);
            }}
          />
        )}
      </button>
      {open && url && (
        <div class="media-lightbox" role="dialog" aria-label="Картинка">
          <button type="button" class="media-close" aria-label="Закрыть" onClick={() => setOpen(false)}>×</button>
          <img src={url} alt={fileName(path)} />
        </div>
      )}
    </>
  );
}

export function MediaView({
  sessionId,
  file,
  onSize,
  fill,
}: {
  sessionId: string;
  file: MediaRef;
  onSize?: SizeCb;
  fill?: boolean;
}) {
  if (file.kind === "audio") return <AudioCard sessionId={sessionId} path={file.path} />;
  if (file.kind === "video") return <VideoCard sessionId={sessionId} path={file.path} onSize={onSize} fill={fill} />;
  return <ImageCard sessionId={sessionId} path={file.path} onSize={onSize} fill={fill} />;
}

type Dim = { w: number; h: number };
type RowItem = { file: MediaRef; width: number };
type Row = { height: number; items: RowItem[] };

const GAP = 8;
const IDEAL_H = 240;
const MAX_H = 360;
const MIN_H = 120;
const FALLBACK_AR = 16 / 9;

function aspectOf(dims: Record<string, Dim>, path: string): number {
  const d = dims[path];
  if (!d || d.h <= 0 || d.w <= 0) return FALLBACK_AR;
  return d.w / d.h;
}

function packRows(files: MediaRef[], dims: Record<string, Dim>, containerW: number): Row[] {
  if (!files.length) return [];
  if (containerW <= 0) {
    return [{ height: IDEAL_H, items: files.map((file) => ({ file, width: IDEAL_H * FALLBACK_AR })) }];
  }

  const rows: Row[] = [];
  let buf: MediaRef[] = [];
  let arSum = 0;

  const flush = (justify: boolean): void => {
    if (!buf.length) return;
    const gaps = GAP * Math.max(0, buf.length - 1);
    const avail = Math.max(40, containerW - gaps);
    let height = justify && buf.length > 0 ? avail / arSum : Math.min(IDEAL_H, avail / arSum);
    height = Math.min(MAX_H, Math.max(MIN_H, height));
    // Single oversized item: shrink to fit width
    if (buf.length === 1) {
      const ar = aspectOf(dims, buf[0]!.path);
      height = Math.min(height, avail / ar, MAX_H);
      height = Math.max(MIN_H, height);
    }
    rows.push({
      height,
      items: buf.map((file) => ({ file, width: aspectOf(dims, file.path) * height })),
    });
    buf = [];
    arSum = 0;
  };

  for (const file of files) {
    const ar = aspectOf(dims, file.path);
    const nextAr = arSum + ar;
    const nextW = nextAr * IDEAL_H + GAP * buf.length;
    if (buf.length > 0 && nextW > containerW) flush(true);
    buf.push(file);
    arSum += ar;
  }
  flush(false);
  return rows;
}

/** Image/video gallery: natural aspect, shared row height, fills width when several fit. */
export function MediaStrip({ sessionId, files }: { sessionId: string; files: MediaRef[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dims, setDims] = useState<Record<string, Dim>>({});

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const sync = (): void => setWidth(el.clientWidth);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onSize: SizeCb = (path, w, h) => {
    setDims((prev) => {
      const cur = prev[path];
      if (cur && cur.w === w && cur.h === h) return prev;
      return { ...prev, [path]: { w, h } };
    });
  };

  const visual = files.filter((f) => f.kind === "image" || f.kind === "video");
  const audio = files.filter((f) => f.kind === "audio");
  const rows = packRows(visual, dims, width);

  return (
    <div class="media-strip" ref={box}>
      {rows.map((row, i) => (
        <div class="media-row" key={i} style={{ height: `${row.height}px` }}>
          {row.items.map(({ file, width: cellW }) => (
            <div class="media-cell" key={file.path} style={{ width: `${cellW}px`, height: `${row.height}px` }}>
              <MediaView sessionId={sessionId} file={file} onSize={onSize} fill />
            </div>
          ))}
        </div>
      ))}
      {audio.map((file) => (
        <MediaView key={file.path} sessionId={sessionId} file={file} />
      ))}
    </div>
  );
}
