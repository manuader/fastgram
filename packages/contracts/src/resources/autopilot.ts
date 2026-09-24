/**
 * Piloto automático — `PU-AUTO-001…003` (`docs/PLAN-USO-PERSONAL.md` §2, PRD
 * §2.7 `D-08`, §25.3 `JV-3`).
 *
 *   GET /autopilot/digest?date&brands   el resumen del día, por marca
 *   GET /autopilot/policy               cómo decide el piloto (sólo lectura)
 *
 * Ninguna ruta está en el PRD original (§9.3): nacen del plan de uso personal.
 *
 * ## Los códigos de motivo están duplicados, a propósito
 *
 * Los decide `packages/core` (`judgment/preflight.ts`), y este paquete es
 * standalone (no importa `core`). `apps/api` tiene un test que compara las dos
 * listas: si `core` agrega un motivo y acá no, el test falla antes de que la
 * API responda algo que el contrato rechaza.
 *
 * ## `date` es un día **local de cada marca**
 *
 * Con `brands=all` cada marca puede estar en otra zona: el "hoy" de una marca
 * en Madrid no es el de una en Buenos Aires. `date` (`YYYY-MM-DD`) se
 * interpreta en la zona de cada marca; sin `date`, es el hoy de cada una.
 */
import { z } from "zod";

import { contentTypeSchema, postPlatformSchema } from "../primitives/enums.js";
import { msEpochSchema } from "../primitives/ids.js";
import { brandAutonomySchema, strategyNetworkSchema } from "./strategy.js";

/** Por qué el pre-chequeo (o el aceptar) rechazó una pieza. */
export const AUTOPILOT_REJECT_REASONS = [
  "off_brand",
  "health_claim",
  "financial_claim",
  "legal_claim",
  "third_party_brand",
  "incoherent",
  "wrong_language",
  /** Pasó el pre-chequeo pero no se puede construir (media borrada, plan roto). */
  "unbuildable",
] as const;

/** Por qué quedó en la cola para el humano. Nunca se auto-aprueba. */
export const AUTOPILOT_HOLD_REASONS = [
  "judgment_timeout",
  "judgment_unavailable",
] as const;

export const autopilotReasonSchema = z.enum([
  ...AUTOPILOT_REJECT_REASONS,
  ...AUTOPILOT_HOLD_REASONS,
]);
export type AutopilotReason = z.infer<typeof autopilotReasonSchema>;

/** Qué pasó en la última corrida de una marca. */
export const AUTOPILOT_RUN_OUTCOMES = [
  "ran",
  "manual",
  "no_llm",
  "no_judgment",
  "invalid_strategy",
  "profile_not_ready",
  "error",
] as const;
export const autopilotRunOutcomeSchema = z.enum(AUTOPILOT_RUN_OUTCOMES);
export type AutopilotRunOutcome = z.infer<typeof autopilotRunOutcomeSchema>;

export const autopilotDigestQuerySchema = z
  .object({
    /** Día local de cada marca, `YYYY-MM-DD`. Sin esto, hoy. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u, "Use YYYY-MM-DD.")
      .optional(),
    brands: z.enum(["current", "all"]).default("current"),
  })
  .strict();
export type AutopilotDigestQuery = z.infer<typeof autopilotDigestQuerySchema>;

export const autopilotDecisionItemSchema = z
  .object({
    suggestionId: z.string().uuid(),
    contentType: contentTypeSchema.optional(),
    /** Las primeras palabras de la copy, para reconocer la pieza. */
    excerpt: z.string(),
    at: msEpochSchema,
    /** Vacío si se aprobó. */
    reasons: z.array(autopilotReasonSchema),
    /** La pieza construida, si se aprobó. */
    contentId: z.string().uuid().optional(),
    /** Dónde quedó agendada, si se aprobó. */
    scheduled: z.array(
      z.object({ network: strategyNetworkSchema, at: msEpochSchema }).strict(),
    ),
  })
  .strict();
export type AutopilotDecisionItem = z.infer<typeof autopilotDecisionItemSchema>;

export const autopilotLastRunSchema = z
  .object({
    at: msEpochSchema,
    outcome: autopilotRunOutcomeSchema,
    queueTarget: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
  })
  .strict();

export const autopilotBrandDigestSchema = z
  .object({
    brandId: z.string().uuid(),
    brandName: z.string(),
    timezone: z.string(),
    /** El día local de esta marca que se resumió. */
    date: z.string(),
    /** `manual` también si la marca nunca guardó estrategia. */
    autonomy: brandAutonomySchema,
    lastRun: autopilotLastRunSchema.nullable(),
    /** Sugerencias nuevas del día (refill y prompt). */
    generated: z.number().int().nonnegative(),
    approved: z.array(autopilotDecisionItemSchema),
    rejected: z.array(autopilotDecisionItemSchema),
    /** En la cola esperando al humano: el juicio no respondió. */
    held: z.array(autopilotDecisionItemSchema),
    /** Posts que salieron ese día (incluye borradores de TikTok entregados). */
    published: z.number().int().nonnegative(),
    failed: z.array(
      z
        .object({
          postId: z.string().uuid(),
          network: postPlatformSchema,
          errorCode: z.string().optional(),
          at: msEpochSchema,
        })
        .strict(),
    ),
    /** Alguna lista llegó al tope y se cortó. */
    truncated: z.boolean(),
  })
  .strict();
export type AutopilotBrandDigest = z.infer<typeof autopilotBrandDigestSchema>;

export const autopilotDigestSchema = z
  .object({ brands: z.array(autopilotBrandDigestSchema) })
  .strict();
export type AutopilotDigest = z.infer<typeof autopilotDigestSchema>;

export const autopilotPolicySchema = z
  .object({
    horizonDays: z.number().int().positive(),
    queueTargetMin: z.number().int().nonnegative(),
    queueTargetMax: z.number().int().positive(),
    maxDecisionsPerRun: z.number().int().positive(),
    runEveryMinutes: z.number().int().positive(),
    precheckTimeoutMs: z.number().int().positive(),
    /** Versión de las preguntas y los umbrales. */
    precheckVersion: z.string(),
    thresholds: z
      .object({
        onBrandMin: z.number().min(0).max(1),
        riskyClaimMaxMass: z.number().min(0).max(1),
        thirdPartyMax: z.number().min(0).max(1),
        coherentMin: z.number().min(0).max(1),
        inLanguageMin: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();
export type AutopilotPolicy = z.infer<typeof autopilotPolicySchema>;
