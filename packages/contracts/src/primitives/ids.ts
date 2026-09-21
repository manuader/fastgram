/**
 * Identificadores con marca de tipo (branded types).
 *
 * El PRD describe los ids como opacos ("valid Convex document ids", DATA-001 y
 * siguientes). La API v1 nunca promete un formato concreto, así que el contrato
 * valida sólo "string no vacío" y usa la marca para que el compilador impida
 * pasar un `PostId` donde se espera un `ContentId`. La marca es de tipo, no de
 * runtime: `parse` devuelve el mismo string.
 */
import { z } from "zod";

const opaqueId = z.string().min(1);

export const companyIdSchema = opaqueId.brand<"CompanyId">();
export const contentIdSchema = opaqueId.brand<"ContentId">();
export const postIdSchema = opaqueId.brand<"PostId">();
export const mediaIdSchema = opaqueId.brand<"MediaId">();
export const mediaSetIdSchema = opaqueId.brand<"MediaSetId">();
export const influencerIdSchema = opaqueId.brand<"InfluencerId">();
export const angleIdSchema = opaqueId.brand<"AngleId">();
export const connectionIdSchema = opaqueId.brand<"ConnectionId">();
export const warmedAccountIdSchema = opaqueId.brand<"WarmedAccountId">();
export const uploadIdSchema = opaqueId.brand<"UploadId">();
export const audioIdSchema = opaqueId.brand<"AudioId">();
export const brandSourceIdSchema = opaqueId.brand<"BrandSourceId">();
export const tiktokSoundIdSchema = opaqueId.brand<"TiktokSoundId">();

/**
 * Id de caja de texto. A diferencia del resto NO es opaco: el PRD fija la forma
 * `slide-0-text-0` como ejemplo de id estable (DATA-009, PRD:2090). Se valida
 * como string no vacío porque el PRD da un ejemplo, no una gramática.
 */
export const textBoxIdSchema = opaqueId.brand<"TextBoxId">();

export type CompanyId = z.infer<typeof companyIdSchema>;
export type ContentId = z.infer<typeof contentIdSchema>;
export type PostId = z.infer<typeof postIdSchema>;
export type MediaId = z.infer<typeof mediaIdSchema>;
export type MediaSetId = z.infer<typeof mediaSetIdSchema>;
export type InfluencerId = z.infer<typeof influencerIdSchema>;
export type AngleId = z.infer<typeof angleIdSchema>;
export type ConnectionId = z.infer<typeof connectionIdSchema>;
export type WarmedAccountId = z.infer<typeof warmedAccountIdSchema>;
export type UploadId = z.infer<typeof uploadIdSchema>;
export type AudioId = z.infer<typeof audioIdSchema>;
export type BrandSourceId = z.infer<typeof brandSourceIdSchema>;
export type TiktokSoundId = z.infer<typeof tiktokSoundIdSchema>;
export type TextBoxId = z.infer<typeof textBoxIdSchema>;

/** Timestamp en milisegundos desde epoch. El PRD usa "ms epoch" en todo DATA-*. */
export const msEpochSchema = z.number().int().nonnegative();
export type MsEpoch = z.infer<typeof msEpochSchema>;
