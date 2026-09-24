/**
 * La política de una subida en tres pasos (§9.8), compartida por las dos
 * pantallas que suben: el video custom del Studio (`lib/studio/custom-video.ts`)
 * y el Media Bank (`lib/media/upload/queue.ts`).
 *
 * Salió de `custom-video.ts` en `PU-MEDIA-001`. Lo que cambia entre las dos
 * pantallas es **qué schema del contrato** valida la reserva y **qué content
 * types** acepta; lo demás —deducir el tipo por la extensión, traducir el issue
 * de Zod a un motivo, desde dónde se retoma un fallo— es la misma regla, y dos
 * copias de una regla terminan discrepando.
 */
import { BYTES_PER_MB, CONTENT_TYPE_EXTENSIONS } from "@fastgram/contracts";
import type { z } from "zod";
import { presentError } from "../../api/error-presentation";
import { ApiRequestError, isApiRequestError } from "../../api/errors";

/**
 * Lo mínimo que hace falta de un archivo. Es un `File` del navegador sin
 * depender del DOM, para poder probar la política sin fabricar un `File`.
 */
export interface UploadCandidate {
  readonly name: string;
  /** `""` cuando el sistema no supo decir el tipo. Pasa, y hay que tratarlo. */
  readonly type: string;
  readonly size: number;
}

export type FileRejectionReason =
  "empty" | "too_large" | "unsupported_type" | "extension_mismatch";

export type FileCheck<TBody> =
  | { readonly ok: true; readonly body: TBody }
  | { readonly ok: false; readonly reason: FileRejectionReason };

/** Las extensiones que el contrato ata a esos content types. */
export function extensionsFor(contentTypes: readonly string[]): readonly string[] {
  return [
    ...new Set(contentTypes.flatMap((type) => CONTENT_TYPE_EXTENSIONS[type] ?? [])),
  ];
}

/**
 * El `accept` del `<input type="file">`: content types **y** extensiones.
 *
 * No son intercambiables: Windows y algunos Safari no le ponen `type` a un
 * `.mov`, así que filtrar sólo por MIME esconde archivos que sí se aceptan. Y
 * `accept` es una sugerencia del diálogo, nunca una validación: quien arrastre
 * otra cosa pasa igual, y para eso está `checkUpload`.
 */
export function acceptFor(contentTypes: readonly string[]): string {
  return [...contentTypes, ...extensionsFor(contentTypes)].join(",");
}

/**
 * El content type que se va a **declarar** en la reserva.
 *
 * Si el navegador da uno de los permitidos, ése. Si no, se deduce de la
 * extensión con el mapa del **contrato** leído al revés. Deducir no afloja
 * nada: el servidor tampoco abre el archivo — comprueba exactamente estas dos
 * cosas, el tipo declarado y que la extensión le corresponda.
 */
export function contentTypeFrom(
  file: UploadCandidate,
  contentTypes: readonly string[],
): string {
  if (contentTypes.includes(file.type)) return file.type;
  const lower = file.name.toLowerCase();
  const guessed = contentTypes.find((type) =>
    (CONTENT_TYPE_EXTENSIONS[type] ?? []).some((ext) => lower.endsWith(ext)),
  );
  // Sin deducción se devuelve lo que dijo el navegador (o `""`): el schema lo
  // rechaza con `unsupported_type`, que es la verdad.
  return guessed ?? file.type;
}

/**
 * ¿Entra este archivo? La respuesta la da el schema del contrato —el mismo que
 * valida el body en la API—, y el motivo sale del `path` del issue de Zod, no
 * de una segunda tanda de `if`s que podría discrepar con él.
 */
export function checkUpload<TBody>(
  file: UploadCandidate,
  schema: z.ZodType<TBody, z.ZodTypeDef, unknown>,
  contentTypes: readonly string[],
): FileCheck<TBody> {
  // Un archivo de 0 bytes falla el `.positive()` del schema por `sizeBytes`, o
  // sea por el mismo camino que uno de 80 MB. Decirle a alguien "el tope son 50
  // MB" sobre un archivo vacío es un consejo falso, así que se separa antes.
  if (file.size <= 0) return { ok: false, reason: "empty" };

  const parsed = schema.safeParse({
    filename: file.name,
    contentType: contentTypeFrom(file, contentTypes),
    sizeBytes: file.size,
  });
  if (parsed.success) return { ok: true, body: parsed.data };

  const paths = new Set(parsed.error.issues.map((issue) => issue.path[0]));
  // El orden importa: un `.txt` de 80 MB falla por las dos cosas, y lo que hay
  // que decirle a quien lo eligió es que el formato no entra — renombrarlo no
  // lo arreglaría, y bajarle el peso tampoco.
  if (paths.has("contentType")) return { ok: false, reason: "unsupported_type" };
  if (paths.has("filename")) return { ok: false, reason: "extension_mismatch" };
  if (paths.has("sizeBytes")) return { ok: false, reason: "too_large" };
  return { ok: false, reason: "unsupported_type" };
}

/** `62.4` — el tamaño en MB con un decimal, para decírselo al usuario. */
export function sizeInMb(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1);
}

/** Los tres pasos de §9.8, para saber cuál falló. */
export type UploadStep = "reserve" | "transfer" | "finalize";

/**
 * Desde dónde se puede retomar un fallo.
 *
 * · `restart`  — hay que volver al paso 1 (que es gratis).
 * · `finalize` — los bytes ya están arriba: sólo falta el paso 3.
 * · `none`     — no hay reintento que ayude, y ofrecerlo sería un botón que no
 *                puede funcionar (§19: la cuota agotada es el caso de manual).
 */
export type ResumePoint = "restart" | "finalize" | "none";

/**
 * Qué se puede hacer con un fallo, según **qué paso** cayó y **qué código**
 * trajo. La regla de fondo: el reintento se ofrece cuando puede cambiar el
 * resultado, y cuesta lo menos posible. Reintentar el paso 3 no vuelve a subir
 * el archivo; reintentar el paso 1 no cuesta nada (PRD:2285).
 */
export function resumeFor(step: UploadStep, error: ApiRequestError | null): ResumePoint {
  // El PUT: la reserva vieja no aporta nada y una nueva es gratis.
  if (step === "transfer" || error === null) return "restart";

  if (step === "reserve") {
    return presentError(error).remedy === "retry" ? "restart" : "none";
  }

  // Paso 3. `410 gone` = la reserva caducó: repetirlo da otro 410.
  if (error.code === "gone") return "restart";
  // `409 conflict` en §9.8 es "el objeto todavía no se ve" — recuperable, y
  // justo el caso en que volver a subir 50 MB sería absurdo.
  if (error.code === "conflict") return "finalize";
  return presentError(error).remedy === "retry" ? "finalize" : "none";
}

/** Cualquier cosa que lance `apiRequest`, como error del contrato. */
export function asApiError(cause: unknown): ApiRequestError {
  if (isApiRequestError(cause)) return cause;
  return new ApiRequestError({
    code: "invalid_response",
    status: 0,
    serverMessage: cause instanceof Error ? cause.message : String(cause),
  });
}
