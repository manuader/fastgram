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
 * No hay LLM de por medio y no es una omisión disimulada: redactar el prompt de
 * `AI-002` es una decisión de producto, y un texto inventado por un modelo sin
 * ese prompt sería peor que uno que dice exactamente lo que el dado decidió.
 * Cuando exista el generador real, reemplaza a esto y el resto no se entera.
 *
 * El efecto lateral bueno de derivarla: **lo que falta se ve**. Cuando la
 * selección pide influencer y no se puede elegir cuál, el texto lo dice en vez
 * de que la sugerencia salga silenciosamente sin personaje.
 */

import type { SuggestionPlan } from "./plan-suggestion.js";

/** Lo que viaja en la cola `discovery-refill`. */
export interface DiscoveryRefillJob {
  readonly companyId: string;
}

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

  parts.push(`Format: ${plan.contentType}, drawn from your content mix.`);

  if (plan.angleId === null) {
    parts.push("Angle: none — this workspace has no active content angle.");
  } else if (narrative.angleTitle === undefined || narrative.angleTitle.trim() === "") {
    parts.push("Angle: picked from your angle weights.");
  } else {
    parts.push(
      `Angle: "${oneLine(narrative.angleTitle, MAX_ANGLE_TITLE_CHARS)}", ` +
        "picked from your angle weights.",
    );
  }

  parts.push(
    plan.isRemix
      ? "Source: a remix of trending content. The specific trend is picked when " +
          "you accept this suggestion."
      : "Source: original content, not a remix.",
  );

  parts.push(
    plan.useOwnMedia
      ? "Media: from your own Media Bank."
      : "Media: not from your own Media Bank.",
  );

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

function influencerLine(plan: SuggestionPlan, narrative: SuggestionNarrative): string {
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
