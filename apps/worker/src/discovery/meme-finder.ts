/**
 * Buscar e importar un meme de pantalla verde — sprint 7 («buscar el meme si
 * no hay»). Lo usa «crear desde prompt» cuando el pedido es green-screen y el
 * Media Bank no tiene un clip para el tema.
 *
 * ```
 *   yt-dlp --flat-playlist --dump-single-json "ytsearch8:<tema> green screen meme"
 *   rankMemeResults (core): verde en el título, ≤ 15 s, palabras del tema
 *   para los 2 primeros: el import de siempre (PU-MEME-001/002), en línea,
 *                        sin etiquetar y sin recorte pago
 *   el primero que el croma local confirma verde → ése
 * ```
 *
 * ## Por qué el import va en línea y no por la cola
 *
 * El pedido tiene a alguien mirando: encolar el import y esperar a que otro
 * job termine sería lo mismo con un salto más y sin forma de saber cuándo.
 * Reusar `createMediaImportRunner` es reusar **el mismo código**: la misma
 * validación de URL, los mismos topes, la misma fila `processing` + la
 * normalización encolada en su transacción, el mismo estado en el storage.
 *
 * ## Topes
 *
 * - Una búsqueda por llamada; el tope por pedido (2) lo lleva la base
 *   (`reservePromptMemeSearch`).
 * - Dos imports como mucho por búsqueda: si el primero no es verde, el
 *   segundo; más es pagar bajadas por clips que no sirven.
 * - `yt-dlp` con plazo duro ({@link MEME_SEARCH_TIMEOUT_MS}); la bajada, con el
 *   del runner que arma `handlers.ts` (más corto que el del import por link).
 *
 * Un clip que no resultó verde queda en el Media Bank como cualquier import
 * (sin categoría green-screen: no entra a ningún pool); quien llama lo borra
 * (soft delete) para no llenar la Library de clips inútiles.
 */
import { randomUUID } from "node:crypto";

import { minimalChildEnv, runProcess } from "@fastgram/adapters";
import {
  GREEN_SCREEN_CATEGORY,
  MEME_SEARCH_LIMITS,
  memeKeywordsPrompt,
  memeSearchQuery,
  MEME_KEYWORDS_SCHEMA,
  parseMemeKeywords,
  parseMemeSearchResults,
  rankMemeResults,
  type MemeSearchResult,
} from "@fastgram/core";
import type { Llm } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { MediaImportRunner } from "../media-import/handler.js";

/** Plazo duro de la búsqueda. */
export const MEME_SEARCH_TIMEOUT_MS = 45_000;

/** Imports por búsqueda. */
export const MEME_IMPORTS_PER_SEARCH = 2;

export interface MemeSearcher {
  search(query: string): Promise<readonly MemeSearchResult[]>;
}

/** El buscador real: `yt-dlp` como proceso hijo, sin shell, con plazo duro. */
export function createYtDlpMemeSearcher(config: {
  readonly binary: string;
  readonly timeoutMs?: number;
}): MemeSearcher {
  return {
    async search(query) {
      const r = await runProcess(
        config.binary,
        [
          "--no-config",
          "--no-warnings",
          "--flat-playlist",
          "--dump-single-json",
          "--",
          query,
        ],
        {
          timeoutMs: config.timeoutMs ?? MEME_SEARCH_TIMEOUT_MS,
          maxStdoutBytes: 4 * 1024 * 1024,
          env: minimalChildEnv(),
        },
      );
      // El stderr de yt-dlp no sale: sólo si hubo resultados o no.
      if (r.exitCode !== 0 || r.timedOut || r.stdoutOverflow) return [];
      try {
        return parseMemeSearchResults(JSON.parse(r.stdout) as unknown);
      } catch {
        return [];
      }
    },
  };
}

export interface FoundMeme {
  readonly mediaId: string;
  readonly sourceUrl: string;
  readonly title: string;
}

export interface MemeFindOutcome {
  /** El clip verde importado, o `null` si ninguno sirvió. */
  readonly found: FoundMeme | null;
  /** Clips importados que no resultaron verdes: quien llama los borra. */
  readonly rejectedMediaIds: readonly string[];
  /** Cuántos resultados devolvió la búsqueda (para el log). */
  readonly results: number;
}

export interface MemeFinder {
  find(input: {
    readonly companyId: string;
    readonly topic: string;
    /** Para el log y el `jobId` del import. */
    readonly requestId: string;
  }): Promise<MemeFindOutcome>;
}

/**
 * Tema → palabras de reacción con el modelo de texto (ver `memeKeywordsPrompt`).
 * `null` si no hay modelo o no contestó algo usable: se busca el tema literal.
 */
export type MemeKeywords = (topic: string) => Promise<string | null>;

export function createLlmMemeKeywords(llm: () => Promise<Llm | null>): MemeKeywords {
  return async (topic) => {
    try {
      const model = await llm();
      if (model === null) return null;
      const prompt = memeKeywordsPrompt(topic);
      const out = await model.completeJson({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        schema: MEME_KEYWORDS_SCHEMA,
        schemaName: "meme_keywords",
        temperature: 0.2,
        maxOutputTokens: 60,
        timeoutMs: 20_000,
      });
      return parseMemeKeywords(out.value);
    } catch {
      return null;
    }
  };
}

export function createMemeFinder(deps: {
  readonly searcher: MemeSearcher;
  readonly runImport: MediaImportRunner;
  readonly logger: BuildLogger;
  readonly keywords?: MemeKeywords;
}): MemeFinder {
  /** Primero las palabras de reacción; si no dan candidatos, el tema literal. */
  async function candidates(topic: string, requestId: string) {
    const reaction = deps.keywords === undefined ? null : await deps.keywords(topic);
    const queries = reaction === null ? [topic] : [reaction, topic];
    let total = 0;
    for (const q of queries) {
      const results = await deps.searcher.search(memeSearchQuery(q));
      total += results.length;
      const ranked = rankMemeResults(q, results).slice(0, MEME_IMPORTS_PER_SEARCH);
      deps.logger.info(
        { requestId, query: q, results: results.length, candidates: ranked.length },
        "búsqueda de meme",
      );
      if (ranked.length > 0) return { ranked, total };
    }
    return { ranked: [], total };
  }

  return {
    async find({ companyId, topic, requestId }) {
      const { ranked, total } = await candidates(topic, requestId);
      const results = { length: total };
      const rejected: string[] = [];
      for (const r of ranked) {
        const mediaId = randomUUID();
        let state: string | null = null;
        let background: string | null = null;
        try {
          const status = await deps.runImport(
            {
              companyId,
              importId: randomUUID(),
              mediaId,
              url: r.url,
              kind: "video",
              categories: [GREEN_SCREEN_CATEGORY],
            },
            // En línea: un solo intento, sin reintento de la cola.
            { jobId: `prompt-meme:${requestId}`, attempt: 1, maxAttempts: 1 },
            { tagging: false, paidCutout: false },
          );
          state = status?.state ?? null;
          background = status?.background ?? null;
        } catch (error: unknown) {
          deps.logger.warn(
            {
              companyId,
              requestId,
              error: error instanceof Error ? error.name : "unknown",
            },
            "import del meme encontrado fallido",
          );
        }
        if (state === "imported" && background === "green_screen") {
          return {
            found: { mediaId, sourceUrl: r.url, title: r.title },
            rejectedMediaIds: rejected,
            results: results.length,
          };
        }
        if (state === "imported") rejected.push(mediaId);
        deps.logger.info(
          { companyId, requestId, state, background, durationSeconds: r.durationSeconds },
          "el meme encontrado no sirve (no es verde o no se pudo bajar)",
        );
      }
      return { found: null, rejectedMediaIds: rejected, results: results.length };
    },
  };
}

/** Los topes, reexportados para quien arma el runner del meme. */
export const MEME_IMPORT_MAX_SECONDS = MEME_SEARCH_LIMITS.maxSeconds;
