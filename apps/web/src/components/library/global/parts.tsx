"use client";

/**
 * Piezas chicas que comparten la grilla, el detalle y el picker: la preview
 * por tipo de asset, los badges de estado y de licencia, y el formato de la
 * duración. Están juntas para que las tres pantallas dibujen un asset igual.
 */
import type { LibraryAsset } from "@fastgram/contracts";
import { Badge, Spinner, cn } from "@fastgram/ui";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChromaKeyVideo } from "@/components/blitz/deck/ChromaKeyVideo";
import { tw } from "@/lib/i18n/t";
import { FAILURE_COPY, KIND_COPY, LICENSE_COPY, STATUS_COPY } from "./copy";

/** `4.2 s`, `1:05`. `null` = no hay duración que mostrar (imagen). */
export function formatDuration(sec: number | null): string | null {
  if (sec === null) return null;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${String(m)}:${String(s).padStart(2, "0")}`;
}

/**
 * El damero de «esto es transparente», como en cualquier editor. Sobre un
 * fondo liso no se distingue un croma bien recortado de uno que dejó un halo
 * del mismo color que el fondo.
 */
export const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundColor: "#e5e5e5",
  backgroundImage:
    "linear-gradient(45deg, #bdbdbd 25%, transparent 25%), linear-gradient(-45deg, #bdbdbd 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #bdbdbd 75%), linear-gradient(-45deg, transparent 75%, #bdbdbd 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

/**
 * ¿Está en pantalla? El keyer de `ChromaKeyVideo` corre un `requestAnimationFrame`
 * con `getImageData` por cuadro: cuarenta tarjetas a la vez son cuarenta
 * bucles. Sólo se monta para lo visible. Sin `IntersectionObserver` (jsdom,
 * navegadores viejos) se asume visible: mejor caro que en blanco.
 */
function useInView<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      setInView(entries.some((e) => e.isIntersecting));
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, []);
  return [ref, inView];
}

/**
 * La preview según el tipo:
 *
 * - `green_screen_video` con croma verde → `ChromaKeyVideo` sobre el damero.
 *   Ese keyer sólo recorta verde; un clip `blue` o `alpha` va como video
 *   plano sobre el damero (el `alpha` se ve bien igual, el `blue` no).
 * - videos de fondo → `<video>` que corre al pasar el mouse.
 * - imágenes → `<img>`.
 * - audio → un `<audio controls>`.
 *
 * Mientras procesa no hay `url`: se muestra un spinner, no un hueco.
 */
export function AssetPreview({
  asset,
  compact = false,
}: {
  readonly asset: LibraryAsset;
  readonly compact?: boolean;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const url = asset.url ?? asset.previewUrl;
  const frame = cn(
    "relative w-full overflow-hidden bg-surface-sunken",
    asset.kind === "audio" ? "h-24" : compact ? "aspect-square" : "aspect-[4/5]",
  );

  if (url === null) {
    return (
      <div ref={ref} className={cn(frame, "flex items-center justify-center")}>
        {asset.status === "processing" ? (
          <Spinner label={tw("globalLibrary.status.processing")} />
        ) : (
          <span className="text-xs text-text-subtle">
            {tw("globalLibrary.preview.none")}
          </span>
        )}
      </div>
    );
  }

  if (asset.kind === "green_screen_video") {
    const chroma = asset.metadata?.chroma.type ?? "green";
    const src = asset.url ?? url;
    return (
      <div
        ref={ref}
        className={frame}
        style={CHECKERBOARD_STYLE}
        data-testid="green-screen-preview"
      >
        {!inView ? null : chroma === "green" ? (
          <ChromaKeyVideo url={src} />
        ) : (
          <video
            src={src}
            muted
            loop
            autoPlay
            playsInline
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
      </div>
    );
  }

  if (asset.mediaType === "video") {
    return (
      <div ref={ref} className={frame}>
        <video
          src={asset.url ?? url}
          {...(asset.previewUrl === null ? {} : { poster: asset.previewUrl })}
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          className="h-full w-full object-cover"
          onMouseEnter={(e) => {
            void e.currentTarget.play().catch(() => undefined);
          }}
          onMouseLeave={(e) => {
            e.currentTarget.pause();
          }}
        />
      </div>
    );
  }

  if (asset.mediaType === "audio") {
    return (
      <div ref={ref} className={cn(frame, "flex items-center px-3")}>
        <audio
          src={url}
          controls
          preload="none"
          className="w-full"
          aria-label={asset.title}
        />
      </div>
    );
  }

  return (
    <div ref={ref} className={frame}>
      <img
        src={asset.previewUrl ?? url}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
    </div>
  );
}

/** Estado (salvo `ready`, que es lo normal) y «Needs review». */
export function AssetStatusBadges({ asset }: { readonly asset: LibraryAsset }) {
  const tone =
    asset.status === "failed" ? "danger" : asset.status === "hidden" ? "neutral" : "info";
  return (
    <span className="flex flex-wrap gap-1">
      {asset.status !== "ready" && (
        <Badge tone={tone} size="sm">
          {tw(STATUS_COPY[asset.status])}
        </Badge>
      )}
      {asset.metadata?.needsReview === true && (
        <Badge tone="warning" size="sm">
          {tw("globalLibrary.needsReview")}
        </Badge>
      )}
    </span>
  );
}

export function KindBadge({ asset }: { readonly asset: LibraryAsset }) {
  return (
    <Badge tone="outline" size="sm">
      {tw(KIND_COPY[asset.kind])}
    </Badge>
  );
}

/**
 * La licencia, y la atribución cuando la exige (CC BY): mostrarla es una
 * condición de la licencia, no un adorno, así que va visible en la tarjeta.
 */
export function LicenseLine({ asset }: { readonly asset: LibraryAsset }) {
  const { license } = asset;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1">
        <Badge tone="accent" size="sm" data-testid="license-badge">
          {tw(LICENSE_COPY[license.type])}
          {license.version === undefined ? "" : ` ${license.version}`}
        </Badge>
      </span>
      {license.attribution !== undefined && (
        <span
          className="truncate text-xs text-text-muted"
          title={license.attribution}
          data-testid="license-attribution"
        >
          {tw("globalLibrary.attribution", { text: license.attribution })}
        </span>
      )}
    </span>
  );
}

export function FailureNote({ asset }: { readonly asset: LibraryAsset }) {
  if (asset.status !== "failed" || asset.failureCode === null) return null;
  return (
    <span className="text-xs text-danger">{tw(FAILURE_COPY[asset.failureCode])}</span>
  );
}
