/**
 * El handler de `brand-source-analysis` — PRD §9.5 #18, `AI-016`, `FR-011.4`,
 * `FR-011.6`, `FR-011.7`, `FR-011.8`, §9.14, `DATA-031`, `DATA-032`.
 *
 * Hasta acá las rutas de brand encolaban y **ninguna fuente salía nunca de
 * `pending`**. La nota de `P1-BRAND-006` explica por qué no se montó antes: no
 * había extractor, y ningún motivo del enum era verdad para «no hay con qué
 * leer». Con `WebsiteReader` eso cambió para `website` y `other_url`.
 *
 * ## Las cuatro etapas de `AI-016`, y cuáles hace este handler
 *
 *  1. **Recolección** — sí: el `SocialReader` de la plataforma, según el plan
 *     de `acquisitionPlan` (B → C → A → D). Del tier A sólo se **ofrece**: leer
 *     con OAuth exige descifrar el token de la `Connection`, y eso no existe.
 *  2. **Enriquecimiento** — link-in-bio sí (`INT-018`, `P1-BRAND-015`): un
 *     nivel, cinco destinos, leídos con el lector web ({@link followLinkInBio}).
 *     OCR de media (`INT-016`) no: el tier D con capturas lo hace la API.
 *  3. **Síntesis** — sí, por el {@link BrandSynthesizer} inyectado, que con
 *     verificador mide la confianza de cada campo con `JV-4`.
 *  4. **Conciliación** — sí: `reconcileBrandProfile` de `core` contra el
 *     último snapshot de cada otra fuente del workspace.
 *
 * La semilla de content angles (`FR-011.7` paso 7, `P1-BRAND-023`) **no** se
 * hace: es otra tarea.
 *
 * ## El resultado de cada camino, y por qué es verdad
 *
 * | Camino | Fuente | `failureReason` | tier |
 * |---|---|---|---|
 * | leído y sintetizado | `ready` / `partial` | — | el que resolvió |
 * | `not_found` / `private` / `insufficient_content` | `failed` | ese | `D_assisted` |
 * | **no hay extractor para la plataforma** | `failed` | `unsupported_platform` | `D_assisted` |
 * | proveedor de lectura agotó reintentos | `failed` | `rate_limited` / `provider_unavailable` | `D_assisted` |
 * | el LLM falló o contestó fuera de contrato | `failed` | **`null`** | `D_assisted` |
 * | **texto pegado** (`assisted` en el payload, `P1-BRAND-014`) | `ready` / `partial` | — | `D_assisted` |
 *
 * El último camino es el tier D de verdad: el usuario pegó su bio y unos
 * captions (`POST /brand/sources/:id/assist`). No se consulta ningún extractor
 * —así funciona aunque la plataforma no tenga uno montado— y lo pegado pasa
 * por la misma síntesis y la misma contención que una bio leída.
 *
 * `D_assisted` en toda falla terminal: `FR-011.4` y §19.5.1 dicen que ninguna
 * falla bloquea el alta, «como mucho degradan al tier D», y `AI-016` que
 * «agotados los reintentos, se degrada al tier D». `FR-011.4` pide que la UI
 * **lo diga** cuando degrada a D: la columna es cómo lo sabe.
 *
 * `unsupported_platform` para instagram/tiktok/x/youtube/linkedin: es
 * literal —esta instalación **no soporta leer** esa plataforma—, al revés que
 * `provider_unavailable`, que culparía a la plataforma (`ERR-B07`). La fuente
 * queda re-analizable: `startAnalysis` acepta `failed`.
 *
 * Un fallo del LLM va con motivo `null` y no `provider_unavailable`: el copy
 * de ese motivo (`ERR-B07`) nombra a la **plataforma**, y la plataforma
 * respondió bien. La columna es nullable y el contrato lo omite.
 *
 * ## Idempotencia
 *
 * La forma está en `packages/db/src/repositories/brand-analysis.ts`: reclamar
 * con un `UPDATE` condicional, trabajar fuera de toda transacción, y escribir
 * todo —estado, snapshot, perfil— en **una** transacción que empieza por el
 * `UPDATE … WHERE status = 'analyzing'`. La entrega que pierde no escribe nada.
 */
import { randomUUID } from "node:crypto";

import {
  acquisitionPlan,
  assistedSynthesisInput,
  BRAND_PROFILE_FIELDS,
  completeAnalysis,
  currentProfileFields,
  fromStoredDerivedFields,
  linkDestinationItem,
  linkInBioTargets,
  materializeField,
  parseBrandSourceAnalysisJob,
  reconcileBrandProfile,
  splitCategories,
  toStoredDerivedFields,
  type BrandProfileField,
  type BrandSource,
  type BrandSourceAnalysisJob,
  type BrandSourceFailureReason,
  type SnapshotCandidate,
} from "@fastgram/core";
import {
  brandAnalysisStore,
  withCompany,
  type BrandSourceRow,
  type Database,
  type MaterializedProfileValues,
  type Transaction,
} from "@fastgram/db";
import {
  isPortError,
  type AcquisitionTier,
  type BrandSourceType,
  type Clock,
  type JobContext,
  type JobHandler,
  type SocialContentItem,
  type SocialProfileSignals,
  type SocialReader,
} from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { SynthesisRejectedError, type BrandSynthesizer } from "./synthesizer.js";

const DAY_MS = 86_400_000;

export interface BrandSourceAnalysisDeps {
  readonly db: Database;
  /**
   * Un extractor por plataforma (§9.14). Lo que falte acá termina en
   * `unsupported_platform`. `website`/`other_url` los monta `main.ts`; las
   * redes, `socialReadersFromEnv` (`./social-readers.ts`), cada una sólo si
   * su variable está.
   */
  readonly readers: Readonly<Partial<Record<BrandSourceType, SocialReader>>>;
  readonly synthesizer: BrandSynthesizer;
  /**
   * Días hasta `rawRetentionExpiresAt` (`DATA-032`). **El PRD no da el
   * número** —lo ata a `OQ-16`—, así que no hay default: lo pone quien monta.
   */
  readonly rawRetentionDays: number;
  readonly clock: Clock;
  /** Sin él, un superusuario saltea RLS (trampa 16). */
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
}

/** Una falla ya clasificada. `retryable` sólo vale mientras queden intentos. */
interface Failure {
  readonly code: string;
  readonly retryable: boolean;
  /** El motivo que se persiste si esta falla es terminal. */
  readonly reason: BrandSourceFailureReason | null;
  readonly cause: unknown;
}

/** Errores del extractor: los de `PortError` que nombra `SocialReader`. */
export function classifyReaderError(error: unknown): Failure {
  if (isPortError(error)) {
    switch (error.code) {
      case "rate_limited":
        return {
          code: "reader_rate_limited",
          retryable: true,
          reason: "rate_limited",
          cause: error,
        };
      case "provider_unavailable":
      case "timeout":
        return {
          code: "reader_unavailable",
          retryable: true,
          reason: "provider_unavailable",
          cause: error,
        };
      default:
        // `bad_request` (URL guardada que no parsea), `forbidden` (la guarda
        // SSRF), `provider_contract_violation`: ningún motivo del enum es
        // verdad para ellos, y reintentar no los cambia.
        return {
          code: `reader_${error.code}`,
          retryable: false,
          reason: null,
          cause: error,
        };
    }
  }
  return { code: "internal_error", retryable: true, reason: null, cause: error };
}

/** Errores de la síntesis. Nunca se atribuyen a la plataforma: ver la cabecera. */
export function classifySynthesisError(error: unknown): Failure {
  if (error instanceof SynthesisRejectedError) {
    return { code: "synthesis_rejected", retryable: false, reason: null, cause: error };
  }
  if (isPortError(error)) {
    return {
      code: `llm_${error.code}`,
      retryable: error.isRetryable,
      reason: null,
      cause: error,
    };
  }
  return { code: "internal_error", retryable: true, reason: null, cause: error };
}

/** La fila como la entidad de `core`, para usar sus transiciones y no copiarlas. */
function toDomain(row: BrandSourceRow): BrandSource {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceType: row.sourceType,
    handle: row.handle ?? "",
    canonicalUrl: row.canonicalUrl ?? "",
    isPrimary: row.isPrimary,
    status: row.status,
    analysisCount: row.analysisCount,
    createdAt: row.createdAt,
  };
}

/**
 * `DATA-032.contentItems`: los campos que nombra el PRD, más `title` y
 * `permalink` porque son **de dónde** sale una cita de una página web. Sin
 * `mediaUrls`: los binarios no se persisten, y sus URLs no se usan para nada
 * después.
 */
function storedItem(item: SocialContentItem): Record<string, unknown> {
  return {
    externalId: item.externalId,
    kind: item.kind,
    ...(item.permalink === undefined ? {} : { permalink: item.permalink }),
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.caption === undefined ? {} : { caption: item.caption }),
    hashtags: [...item.hashtags],
    engagement: { ...item.engagement },
    ...(item.postedAt === undefined ? {} : { postedAt: item.postedAt.toISOString() }),
  };
}

/**
 * Un nivel, sin recursión (`INT-018`): se lee **la página** de cada destino
 * con el lector web (tier C, con su guarda SSRF por salto) y nada más; los
 * links de esos destinos no se siguen. Un destino que falla se saltea: el
 * enriquecimiento degrada, nunca aborta el análisis (`AI-016`).
 */
export async function followLinkInBio(
  reader: SocialReader,
  targets: readonly string[],
): Promise<SocialContentItem[]> {
  const out: SocialContentItem[] = [];
  for (const url of targets) {
    try {
      const read = await reader.readProfile({ handle: url });
      if (read.status !== "ok") continue;
      const item = linkDestinationItem(url, read.data);
      if (item !== null) out.push(item);
    } catch {
      // SSRF bloqueado, timeout, 4xx/5xx: el destino no aporta y se sigue.
      continue;
    }
  }
  return out;
}

type Collected =
  | {
      readonly kind: "ok";
      readonly tier: AcquisitionTier;
      readonly profile: SocialProfileSignals;
      readonly items: readonly SocialContentItem[];
      /** Una señal falló pero hay perfil: `partial` (`FR-011.8`). */
      readonly signalsFailed: boolean;
    }
  | { readonly kind: "unavailable"; readonly reason: BrandSourceFailureReason }
  | { readonly kind: "error"; readonly failure: Failure };

export function createBrandSourceAnalysisHandler(
  deps: BrandSourceAnalysisDeps,
): JobHandler<unknown> {
  if (!Number.isInteger(deps.rawRetentionDays) || deps.rawRetentionDays < 1) {
    throw new Error(
      `rawRetentionDays tiene que ser un entero >= 1 (vino ${String(deps.rawRetentionDays)})`,
    );
  }

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

  /** Etapa 1. Sin `try` alrededor del plan: los «no» del puerto son resultados. */
  async function collect(
    reader: SocialReader,
    row: BrandSourceRow,
    job: BrandSourceAnalysisJob,
  ): Promise<Collected> {
    const caps = reader.capabilities();
    const plan = acquisitionPlan({
      renderedFetchEnabled: caps.renderedFetchEnabled,
      // Leer con OAuth exige descifrar el token de la `Connection`, que no
      // existe todavía. Sin credencial, A sólo se ofrece.
      hasConnection: false,
      requiresConnection: caps.requiresConnection,
    });
    const readable = plan.filter(
      (t) => (t === "B_public_api" || t === "C_page_fetch") && caps.tiers.includes(t),
    );
    if (readable.length === 0) {
      // El extractor existe pero no sabe leer sin credencial: para esta
      // instalación, la plataforma no se puede leer.
      return { kind: "unavailable", reason: "unsupported_platform" };
    }

    // `WebsiteReader` lo pide así: `ReadProfileRequest` sólo trae `handle`, y
    // con el host solo se pierde el path de `sitio.com/marca`.
    const handle = row.canonicalUrl ?? row.handle ?? "";
    let profile: SocialProfileSignals;
    let tier: AcquisitionTier;
    try {
      const read = await reader.readProfile({ handle });
      // `not_found` / `private` / `insufficient_content`: resultados, no
      // excepciones. Con C apagado y A sin credencial, la escalera termina en D.
      if (read.status !== "ok") {
        return {
          kind: "unavailable",
          // La herramienta del extractor no está (`PU-SCRAPE-001`): para esta
          // instalación, hoy, la plataforma no se puede leer. No es la
          // plataforma la que falló, así que no es `provider_unavailable`.
          reason:
            read.status === "extractor_unavailable"
              ? "unsupported_platform"
              : read.status,
        };
      }
      profile = read.data;
      tier = read.tier;
    } catch (error: unknown) {
      return { kind: "error", failure: classifyReaderError(error) };
    }

    let items: readonly SocialContentItem[] = [];
    let signalsFailed = false;
    try {
      const content = await reader.readRecentContent({
        handle,
        limit: Math.min(job.itemsPerAnalysis, caps.maxContentItems),
      });
      if (content.status === "ok") items = content.data;
      else signalsFailed = true;
    } catch (error: unknown) {
      const failure = classifyReaderError(error);
      // Un límite o una caída transitoria vale otro intento del job entero;
      // cualquier otra cosa degrada a `partial`: hay perfil.
      if (failure.retryable) return { kind: "error", failure };
      signalsFailed = true;
    }
    return { kind: "ok", tier, profile, items, signalsFailed };
  }

  async function fail(
    job: BrandSourceAnalysisJob,
    reason: BrandSourceFailureReason | null,
  ): Promise<boolean> {
    const now = new Date(deps.clock.nowMs());
    return inCompany(job.companyId, (tx) =>
      brandAnalysisStore.failBrandSourceAnalysis(
        tx,
        { companyId: job.companyId },
        job.brandSourceId,
        { failureReason: reason, acquisitionTier: "D_assisted", now },
      ),
    );
  }

  return async function handle(ctx: JobContext<unknown>): Promise<void> {
    const parsed = parseBrandSourceAnalysisJob(ctx.payload);
    if (!parsed.ok) {
      deps.logger.error(
        { jobId: ctx.jobId, reason: parsed.reason },
        "payload de brand-source-analysis inválido",
      );
      return;
    }
    const job = parsed.job;
    const scope = { companyId: job.companyId };
    const base = {
      jobId: ctx.jobId,
      brandSourceId: job.brandSourceId,
      attempt: ctx.attempt,
    };
    const lastAttempt = ctx.attempt >= ctx.maxAttempts;

    // ── Reclamar ────────────────────────────────────────────────────────────
    const found = await inCompany(job.companyId, (tx) =>
      brandAnalysisStore.findBrandSourceForAnalysis(tx, scope, job.brandSourceId),
    );
    if (found === null) {
      // Inexistente, ajena o borrada: indistinguibles a propósito (§9.2).
      deps.logger.info(base, "análisis omitido: la fuente no existe");
      return;
    }
    if (found.sourceType === "manual") {
      // `manual` es el tier D: el texto lo pega el usuario y no hay nada que
      // leer. La API no encola análisis para `manual`; si llega, no se toca.
      deps.logger.warn(base, "análisis omitido: una fuente manual no se lee");
      return;
    }
    const row = await inCompany(job.companyId, (tx) =>
      brandAnalysisStore.claimBrandSourceAnalysis(
        tx,
        scope,
        job.brandSourceId,
        new Date(deps.clock.nowMs()),
      ),
    );
    if (row === null) {
      deps.logger.info(
        { ...base, status: found.status },
        "análisis omitido: la fuente ya no está pendiente",
      );
      return;
    }
    const sourceType: BrandSourceType = found.sourceType;

    const terminal = async (failure: Failure): Promise<void> => {
      if (failure.retryable && !lastAttempt) {
        deps.logger.warn(
          { ...base, code: failure.code, maxAttempts: ctx.maxAttempts },
          "análisis de brand source fallido, se reintenta",
        );
        // Relanzar es lo que hace que la cola reintente con su backoff; la
        // fuente sigue `analyzing`, que es verdad.
        throw failure.cause instanceof Error ? failure.cause : new Error(failure.code);
      }
      const marked = await fail(job, failure.reason);
      deps.logger.error(
        {
          ...base,
          code: failure.code,
          reason: failure.reason,
          marked,
          error: failure.cause,
        },
        "análisis de brand source fallido definitivamente",
      );
    };

    // ── Etapa 1: recolección ────────────────────────────────────────────────
    let collected: Collected;
    if (job.assisted !== undefined) {
      // Tier D asistido (`P1-BRAND-014`): el usuario pegó su bio y captions
      // porque el extractor no alcanzó. No se lee la plataforma —ni hace falta
      // que haya extractor—, y lo pegado entra a la síntesis por el mismo
      // camino que una bio leída: dato delimitado, nunca instrucción.
      const input = assistedSynthesisInput(job.assisted, {
        sourceId: row.id,
        sourceType,
        handle: row.handle ?? undefined,
      });
      collected = {
        kind: "ok",
        tier: "D_assisted",
        profile: input.profile,
        items: input.items,
        signalsFailed: false,
      };
    } else {
      const reader = deps.readers[sourceType];
      if (reader === undefined) {
        const marked = await fail(job, "unsupported_platform");
        deps.logger.warn(
          { ...base, sourceType, marked },
          "sin extractor para la plataforma: failed/unsupported_platform, degradada a D",
        );
        return;
      }
      collected = await collect(reader, row, job);
    }
    if (collected.kind === "unavailable") {
      const marked = await fail(job, collected.reason);
      deps.logger.info(
        { ...base, reason: collected.reason, marked },
        "la fuente no se pudo leer: degradada a D",
      );
      return;
    }
    if (collected.kind === "error") {
      await terminal(collected.failure);
      return;
    }

    // ── Etapa 2: enriquecimiento — link-in-bio (`P1-BRAND-015`, `INT-018`) ──
    let items = collected.items;
    const linkReader = deps.readers.website;
    if (
      job.assisted === undefined &&
      linkReader !== undefined &&
      sourceType !== "website" &&
      sourceType !== "other_url"
    ) {
      const extra = await followLinkInBio(
        linkReader,
        linkInBioTargets(collected.profile.links, row.canonicalUrl ?? undefined),
      );
      if (extra.length > 0) {
        items = [...items, ...extra];
        deps.logger.info({ ...base, links: extra.length }, "link-in-bio leído");
      }
    }

    // ── Etapa 3: síntesis ───────────────────────────────────────────────────
    let synthesis;
    try {
      synthesis = await deps.synthesizer.synthesize({
        companyId: job.companyId,
        sourceId: row.id,
        sourceType,
        profile: collected.profile,
        items,
      });
    } catch (error: unknown) {
      await terminal(classifySynthesisError(error));
      return;
    }

    // ── Etapa 4 y escritura, en una transacción ─────────────────────────────
    const now = new Date(deps.clock.nowMs());
    const snapshotId = randomUUID();
    const own = synthesis.fields;
    const ownMaterialized = own.map(materializeField);
    const outcome = completeAnalysis(
      toDomain(row),
      {
        enrichmentFailed: collected.signalsFailed,
        // `FR-011.8`: `partial` = «hay perfil pero con **huecos** marcados».
        // Un campo en revisión (`low`) no es un hueco: tiene extracto.
        allFieldsCovered: ownMaterialized.every((m) => m.status !== "empty"),
      },
      now,
    );
    const status = outcome.status === "ready" ? "ready" : "partial";

    const written = await inCompany(job.companyId, async (tx) => {
      const completed = await brandAnalysisStore.completeBrandSourceAnalysis(
        tx,
        scope,
        row.id,
        {
          status,
          acquisitionTier: collected.tier,
          displayName: collected.profile.displayName,
          avatarUrl: collected.profile.avatarUrl,
          now,
        },
      );
      // Otra entrega terminó primero, o la fuente se borró: no se escribe nada.
      if (completed === null) return null;

      const profile = await brandAnalysisStore.lockCompanyProfile(tx, scope);
      const others = await brandAnalysisStore.latestSnapshotsOfOtherSources(
        tx,
        scope,
        row.id,
      );
      const candidates: SnapshotCandidate[] = [
        ...own.map((derived) => ({ derived, snapshotId })),
        ...others.flatMap((o) =>
          fromStoredDerivedFields(o.derivedFields, {
            sourceId: o.brandSourceId,
            sourceType: o.sourceType,
          }).map((derived) => ({ derived, snapshotId: o.snapshotId })),
        ),
      ];
      const primarySourceId = completed.isPrimary
        ? completed.id
        : (others.find((o) => o.isPrimary)?.brandSourceId ?? null);

      const current = currentProfileFields(
        {
          coreIdentity: profile.coreIdentity,
          productOffering: profile.productOffering,
          uniqueBenefits: profile.uniqueBenefits,
          problemSolution: profile.problemSolution,
          marketAndCompetition: profile.marketAndCompetition,
          toneOfVoice: profile.toneOfVoice,
          targetAudience: profile.targetAudience,
          businessCategories: profile.businessCategories,
        },
        profile.fieldMeta,
      );
      const reconciled = reconcileBrandProfile({ candidates, primarySourceId, current });

      const inserted = await brandAnalysisStore.insertBrandSourceSnapshot(tx, scope, {
        id: snapshotId,
        brandSourceId: row.id,
        tier: collected.tier,
        capturedAt: now,
        profileSignals: collected.profile,
        contentItems: items.map(storedItem),
        derivedFields: toStoredDerivedFields(own),
        conflicts: reconciled.conflicts,
        rawRetentionExpiresAt: new Date(now.getTime() + deps.rawRetentionDays * DAY_MS),
      });
      if (inserted === null) {
        // Inalcanzable: la fuente es del workspace, lo dijo el UPDATE de arriba.
        throw new Error("el snapshot no se insertó sobre una fuente recién completada");
      }

      const values: Record<string, string | readonly string[]> = {};
      const fieldMeta: Record<string, unknown> =
        typeof profile.fieldMeta === "object" && profile.fieldMeta !== null
          ? { ...(profile.fieldMeta as Record<string, unknown>) }
          : {};
      const writes: BrandProfileField[] = [];
      for (const d of reconciled.decisions) {
        if (d.action !== "write") continue;
        values[d.field] =
          d.field === "businessCategories" ? splitCategories(d.value) : d.value;
        fieldMeta[d.field] = d.meta;
        writes.push(d.field);
      }
      if (writes.length > 0) {
        const hasValue = (f: BrandProfileField): boolean =>
          writes.includes(f) || current[f].hasValue;
        await brandAnalysisStore.saveMaterializedProfile(tx, scope, profile.id, {
          values: values as MaterializedProfileValues,
          fieldMeta,
          // `FR-011.7` paso 6: incrementa. Sólo afecta a generaciones futuras.
          brandRevision: profile.brandRevision + 1,
          status: BRAND_PROFILE_FIELDS.every(hasValue) ? "ready" : "partial",
          now,
        });
      }
      return {
        writes,
        kept: reconciled.decisions
          .filter((d) => d.action === "keep")
          .map((d) => `${d.field}:${d.action === "keep" ? d.reason : ""}`),
        conflicts: reconciled.conflicts.length,
      };
    });

    if (written === null) {
      deps.logger.info(
        base,
        "resultado descartado: la fuente cambió durante el análisis",
      );
      return;
    }
    deps.logger.info(
      {
        ...base,
        status,
        tier: collected.tier,
        items: items.length,
        model: synthesis.model,
        rejected: synthesis.rejected,
        fenceEscapeAttempts: synthesis.fenceEscapeAttempts,
        ...written,
      },
      "brand source analizada",
    );
  };
}
