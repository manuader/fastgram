/**
 * Warmed accounts · `GET /warmed-accounts` (PRD:2274).
 *
 * Fuente: FR-130 (PRD:1679-1712), DATA-017 (PRD:2114), DATA-018 (PRD:2117).
 *
 * "Máximo **100 cuentas visibles**, sin cursor de paginación" (PRD:1695): este
 * listado es el único de la v1 que **no** pagina por cursor.
 */
import { z } from "zod";
import { warmedPlatformSchema } from "../primitives/enums.js";
import { msEpochSchema, warmedAccountIdSchema } from "../primitives/ids.js";

/** FR-130 (PRD:1695) — tope de cuentas devueltas. */
export const WARMED_ACCOUNTS_MAX_VISIBLE = 100;
/** FR-130 (PRD:1687) — la cuenta se calienta 5 días en un teléfono real. */
export const WARMED_ACCOUNT_WARMING_DAYS = 5;

/** FR-130 (PRD:1697). `checking` y `replacement_needed` pausan la publicación. */
export const postingAvailabilitySchema = z.enum([
  "available",
  "checking",
  "replacement_needed",
]);
export type PostingAvailability = z.infer<typeof postingAvailabilitySchema>;

/** DATA-017 (PRD:2114) — país de provisión. */
export const warmedAccountCountrySchema = z.enum(["US", "EU"]);
export type WarmedAccountCountry = z.infer<typeof warmedAccountCountrySchema>;

/** DATA-019 (PRD:2120). */
export const replacementDecisionStatusSchema = z.enum(["pending", "resolved"]);
export type ReplacementDecisionStatus = z.infer<typeof replacementDecisionStatusSchema>;

/**
 * El PRD enumera `options[]` sin decir qué hay dentro (DATA-019, PRD:2120): se
 * contrata como lista de strings y queda anotado como abierto.
 */
export const replacementDecisionSchema = z
  .object({
    warmedAccountId: warmedAccountIdSchema,
    options: z.array(z.string()),
    status: replacementDecisionStatusSchema,
  })
  .strict();
export type ReplacementDecision = z.infer<typeof replacementDecisionSchema>;

/**
 * `status` de la cuenta: el PRD muestra copy de UI (`Account Awaiting Approval`,
 * `Account Status Being Checked`, `Account Unavailable`, PRD:1692) pero **no**
 * enumera los valores del campo. Se contrata como string y queda anotado.
 */
export const warmedAccountSchema = z
  .object({
    warmedAccountId: warmedAccountIdSchema,
    accountType: z.literal("warmed"),
    platform: warmedPlatformSchema,
    username: z.string().min(1),
    displayName: z.string(),
    profilePictureUrl: z.string().url().optional(),
    status: z.string().min(1),
    postable: z.boolean(),
    postingAvailability: postingAvailabilitySchema,
    minLeadTimeMs: z.number().int().nonnegative(),
    country: warmedAccountCountrySchema.optional(),
    niche: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    approvedAt: msEpochSchema.optional(),
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type WarmedAccount = z.infer<typeof warmedAccountSchema>;

/**
 * Respuesta de `GET /warmed-accounts` (PRD:1695): las cuentas más
 * `replacementDecisions[]`, `slotBalance` y un `minLeadTimeMs` global —el más
 * conservador, "sólo por compatibilidad"—. No lleva `pagination`.
 */
export const listWarmedAccountsResponseSchema = z
  .object({
    data: z.array(warmedAccountSchema).max(WARMED_ACCOUNTS_MAX_VISIBLE),
    replacementDecisions: z.array(replacementDecisionSchema),
    slotBalance: z.number().int().nonnegative(),
    minLeadTimeMs: z.number().int().nonnegative(),
  })
  .strict();
export type ListWarmedAccountsResponse = z.infer<typeof listWarmedAccountsResponseSchema>;
