/**
 * Confirmación antes de gastar — sprint 9 (R), `D-21`: *"activar, reanudar o
 * subir presupuesto exige una confirmación explícita en la app que muestra el
 * gasto máximo posible"*.
 *
 * ## El protocolo
 *
 * 1. `POST …/activation-preview` calcula el máximo (`maxPossibleSpend`) y
 *    emite un **preview**: un token de un solo uso, atado a la campaña, a la
 *    acción y a los topes con los que se calculó, que vence en
 *    {@link ACTIVATION_PREVIEW_TTL_MS}. Se guarda en `ad_actions` (es también
 *    la auditoría de qué máximo se mostró).
 * 2. `POST …/activate` (o el cambio de presupuesto) trae ese token. Sin
 *    token, vencido, ya usado, de otra acción o con topes que cambiaron desde
 *    que se mostró → **409**. El máximo que el dueño aceptó tiene que ser el
 *    que de verdad rige.
 *
 * Es deliberadamente más que un "¿seguro?" en la web: la regla vive en la API,
 * así un cliente que se saltee el diálogo no puede prender nada.
 */
import type { SpendCaps } from "./caps.js";

/** Cinco minutos: lo que dura leer el diálogo, no una sesión. */
export const ACTIVATION_PREVIEW_TTL_MS = 5 * 60_000;

export const CONFIRMABLE_ACTIONS = ["activate", "budget_increase"] as const;
export type ConfirmableAction = (typeof CONFIRMABLE_ACTIONS)[number];

export interface StoredActivationPreview {
  readonly campaignId: string;
  readonly action: ConfirmableAction;
  /** Los topes con los que se calculó el máximo mostrado. */
  readonly caps: SpendCaps;
  readonly maxSpendMinor: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export type ConfirmationRejection =
  "preview_required" | "preview_expired" | "preview_used" | "preview_mismatch";

export interface ConfirmationCheck {
  readonly campaignId: string;
  readonly action: ConfirmableAction;
  /** Los topes que van a regir si se confirma. */
  readonly caps: SpendCaps;
  readonly now: Date;
}

/**
 * `preview` es lo que se encontró con el token (o `null` si no se mandó o no
 * existe **en esta marca**: el repositorio busca con scope).
 */
export function checkConfirmation(
  preview: StoredActivationPreview | null,
  check: ConfirmationCheck,
):
  | { readonly ok: true; readonly maxSpendMinor: number }
  | { readonly ok: false; readonly reason: ConfirmationRejection } {
  if (preview === null) return { ok: false, reason: "preview_required" };
  if (preview.campaignId !== check.campaignId || preview.action !== check.action)
    return { ok: false, reason: "preview_mismatch" };
  if (preview.consumedAt !== null) return { ok: false, reason: "preview_used" };
  if (preview.expiresAt.getTime() <= check.now.getTime())
    return { ok: false, reason: "preview_expired" };
  if (
    preview.caps.dailyCapMinor !== check.caps.dailyCapMinor ||
    preview.caps.totalCapMinor !== check.caps.totalCapMinor
  )
    return { ok: false, reason: "preview_mismatch" };
  return { ok: true, maxSpendMinor: preview.maxSpendMinor };
}
