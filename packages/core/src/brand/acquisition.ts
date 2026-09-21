/**
 * Orden de adquisición de una Brand Source — PRD `FR-011.4`, decisión `D-01`.
 *
 * El orden normativo es **B → C → A → D**, y lo que tiene de raro es
 * exactamente lo que lo hace valioso: **A es el mejor dato y va tercero**.
 *
 *   B (API pública / oEmbed)
 *     → C (fetch de la página renderizada, sólo si el flag está activo)
 *       → si ambos fallan, la cuenta es privada o la señal es insuficiente:
 *           ofrecer A (conectar por OAuth)
 *             → si el usuario no quiere, D (asistido)
 *
 * **Por qué A no va primero, que es la pregunta obvia.** Porque el signup no
 * pide OAuth (`D-01`). Poner A de entrada convierte "pegá tu Instagram" en
 * "autorizá a esta app que acabás de conocer a leer tu cuenta", y ahí se cae
 * justamente el segmento que la extensión `EXT-001` existe para capturar: el
 * que no tiene web y no tiene ganas de autorizar nada. A sigue siendo el mejor
 * dato y por eso se ofrece **después** del análisis, presentado como mejora.
 *
 * **El coste honesto de esa decisión**, que el PRD obliga a asumir: con B/C la
 * señal es peor, así que hay que esperar **más campos en confianza `low` y más
 * preguntas de cierre de huecos**. El diseño lo absorbe preguntando en vez de
 * inventando (ver `synthesis.ts`); no lo disimula.
 *
 * **C está apagado por defecto** hasta `OQ-16` (es una pregunta legal, no
 * técnica), y el PRD exige que apagarlo **no rompa ningún alta**: degrada a D
 * en silencio, sin mostrar nunca un error por ello.
 */
import type { AcquisitionTier } from "@fastgram/ports";

/**
 * Qué puede intentarse, en orden.
 *
 * `renderedFetchEnabled` es el flag de C. `canOfferOAuth` es falso cuando la
 * plataforma no tiene integración OAuth o el workspace ya la descartó.
 */
export interface AcquisitionContext {
  /** Flag del tier C. Apagado por defecto hasta `OQ-16`. */
  readonly renderedFetchEnabled: boolean;
  /**
   * Ya hay una `Connection` OAuth para esta plataforma. Cambia el orden: si
   * la credencial ya existe, usarla no le pide nada al usuario, así que A
   * deja de tener coste y pasa al frente. `FR-011.5` lo describe como el
   * camino de "reutilización de cuentas ya conectadas".
   */
  readonly hasConnection: boolean;
  /** La plataforma no lee nada sin credencial (`SocialReadCapabilities`). */
  readonly requiresConnection: boolean;
}

/**
 * El plan de adquisición para una fuente.
 *
 * `D_assisted` **siempre** cierra la lista: es el suelo del que no se cae.
 * Una lista sin D sería una lista que puede terminar sin ningún resultado, y
 * el PRD es explícito en que ningún fallo de lectura bloquea el alta.
 */
export function acquisitionPlan(context: AcquisitionContext): readonly AcquisitionTier[] {
  const plan: AcquisitionTier[] = [];

  // Caso especial: la plataforma no expone nada en público. Intentar B y C
  // sería gastar dos llamadas para llegar al mismo sitio, y —peor— retrasar
  // la oferta de conectar que es la única vía real.
  if (context.requiresConnection) {
    if (context.hasConnection) plan.push("A_oauth");
    plan.push("D_assisted");
    return plan;
  }

  // Con la credencial ya en mano, A no le pide nada a nadie: va primero.
  if (context.hasConnection) plan.push("A_oauth");

  plan.push("B_public_api");
  if (context.renderedFetchEnabled) plan.push("C_rendered_fetch");

  // La oferta de conectar, cuando todavía no hay credencial.
  if (!context.hasConnection) plan.push("A_oauth");

  plan.push("D_assisted");
  return plan;
}

/**
 * Resultado de un intento de lectura, tal como lo devuelve `SocialReader`.
 * `ok` es el único que corta la escalada.
 */
export type AcquisitionOutcome =
  "ok" | "not_found" | "private" | "insufficient_content" | "unavailable";

export interface AcquisitionStep {
  readonly tier: AcquisitionTier;
  readonly outcome: AcquisitionOutcome;
}

export interface AcquisitionVerdict {
  /** Con qué tier se resolvió, o `null` si ninguno dio señal. */
  readonly resolvedTier: AcquisitionTier | null;
  /** `true` si hay que ofrecer conectar la cuenta como mejora. */
  readonly offerOAuth: boolean;
  /** `true` si hay que pedirle al usuario la ayuda concreta del tier D. */
  readonly degradedToAssisted: boolean;
  readonly attemptedTiers: readonly AcquisitionTier[];
}

/**
 * Lee la escalada ya ejecutada y dice en qué quedó.
 *
 * Es una función aparte del plan porque el dominio no hace IO: quien recorre
 * el plan es el job de análisis, y esto interpreta el resultado. Separarlo
 * permite testear la interpretación con escaleras completas sin red.
 *
 * `FR-011.4`, requisito de diseño: **la UI nunca expone en qué nivel se
 * resolvió, salvo cuando degrada a D**. Por eso el veredicto tiene
 * `degradedToAssisted` como campo propio: es el único que la UI puede mostrar.
 */
export function interpretAcquisition(
  steps: readonly AcquisitionStep[],
): AcquisitionVerdict {
  const attemptedTiers = steps.map((s) => s.tier);
  const success = steps.find((s) => s.outcome === "ok");

  if (success !== undefined) {
    return {
      resolvedTier: success.tier,
      // Se ofrece conectar cuando se resolvió con algo peor que OAuth: es la
      // mejora que `D-01` promete presentar DESPUÉS del análisis.
      offerOAuth: success.tier !== "A_oauth",
      degradedToAssisted: false,
      attemptedTiers,
    };
  }

  // Ninguno dio señal. `private` e `insufficient_content` son los dos casos
  // que el PRD manda tratar como degradación y no como fallo: «ninguno
  // bloquea el alta» (§19.5.1).
  return {
    resolvedTier: null,
    offerOAuth: !attemptedTiers.includes("A_oauth"),
    degradedToAssisted: true,
    attemptedTiers,
  };
}
