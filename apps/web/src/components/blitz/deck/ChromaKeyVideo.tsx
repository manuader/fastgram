"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

/**
 * El clip de meme de un green screen, recortado en el navegador (sprint 7).
 *
 * El render real hace el croma con ffmpeg (`services/render`, `formats.ts`);
 * esto es sólo la preview de la tarjeta: cada frame del video se dibuja en un
 * canvas chico y los píxeles «muy verdes» se vuelven transparentes. Va donde
 * lo pone el build: entero (`contain`) en el tramo de abajo.
 *
 * Necesita que el storage mande CORS (MinIO lo hace): sin eso `getImageData`
 * tira y la preview cae al video sin recortar, que al menos muestra el meme.
 */
const MAX_SIDE = 360;

/**
 * Copia de `GREEN_SCREEN_CLIP_TOP` de `@fastgram/core` (`blitz-build.ts`): la
 * web no depende de core. Si cambia allá, cambia acá.
 */
const GREEN_SCREEN_CLIP_TOP = 0.35;

export function ChromaKeyVideo({ url }: { url: string }) {
  // WCAG 2.2.2: con «reducir movimiento» el meme queda quieto en su primer
  // frame (se sigue viendo recortado sobre el fondo).
  const still = useReducedMotion() ?? false;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video === null || canvas === null) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) return;
    let raf = 0;
    let tainted = false;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (video.readyState < 2 || video.videoWidth === 0) return;
      const box = canvas.getBoundingClientRect();
      const scale = Math.min(1, MAX_SIDE / Math.max(box.width, box.height, 1));
      const w = Math.max(1, Math.round(box.width * scale));
      const h = Math.max(1, Math.round(box.height * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // `contain` en el tramo de abajo, como el build (`GREEN_SCREEN_CLIP_TOP`).
      const top = Math.round(h * GREEN_SCREEN_CLIP_TOP);
      const areaH = h - top;
      const k = Math.min(w / video.videoWidth, areaH / video.videoHeight);
      const dw = video.videoWidth * k;
      const dh = video.videoHeight * k;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(video, (w - dw) / 2, top + (areaH - dh) / 2, dw, dh);
      if (tainted) return;
      try {
        const frame = ctx.getImageData(0, 0, w, h);
        const px = frame.data;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i] ?? 0;
          const g = px[i + 1] ?? 0;
          const b = px[i + 2] ?? 0;
          if (g > 90 && g > r * 1.35 && g > b * 1.35) px[i + 3] = 0;
        }
        ctx.putImageData(frame, 0, 0);
      } catch {
        tainted = true;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [url]);

  return (
    <>
      <video
        ref={videoRef}
        src={url}
        crossOrigin="anonymous"
        autoPlay={!still}
        preload="auto"
        muted
        loop
        playsInline
        aria-hidden="true"
        className="hidden"
      />
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
      />
    </>
  );
}
