/**
 * Reservas de subida — el procedimiento de PRD §9.8, paso 1 y paso 3.
 *
 * ## Por qué está en `support/` y no en `http/`
 *
 * Estas funciones tocan `uploadReservationRepository` y `Storage`, y en esta app
 * `src/http/` es **política sin base**: `uploads.ts` decide qué código devuelve
 * cada estado de una reserva, `idempotency.ts` decide las tres reglas, y ninguno
 * de los dos sabe de dónde salen las filas. Lo que sí las toca vive en
 * `support/`, al lado de `idempotency-store.ts`, que resuelve exactamente la
 * misma separación para la idempotencia.
 *
 * ## De dónde vino
 *
 * Esto estaba en `routes/v1/media.ts`, e `influencers.ts` lo importaba **desde
 * ahí** — una ruta dependiendo de otra ruta. Los tres endpoints de reserva
 * (`media`, `influencers/base-image`, `content/custom/video`) son el mismo
 * procedimiento con otro prefijo y otro schema de entrada, así que el
 * procedimiento tiene que estar en un solo lado y ninguno de esos lados es un
 * archivo de rutas.
 */

import { randomUUID } from "node:crypto";
import {
  CONTENT_TYPE_EXTENSIONS,
  type ErrorCode,
  type UploadReservation,
} from "@fastgram/contracts";
import {
  uploadReservationRepository,
  type Transaction,
  type uploadReservations,
} from "@fastgram/db";
import { MAX_SIGNED_URL_TTL_SECONDS, type Storage } from "@fastgram/ports";

import { canFinalize } from "../http/uploads.js";

type ReservationRow = (typeof uploadReservations)["$inferSelect"];

/**
 * Rechazo que ya trae su forma HTTP.
 *
 * Los tres estados de §9.8 (`404` ajena, `410` expirada, `409` no alcanzable o ya
 * finalizada) los produce la misma función y los consumen dos rutas de dos archivos,
 * así que viajan como dato en vez de como tres `reply.status(...)` repetidos.
 */
export interface UploadRejection {
  readonly status: 404 | 409 | 410;
  readonly code: Extract<ErrorCode, "not_found" | "conflict" | "gone">;
  readonly message: string;
}

export type ReservationClaim =
  | { readonly ok: true; readonly row: ReservationRow; readonly sizeBytes: number }
  | { readonly ok: false; readonly rejection: UploadRejection };

/**
 * Extensión canónica del content type.
 *
 * El filename que manda el cliente **no** entra en la clave del objeto. Es texto
 * elegido por quien sube: con él dentro, un `../` o un `%00` viajan hasta el bucket y
 * el nombre del objeto deja de ser nuestro. El nombre original se guarda en la fila,
 * que es donde sirve, y la clave se arma con el uuid de la reserva.
 */
export function extensionFor(contentType: string): string {
  // El `?? ""` no es alcanzable: los schemas de ruta acotan `contentType` al enum de
  // §9.8 y el mapa cubre el enum entero. Está por `noUncheckedIndexedAccess`.
  return CONTENT_TYPE_EXTENSIONS[contentType]?.[0] ?? "";
}

/**
 * URL estable del objeto, la que se guarda en `Media.r2Url` (DATA-010).
 *
 * Se re-exporta desde `@fastgram/adapters` —no vive más acá— porque
 * `apps/worker` necesita exactamente la misma al guardar el resultado de un
 * build, y dos definiciones de "cuál es la dirección de un objeto" se separan
 * sin que nadie lo note: las dos siguen devolviendo una URL plausible. El
 * porqué del rodeo (firmar y tirar la query) está en el archivo de destino.
 */
export { canonicalObjectUrl } from "@fastgram/adapters";

export interface ReserveUploadInput {
  readonly tx: Transaction;
  readonly storage: Storage;
  readonly companyId: string;
  /** DATA-028 lo registra. `undefined` cuando quien pide es una sesión, no una key. */
  readonly apiKeyId: string | undefined;
  /** Prefijo de la clave en el bucket, sin barra final. */
  readonly prefix: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/**
 * Paso 1 de §9.8: firma la subida y deja la reserva en la base.
 *
 * Vive acá y la importa `influencers.ts` porque los dos endpoints de reserva son el
 * mismo procedimiento con otro prefijo y otro schema de entrada. Su sitio natural es
 * `src/http/uploads.ts`, junto al resto de la política de subidas; queda anotado.
 *
 * El `ttlSeconds` es el tope del puerto (`NFR-008`, una hora). El PRD **no fija** una
 * vida para la reserva, así que se usa el único número que sí está escrito en vez de
 * elegir uno: pedir más sería `bad_request` del adaptador.
 */
export async function reserveUpload(
  input: ReserveUploadInput,
): Promise<UploadReservation> {
  const uploadId = randomUUID();
  const storageKey = `${input.prefix}/${uploadId}${extensionFor(input.contentType)}`;

  const presigned = await input.storage.createUploadUrl({
    key: storageKey,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    ttlSeconds: MAX_SIGNED_URL_TTL_SECONDS,
  });

  await uploadReservationRepository.create(
    input.tx,
    { companyId: input.companyId },
    {
      uploadId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      storageKey,
      // La reserva caduca cuando caduca la firma. Dos relojes distintos darían una
      // ventana en la que la fila dice `reserved` y el PUT ya no entra, o al revés.
      expiresAt: presigned.expiresAt,
      ...(input.apiKeyId === undefined ? {} : { apiKeyId: input.apiKeyId }),
    },
  );

  return {
    uploadId,
    uploadUrl: presigned.url,
    method: "PUT",
    headers: { ...presigned.headers },
    expiresAt: presigned.expiresAt.getTime(),
  } as UploadReservation;
}

export interface ClaimReservationInput {
  readonly tx: Transaction;
  readonly storage: Storage;
  readonly companyId: string;
  readonly uploadId: string;
  readonly nowMs: number;
}

/**
 * Paso 3 de §9.8: comprueba que la reserva se puede finalizar y que el objeto llegó.
 *
 * El orden importa y no es el intuitivo. `findById` ya está scopeado, así que una
 * reserva ajena vuelve como `null` y sale por el mismo 404 que una inexistente —
 * **antes** de mirar la expiración. Es la misma razón por la que `canFinalize`
 * comprueba el tenant primero: un `410` sobre la reserva de otro workspace confirmaría
 * que ese `uploadId` existe, que es justo lo que §9.2 cierra.
 *
 * Lo que este chequeo **no** garantiza: dos finalizaciones simultáneas de la misma
 * reserva pueden pasar las dos. La lectura del estado y su escritura son dos
 * sentencias, y el repositorio no ofrece un `UPDATE ... WHERE state = 'reserved'` con
 * el que convertirlas en una. Está en el reporte.
 */
export async function claimReservation(
  input: ClaimReservationInput,
): Promise<ReservationClaim> {
  const row = await uploadReservationRepository.findById(
    input.tx,
    { companyId: input.companyId },
    input.uploadId,
  );

  const outcome = canFinalize(
    row === null
      ? null
      : {
          uploadId: row.uploadId,
          companyId: row.companyId,
          status: row.state,
          expiresAtMs: row.expiresAt.getTime(),
        },
    { companyId: input.companyId },
    input.nowMs,
  );

  if (outcome.kind === "not_found" || row === null) {
    return {
      ok: false,
      rejection: {
        status: 404,
        code: "not_found",
        message: "upload reservation not found",
      },
    };
  }
  if (outcome.kind === "gone") {
    return {
      ok: false,
      rejection: {
        status: 410,
        code: "gone",
        message: "This upload reservation has expired. Reserve a new one.",
      },
    };
  }
  if (outcome.kind === "conflict") {
    return {
      ok: false,
      rejection: { status: 409, code: "conflict", message: outcome.reason },
    };
  }

  // §9.8: *"Fastlane verifies the R2 object"*. `head` devuelve `null` —y no lanza—
  // cuando el cliente todavía no hizo el PUT, y ese caso es `409`, no un fallo de
  // infraestructura. La reserva se deja intacta para que el cliente suba y reintente:
  // marcarla `failed` acá la mataría por una carrera de segundos.
  const object = await input.storage.head(row.storageKey);
  if (object === null) {
    return {
      ok: false,
      rejection: {
        status: 409,
        code: "conflict",
        message: "The uploaded object is not reachable yet. Finish the upload and retry.",
      },
    };
  }

  return { ok: true, row, sizeBytes: object.sizeBytes };
}
