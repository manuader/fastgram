/**
 * Preferencias aprendidas desde Blitz — sprint 9 (agente Q), `PU-S9-011`, `D-22`.
 *
 *   GET   /preferences           lo aprendido en la marca activa (marca + dueño)
 *   PATCH /preferences           on/off, exploración y vida media de la marca
 *   POST  /preferences/reset     olvidar lo de la marca o lo del dueño (con confirmación)
 *   GET   /preferences/owner     el nivel del dueño (owner-level: ignora la marca)
 *   PATCH /preferences/owner     los defaults del dueño
 *
 * Ninguna está en el PRD original (§9.3): nacen de `D-22`.
 *
 * ## Los rasgos viajan como datos, no como frases
 *
 * Cada rasgo aprendido sale con su familia, su valor, su dirección y su
 * evidencia; las frases («You accept short reaction memes (12 of 14)») las
 * arma la web con plantillas del catálogo i18n. No hay texto de un modelo en
 * esta respuesta. Las familias y los valores están duplicados de
 * `@fastgram/core` (`preferences/features.ts`) porque este paquete no importa
 * `core`; el test de la API compara las dos listas.
 *
 * ## Fechas en ms de epoch, como el resto del contrato.
 */
import { z } from "zod";

/** Las familias de rasgos (`PREFERENCE_FEATURE_FAMILIES` de `core`). */
export const PREFERENCE_FAMILY_VALUES = [
  "format",
  "angle",
  "influencer",
  "model",
  "origin",
  "bg.type",
  "bg.source",
  "bg.tone",
  "clip.type",
  "clip.kind",
  "clip.source",
  "music",
  "music.track",
  "music.source",
  "text.preset",
  "text.font",
  "text.size",
  "text.box",
  "text.anim",
  "text.len",
  "duration",
  // Vocabulario v2 (sprint 9, U, `PU-S9-014`): rasgos de reel.
  "reel.template",
  "reel.anim",
  "reel.captions",
  "reel.clip",
] as const;
export const preferenceFamilySchema = z.enum(PREFERENCE_FAMILY_VALUES);
export type PreferenceFamily = z.infer<typeof preferenceFamilySchema>;

export const PREFERENCE_ASPECT_VALUES = [
  "text",
  "background",
  "clip",
  "music",
  "style",
] as const;
export const preferenceAspectSchema = z.enum(PREFERENCE_ASPECT_VALUES);

export const PREFERENCE_EXPLORATION_MIN = 0;
export const PREFERENCE_EXPLORATION_MAX = 0.5;
export const PREFERENCE_HALF_LIFE_MIN_DAYS = 1;
export const PREFERENCE_HALF_LIFE_MAX_DAYS = 365;

export const learnedPreferenceSchema = z
  .object({
    /** `familia=valor`. */
    feature: z.string(),
    family: preferenceFamilySchema,
    value: z.string(),
    /**
     * El nombre legible de un valor que es un id (ángulo, influencer, modelo,
     * pista), o `null` si no es un id o ya no existe.
     */
    label: z.string().nullable(),
    aspect: preferenceAspectSchema.nullable(),
    direction: z.enum(["likes", "avoids"]),
    /** En [-1, 1]. */
    score: z.number().min(-1).max(1),
    /** Decisiones a favor (cuenta cruda, sin decaer). */
    accepts: z.number().int().nonnegative(),
    /** Decisiones sobre el rasgo (cuenta cruda). */
    total: z.number().int().nonnegative(),
    /** Cuánto pesa hoy lo que se sabe (decaído). */
    evidence: z.number().nonnegative(),
    source: z.enum(["brand", "owner", "both"]),
  })
  .strict();
export type LearnedPreference = z.infer<typeof learnedPreferenceSchema>;

export const preferenceSettingsViewSchema = z
  .object({
    enabled: z.boolean(),
    exploration: z
      .number()
      .min(PREFERENCE_EXPLORATION_MIN)
      .max(PREFERENCE_EXPLORATION_MAX),
    halfLifeDays: z
      .number()
      .min(PREFERENCE_HALF_LIFE_MIN_DAYS)
      .max(PREFERENCE_HALF_LIFE_MAX_DAYS),
    /** De dónde sale cada valor: la marca lo fijó o hereda el del dueño. */
    explorationSource: z.enum(["brand", "owner"]),
    halfLifeSource: z.enum(["brand", "owner"]),
  })
  .strict();
export type PreferenceSettingsView = z.infer<typeof preferenceSettingsViewSchema>;

export const preferencesViewSchema = z
  .object({
    scope: z.enum(["brand", "owner"]),
    settings: preferenceSettingsViewSchema,
    ownerDefaults: z
      .object({ exploration: z.number(), halfLifeDays: z.number() })
      .strict(),
    signals: z
      .object({
        total: z.number().int().nonnegative(),
        lastAt: z.number().int().nullable(),
      })
      .strict(),
    /** Ordenados por fuerza, los más marcados primero. */
    learned: z.array(learnedPreferenceSchema),
    computedAt: z.number().int().nullable(),
  })
  .strict();
export type PreferencesView = z.infer<typeof preferencesViewSchema>;

const exploration = z
  .number()
  .min(PREFERENCE_EXPLORATION_MIN)
  .max(PREFERENCE_EXPLORATION_MAX);
const halfLife = z
  .number()
  .min(PREFERENCE_HALF_LIFE_MIN_DAYS)
  .max(PREFERENCE_HALF_LIFE_MAX_DAYS);

/** `PATCH /preferences`. `null` = volver a heredar el valor del dueño. */
export const updatePreferenceSettingsRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    exploration: exploration.nullable().optional(),
    halfLifeDays: halfLife.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "nothing to update",
  });
export type UpdatePreferenceSettingsRequest = z.infer<
  typeof updatePreferenceSettingsRequestSchema
>;

/** `PATCH /preferences/owner`. */
export const updateOwnerPreferenceSettingsRequestSchema = z
  .object({
    exploration: exploration.optional(),
    halfLifeDays: halfLife.optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "nothing to update",
  });
export type UpdateOwnerPreferenceSettingsRequest = z.infer<
  typeof updateOwnerPreferenceSettingsRequestSchema
>;

/**
 * `POST /preferences/reset`. `confirm: true` es la confirmación: sin ella es
 * `400`. `brand` borra las señales y los pesos de la marca activa (y su aporte
 * al dueño); `owner` hace que lo anterior deje de contar para el nivel del
 * dueño, sin tocar lo de cada marca.
 */
export const resetPreferencesRequestSchema = z
  .object({
    scope: z.enum(["brand", "owner"]),
    confirm: z.literal(true),
  })
  .strict();
export type ResetPreferencesRequest = z.infer<typeof resetPreferencesRequestSchema>;
