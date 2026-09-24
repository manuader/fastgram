"use client";

/**
 * Preview de una pista: un solo `<audio>` por pantalla, play/pause por id.
 *
 * Uno solo a propósito: con uno por fila, tocar dos previews las superpone y
 * la única forma de callarlas es encontrar cuál suena. Se detiene al
 * desmontar (cerrar el modal no puede dejar música sonando de fondo).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface AudioPreview {
  /** El id que está sonando, o `null`. */
  readonly playingId: string | null;
  /** Play si no sonaba esa pista; pause si sí. */
  readonly toggle: (id: string, url: string) => void;
  readonly stop: () => void;
  /** `true` si el navegador no pudo reproducir la última pista pedida. */
  readonly failedId: string | null;
}

export function useAudioPreview(): AudioPreview {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setPlayingId(null);
  }, []);

  const toggle = useCallback(
    (id: string, url: string) => {
      if (typeof Audio === "undefined") return;
      if (playingId === id) {
        stop();
        return;
      }
      let audio = audioRef.current;
      if (audio === null) {
        audio = new Audio();
        audio.preload = "none";
        audioRef.current = audio;
      }
      audio.pause();
      audio.src = url;
      audio.onended = () => setPlayingId(null);
      setFailedId(null);
      setPlayingId(id);
      // `play()` puede rechazar (formato, autoplay, red). No es un error de la
      // pantalla: se marca la fila y se vuelve a "pausado".
      void Promise.resolve(audio.play()).catch(() => {
        setPlayingId((current) => (current === id ? null : current));
        setFailedId(id);
      });
    },
    [playingId, stop],
  );

  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (audio !== null) {
        audio.pause();
        audio.removeAttribute("src");
      }
    },
    [],
  );

  return { playingId, toggle, stop, failedId };
}
