/**
 * El lado de la base de `brand-backgrounds` — `PU-MEDIA-002`.
 *
 * El handler genera fondos en `services/render`, los sube con claves de
 * storage **deterministas** por semilla y después crea las filas de `media`.
 * La idempotencia sale de esas claves: antes de generar se pregunta qué claves
 * ya tienen fila, y al escribir se vuelve a preguntar bajo un lock.
 *
 * ## Por qué un advisory lock y no un índice único
 *
 * `media` no tiene unicidad sobre `(company_id, storage_key)`, y agregarla hoy
 * es una migración sobre una tabla con datos de usuarios que esta tarea no
 * necesita. Con dos entregas solapadas del mismo job, la sentencia «insertar
 * las que no existen» **no** se protege sola —es un `INSERT`, trampa 37—: las
 * dos verían cero filas. El lock de transacción por marca serializa el
 * «contar e insertar»; la segunda entrega ve lo que la primera commiteó.
 *
 * Es la forma de **dos enteros** de `pg_advisory_xact_lock`, a propósito: vive
 * en otro espacio de claves que la de un `bigint` que usa el refill de
 * discovery (`refillLockKey`), así que no compite con él aunque derive del
 * mismo `companyId`.
 *
 * ## Las borradas cuentan como existentes
 *
 * Si el usuario borró un fondo del kit, una reentrega no lo resucita: la
 * búsqueda incluye filas con `deleted_at`. Borrar es una decisión del usuario;
 * regenerar el mismo archivo sería deshacerla sin preguntar.
 */

import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { media } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export async function lockCompanyBrandKit(
  exec: Executor,
  scope: TenantScope,
): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(hashtext('brand-kit'), hashtext(${scope.companyId}))`,
  );
}

/** Las claves de la lista que ya tienen fila en este workspace (borradas incluidas). */
export async function existingBrandKitKeys(
  exec: Executor,
  scope: TenantScope,
  storageKeys: readonly string[],
): Promise<ReadonlySet<string>> {
  if (storageKeys.length === 0) return new Set();
  const rows = await exec
    .select({ storageKey: media.storageKey })
    .from(media)
    .where(
      and(
        eq(media.companyId, scope.companyId),
        inArray(media.storageKey, [...storageKeys]),
      ),
    );
  return new Set(rows.map((r) => r.storageKey));
}

export interface BrandKitMediaInput {
  readonly mediaType: "image" | "video";
  readonly filename: string;
  readonly r2Url: string;
  readonly storageKey: string;
  readonly sizeMb: number;
  readonly videoDurationSec: number | null;
  readonly categories: readonly string[];
}

/**
 * Inserta las piezas que todavía no tienen fila y devuelve cuántas entraron.
 * **Tiene que correr después de {@link lockCompanyBrandKit} en la misma
 * transacción**: sin el lock, el filtro de existentes no protege nada.
 *
 * Las filas nacen `ready` —el render ya entregó H.264 yuv420p con faststart,
 * que es lo que la normalización dejaría— y con `origin = 'brand_kit'`, que
 * `GET /media` lista (migración `0013`).
 */
export async function insertBrandKitMedia(
  exec: Executor,
  scope: TenantScope,
  items: readonly BrandKitMediaInput[],
): Promise<number> {
  const existing = await existingBrandKitKeys(
    exec,
    scope,
    items.map((i) => i.storageKey),
  );
  const fresh = items.filter((i) => !existing.has(i.storageKey));
  if (fresh.length === 0) return 0;
  await exec.insert(media).values(
    fresh.map((i) => ({
      companyId: scope.companyId,
      mediaType: i.mediaType,
      filename: i.filename,
      r2Url: i.r2Url,
      storageKey: i.storageKey,
      status: "ready" as const,
      sizeMb: i.sizeMb,
      ...(i.videoDurationSec === null ? {} : { videoDurationSec: i.videoDurationSec }),
      categories: [...i.categories],
      origin: "brand_kit" as const,
    })),
  );
  return fresh.length;
}

export const brandKitStore = {
  lockCompanyBrandKit,
  existingBrandKitKeys,
  insertBrandKitMedia,
};
