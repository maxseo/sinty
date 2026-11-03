import { useEffect, useRef, useState } from "preact/hooks";
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

function VideoCard({ sessionId, path }: { sessionId: string; path: string }) {
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
    <div class={`media-stage${full ? " full" : ""}`} ref={box}>
      <video
        ref={video}
        src={url || undefined}
        preload="metadata"
        playsInline
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => setOn(false)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
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

function ImageCard({ sessionId, path }: { sessionId: string; path: string }) {
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
      <button type="button" class="media-shot" aria-label="Открыть картинку" disabled={!url} onClick={() => setOpen(true)}>
        {url && <img src={url} alt={fileName(path)} />}
      </button>
      {open && url && (
        <div class="media-lightbox" role="dialog" aria-label="Картинка">
          <button type="button" class="media-close" aria-label="Свернуть" onClick={() => setOpen(false)}>×</button>
          <img src={url} alt={fileName(path)} />
        </div>
      )}
    </>
  );
}

export function MediaView({ sessionId, file }: { sessionId: string; file: MediaRef }) {
  if (file.kind === "audio") return <AudioCard sessionId={sessionId} path={file.path} />;
  if (file.kind === "video") return <VideoCard sessionId={sessionId} path={file.path} />;
  return <ImageCard sessionId={sessionId} path={file.path} />;
}
