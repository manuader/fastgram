/**
 * «Crear desde prompt» en el worker — `EXT-009`, `PU-BLITZ-003`.
 *
 * ## Mismo pipeline que el refill, a propósito
 *
 * El usuario escribe un tema («hacé un meme sobre los lunes para mi
 * cafetería») y, si quiere, fuerza el formato y la cantidad. Lo que sale tiene
 * que ser **indistinguible** de una sugerencia del refill salvo por su origen:
 * mismo editor, mismo aceptar, mismo `build_plan`. Por eso esto no reimplementa
 * nada:
 *
 *  - **leer** es `readRefillSubject` (preferencias, Media Bank, perfil…);
 *  - **planificar** es `planPromptSuggestion` de `core`, que es
 *    `planBlitzSuggestion` con el formato forzado y sin ángulo;
 *  - **escribir la copy** es `withCopy` del refill, con el tema como directiva
 *    principal (y como dato: ver `suggestion-copy.ts`).
 *
 * ## Por qué viaja por la cola `discovery-refill`
 *
 * Una cola nueva pedía tocar `JOB_QUEUES`, el catálogo, el invariante de
 * `check-consistency` y los grants — cinco archivos compartidos — para una
 * política (3 intentos, backoff, 120 s) que es **la misma** del refill: los dos
 * son LLM + selección y ninguno cobra (la trampa 49 separa colas cuando
 * difieren las reglas de cierre, y acá no difieren). El payload lleva
 * `promptRequestId` y {@link createDiscoveryDispatcher} lo manda acá.
 *
 * La `singletonKey` la pone la API con el `requestId`, un UUID nuevo por
 * pedido: nunca se repite (trampas 39 y 45).
 *
 * ## El estado vive en `blitz_prompt_requests`
 *
 * La web pregunta en qué quedó. Cada salida de este handler **cierra** el
 * pedido —`done` con sus sugerencias o `failed` con un código estable— salvo
 * un fallo transitorio con intentos por delante, que se relanza para que la
 * cola reintente y el pedido queda `running`. En el último intento, un fallo
 * transitorio también cierra: si no, el pedido quedaría `running` para siempre
 * y la web haciendo polling contra nada.
 *
 * ## Buscar el meme si no hay (sprint 7)
 *
 * Con el formato forzado a green-screen, fondo de marca en el Media Bank y
 * **ningún** clip que matchee el tema, el handler busca uno en YouTube y lo
 * importa con el pipeline de siempre (`meme-finder.ts`). El pedido pasa a
 * `phase = searching_meme` (la web lo muestra), cuenta la búsqueda (tope 2 por
 * pedido, en la base) y anota el clip (`auto_media_id`): si la normalización
 * no lo dejó `ready` a tiempo, el job se relanza y el reintento lo retoma en
 * vez de bajar otro. El clip queda en el Media Bank con la etiqueta
 * `auto-found`, y la sugerencia con la anotación que dibuja el chip.
 *
 * Si no aparece ninguno verde: con otros clips (que no matchean) se sigue con
 * ellos, como antes; sin ninguno, `meme_not_found` («importá uno por link»).
 *
 * Sólo con formato forzado: con el mix, buscar un meme cada vez que salga
 * green-screen sesgaría el mix hacia el formato más lento (decisión que el
 * PRD no cubre).
 *
 * ## `JV-6`
 *
 * Entre varios candidatos (influencer, meme, fondo) elige el juicio
 * (`jv6.ts`); sin modelo, el ranking por tema.
 *
 * ## Lo que no hace
 *
 * - **No respeta el objetivo de 5**: el usuario pidió N y entran N.
 * - **No cobra**: igual que el refill. Aceptar la pieza cobra, como siempre.
 */
import {
  BlitzPromptError,
  DomainError,
  GREEN_SCREEN_CATEGORY,
  MEME_SEARCH_LIMITS,
  buildMediaBank,
  isBlitzPromptPayload,
  mediaMetaKey,
  parseBlitzPromptJob,
  planPromptSuggestion,
  relevantCandidates,
  toCopyRemixReference,
  withAutoFoundMeme,
  withJudgedMedia,
  type PlanningMedia,
  type BlitzContentType,
  type CopyRemixReference,
  type BlitzPromptJob,
  type PlannedBlitzSuggestion,
  type PromptFailureReason,
} from "@fastgram/core";
import {
  addMediaTag,
  clearPromptPhase,
  completePromptRequest,
  failPromptRequest,
  findOwnerReference,
  isOpenPromptRequest,
  lockPromptRequest,
  markPromptRequestRunning,
  mediaRepository,
  reservePromptMemeSearch,
  setPromptAutoMedia,
  withCompany,
  type Database,
  type QueuedSuggestionDraft,
  type Transaction,
} from "@fastgram/db";
import {
  PortError,
  type JobContext,
  type JobHandler,
  type Rng,
  type Storage,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import type { SuggestionCopywriter } from "./copywriter.js";
import { applyJv6, type Jv6JudgmentProvider } from "./jv6.js";
import { AUTO_FOUND_TAG } from "./media-descriptors.js";
import type { MemeFinder } from "./meme-finder.js";
import { readJsonObject } from "../media-import/status-store.js";
import {
  readRefillSubject,
  withCopy,
  type CopywriterProvider,
  type RefillSubject,
} from "./refill-handler.js";

export interface BlitzPromptDeps {
  readonly db: Database;
  /** Ver `DiscoveryRefillDeps.rng`: en producción `systemRng`. */
  readonly rng: Rng;
  /** El mismo que el refill: fijo, `null`, o resuelto en cada job. */
  readonly copywriter: SuggestionCopywriter | null | CopywriterProvider;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  /** Sprint 7: etiquetas de los clips (`JV-6`) y el origen del meme importado. */
  readonly storage?: Storage | undefined;
  /** Sprint 7 (`JV-6`): el juicio entre varios candidatos. Ausente = ranking. */
  readonly judgment?: Jv6JudgmentProvider | undefined;
  /**
   * Sprint 7: buscar e importar un meme cuando no hay uno para el tema.
   * Ausente = el comportamiento de antes (sin `yt-dlp` montado, en tests).
   */
  readonly memeFinder?: MemeFinder | undefined;
  /** Cuánto esperar a que el clip importado quede `ready`. Default 20 s. */
  readonly memeReadyWaitMs?: number | undefined;
  /** Sólo tests: la espera entre sondeos. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * El clip importado todavía no está `ready` (lo normaliza otro job). Se
 * relanza para que la cola reintente; el reintento retoma el mismo clip.
 */
export class MemeNotReadyYet extends Error {
  override readonly name = "MemeNotReadyYet";
}

/** Lo que dejó la búsqueda del meme para planificar. */
type MemePrep =
  | { readonly kind: "none" }
  | { readonly kind: "fail" }
  | { readonly kind: "found"; readonly media: PlanningMedia; readonly sourceUrl: string };

const MEME_POLL_MS = 2_000;

/** Lo que el handler lee del pedido. */
interface PromptSubject {
  readonly prompt: string;
  readonly contentType: BlitzContentType | null;
  readonly count: number;
}

/** Lo que la búsqueda del meme necesita del pedido. */
interface MemeRequest {
  readonly id: string;
  readonly prompt: string;
  readonly contentType: BlitzContentType | null;
  readonly autoMediaId: string | null;
}

export function createBlitzPromptHandler(deps: BlitzPromptDeps): JobHandler<unknown> {
  const inCompany = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  /** Cierra el pedido como `failed`. Idempotente: no toca uno ya cerrado. */
  async function fail(job: BlitzPromptJob, reason: PromptFailureReason): Promise<void> {
    await inCompany(job.companyId, (tx) =>
      failPromptRequest(tx, { companyId: job.companyId }, job.promptRequestId, reason),
    );
  }

  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** La URL de origen del clip (la guarda el import en su metadata). */
  async function sourceUrlOf(companyId: string, mediaId: string): Promise<string> {
    if (deps.storage === undefined) return "";
    try {
      const raw = await readJsonObject(deps.storage, mediaMetaKey(companyId, mediaId));
      const url =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)["sourceUrl"]
          : undefined;
      return typeof url === "string" ? url : "";
    } catch {
      return "";
    }
  }

  /**
   * Busca (o retoma) el meme. Ver la cabecera. Lanza {@link MemeNotReadyYet}
   * para que la cola reintente mientras la normalización termina.
   */
  async function prepareMeme(
    job: BlitzPromptJob,
    request: MemeRequest,
    refill: RefillSubject,
    ctx: JobContext<unknown>,
    log: Record<string, unknown>,
  ): Promise<MemePrep> {
    const finder = deps.memeFinder;
    if (finder === undefined || request.contentType !== "green-screen") {
      return { kind: "none" };
    }
    const bank = refill.planning.bank;
    const hasBackground = bank.media.some(
      (m) => m.mediaType === "image" && m.categories.includes("green-screen-background"),
    );
    // Sin fondo, la planificación falla con `no_media_for_format` como antes:
    // un meme no arregla eso.
    if (!hasBackground) return { kind: "none" };
    const anyClip = bank.media.some(
      (m) => m.mediaType === "video" && m.categories.includes(GREEN_SCREEN_CATEGORY),
    );
    const scope = { companyId: job.companyId };
    let mediaId = request.autoMediaId;
    if (mediaId === null) {
      const relevant = relevantCandidates(
        bank,
        "green-screen",
        null,
        "video",
        request.prompt,
        1,
      );
      if (relevant.length > 0) return { kind: "none" };
      const reserved = await inCompany(job.companyId, (tx) =>
        reservePromptMemeSearch(
          tx,
          scope,
          request.id,
          MEME_SEARCH_LIMITS.searchesPerRequest,
        ),
      );
      if (!reserved) {
        deps.logger.info(log, "tope de búsquedas de meme alcanzado");
        return anyClip ? { kind: "none" } : { kind: "fail" };
      }
      const outcome = await finder.find({
        companyId: job.companyId,
        topic: request.prompt,
        requestId: request.id,
      });
      const found = outcome.found;
      await inCompany(job.companyId, async (tx) => {
        // Los que no resultaron verdes no sirven para nada: afuera (soft delete).
        for (const id of outcome.rejectedMediaIds) {
          await mediaRepository.softDelete(tx, scope, id);
        }
        if (found !== null) {
          await setPromptAutoMedia(tx, scope, request.id, found.mediaId);
          await addMediaTag(tx, scope, found.mediaId, AUTO_FOUND_TAG);
        } else {
          await clearPromptPhase(tx, scope, request.id);
        }
      });
      deps.logger.info(
        { ...log, results: outcome.results, found: found !== null },
        "búsqueda automática de meme",
      );
      if (found === null) return anyClip ? { kind: "none" } : { kind: "fail" };
      mediaId = found.mediaId;
    }

    // Esperar a que la normalización lo deje `ready`.
    const waitMs = deps.memeReadyWaitMs ?? 20_000;
    const id = mediaId;
    const load = () =>
      inCompany(job.companyId, (tx) => mediaRepository.findById(tx, scope, id));
    let row = await load();
    for (let waited = 0; row?.status === "processing" && waited < waitMs;) {
      await sleep(MEME_POLL_MS);
      waited += MEME_POLL_MS;
      row = await load();
    }
    if (row === null || row.status === "failed") {
      // Lo borraron o la normalización falló: se olvida y se sigue sin él.
      await inCompany(job.companyId, async (tx) => {
        await setPromptAutoMedia(tx, scope, request.id, null);
        await clearPromptPhase(tx, scope, request.id);
      });
      return anyClip ? { kind: "none" } : { kind: "fail" };
    }
    if (row.status !== "ready") {
      if (ctx.attempt < ctx.maxAttempts) {
        throw new MemeNotReadyYet(`media ${id} todavía ${row.status}`);
      }
      // Último intento: se usa igual. Si al aceptar sigue sin estar lista, la
      // API descarta la tarjeta sin cobrar (`media_unavailable`).
      deps.logger.warn(
        { ...log, mediaId: id },
        "el meme importado sigue sin estar listo",
      );
    }
    await inCompany(job.companyId, (tx) => clearPromptPhase(tx, scope, request.id));
    return {
      kind: "found",
      sourceUrl: await sourceUrlOf(job.companyId, id),
      media: {
        id,
        mediaType: "video",
        url: row.r2Url,
        categories: [GREEN_SCREEN_CATEGORY],
        title: row.filename,
        autoFound: true,
      },
    };
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseBlitzPromptJob(ctx.payload);
    if (!parsed.ok) {
      // Bug del productor: no se reintenta (mismo criterio que el refill).
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de crear-desde-prompt inválido",
      );
      return;
    }
    const job = parsed.payload;
    const base = {
      jobId: ctx.jobId,
      companyId: job.companyId,
      promptRequestId: job.promptRequestId,
    };

    // Abrir: leer el pedido y pasarlo a `running`. Uno cerrado es una
    // reentrega de un job que ya terminó: no hay nada que hacer.
    const request = await inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const row = await lockPromptRequest(tx, scope, job.promptRequestId);
      if (row === null || !isOpenPromptRequest(row)) return row;
      await markPromptRequestRunning(tx, scope, job.promptRequestId);
      return row;
    });
    if (request === null) {
      deps.logger.error({ ...base }, "pedido de prompt inexistente en este workspace");
      return;
    }
    if (!isOpenPromptRequest(request)) {
      deps.logger.info(
        { ...base, status: request.status },
        "pedido de prompt ya cerrado",
      );
      return;
    }
    const subject: PromptSubject = {
      prompt: request.prompt,
      contentType: request.contentType,
      count: request.count,
    };

    const copywriter =
      typeof deps.copywriter === "function" ? await deps.copywriter() : deps.copywriter;
    if (copywriter === null) {
      // No es silencioso como en el refill: acá hay un usuario esperando, y
      // el código le dice adónde ir (Settings → Models).
      deps.logger.warn({ ...base }, "pedido de prompt sin LLM configurado");
      await fail(job, "llm_not_configured");
      return;
    }

    let refill: RefillSubject;
    let planned: PlannedBlitzSuggestion[];
    let meme: MemePrep = { kind: "none" };
    // Inspiration «Remix this»: la referencia viaja a la copy como dato
    // (`CopyRemixReference`, bloque `untrusted`). Borrada → prompt común.
    let remix: CopyRemixReference | undefined;
    try {
      refill = await inCompany(job.companyId, async (tx) => {
        const sourceId = request.sourceTrendingItemId;
        if (sourceId !== null) {
          const source = await findOwnerReference(
            tx,
            { companyId: job.companyId },
            sourceId,
          );
          if (source !== null) remix = toCopyRemixReference(source);
        }
        return readRefillSubject(tx, job.companyId, deps.storage);
      });
      meme = await prepareMeme(
        job,
        {
          id: job.promptRequestId,
          prompt: request.prompt,
          contentType: request.contentType,
          autoMediaId: request.autoMediaId,
        },
        refill,
        ctx,
        base,
      );
      if (meme.kind === "fail") {
        deps.logger.warn({ ...base }, "pedido de prompt sin meme");
        await fail(job, "meme_not_found");
        return;
      }
      if (meme.kind === "found") {
        // El meme encontrado es **el** meme de este pedido: los otros clips
        // verdes no matcheaban el tema (por eso se buscó).
        const found = meme.media;
        const bank = refill.planning.bank;
        refill = {
          ...refill,
          planning: {
            ...refill.planning,
            bank: {
              ...buildMediaBank(
                [
                  ...bank.media.filter(
                    (m) =>
                      !(
                        m.mediaType === "video" &&
                        m.categories.includes(GREEN_SCREEN_CATEGORY)
                      ),
                  ),
                  found,
                ],
                [],
              ),
              influencerPools: bank.influencerPools,
            },
          },
        };
      }
      planned = Array.from({ length: subject.count }, () =>
        planPromptSuggestion(deps.rng, refill.preferences, refill.planning, {
          topic: subject.prompt,
          contentType: subject.contentType,
        }),
      );
    } catch (error: unknown) {
      const reason = planningFailure(error);
      if (reason === null) throw error;
      deps.logger.warn(
        {
          ...base,
          reason,
          details: error instanceof BlitzPromptError ? error.details : undefined,
        },
        "pedido de prompt imposible de planificar",
      );
      await fail(job, reason);
      return;
    }

    // Sprint 7 (`JV-6`): el juicio elige entre varios candidatos; nunca bloquea.
    const judgment =
      deps.judgment === undefined
        ? null
        : await deps
            .judgment({
              companyId: job.companyId,
              subjectType: "blitz_prompt_request",
              subjectId: job.promptRequestId,
            })
            .catch(() => null);
    // Sprint 9 (O): el decisor por candidato, si `judgment.assets` es SystemOne.
    const assets =
      deps.judgment?.assets === undefined
        ? null
        : await deps.judgment
            .assets({
              companyId: job.companyId,
              subjectType: "blitz_prompt_request",
              subjectId: job.promptRequestId,
            })
            .catch(() => null);
    const recentIds = new Set<string>();
    const autoMeme = meme.kind === "found" ? meme : null;

    const drafts: QueuedSuggestionDraft[] = [];
    let lastPortError: PortError | null = null;
    let rejected = 0;
    for (const planned0 of planned) {
      let p = await applyJv6(planned0, {
        judgment,
        rng: deps.rng,
        context: refill.planning,
        brandName: refill.businessName,
        profile: refill.profile,
        logger: deps.logger,
        // Sprint 8 (P4-JV-004): el perfil de los modelos de la biblioteca.
        influencerProfiles: refill.influencerProfiles,
        assets,
        recentIds,
      });
      const memeId = p.media.format === "green-screen" ? p.media.video.mediaId : null;
      if (autoMeme !== null && memeId === autoMeme.media.id) {
        p = withJudgedMedia(
          p,
          "video",
          { mediaId: autoMeme.media.id, url: autoMeme.media.url },
          "Meme: your Media Bank had none for this topic, so one was found on " +
            "YouTube and imported (tagged auto-found).",
        );
      }
      try {
        const draft = await withCopy(copywriter, refill, p, subject.prompt, remix);
        if (draft.ok) {
          drafts.push(
            autoMeme === null
              ? draft.draft
              : {
                  ...draft.draft,
                  buildPlan: withAutoFoundMeme(
                    draft.draft.buildPlan as object,
                    { mediaId: autoMeme.media.id, sourceUrl: autoMeme.sourceUrl },
                    memeId,
                  ),
                },
          );
        } else {
          rejected += 1;
          deps.logger.warn(
            { ...base, contentType: p.plan.contentType, reason: draft.reason },
            "pieza de prompt descartada: la copy del modelo no sirve",
          );
        }
      } catch (error: unknown) {
        if (!(error instanceof PortError)) throw error;
        // El mensaje del `PortError` no lleva la key (lo garantiza el
        // adaptador); el código es lo que sirve.
        deps.logger.warn(
          { ...base, contentType: p.plan.contentType, code: error.code },
          "pieza de prompt descartada: el LLM falló",
        );
        lastPortError = error;
      }
    }

    if (drafts.length === 0) {
      // Todas fallaron. Transitorio con intentos por delante: que la cola
      // reintente y el pedido siga `running`. Si no, se cierra.
      if (
        lastPortError !== null &&
        lastPortError.isRetryable &&
        ctx.attempt < ctx.maxAttempts
      ) {
        throw lastPortError;
      }
      const reason: PromptFailureReason =
        lastPortError !== null && rejected === 0 ? "llm_failed" : "copy_rejected";
      deps.logger.error(
        { ...base, planned: planned.length, reason },
        "pedido de prompt sin piezas",
      );
      await fail(job, reason);
      return;
    }

    // Cerrar: con el pedido bloqueado, y sólo si sigue abierto. Es la guarda
    // contra la reentrega (ver `db/repositories/blitz-prompt.ts`).
    const ids = await inCompany(job.companyId, async (tx) => {
      const scope = { companyId: job.companyId };
      const row = await lockPromptRequest(tx, scope, job.promptRequestId);
      if (row === null || !isOpenPromptRequest(row)) return null;
      return completePromptRequest(tx, scope, job.promptRequestId, drafts);
    });

    deps.logger.info(
      {
        ...base,
        requested: subject.count,
        written: drafts.length,
        inserted: ids?.length ?? 0,
      },
      ids === null
        ? "pedido de prompt sin efecto: otra entrega lo cerró primero"
        : "pedido de prompt listo",
    );
  };
}

/** El código estable de un fallo de planificación, o `null` si no es uno. */
function planningFailure(error: unknown): PromptFailureReason | null {
  if (error instanceof BlitzPromptError) return error.reason;
  if (error instanceof DomainError) return "invalid_state";
  return null;
}

/**
 * La cola `discovery-refill` atiende dos cosas: el relleno y los pedidos de
 * prompt (ver la cabecera). Esto elige por el payload: con `promptRequestId`,
 * prompt; sin él, relleno — exactamente lo que el relleno recibía antes.
 */
export function createDiscoveryDispatcher(handlers: {
  readonly refill: JobHandler<unknown>;
  readonly prompt: JobHandler<unknown>;
}): JobHandler<unknown> {
  return (ctx) =>
    isBlitzPromptPayload(ctx.payload) ? handlers.prompt(ctx) : handlers.refill(ctx);
}
