/**
 * Repositorio de catálogo — `P1-DATA-014`.
 *
 * ## Por qué esto existe y por qué es peligroso
 *
 * Todo lo demás en este paquete lleva `TenantScope` en la firma. `audio_tracks` no
 * puede: el PRD (DATA-012) dice literalmente *"Global, no por workspace"*, y el
 * catálogo de audio es *"compartido por todos los workspaces"* (§FR-053). No hay
 * `companyId` en la tabla, y por eso tampoco hay política RLS por compañía
 * (`drizzle/0002_tenancy_rls.sql`).
 *
 * Eso convierte a este archivo en **la excepción a la regla que sostiene el
 * aislamiento del sistema**, así que conviene decir con precisión de qué tamaño es la
 * excepción:
 *
 *  - Es **sólo lectura**. No hay `create`, `update` ni `delete`. El catálogo se
 *    carga por migración o por seed, no por la API. El Media Bank, de hecho, *"no
 *    acepta subidas de audio"* (FR-053).
 *  - Sirve **una sola tabla**, que no contiene ni un dato de ningún cliente.
 *
 * Si algún día aparece una segunda tabla global, tiene que pasar por las dos pruebas
 * de arriba —sin datos de cliente y sin escritura desde la API— o no entra acá.
 * Un repositorio sin scope es fácil de copiar y difícil de auditar después.
 */

import { and, asc, eq, sql, type SQL } from "drizzle-orm";

import type { Executor } from "../client.js";
import {
  buildPage,
  cursorCondition,
  fetchLimit,
  normalizeLimit,
  type Page,
  type PageRequest,
} from "../pagination.js";
import { audioTracks } from "../schema/index.js";
import type { AUDIO_LIBRARY } from "../schema/enums.js";

export type AudioLibrary = (typeof AUDIO_LIBRARY)[number];
export type AudioTrackRow = typeof audioTracks.$inferSelect;

export interface AudioTrackListOptions extends PageRequest {
  /**
   * El `for=` de `GET /audio?for=wall-of-text|video-hook` (§9.3).
   *
   * Es opcional en el tipo pero **la ruta debería exigirlo**: el PRD describe el
   * catálogo como *"curado por tipo de contenido"*, y mezclar las dos bibliotecas
   * ofrecería al usuario pistas que la UI de ese formato nunca muestra.
   */
  readonly library?: AudioLibrary;
}

/**
 * `audio_tracks` no tiene `companyId`, así que la firma tampoco lo tiene. Que falte
 * es la señal, no un olvido: si alguna vez ves un repositorio sin scope, tiene que
 * estar en este archivo y tener el comentario de arriba encima.
 */
export const audioTrackRepository = {
  table: audioTracks,

  async findById(exec: Executor, audioId: string): Promise<AudioTrackRow | null> {
    const rows = await exec
      .select()
      .from(audioTracks)
      .where(eq(audioTracks.audioId, audioId))
      .limit(1);
    return rows[0] ?? null;
  },

  async list(
    exec: Executor,
    options: AudioTrackListOptions = {},
  ): Promise<Page<AudioTrackRow>> {
    const limit = normalizeLimit(options.limit);
    const conditions: (SQL | undefined)[] = [
      options.library === undefined ? undefined : eq(audioTracks.library, options.library),
      cursorCondition(audioTracks.createdAt, audioTracks.audioId, options.cursor, "asc"),
    ];

    const rows = await exec
      .select()
      .from(audioTracks)
      .where(and(...conditions))
      // Ascendente, al revés que el resto de la API. Un catálogo curado no es un feed:
      // el orden es el que le dieron al cargarlo, y que una pista nueva aparezca
      // primera cambiaría lo que el usuario ve arriba sin que nadie lo haya decidido.
      // `cursorCondition` va en "asc" por lo mismo: los dos tienen que moverse juntos.
      .orderBy(asc(audioTracks.createdAt), asc(sql`${audioTracks.audioId}::text`))
      .limit(fetchLimit(limit));

    return buildPage(rows, limit, (row) => ({
      createdAt: row.createdAt,
      id: row.audioId,
    }));
  },

  async count(exec: Executor, options: { library?: AudioLibrary } = {}): Promise<number> {
    const rows = await exec
      .select({ value: sql<number>`count(*)::int` })
      .from(audioTracks)
      .where(
        options.library === undefined ? undefined : eq(audioTracks.library, options.library),
      );
    return rows[0]?.value ?? 0;
  },
};
