"use client";

import { useReducedMotion } from "motion/react";
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
import { ChromaKeyVideo, type ChromaInfo } from "./ChromaKeyVideo";
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
  const reel = suggestion.preview?.reel ?? null;
  if (reel !== null && reel.videoUrl != null) {
    return (
      <ReelFace
        videoUrl={reel.videoUrl}
        posterUrl={reel.posterUrl ?? null}
        interactive={interactive}
      />
    );
  }
  // Sprint 9 (U): un reel del planificador todavía no se renderizó; su cara es
  // el póster (un cuadro compuesto por el mismo motor: fuentes, colores, logo).
  if (reel !== null && reel.posterUrl != null) {
    return <ReelPosterFace posterUrl={reel.posterUrl} durationSec={reel.durationSec ?? null} />;
  }
  return (
    <SuggestionFace
      // Un reel sin póster se dibuja como texto sobre el fondo neutro.
      contentType={suggestion.contentType === "reel" ? "wall-of-text" : suggestion.contentType}
      slides={slidesOf(suggestion)}
      audioUrl={hasAudio(suggestion) ? (suggestion.preview?.audioUrl ?? null) : null}
      overlayVideoUrl={suggestion.preview?.overlayVideoUrl ?? null}
      overlayChroma={suggestion.preview?.overlayChroma ?? null}
      interactive={interactive}
    />
  );
}

interface SuggestionFaceProps {
  readonly contentType: BlitzContentType;
  readonly slides: readonly PreviewSlide[];
  readonly audioUrl: string | null;
  /** Green screen: el meme, recortado en el cliente. Sólo en la de arriba. */
  readonly overlayVideoUrl: string | null;
  /** Sprint 9 (T): el croma del meme (azul, alfa), si se conoce. */
  readonly overlayChroma?: ChromaInfo | null;
  readonly interactive: boolean;
}

function SuggestionFace({
  contentType,
  slides,
  audioUrl,
  overlayVideoUrl,
  overlayChroma,
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

      {interactive && contentType === "green-screen" && overlayVideoUrl !== null && (
        <ChromaKeyVideo url={overlayVideoUrl} chroma={overlayChroma} />
      )}

      {current?.text != null && (
        <div
          className={
            // Green screen: caption arriba, como el build (`blitz-build.ts`, 15 %).
            contentType === "green-screen"
              ? "absolute inset-x-0 top-[8%] flex justify-center p-[8%]"
              : "absolute inset-0 flex items-center justify-center p-[8%]"
          }
        >
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
  const still = useReducedMotion() ?? false;
  if (fileKind(url, contentType) === "video") {
    return (
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src={url}
        // WCAG 2.2.2: con «reducir movimiento», primer frame quieto.
        autoPlay={!still}
        preload={still ? "metadata" : "auto"}
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

/**
 * Sprint 9 (U, `PU-S9-014`): la cara de un reel planificado, antes del render:
 * su póster y cuánto dura. El video se renderiza al aceptar (HyperFrames, 1–2
 * min en esta Mac): renderizar cada sugerencia sólo para mostrarla costaría eso
 * por tarjeta, aceptada o no.
 */
export function ReelPosterFace({
  posterUrl,
  durationSec,
}: {
  readonly posterUrl: string;
  readonly durationSec: number | null;
}) {
  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black"
      data-testid="reel-poster-face"
    >
      <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      <span className="absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white">
        {durationSec === null
          ? td("deck.reel.poster")
          : td("deck.reel.posterDuration", { seconds: Math.round(durationSec) })}
      </span>
    </div>
  );
}

/**
 * Sprint 9 (`PU-S9-010`): la cara de un reel es **el reel**: póster mientras
 * carga y el video en loop (mudo; el sonido se prende con el mismo botón que
 * el resto del deck). Sin movimiento reducido no hay autoplay: queda el póster
 * y se reproduce al tocar.
 */
export function ReelFace({
  videoUrl,
  posterUrl,
  interactive,
}: {
  readonly videoUrl: string;
  readonly posterUrl: string | null;
  readonly interactive: boolean;
}) {
  const reduce = useReducedMotion() === true;
  const video = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);

  function toggle(): void {
    const el = video.current;
    if (el === null) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-black"
      data-testid="reel-face"
    >
      <video
        ref={video}
        src={interactive ? videoUrl : undefined}
        poster={posterUrl ?? undefined}
        muted={muted}
        loop
        playsInline
        autoPlay={interactive && !reduce}
        preload={interactive ? "metadata" : "none"}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {interactive && (
        <div className="absolute bottom-3 right-3 flex gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={td(playing ? "deck.reel.pause" : "deck.reel.play")}
            className="fg-focusable rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white"
          >
            {td(playing ? "deck.reel.pause" : "deck.reel.play")}
          </button>
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            aria-label={td(muted ? "deck.unmute" : "deck.mute")}
            className="fg-focusable rounded-full bg-black/60 p-2 text-white"
          >
            {muted ? <MuteIcon size={16} /> : <VolumeIcon size={16} />}
          </button>
        </div>
      )}
    </div>
  );
}
