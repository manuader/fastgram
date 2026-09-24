/**
 * El job `discovery-refill` — PRD §9.5.2, `AI-002`, `FR-030`.
 *
 * Dos cosas que el worker necesita y que no son SQL ni azar: **qué llega en el
 * payload** y **qué texto se guarda en `aiExplanation`**.
 *
 * ## El payload, y por qué hay un parser a mano
 *
 * Mismo motivo que `jobs/content-build.ts`: `core` no importa npm (regla
 * `core-no-npm`), así que no hay Zod, y el payload vuelve de la cola como
 * `unknown` —viajó por JSON dentro de una tabla de Postgres— así que un `as`
 * sobre eso es una mentira que el compilador no puede desmentir.
 *
 * Acá el campo es uno solo, y aun así el parser paga: sin él, un `companyId`
 * `undefined` llega a `withCompany`, que **lanza** porque no es un UUID, y el
 * handler termina reintentando tres veces un payload que no va a mejorar.
 * Parsear deja distinguir «bug del productor» —se loguea y se descarta— de
 * «fallo de infraestructura», que sí merece reintento.
 *
 * **Lo que el payload NO trae hoy:** el `contentType` forzado de `F-067`
 * (`P2-DISC-006`). `AI-002` lo nombra como segundo disparador —*"también bajo
 * demanda al forzar un `contentType`"*— y no está acá a propósito: aceptar el
 * campo y no honrarlo es peor que no aceptarlo, porque el productor creería que
 * está forzando algo. Cuando `P2-DISC-006` se implemente, se agrega acá y el
 * parser lo valida contra `BLITZ_CONTENT_TYPES`.
 *
 * ## La explicación, y por qué se deriva en vez de generarse
 *
 * `AI-002` pide *"la copy más una **explicación** de la elección"*, y
 * `P2-DISC-005` que se **persista con la sugerencia**, no se regenere al
 * abrirla. Lo que este archivo produce es la explicación **derivada de la
 * propia selección**: el formato que salió, el ángulo que salió, si toca remix,
 * de dónde sale la media, qué pasó con el influencer y qué preset de caption
 * quedó. Ni una palabra que no esté en el `SuggestionPlan`.
 *
 * Desde la migración `0011` esto es **la mitad de abajo** de `aiExplanation`:
 * arriba van los bullets del modelo (`composeAiExplanation`, generados con la
 * copy por `suggestion-copy.ts`), que dicen *por qué* la pieza funcionaría;
 * esto dice *de dónde salió*. Las dos son verdad y ninguna reemplaza a la otra.
 *
 * El efecto lateral bueno de derivarla: **lo que falta se ve**. Cuando la
 * selección pide influencer y no se puede elegir cuál, el texto lo dice en vez
 * de que la sugerencia salga silenciosamente sin personaje.
 */

import type { BlitzContentType } from "../content/content.js";
import type { SuggestionPlan } from "./plan-suggestion.js";

/** Lo que viaja en la cola `discovery-refill`. */
export interface DiscoveryRefillJob {
  readonly companyId: string;
  /**
   * `PU-BLITZ-003`: si está, el job **no** es un relleno sino un pedido de
   * «crear desde prompt», y lo atiende otro handler (ver
   * {@link parseBlitzPromptJob}). El tema, el formato y la cantidad no viajan
   * acá: viven en `blitz_prompt_requests`, que el worker lee con el scope del
   * workspace. Así el payload no carga texto del usuario por las tablas de
   * pg-boss, que no tienen RLS.
   */
  readonly promptRequestId?: string;
}

/** Un pedido de «crear desde prompt» — `EXT-009`, `PU-BLITZ-003`. */
export interface BlitzPromptJob {
  readonly companyId: string;
  readonly promptRequestId: string;
}

/**
 * Los límites del pedido. Los fija la tarea (`PU-BLITZ-003`), no el PRD:
 * 3–500 caracteres de tema y 1–5 piezas. La base los repite en CHECKs
 * (migración `0012`) y el contrato en el schema del body.
 */
export const BLITZ_PROMPT_LIMITS = {
  promptMinChars: 3,
  promptMaxChars: 500,
  minCount: 1,
  maxCount: 5,
} as const;

/**
 * Por qué puede fallar un pedido — **códigos estables** que la API devuelve y
 * la web traduce a un mensaje con qué hacer. Nunca un error crudo de proveedor.
 *
 * - `llm_not_configured`: no hay modelo para la tarea `text` → Settings → Models.
 * - `no_media_for_format`: se forzó un formato y el Media Bank no tiene media
 *   categorizada para él → Library.
 * - `no_media`: sin formato forzado, ningún formato del content mix tiene media.
 * - `copy_rejected`: el modelo contestó, pero ninguna copy pasó las reglas
 *   (vacía, larga de más, o con pinta de instrucción filtrada).
 * - `llm_failed`: el proveedor falló y se agotaron los reintentos.
 * - `invalid_state`: el workspace no permite planificar (p. ej. pesos de ángulo
 *   rotos). No mejora reintentando.
 */
export const PROMPT_FAILURE_REASONS = [
  "llm_not_configured",
  "no_media_for_format",
  "no_media",
  "copy_rejected",
  "llm_failed",
  "invalid_state",
] as const;
export type PromptFailureReason = (typeof PROMPT_FAILURE_REASONS)[number];

/**
 * La misma forma que `withCompany` exige antes de abrir la transacción.
 *
 * Está duplicada —vive también en `packages/db/src/tenancy.ts`— y la
 * duplicación es el precio de que `core` no importe `db`. Vale la pena: sin
 * esta comprobación, un `companyId` mal formado pasa el parser, llega a
 * `withCompany`, **lanza**, y el handler lo reintenta tres veces antes de
 * mandarlo a la dead-letter como si fuera un fallo de infraestructura. Es el
 * mismo final que `parseContentBuildJob` existe para evitar.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type ParsedDiscoveryRefillJob =
  | { readonly ok: true; readonly payload: DiscoveryRefillJob }
  /** Qué falta, en una línea. Va al log del worker, no al usuario. */
  | { readonly ok: false; readonly reason: string };

/**
 * Valida un payload que vuelve de la cola.
 *
 * Devuelve un resultado en vez de lanzar, por lo mismo que
 * `parseContentBuildJob`: quien llama **no debe reintentar** un payload
 * inválido. Reintentarlo da el mismo error tres veces y después parece un fallo
 * de infraestructura en la dead-letter.
 */
export function parseDiscoveryRefillJob(raw: unknown): ParsedDiscoveryRefillJob {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const companyId = (raw as Record<string, unknown>)["companyId"];
  if (typeof companyId !== "string" || companyId.length === 0) {
    return { ok: false, reason: "companyId is missing" };
  }
  if (!UUID_RE.test(companyId)) {
    return { ok: false, reason: "companyId is not a UUID" };
  }
  return { ok: true, payload: { companyId } };
}

export type ParsedBlitzPromptJob =
  | { readonly ok: true; readonly payload: BlitzPromptJob }
  | { readonly ok: false; readonly reason: string };

/** ¿Este payload de `discovery-refill` es un pedido de prompt? Mira la clave, no el valor. */
export function isBlitzPromptPayload(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "promptRequestId" in raw;
}

/** Como {@link parseDiscoveryRefillJob}, para un pedido de prompt. */
export function parseBlitzPromptJob(raw: unknown): ParsedBlitzPromptJob {
  const base = parseDiscoveryRefillJob(raw);
  if (!base.ok) return base;
  const id = (raw as Record<string, unknown>)["promptRequestId"];
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return { ok: false, reason: "promptRequestId is not a UUID" };
  }
  return {
    ok: true,
    payload: { companyId: base.payload.companyId, promptRequestId: id },
  };
}

/**
 * Lo que la explicación sabe del mundo además del plan: nombres.
 *
 * El plan trae ids —`angleId`, candidatos de influencer— y un id no le dice
 * nada a nadie en `Why This Content?`. Los nombres los lee el worker en la
 * misma transacción en la que lee las preferencias, así que no cuestan una
 * consulta extra.
 */
export interface SuggestionNarrative {
  /** Título del ángulo que salió. Texto del usuario: se acota antes de guardar. */
  readonly angleTitle?: string | undefined;
  /** Nombre del influencer, **sólo si se pudo elegir uno**. Ver `chosenInfluencerId`. */
  readonly influencerName?: string | undefined;
  /**
   * Cuántos candidatos había cuando la tirada de influencer salió y **no** se
   * pudo elegir uno. `0` o ausente = no aplica.
   *
   * Existe porque «pedí influencer y salí sin ninguno» tiene dos causas muy
   * distintas —no había elegibles, o había varios y elegir es `DP-005`/`JV-6`—
   * y al usuario le importan de forma distinta: la primera la arregla
   * entrenando un personaje, la segunda no la arregla él.
   */
  readonly undecidedCandidates?: number | undefined;
  /**
   * Nombre del influencer que la tirada eligió y **no** se usó porque sus sets
   * no tienen media para este formato (`FR-083`). Cae a contenido regular,
   * igual que sin elegible (`AI-002`, «Reintentos»).
   */
  readonly influencerWithoutMedia?: string | undefined;
  /** Formatos del mix que no se pudieron planificar: sin media en el Media Bank. */
  readonly skippedFormats?: readonly BlitzContentType[] | undefined;
  /**
   * `PU-BLITZ-003`: la pieza salió de un pedido del usuario. Cambia dos líneas
   * de la explicación —de dónde salió el formato y qué ocupó el lugar del
   * ángulo— y agrega una que dice cuál fue el pedido.
   */
  readonly prompt?: PromptNarrative | undefined;
}

export interface PromptNarrative {
  /** El tema, tal cual lo escribió el usuario. Se acota antes de guardar. */
  readonly topic: string;
  /** `true` si el usuario forzó el formato; `false` si lo decidió el mix. */
  readonly forcedFormat: boolean;
}

/** Cuánto texto ajeno entra en la explicación. Un título largo no la secuestra. */
const MAX_ANGLE_TITLE_CHARS = 120;

/** Una línea, sin saltos: la explicación se guarda en una columna y se muestra entera. */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * La explicación que se persiste con la sugerencia — `AI-002`, `P2-DISC-005`.
 *
 * Determinista: el mismo plan y los mismos nombres dan el mismo texto. Es lo
 * que permite que el test de determinismo del `Rng` sembrado se extienda hasta
 * la fila guardada, y no sólo hasta el plan.
 */
export function explainSuggestion(
  plan: SuggestionPlan,
  narrative: SuggestionNarrative = {},
): string {
  const parts: string[] = [];

  if (narrative.prompt !== undefined) {
    parts.push(
      `Created from your prompt: "${oneLine(narrative.prompt.topic, MAX_ANGLE_TITLE_CHARS)}".`,
    );
  }

  parts.push(
    narrative.prompt?.forcedFormat === true
      ? `Format: ${plan.contentType}, as you asked.`
      : `Format: ${plan.contentType}, drawn from your content mix.`,
  );

  if (narrative.prompt !== undefined) {
    parts.push("Angle: none — your prompt is the topic.");
  } else if (plan.angleId === null) {
    parts.push("Angle: none — this workspace has no active content angle.");
  } else if (narrative.angleTitle === undefined || narrative.angleTitle.trim() === "") {
    parts.push("Angle: picked from your angle weights.");
  } else {
    parts.push(
      `Angle: "${oneLine(narrative.angleTitle, MAX_ANGLE_TITLE_CHARS)}", ` +
        "picked from your angle weights.",
    );
  }

  // *Qué* remixar es `DP-005`/`JV-6` y no tiene implementación: la pieza sale
  // original y el texto lo dice, en vez de prometer una tendencia que nadie
  // va a elegir.
  parts.push(
    plan.isRemix
      ? "Source: original content. Your remix ratio drew a remix, but picking " +
          "a trending source isn't available yet."
      : "Source: original content, not a remix.",
  );

  // La librería compartida no existe en este sistema (ver `blitz-media.ts`):
  // toda media sale del Media Bank, y cuando la tirada pidió la librería se
  // dice.
  parts.push(
    plan.useOwnMedia
      ? "Media: from your own Media Bank."
      : "Media: from your own Media Bank — the shared library isn't available yet.",
  );

  if (narrative.skippedFormats !== undefined && narrative.skippedFormats.length > 0) {
    parts.push(
      `Not planned: ${narrative.skippedFormats.join(", ")} — your Media Bank has ` +
        "no media categorized for it.",
    );
  }

  parts.push(influencerLine(plan, narrative));

  parts.push(
    plan.textStylePresetId === null
      ? "Caption style: the engine default — you have no caption style mix set."
      : `Caption style: ${plan.textStylePresetId}.`,
  );

  parts.push(
    plan.mentionBusiness
      ? "It mentions your business."
      : "It does not mention your business.",
  );

  return parts.join(" ");
}

/**
 * La explicación que se guarda: los bullets del modelo (`FR-050`, *Why This
 * Content?*) y, debajo, lo que el dado decidió. Las dos partes son verdad y
 * responden cosas distintas: por qué la pieza funcionaría, y de dónde salió.
 */
export function composeAiExplanation(
  bullets: readonly string[],
  derived: string,
): string {
  const lines = bullets.map((b) => `• ${b.replace(/\s+/gu, " ").trim()}`);
  return [...lines, "", derived].join("\n");
}

function influencerLine(plan: SuggestionPlan, narrative: SuggestionNarrative): string {
  if (
    narrative.influencerWithoutMedia !== undefined &&
    narrative.influencerWithoutMedia.trim() !== ""
  ) {
    return (
      `Influencer: none — ${oneLine(narrative.influencerWithoutMedia, MAX_ANGLE_TITLE_CHARS)} ` +
      "has no media in their sets for this format, so this is regular content."
    );
  }
  if (plan.influencer.decision === "none") {
    switch (plan.influencer.reason) {
      case "green_screen":
        return "Influencer: none — green-screen is always regular content.";
      case "roll_missed":
        return "Influencer: none — this one came up as regular content.";
      case "no_eligible_influencer":
        return (
          "Influencer: none — no active, trained character fits this format and " +
          "your gender filter."
        );
    }
  }

  if (narrative.influencerName !== undefined && narrative.influencerName.trim() !== "") {
    return (
      `Influencer: ${oneLine(narrative.influencerName, MAX_ANGLE_TITLE_CHARS)} — ` +
      "the only eligible character for this format."
    );
  }

  // La tirada salió, hay candidatos, y **elegir cuál no es una tirada**: es
  // `DP-005`/`JV-6` (PRD §25), que ordena por encaje con la marca. Todavía no
  // hay adaptador de `Judgment` para ese punto de decisión, así que la
  // sugerencia sale sin personaje y el texto lo dice. Sustituirlo por un dado
  // sería exactamente lo que `EXT-008` existe para evitar.
  const cuantos = narrative.undecidedCandidates ?? 0;
  return (
    `Influencer: none — ${cuantos > 0 ? String(cuantos) : "several"} of your ` +
    "characters fit, and picking between them is not available yet."
  );
}
