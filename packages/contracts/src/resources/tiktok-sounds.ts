/**
 * TikTok sounds · `GET /tiktok/sounds?warmedAccountId=` (PRD:2271).
 *
 * Fuente: F-159 (PRD:627) y §9.10 (PRD:2347). Sonidos comerciales para
 * slideshows en cuentas warmed. Las URLs de preview son **firmadas y de vida
 * corta (1 h)**: no persistir, no loguear (NFR-008, PRD:2958) — por eso el
 * schema las trata como campo efímero y nada en el contrato invita a guardarlas.
 */
import { z } from "zod";
import { tiktokSoundIdSchema, warmedAccountIdSchema } from "../primitives/ids";

/** NFR-008 (PRD:2958) — vida de una URL firmada de preview. */
export const SIGNED_PREVIEW_URL_TTL_HOURS = 1;

export const listTiktokSoundsQuerySchema = z
  .object({ warmedAccountId: warmedAccountIdSchema })
  .strict();
export type ListTiktokSoundsQuery = z.infer<typeof listTiktokSoundsQuerySchema>;

/**
 * El PRD nombra `tiktok_sound_id` y `tiktok_sound_mode` como datos enviados a
 * TikTok (INT-001, PRD:2444) pero no enumera los campos que devuelve el
 * catálogo más allá del id y su preview. Se contrata el mínimo verificable.
 */
export const tiktokSoundSchema = z
  .object({
    tiktokSoundId: tiktokSoundIdSchema,
    title: z.string(),
    previewUrl: z.string().url().optional(),
  })
  .strict();
export type TiktokSound = z.infer<typeof tiktokSoundSchema>;
