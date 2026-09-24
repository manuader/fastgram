/**
 * El lado de la base del handler de `media-normalization` — PRD §9.5 #7,
 * `NFR-014`, `FR-100` («los videos quedan `processing` y se normalizan en
 * background hasta `ready` o `failed`»), `DATA-010`.
 *
 * ## Por qué las escrituras son `UPDATE` condicionales y no un `FOR UPDATE`
 *
 * La normalización dura minutos (el catálogo le da 600 s) y no puede ocurrir
 * dentro de una transacción. Entre leer la fila y escribir el resultado el
 * usuario puede **borrar** el asset (`DELETE /media/:id`) o puede llegar otra
 * entrega del mismo job. Las dos escrituras de abajo llevan en su `WHERE` todo
 * lo que tiene que seguir siendo cierto —`status = 'processing'`, no borrado y,
 * al completar, la misma `storageKey` que se leyó— y con READ COMMITTED un
 * `UPDATE` que compite **espera y reevalúa** su `WHERE` (trampa 37: es un
 * `UPDATE`, no un `INSERT`, así que la sentencia sola es la guarda).
 *
 * Un `FOR UPDATE` en la lectura no agregaría nada: la lectura y la escritura
 * están en transacciones distintas, así que el bloqueo se soltaría antes de
 * que empiece el trabajo largo.
 *
 * ## Por qué vive en `packages/db`
 *
 * Es SQL, y `apps/worker` no puede importar `drizzle-orm`: es lo que impide que
 * un proceso arme su propio `WHERE` y se olvide el tenant.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Executor } from "../client.js";
import { media, type MediaNormalizationOutcome } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type MediaRow = typeof media.$inferSelect;

/**
 * El asset a normalizar, o `null` si no existe, es de otro workspace o está
 * borrado. Los tres casos son lo mismo para el handler: no hay nada que hacer,
 * y **no** se distingue cuál fue (§9.2: un id ajeno no confirma existencia).
 *
 * No filtra por `status` a propósito: el handler necesita ver `ready` para
 * poder decir en el log «ya estaba normalizado» en vez de «no existe».
 */
export async function findMediaToNormalize(
  exec: Executor,
  scope: TenantScope,
  mediaId: string,
): Promise<MediaRow | null> {
  const filas = await exec
    .select()
    .from(media)
    .where(
      and(
        eq(media.companyId, scope.companyId),
        eq(media.mediaId, mediaId),
        isNull(media.deletedAt),
      ),
    )
    .limit(1);
  return filas[0] ?? null;
}

export interface CompleteNormalizationInput {
  /**
   * La `storageKey` que el handler leyó al empezar. Si ya no es ésa, otra
   * entrega completó primero y este resultado es huérfano.
   */
  readonly expectedStorageKey: string;
  /** Adónde apunta el asset ahora. Igual a la esperada si no hubo que transcodificar. */
  readonly storageKey: string;
  readonly r2Url: string;
  readonly sizeMb: number;
  /** `null` deja la columna como está: el probe no siempre informa duración. */
  readonly videoDurationSec: number | null;
  readonly now: Date;
  /** `0029`: qué hizo la normalización. Ausente = no se toca la columna. */
  readonly normalization?: MediaNormalizationOutcome | undefined;
}

/**
 * `processing → ready`, con el archivo normalizado.
 *
 * Devuelve la fila escrita, o `null` si la condición ya no se cumplía: borrado
 * en el medio, otra entrega que llegó antes, o id ajeno. Quien llama, ante
 * `null`, **descarta lo que subió**.
 */
export async function completeMediaNormalization(
  exec: Executor,
  scope: TenantScope,
  mediaId: string,
  input: CompleteNormalizationInput,
): Promise<MediaRow | null> {
  const filas = await exec
    .update(media)
    .set({
      status: "ready",
      storageKey: input.storageKey,
      r2Url: input.r2Url,
      sizeMb: input.sizeMb,
      ...(input.videoDurationSec === null
        ? {}
        : { videoDurationSec: input.videoDurationSec }),
      ...(input.normalization === undefined
        ? {}
        : { normalization: input.normalization }),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(media.companyId, scope.companyId),
        eq(media.mediaId, mediaId),
        eq(media.status, "processing"),
        eq(media.storageKey, input.expectedStorageKey),
        isNull(media.deletedAt),
      ),
    )
    .returning();
  return filas[0] ?? null;
}

/**
 * `processing → failed`. Devuelve `false` si la fila ya no estaba en
 * `processing` (otra entrega terminó, o se borró): un fallo tardío **no** pisa
 * un `ready`.
 */
export async function failMediaNormalization(
  exec: Executor,
  scope: TenantScope,
  mediaId: string,
  now: Date,
): Promise<boolean> {
  const filas = await exec
    .update(media)
    .set({ status: "failed", updatedAt: now })
    .where(
      and(
        eq(media.companyId, scope.companyId),
        eq(media.mediaId, mediaId),
        eq(media.status, "processing"),
        isNull(media.deletedAt),
      ),
    )
    .returning({ mediaId: media.mediaId });
  return filas.length > 0;
}

export const mediaNormalizationStore = {
  table: media,
  findMediaToNormalize,
  completeMediaNormalization,
  failMediaNormalization,
};
