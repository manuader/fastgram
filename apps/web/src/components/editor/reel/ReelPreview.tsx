"use client";

/**
 * La preview del reel: la **misma** composición HTML que renderiza el motor
 * (`POST /reels/preview` → `services/render`), en un iframe, con el runtime de
 * HyperFrames adentro. Play / pause / seek hablan con `window.__player` del
 * iframe. Lo que se ve es lo que sale: no hay un segundo dibujante que se
 * pueda desincronizar del render.
 *
 * El iframe es 1080×1920 de verdad y se escala con `transform`: dibujarlo al
 * tamaño de pantalla cambiaría el layout (el texto se parte distinto) y dejaría
 * de ser idéntico al render.
 */
import { Button, Spinner } from "@fastgram/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useElementWidth } from "@/lib/editor/dom";
import { tw } from "@/lib/i18n/t";
import { formatClock } from "./state";

const CANVAS_W = 1080;
const CANVAS_H = 1920;
const MAX_WIDTH = 360;

interface HfPlayer {
  play(): void;
  pause(): void;
  seek(time: number): void;
  getTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
}

/** Un pedido de la página: ir a `time` y, si `play`, reproducir desde ahí. */
export interface PreviewCue {
  readonly time: number;
  readonly play: boolean;
  /** Cambia en cada pedido, aunque `time` sea el mismo. */
  readonly nonce: number;
}

export interface ReelPreviewProps {
  readonly html: string | null;
  readonly loading: boolean;
  readonly error: "unavailable" | "failed" | null;
  readonly durationSec: number;
  readonly cue: PreviewCue | null;
  readonly onRetry: () => void;
}

function playerOf(frame: HTMLIFrameElement | null): HfPlayer | null {
  const win = frame?.contentWindow as
    (Window & { __player?: HfPlayer }) | null | undefined;
  return win?.__player ?? null;
}

export function ReelPreview({
  html,
  loading,
  error,
  durationSec,
  cue,
  onRetry,
}: ReelPreviewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const width = Math.min(MAX_WIDTH, useElementWidth(box, MAX_WIDTH));
  const scale = width / CANVAS_W;
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const seekId = useId();

  // Cada HTML nuevo es otro documento: hay que esperar a su runtime.
  useEffect(() => {
    setReady(false);
    setPlaying(false);
  }, [html]);

  function onLoad(): void {
    let tries = 0;
    const wait = (): void => {
      if (playerOf(frameRef.current) !== null) {
        setReady(true);
        return;
      }
      tries += 1;
      if (tries < 100) window.setTimeout(wait, 50);
    };
    wait();
  }

  // Reloj: mientras reproduce, se lee la hora del runtime (no se inventa una).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = (): void => {
      const p = playerOf(frameRef.current);
      if (p !== null) {
        setTime(p.getTime());
        if (!p.isPlaying()) {
          setPlaying(false);
          return;
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [playing]);

  // Pedidos de la página (preview de animación, elegir una capa).
  useEffect(() => {
    if (cue === null || !ready) return;
    const p = playerOf(frameRef.current);
    if (p === null) return;
    p.seek(cue.time);
    setTime(cue.time);
    if (cue.play) {
      p.play();
      setPlaying(true);
    } else {
      p.pause();
      setPlaying(false);
    }
  }, [cue, ready]);

  function toggle(): void {
    const p = playerOf(frameRef.current);
    if (p === null) return;
    if (p.isPlaying()) {
      p.pause();
      setPlaying(false);
    } else {
      if (p.getTime() >= durationSec - 0.05) p.seek(0);
      p.play();
      setPlaying(true);
    }
  }

  function seek(value: number): void {
    const p = playerOf(frameRef.current);
    if (p === null) return;
    p.pause();
    setPlaying(false);
    p.seek(value);
    setTime(value);
  }

  return (
    <div
      ref={box}
      className="grid w-full justify-items-center gap-3"
      data-testid="reel-preview"
    >
      <div
        className="relative overflow-hidden rounded-xl bg-black shadow-sm"
        style={{ width, height: (width * CANVAS_H) / CANVAS_W }}
      >
        {html !== null && (
          <iframe
            ref={frameRef}
            title={tw("editor.reel.preview")}
            srcDoc={html}
            onLoad={onLoad}
            className="absolute left-0 top-0 border-0"
            style={{
              width: CANVAS_W,
              height: CANVAS_H,
              transform: `scale(${String(scale)})`,
              transformOrigin: "0 0",
            }}
          />
        )}
        {(loading || (html !== null && !ready)) && error === null && (
          <div
            role="status"
            className="absolute inset-0 grid place-items-center bg-black/50 text-sm text-white"
          >
            <span className="inline-flex items-center gap-2">
              <Spinner size="sm" aria-hidden />
              {tw("editor.reel.previewLoading")}
            </span>
          </div>
        )}
        {error !== null && (
          <div className="absolute inset-0 grid place-items-center gap-2 bg-black/70 p-4 text-center text-sm text-white">
            <p role="alert">
              {tw(
                error === "unavailable"
                  ? "editor.reel.previewUnavailable"
                  : "editor.reel.previewError",
              )}
            </p>
            {error === "failed" && (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                {tw("editor.reel.previewRetry")}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex w-full max-w-[360px] items-center gap-2">
        <Button size="sm" variant="secondary" onClick={toggle} disabled={!ready}>
          {tw(playing ? "editor.reel.pause" : "editor.reel.play")}
        </Button>
        <label htmlFor={seekId} className="sr-only">
          {tw("editor.reel.seek")}
        </label>
        <input
          id={seekId}
          type="range"
          className="fg-focusable flex-1 accent-[var(--fg-color-accent)]"
          min={0}
          max={durationSec}
          step={0.01}
          value={Math.min(time, durationSec)}
          disabled={!ready}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="w-24 text-right text-xs tabular-nums text-text-muted">
          {tw("editor.reel.time", {
            time: formatClock(time),
            total: formatClock(durationSec),
          })}
        </span>
      </div>
    </div>
  );
}
