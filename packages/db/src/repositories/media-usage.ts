/**
 * ¿Está en uso esta media? — `P2-MEDIA-004`, `FR-100` (`409 media_in_use`).
 *
 * ## Qué es "en uso" (decisión que el PRD deja abierta)
 *
 * FR-100: *"referenciado por contenido no borrado, un influencer activo o un
 * flujo de entrenamiento activo"*. Traducido a lo que existe en el esquema:
 *
 * 1. **Una pieza no borrada** (`contents.deleted_at is null`) cuyo
 *    `build_payload` o `studio_state` nombra la media — por su `mediaId` o
 *    por su URL. Las piezas no tienen una columna de media: la referencia
 *    vive dentro del JSON del plan de build (`SuggestionBuildPlan`,
 *    `{mediaId, url}`) o del estado del editor (a veces sólo la URL). Se
 *    busca como texto dentro del JSON: un uuid o una URL de nuestro bucket no
 *    aparecen por casualidad en otro campo.
 * 2. **Un personaje que no está `failed` ni `inactive`** con la media entre
 *    sus fotos de referencia (`reference_media_ids`): es el "influencer
 *    activo" y el "flujo de entrenamiento activo" del PRD a la vez
 *    (`generating_variations`/`training`/`ready`).
 * 3. **Un media set** que la incluye.
 *
 * Lo que **no** cuenta: una sugerencia de Blitz en cola (no es una pieza; al
 * aceptarla, `lockLiveMedia` ve que la media ya no existe y la rechaza) ni un
 * post ya publicado cuya pieza se borró.
 */
import { sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import type { TenantScope } from "./base.js";

export interface MediaUsage {
  /** `null` si no existe, es de otra marca o ya estaba borrada. */
  readonly media: { readonly storageKey: string; readonly url: string } | null;
  readonly contents: number;
  readonly influencers: number;
  readonly mediaSets: number;
}

export function isMediaInUse(usage: MediaUsage): boolean {
  return usage.contents + usage.influencers + usage.mediaSets > 0;
}

export async function findMediaUsage(
  exec: Executor,
  scope: TenantScope,
  mediaId: string,
): Promise<MediaUsage> {
  const found = (await exec.execute(sql`
    select storage_key, r2_url from media
     where company_id = ${scope.companyId}::uuid
       and media_id = ${mediaId}::uuid
       and deleted_at is null
     for update
  `)) as unknown as Array<{ storage_key: string; r2_url: string }>;
  const row = found[0];
  if (row === undefined)
    return { media: null, contents: 0, influencers: 0, mediaSets: 0 };

  const idLike = `%${escapeLike(mediaId)}%`;
  const urlLike = `%${escapeLike(row.r2_url)}%`;
  const counts = (await exec.execute(sql`
    select
      (select count(*)::int from contents
        where company_id = ${scope.companyId}::uuid
          and deleted_at is null
          and (coalesce(build_payload::text, '') like ${idLike}
               or coalesce(build_payload::text, '') like ${urlLike}
               or coalesce(studio_state::text, '') like ${idLike}
               or coalesce(studio_state::text, '') like ${urlLike})) as contents,
      (select count(*)::int from influencers
        where company_id = ${scope.companyId}::uuid
          and status not in ('failed', 'inactive')
          and ${mediaId}::uuid = any(reference_media_ids)) as influencers,
      (select count(*)::int from media_sets
        where company_id = ${scope.companyId}::uuid
          and ${mediaId}::uuid = any(media_ids)) as media_sets
  `)) as unknown as Array<{ contents: number; influencers: number; media_sets: number }>;
  const c = counts[0];
  return {
    media: { storageKey: row.storage_key, url: row.r2_url },
    contents: c?.contents ?? 0,
    influencers: c?.influencers ?? 0,
    mediaSets: c?.media_sets ?? 0,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
