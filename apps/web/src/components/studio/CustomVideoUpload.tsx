"use client";

import { Button } from "@fastgram/ui";
import Link from "next/link";
import { useId, useRef, type ChangeEvent } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import {
  CUSTOM_VIDEO_ACCEPT,
  CUSTOM_VIDEO_MAX_MB,
  sizeInMb,
  useCustomVideoUpload,
  type CustomVideoPhase,
  type FileRejectionReason,
} from "@/lib/studio/custom-video";
import type { CopyKey } from "@/lib/i18n/t";

/**
 * `/content/custom` — subir un video propio como contenido · `F-083`
 * (PRD:525), `FR-070` (PRD:1463), §9.8.
 *
 * El porqué de los tres pasos, del límite y de los dos puntos de reanudación
 * está en `lib/studio/custom-video.ts`. Acá sólo se dibuja, y lo que se decide
 * es **qué ve el usuario en cada uno**:
 *
 * · **Antes de elegir** — el tope y los formatos, con el número del contrato.
 *   Decirlo antes evita el único error que cuesta tiempo de verdad: elegir un
 *   archivo de 300 MB y enterarse al final.
 * · **Rechazado en local** — el motivo, con *su* número (`62.4 MB`), y ni una
 *   petición. El `400` con `issues` de Zod diría lo mismo en un idioma que no
 *   es el del usuario, y treinta segundos más tarde.
 * · **Subiendo** — una barra con porcentaje **real**, no un spinner. Los 50 MB
 *   del tope son uno o dos minutos de subida doméstica; un indicador que no
 *   avanza se lee como "colgado" y lo que sigue es una recarga que tira lo que
 *   ya había salido. Y `Cancel`, que corta de verdad (`xhr.abort()`).
 * · **Fallo** — con la salida **que corresponde al paso que falló**. Si cayó la
 *   finalización, el botón dice `Finish upload` y no `Try again`: el archivo ya
 *   está arriba y volver a subirlo sería tirar la subida entera por una
 *   petición de 40 bytes. Si cayó el PUT, se empieza otra vez — la reserva es
 *   gratis (PRD:2285).
 * · **Listo** — que la pieza está en `BUILDING` y **todavía no sirve**: el MOV
 *   se normaliza a MP4 y el thumbnail se genera en el servidor (FR-070). Decir
 *   "listo" a secas y mandar a la Library a ver una pieza a medias es prometer
 *   algo que no pasó.
 *
 * ## Lo que esta pantalla no ofrece, y por qué
 *
 * - **Imagen no.** La tarjeta del formato dice "Upload your own video or image"
 *   (PRD:536) pero la reserva de `/content/custom/video` sólo acepta
 *   `video/mp4` y `video/quicktime`. No hay endpoint por donde entre una imagen
 *   como *contenido*, así que ofrecerlo sería un control que no puede terminar.
 * - **Cancelar no borra nada en el servidor.** No hay con qué: ver
 *   `ABANDONED_UPLOAD_NOTE`. La pantalla no dice "cancelado y limpio", porque
 *   limpio no queda.
 */

/** Cada rechazo con su copy: el mensaje tiene que decir qué hacer distinto. */
const REJECTION_COPY: Readonly<Record<FileRejectionReason, CopyKey>> = {
  empty: "studio.custom.reject.empty",
  too_large: "studio.custom.reject.tooLarge",
  unsupported_type: "studio.custom.reject.unsupportedType",
  extension_mismatch: "studio.custom.reject.extensionMismatch",
};

/** Un fallo con su salida. Un bloque propio por lo que se puede hacer. */
function Failure({
  phase,
  onRetry,
}: {
  readonly phase: Extract<CustomVideoPhase, { kind: "failed" }>;
  readonly onRetry: () => void;
}) {
  // 1 · El PUT. No hay código del contrato que traducir: responde el storage.
  if (phase.step === "transfer" || phase.error === null) {
    return (
      <div className="fgw-upload__failed" role="alert">
        <p className="fgw-upload__failed-title">
          {tw("studio.custom.transferFailed.title")}
        </p>
        <p className="fgw-upload__failed-hint">
          {tw("studio.custom.transferFailed.description")}
        </p>
        <Button variant="secondary" onClick={onRetry}>
          {tw("common.tryAgain")}
        </Button>
      </div>
    );
  }

  // 2 · La reserva caducó (`410`). §19 le da `none` como salida, y tiene razón
  // para un 410 cualquiera — pero acá sí hay algo que hacer: volver a subir. El
  // `ErrorState` genérico dejaría al usuario mirando un mensaje sin botón con
  // el archivo todavía en la mano.
  if (phase.error.code === "gone") {
    return (
      <div className="fgw-upload__failed" role="alert">
        <p className="fgw-upload__failed-title">{tw("studio.custom.expired.title")}</p>
        <p className="fgw-upload__failed-hint">
          {tw("studio.custom.expired.description")}
        </p>
        <Button variant="secondary" onClick={onRetry}>
          {tw("common.tryAgain")}
        </Button>
      </div>
    );
  }

  // 3 · Cayó el paso 3 y se puede repetir **sólo** el paso 3.
  if (phase.resume === "finalize") {
    return (
      <div className="fgw-upload__failed" role="alert">
        <p className="fgw-upload__failed-title">
          {tw("studio.custom.finalizeFailed.title")}
        </p>
        <p className="fgw-upload__failed-hint">
          {tw("studio.custom.finalizeFailed.description")}
        </p>
        <Button onClick={onRetry}>{tw("studio.custom.finishUpload")}</Button>
      </div>
    );
  }

  // 4 · Lo demás es un error de la API v1 con código del contrato: la salida la
  // decide §19 y no esta pantalla. Un `429 content_quota_exceeded` con `Try
  // again` sería un botón que no puede funcionar; el `onRetry` sólo se pasa cuando reintentar
  // es realmente la salida.
  return (
    <ApiErrorState
      error={phase.error}
      {...(phase.resume === "restart" ? { onRetry } : {})}
    />
  );
}

export function CustomVideoUpload() {
  const { phase, busy, start, retry, cancel, reset } = useCustomVideoUpload();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  function onPick(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // El input se vacía siempre: sin esto, volver a elegir **el mismo** archivo
    // después de un fallo no dispara `change` y el botón parece roto.
    event.target.value = "";
    if (file === undefined) return;
    start(file);
  }

  function pickAnother(): void {
    reset();
    inputRef.current?.click();
  }

  return (
    <section className="fgw-upload" aria-busy={busy ? "true" : undefined}>
      <div className="fgw-upload__picker">
        <label className="fgw-upload__label" htmlFor={inputId}>
          {tw("studio.custom.fileLabel")}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          className="fgw-upload__input"
          accept={CUSTOM_VIDEO_ACCEPT}
          disabled={busy}
          onChange={onPick}
        />
        <p className="fgw-upload__hint">
          {tw("studio.custom.limitHint", { max: CUSTOM_VIDEO_MAX_MB })}
        </p>
        <p className="fgw-upload__hint">{tw("studio.custom.videoOnly")}</p>
      </div>

      {phase.kind === "rejected" && (
        <p className="fgw-upload__rejected" role="alert">
          {tw(REJECTION_COPY[phase.reason], {
            max: CUSTOM_VIDEO_MAX_MB,
            size: sizeInMb(phase.file.sizeBytes),
            name: phase.file.name,
          })}
        </p>
      )}

      {phase.kind === "reserving" && (
        <p className="fgw-upload__step">{tw("studio.custom.step.reserving")}</p>
      )}

      {phase.kind === "uploading" && (
        <div className="fgw-upload__progress">
          <p className="fgw-upload__step">
            {phase.percent === null
              ? tw("studio.custom.step.uploadingUnknown", { name: phase.file.name })
              : tw("studio.custom.step.uploading", {
                  name: phase.file.name,
                  percent: phase.percent,
                })}
          </p>
          {/* Sin `value` la barra es indeterminada, que es la verdad mientras el
              navegador no sepa el total. */}
          <progress
            className="fgw-upload__bar"
            max={100}
            aria-label={tw("studio.custom.progressLabel")}
            {...(phase.percent === null ? {} : { value: phase.percent })}
          />
          <Button variant="secondary" onClick={cancel}>
            {tw("studio.custom.cancel")}
          </Button>
        </div>
      )}

      {phase.kind === "finalizing" && (
        <p className="fgw-upload__step">{tw("studio.custom.step.finalizing")}</p>
      )}

      {phase.kind === "failed" && <Failure phase={phase} onRetry={retry} />}

      {phase.kind === "done" && (
        <div className="fgw-upload__done" role="status">
          <p className="fgw-upload__done-title">{tw("studio.custom.done.title")}</p>
          <p className="fgw-upload__done-hint">{tw("studio.custom.done.description")}</p>
          <div className="fgw-upload__done-actions">
            <Link href={ROUTES.library} className="fgw-upload__link">
              {tw("studio.custom.done.goToLibrary")}
            </Link>
            <Button variant="secondary" onClick={pickAnother}>
              {tw("studio.custom.uploadAnother")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
