"use client";

import { useEffect, useRef, useState } from "react";
import { fileKind } from "@/lib/library/content";
import { td } from "@/lib/blitz/deck/copy";
import {
  hasAudio,
  slidesOf,
  type DeckCard,
  type PreviewSlide,
} from "@/lib/blitz/deck/suggestion";
import type { BlitzContentType } from "@fastgram/contracts";
import { ChevronLeftIcon, ChevronRightIcon, MuteIcon, VolumeIcon } from "./icons";

/**
 * La cara de una tarjeta: la preview de la pieza, 9:16 (FR-050 *Centro*).
 *
 * ## Una preview fiel, armada en el cliente
 *
 * La sugerencia no trae un render: trae texto y, si el refill eligió media, el
 * fondo. La preview es eso mismo —el texto sobre el fondo— con la escala del
 * render: el tamaño de letra se expresa en **unidades de editor de 360 de
 * ancho** (`calc(N * 100cqw / 360)`), la misma regla que usa el worker
 * (PLAN-USO-PERSONAL §7: *"misma escala de 360 unidades que el render"*). Así
 * una línea que en la tarjeta parte en tres, en el video también.
 *
 * El estilo de texto es el `tiktok-classic` (blanco, contorno negro): el preset
 * concreto de la sugerencia (`textStylePresetId`) no se expone todavía.
 */
export interface CardFaceProps {
  readonly card: DeckCard;
  /** Sólo la de arriba tiene controles; las de atrás son decorado. */
  readonly interactive: boolean;
}

/** 22 unidades de editor ≈ el `tiktok-classic` de un wall of text. */
const TEXT_SIZE_UNITS = 22;

export function CardFace({ card, interactive }: CardFaceProps) {
  const { suggestion } = card;
  return (
    <SuggestionFace
      contentType={suggestion.contentType}
      slides={slidesOf(suggestion)}
      audioUrl={hasAudio(suggestion) ? (suggestion.preview?.audioUrl ?? null) : null}
      interactive={interactive}
    />
  );
}

interface SuggestionFaceProps {
  readonly contentType: BlitzContentType;
  readonly slides: readonly PreviewSlide[];
  readonly audioUrl: string | null;
  readonly interactive: boolean;
}

function SuggestionFace({
  contentType,
  slides,
  audioUrl,
  interactive,
}: SuggestionFaceProps) {
  const [index, setIndex] = useState(0);
  const current = slides[Math.min(index, slides.length - 1)] ?? slides[0];
  const many = slides.length > 1;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ containerType: "inline-size", background: "#111" }}
    >
      {current?.imageUrl != null ? (
        <SlideBackground url={current.imageUrl} contentType={contentType} />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(160deg, var(--fg-accent-700), var(--fg-neutral-900) 70%)",
          }}
        />
      )}

      {current?.text != null && (
        <div className="absolute inset-0 flex items-center justify-center p-[8%]">
          <p
            className="whitespace-pre-line text-center font-extrabold leading-tight text-white"
            style={{
              fontSize: `calc(${String(TEXT_SIZE_UNITS)} * 100cqw / 360)`,
              // `tiktok-classic`: contorno negro. `paint-order` hace que el
              // trazo quede por detrás del relleno y no se coma la letra.
              WebkitTextStroke: "calc(4 * 100cqw / 360) #000",
              paintOrder: "stroke fill",
              textShadow: "0 2px 6px rgba(0,0,0,.45)",
            }}
          >
            {current.text}
          </p>
        </div>
      )}

      {interactive && audioUrl !== null && <MuteToggle audioUrl={audioUrl} />}

      {interactive && many && (
        <SlideNav
          index={index}
          total={slides.length}
          onChange={(next) => {
            setIndex(next);
          }}
        />
      )}
    </div>
  );
}

function SlideBackground({
  url,
  contentType,
}: {
  url: string;
  contentType: BlitzContentType;
}) {
  if (fileKind(url, contentType) === "video") {
    return (
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src={url}
        autoPlay
        muted
        loop
        playsInline
        aria-hidden="true"
      />
    );
  }
  return (
    // `<img>` y no `next/image`: el mismo motivo que `ContentCard` (los hosts de
    // la media no están declarados en `next.config.ts`).
    <img
      className="absolute inset-0 h-full w-full object-cover"
      src={url}
      alt=""
      draggable={false}
    />
  );
}

/**
 * F-057, variante *Generación B*: el mute es un icono **sobre la tarjeta**, en
 * la esquina superior izquierda (FR-050, `[DOCS-7 t=465s]`).
 *
 * Arranca en silencio: los navegadores bloquean el autoplay con sonido, así que
 * el primer sonido tiene que salir de un gesto del usuario — este botón.
 */
function MuteToggle({ audioUrl }: { audioUrl: string }) {
  const [muted, setMuted] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audio.muted = muted;
    if (muted) {
      audio.pause();
      return;
    }
    // `play()` puede rechazar (política de autoplay, formato): la tarjeta sigue
    // funcionando en silencio, que es el estado de partida.
    try {
      const played: Promise<void> | undefined = audio.play() as Promise<void> | undefined;
      played?.catch(() => {
        setMuted(true);
      });
    } catch {
      setMuted(true);
    }
  }, [muted]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    [],
  );

  const label = muted ? td("deck.unmute") : td("deck.mute");
  return (
    <>
      <audio ref={audioRef} src={audioUrl} loop preload="none" />
      <button
        type="button"
        data-no-drag
        aria-label={label}
        aria-pressed={!muted}
        title={label}
        className="fg-focusable absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-white"
        style={{ background: "rgba(0,0,0,.55)" }}
        onClick={() => {
          setMuted((m) => !m);
        }}
      >
        {muted ? <MuteIcon size={18} /> : <VolumeIcon size={18} />}
      </button>
    </>
  );
}

/** Flechas ‹ › y dots de posición para slideshows (FR-050 *Centro*). */
function SlideNav({
  index,
  total,
  onChange,
}: {
  index: number;
  total: number;
  onChange: (next: number) => void;
}) {
  const arrow =
    "fg-focusable absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-white disabled:opacity-30";
  return (
    <>
      <button
        type="button"
        data-no-drag
        className={`${arrow} left-2`}
        style={{ background: "rgba(0,0,0,.45)" }}
        aria-label={td("deck.slide.prev")}
        disabled={index === 0}
        onClick={() => {
          onChange(Math.max(0, index - 1));
        }}
      >
        <ChevronLeftIcon size={18} />
      </button>
      <button
        type="button"
        data-no-drag
        className={`${arrow} right-2`}
        style={{ background: "rgba(0,0,0,.45)" }}
        aria-label={td("deck.slide.next")}
        disabled={index === total - 1}
        onClick={() => {
          onChange(Math.min(total - 1, index + 1));
        }}
      >
        <ChevronRightIcon size={18} />
      </button>
      <div
        className="absolute bottom-3 left-0 right-0 flex justify-center gap-1.5"
        role="status"
        aria-label={td("deck.slide.position", { current: index + 1, total })}
      >
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="h-1.5 rounded-full transition-all"
            style={{
              width: i === index ? 16 : 6,
              background: i === index ? "#fff" : "rgba(255,255,255,.5)",
            }}
          />
        ))}
      </div>
    </>
  );
}
