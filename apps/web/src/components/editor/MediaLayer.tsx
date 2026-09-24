"use client";

import type { MediaElement } from "@fastgram/contracts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { tw } from "@/lib/i18n/t";

/**
 * Un elemento de media en su rectángulo de dibujo (`drawX/Y/W/H`, px de
 * canvas), escalado al preview.
 *
 * `object-fit: fill` porque el render **estira** al rectángulo (FR-070:
 * *"stretch-to-canvas"*): con `cover` el preview recortaría una imagen que en
 * el video sale deformada, y dejaría de ser lo que sale.
 */
export interface MediaLayerProps {
  readonly media: MediaElement;
  readonly kind: "image" | "video";
  readonly scale: number;
  /** El meme del green-screen: se recorta el verde en el cliente. */
  readonly chromaKey?: boolean;
  readonly className?: string;
}

function rectStyle(media: MediaElement, scale: number): CSSProperties {
  return {
    position: "absolute",
    left: media.drawX * scale,
    top: media.drawY * scale,
    width: media.drawW * scale,
    height: media.drawH * scale,
    objectFit: "fill",
    pointerEvents: "none",
    userSelect: "none",
  };
}

export function MediaLayer({
  media,
  kind,
  scale,
  chromaKey,
  className,
}: MediaLayerProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [media.url]);
  const style = rectStyle(media, scale);

  if (failed) {
    return (
      <div
        className="flex items-center justify-center bg-surface-sunken text-xs text-text-subtle"
        style={style}
        role="img"
        aria-label={tw("editor.canvas.mediaError")}
      >
        {tw("editor.canvas.mediaError")}
      </div>
    );
  }

  if (kind === "image") {
    return (
      // Sin `next/image`: los dominios de la media no están declarados.
      <img
        src={media.url}
        alt=""
        draggable={false}
        className={className}
        style={style}
        onError={() => setFailed(true)}
      />
    );
  }

  if (chromaKey === true) {
    return <ChromaVideo media={media} style={style} onError={() => setFailed(true)} />;
  }

  return (
    <video
      src={media.url}
      className={className}
      style={style}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      onError={() => setFailed(true)}
    />
  );
}

/** Verde dominante: el mismo criterio grueso que un chromakey de FFmpeg sobre verde puro. */
function isGreen(r: number, g: number, b: number): boolean {
  return g > 90 && g > r * 1.35 && g > b * 1.35;
}

/**
 * El meme con el fondo verde recortado, dibujado en un `<canvas>`.
 *
 * El render lo compone con el chromakey de FFmpeg; esto es una aproximación
 * para que el preview muestre el fondo de la marca detrás y no un rectángulo
 * verde. **Necesita CORS** en el bucket: leer los píxeles de un video de otro
 * origen sin `Access-Control-Allow-Origin` tira `SecurityError`. En ese caso se
 * cae al video tal cual —con el verde visible— en vez de romper el editor.
 */
function ChromaVideo({
  media,
  style,
  onError,
}: {
  readonly media: MediaElement;
  readonly style: CSSProperties;
  readonly onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [keyed, setKeyed] = useState(true);

  useEffect(() => {
    setKeyed(true);
  }, [media.url]);

  useEffect(() => {
    if (!keyed) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (video === null || canvas === null || ctx === null) {
      setKeyed(false);
      return;
    }
    let raf = 0;
    const draw = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        // Se procesa a baja resolución: es un preview, y 30 fps de
        // `getImageData` a 1080p se comen la CPU.
        const w = Math.min(360, video.videoWidth);
        const h = Math.round((w * video.videoHeight) / video.videoWidth);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        try {
          const frame = ctx.getImageData(0, 0, w, h);
          const px = frame.data;
          for (let i = 0; i < px.length; i += 4) {
            if (isGreen(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0)) px[i + 3] = 0;
          }
          ctx.putImageData(frame, 0, 0);
        } catch {
          setKeyed(false);
          return;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [keyed, media.url]);

  return (
    <>
      <video
        ref={videoRef}
        // `key`: cambiar `crossOrigin` en un video ya cargado no lo recarga.
        key={keyed ? "keyed" : "plain"}
        src={media.url}
        {...(keyed ? { crossOrigin: "anonymous" as const } : {})}
        style={keyed ? { display: "none" } : style}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        // Sin CORS en el bucket, el pedido en modo CORS falla entero: se
        // reintenta sin recorte antes de declarar la media rota.
        onError={keyed ? () => setKeyed(false) : onError}
      />
      {keyed && <canvas ref={canvasRef} style={style} aria-hidden />}
    </>
  );
}
