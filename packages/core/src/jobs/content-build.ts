/**
 * El payload del job `content-build` — PRD §9.5.3, `FR-050`, `FR-051`.
 *
 * ## Por qué esto existe
 *
 * La cola `content-build` tenía **dos productores con dos formas distintas** y
 * ningún consumidor que las reconciliara:
 *
 * - `accept-blitz-suggestion.ts` encolaba `ContentBuildJob`, que exige
 *   `suggestionId` y un `BlitzContentType`.
 * - `apps/api/routes/v1/content.ts` encolaba su propio `ContentBuildRequest`,
 *   con `reason`, `prompt` y un `contentType` que incluye `custom` —que no es
 *   un tipo de Blitz— y sin `suggestionId`, porque no hay sugerencia.
 *
 * Ese archivo dejó la nota: *"Queda reportado para que quien escriba el worker
 * lo cierre"*. Esto lo cierra, y lo hace en `core` por la misma razón por la
 * que los **nombres** de cola se mudaron acá: el payload es contrato entre dos
 * procesos, y un contrato escrito de los dos lados diverge. Ya pasó con
 * `build-content` contra `content-build`.
 *
 * ## La forma: un núcleo obligatorio y el resto opcional
 *
 * Lo que el handler **necesita** para trabajar son cuatro campos, y son los
 * únicos que los dos productores ya tenían en común: `companyId`, `contentId`,
 * `contentType` y `revision`. Todo lo demás es procedencia —de dónde vino el
 * build— y el handler la usa para decidir matices, no para poder construir.
 *
 * Por eso no es una unión discriminada: una unión obligaría a cada productor
 * futuro a declararse, y el efecto real de no declararse bien sería que el job
 * se rechace en vez de construirse. El núcleo alcanza.
 *
 * ## Por qué hay un parser escrito a mano y no un schema
 *
 * `core` no puede importar npm (regla `core-no-npm`), así que no hay Zod acá.
 * Y el parseo **no es opcional**: el payload vuelve de la cola como `unknown`
 * —viajó por JSON en una tabla de Postgres— y un `as` sobre eso es una mentira
 * que el compilador no puede desmentir. Un `contentId` que en realidad es
 * `undefined` termina en un `WHERE id = 'undefined'`, que no falla: no
 * encuentra nada, y el handler concluye que la pieza se borró.
 */

import { CONTENT_TYPES, type ContentType } from "../content/content.js";

/** Qué disparó el build. El handler decide con esto si construye o rehace. */
export const BUILD_REASONS = ["create", "edit", "regenerate", "custom-video", "blitz"] as const;
export type BuildReason = (typeof BUILD_REASONS)[number];

/**
 * Lo que viaja en la cola `content-build`.
 *
 * Los cuatro primeros campos son el contrato; el resto es procedencia.
 */
export interface ContentBuildJob {
  readonly companyId: string;
  readonly contentId: string;
  readonly contentType: ContentType;
  /**
   * La revisión que este job construye.
   *
   * No es decorativa: entre que el job se encola y que el handler escribe el
   * resultado, una edición puede haber subido la revisión y encolado otro
   * build. Escribir el resultado viejo sobre la pieza nueva publicaría el
   * render anterior a la edición, sin error y sin síntoma. El handler compara.
   */
  readonly revision: number;
  /** `FR-050` — la sugerencia de Blitz que se aceptó, si vino de ahí. */
  readonly suggestionId?: string | undefined;
  readonly influencerId?: string | undefined;
  readonly aspectRatio?: string | undefined;
  readonly reason?: BuildReason | undefined;
  /** `AI-004` — prompt opcional de `Regenerate Text`. */
  readonly prompt?: string | undefined;
  readonly mentionBusiness?: boolean | undefined;
}

/** Lo que devuelve {@link parseContentBuildJob} cuando el payload no sirve. */
export interface InvalidContentBuildJob {
  readonly ok: false;
  /** Qué campo, en una línea. Va al log del worker, no al usuario. */
  readonly reason: string;
}

export type ParsedContentBuildJob =
  | { readonly ok: true; readonly payload: ContentBuildJob }
  | InvalidContentBuildJob;

function optionalString(
  source: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.length === 0)
    return { ok: false, reason: `${key} must be a non-empty string when present` };
  return { ok: true, value: raw };
}

/**
 * Valida un payload que vuelve de la cola.
 *
 * Devuelve un resultado en vez de lanzar porque el llamador **no debe
 * reintentar** un payload inválido: reintentarlo produce el mismo error tres
 * veces y después lo manda a la dead-letter, donde parece un fallo de
 * infraestructura. Un payload mal formado es un bug del productor y se loguea
 * como tal.
 */
export function parseContentBuildJob(raw: unknown): ParsedContentBuildJob {
  if (typeof raw !== "object" || raw === null)
    return { ok: false, reason: "payload is not an object" };
  const source = raw as Record<string, unknown>;

  const { companyId, contentId, contentType, revision } = source;

  if (typeof companyId !== "string" || companyId.length === 0)
    return { ok: false, reason: "companyId is missing" };
  if (typeof contentId !== "string" || contentId.length === 0)
    return { ok: false, reason: "contentId is missing" };
  if (typeof contentType !== "string" || !(CONTENT_TYPES as readonly string[]).includes(contentType))
    return { ok: false, reason: `contentType is not one of ${CONTENT_TYPES.join(", ")}` };
  // `Number.isInteger` y no `typeof === "number"`: un `revision` fraccionario o
  // `NaN` nunca va a coincidir con el de la fila, así que el handler
  // descartaría todos los builds en silencio.
  if (!Number.isInteger(revision) || (revision as number) < 1)
    return { ok: false, reason: "revision must be an integer >= 1" };

  const suggestionId = optionalString(source, "suggestionId");
  if (!suggestionId.ok) return { ok: false, reason: suggestionId.reason };
  const influencerId = optionalString(source, "influencerId");
  if (!influencerId.ok) return { ok: false, reason: influencerId.reason };
  const aspectRatio = optionalString(source, "aspectRatio");
  if (!aspectRatio.ok) return { ok: false, reason: aspectRatio.reason };
  const prompt = optionalString(source, "prompt");
  if (!prompt.ok) return { ok: false, reason: prompt.reason };

  const rawReason = source["reason"];
  if (
    rawReason !== undefined &&
    (typeof rawReason !== "string" || !(BUILD_REASONS as readonly string[]).includes(rawReason))
  )
    return { ok: false, reason: `reason is not one of ${BUILD_REASONS.join(", ")}` };

  const mentionBusiness = source["mentionBusiness"];
  if (mentionBusiness !== undefined && typeof mentionBusiness !== "boolean")
    return { ok: false, reason: "mentionBusiness must be a boolean when present" };

  return {
    ok: true,
    payload: {
      companyId,
      contentId,
      contentType: contentType as ContentType,
      revision: revision as number,
      suggestionId: suggestionId.value,
      influencerId: influencerId.value,
      aspectRatio: aspectRatio.value,
      reason: rawReason as BuildReason | undefined,
      prompt: prompt.value,
      mentionBusiness: mentionBusiness as boolean | undefined,
    },
  };
}
