/**
 * Biblioteca de modelos del dueño — sprint 8 (agente K), `P5-LIBR-001/002`.
 *
 * No es del PRD original: el dueño pidió (2026-09-24) «importar a un modelo y
 * hacer UGC con el modelo… almacenar varios modelos y hacer contenido de forma
 * consistente con ellos para una o más marcas».
 *
 *   GET    /character-models                     la biblioteca (contrato K↔L)
 *   GET    /character-models/setup               ¿Higgsfield? ¿saldo? límites
 *   POST   /character-models                     importar (fotos | Soul ID | influencer)
 *   GET    /character-models/{id}
 *   PATCH  /character-models/{id}                nombre, notas, voz
 *   DELETE /character-models/{id}
 *   PUT    /character-models/{id}/brands         asignar a marcas (lista completa)
 *   GET    /character-models/brands/{brandId}/media      imágenes de una marca
 *   GET    /character-models/{id}/ugc?brandId=           lo generado en esa marca
 *   POST   /character-models/{id}/ugc(/estimate)         imagen del modelo (SOUL V2)
 *   POST   /character-models/{id}/ugc/animate(/estimate) animarla (image-to-video)
 *   POST   /character-models/{id}/ugc/piece              pieza en la Library
 *
 * ## Del dueño, no de la marca
 *
 * Todas ignoran la marca activa (`X-Fastgram-Workspace`), como `/workspaces`.
 * Las que actúan sobre una marca la reciben **explícita** (`brandId`,
 * `fromBrandId`) y la API la valida contra el dueño: una marca ajena es 404.
 *
 * ## `createdAt` en ISO
 *
 * Como `/workspaces` y `genai`: los recursos de uso personal van en ISO.
 */
import { z } from "zod";

import {
  INFLUENCER_AGE_MAX,
  INFLUENCER_AGE_MIN,
  INFLUENCER_REFERENCES_MAX,
  INFLUENCER_REFERENCES_MIN,
  influencerFailureCodeSchema,
  influencerImageRequestSchema,
  influencerVideoRequestSchema,
} from "./influencers.js";
import { TEXT_BOX_MAX_LENGTH } from "./content.js";
import { budgetSummarySchema } from "./genai.js";

// --- Voz --------------------------------------------------------------------

/**
 * Los modelos TTS de fal que se pueden elegir, con las voces que **su
 * esquema OpenAPI** lista como ejemplo (`fal.ai/api/openapi/queue/openapi.json
 * ?endpoint_id=…`, consultado el 2026-09-24). Ninguno de los dos tiene un
 * endpoint de listado de voces: el campo es texto libre y estos son
 * sugerencias, no una lista cerrada. ElevenLabs acepta nombres de voz
 * (`voice`, default `Rachel`); MiniMax, `voice_setting.voice_id` (default
 * `Wise_Woman`).
 */
export const CHARACTER_VOICE_MODELS = [
  {
    model: "fal-ai/elevenlabs/tts/eleven-v3",
    label: "ElevenLabs v3",
    defaultVoice: "Rachel",
    voices: [
      "Rachel",
      "Aria",
      "Roger",
      "Sarah",
      "Laura",
      "Charlie",
      "George",
      "Callum",
      "River",
      "Liam",
      "Charlotte",
      "Alice",
      "Matilda",
      "Will",
      "Jessica",
      "Eric",
      "Chris",
      "Brian",
      "Daniel",
      "Lily",
      "Bill",
    ],
  },
  {
    model: "fal-ai/minimax/speech-02-hd",
    label: "MiniMax Speech-02 HD",
    defaultVoice: "Wise_Woman",
    voices: [
      "Wise_Woman",
      "Friendly_Person",
      "Inspirational_girl",
      "Deep_Voice_Man",
      "Calm_Woman",
      "Casual_Guy",
      "Lively_Girl",
      "Patient_Man",
      "Young_Knight",
      "Determined_Man",
      "Lovely_Girl",
      "Decent_Boy",
      "Imposing_Manner",
      "Elegant_Man",
      "Abbess",
      "Sweet_Girl_2",
      "Exuberant_Girl",
    ],
  },
  {
    model: "fal-ai/minimax/speech-02-turbo",
    label: "MiniMax Speech-02 Turbo",
    defaultVoice: "Wise_Woman",
    voices: [
      "Wise_Woman",
      "Friendly_Person",
      "Deep_Voice_Man",
      "Calm_Woman",
      "Casual_Guy",
      "Lively_Girl",
    ],
  },
] as const;

export const CHARACTER_VOICE_MODEL_IDS = CHARACTER_VOICE_MODELS.map((m) => m.model);

/** Proveedor `fal` y un modelo del catálogo de arriba; la voz es texto libre. */
export const characterModelVoiceSchema = z
  .object({
    provider: z.literal("fal"),
    model: z
      .string()
      .refine((m) => (CHARACTER_VOICE_MODEL_IDS as readonly string[]).includes(m), {
        message: "Pick one of the supported fal TTS models",
      }),
    voiceId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_\- .]+$/, "Letters, numbers, spaces, - and _ only"),
  })
  .strict();
export type CharacterModelVoice = z.infer<typeof characterModelVoiceSchema>;

// --- Recurso ----------------------------------------------------------------

export const characterModelStatusSchema = z.enum(["ready", "training", "failed"]);
export type CharacterModelStatus = z.infer<typeof characterModelStatusSchema>;

export const characterModelSourceSchema = z.enum(["photos", "soul_id", "influencer"]);
export type CharacterModelSource = z.infer<typeof characterModelSourceSchema>;

export const CHARACTER_MODEL_NAME_MAX = 100;
export const CHARACTER_MODEL_NOTES_MAX = 500;
export const CHARACTER_MODEL_STYLE_MAX = 120;
/** Productos que acompañan al modelo en una pieza UGC. */
export const CHARACTER_UGC_PRODUCTS_MAX = 3;

/**
 * Contrato K↔L (addendum del sprint 8): `id`, `name`, `portraitUrl`,
 * `status`, `voice`, `brandIds`. El resto es de la pantalla de Models.
 * `soulId` **no** está: es interno.
 */
export const characterModelSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    /** La imagen de referencia principal, en nuestro storage. */
    portraitUrl: z.string().url(),
    status: characterModelStatusSchema,
    voice: characterModelVoiceSchema.nullable(),
    /** Las marcas donde está asignado (activo). */
    brandIds: z.array(z.string().uuid()),
    progress: z.number().int().min(0).max(100),
    source: characterModelSourceSchema,
    notes: z.string().nullable(),
    age: z.number().int().nullable(),
    style: z.string().nullable(),
    failure: z
      .object({ code: influencerFailureCodeSchema, message: z.string() })
      .strict()
      .nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CharacterModel = z.infer<typeof characterModelSchema>;

export const characterModelListSchema = z.array(characterModelSchema);

export const characterModelListResponseSchema = z.object({
  data: characterModelListSchema,
});
export type CharacterModelListResponse = z.infer<typeof characterModelListResponseSchema>;

/** `GET /character-models/setup`. */
export const characterModelSetupSchema = z.object({
  /** Higgsfield en Settings → Models (tarea de imagen o de video). */
  configured: z.boolean(),
  /** Entrenar desde fotos: Higgsfield y saldo en el mes. */
  canTrain: z.boolean(),
  references: z.object({ min: z.number().int(), max: z.number().int() }),
  budget: budgetSummarySchema,
});
export type CharacterModelSetup = z.infer<typeof characterModelSetupSchema>;

// --- Importar ---------------------------------------------------------------

const traits = {
  notes: z.string().trim().max(CHARACTER_MODEL_NOTES_MAX).optional(),
  age: z.number().int().min(INFLUENCER_AGE_MIN).max(INFLUENCER_AGE_MAX).optional(),
  style: z.string().trim().max(CHARACTER_MODEL_STYLE_MAX).optional(),
};
const modelName = z.string().trim().min(1).max(CHARACTER_MODEL_NAME_MAX);

/**
 * `POST /character-models` (`Idempotency-Key` obligatoria). Tres caminos:
 *
 * - `photos`: 4–20 fotos del Media Bank de `fromBrandId` → se copian a la
 *   biblioteca y se entrena un Soul ID nuevo.
 * - `soul_id`: un Soul ID que ya existe en la cuenta de Higgsfield del dueño
 *   (se valida contra `GET /v1/custom-references/{id}`) + un retrato del
 *   Media Bank de `fromBrandId`.
 * - `influencer`: promover un influencer `ready` de `fromBrandId`; reusa su
 *   Soul ID y queda asignado a esa marca.
 */
export const createCharacterModelRequestSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("photos"),
      name: modelName,
      fromBrandId: z.string().uuid(),
      referenceMediaIds: z
        .array(z.string().uuid())
        .min(INFLUENCER_REFERENCES_MIN)
        .max(INFLUENCER_REFERENCES_MAX)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "referenceMediaIds must be unique",
        }),
      ...traits,
    })
    .strict(),
  z
    .object({
      source: z.literal("soul_id"),
      name: modelName,
      fromBrandId: z.string().uuid(),
      soulId: z.string().uuid(),
      portraitMediaId: z.string().uuid(),
      ...traits,
    })
    .strict(),
  z
    .object({
      source: z.literal("influencer"),
      fromBrandId: z.string().uuid(),
      influencerId: z.string().uuid(),
      /** Sin nombre, el del influencer. */
      name: modelName.optional(),
      ...traits,
    })
    .strict(),
]);
export type CreateCharacterModelRequest = z.infer<
  typeof createCharacterModelRequestSchema
>;

/** `PATCH /character-models/{id}`. `voice: null` = sin voz. */
export const updateCharacterModelRequestSchema = z
  .object({
    name: modelName.optional(),
    notes: z.string().trim().max(CHARACTER_MODEL_NOTES_MAX).nullable().optional(),
    age: z
      .number()
      .int()
      .min(INFLUENCER_AGE_MIN)
      .max(INFLUENCER_AGE_MAX)
      .nullable()
      .optional(),
    style: z.string().trim().max(CHARACTER_MODEL_STYLE_MAX).nullable().optional(),
    voice: characterModelVoiceSchema.nullable().optional(),
  })
  .strict();
export type UpdateCharacterModelRequest = z.infer<
  typeof updateCharacterModelRequestSchema
>;

/** `PUT /character-models/{id}/brands`: la lista completa de marcas asignadas. */
export const setCharacterModelBrandsRequestSchema = z
  .object({
    brandIds: z
      .array(z.string().uuid())
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "brandIds must be unique",
      }),
  })
  .strict();
export type SetCharacterModelBrandsRequest = z.infer<
  typeof setCharacterModelBrandsRequestSchema
>;

// --- UGC --------------------------------------------------------------------

/** Imagen del modelo para una marca: el pedido de SOUL V2 + la marca. */
export const characterUgcImageRequestSchema = influencerImageRequestSchema.extend({
  brandId: z.string().uuid(),
});
export type CharacterUgcImageRequest = z.input<typeof characterUgcImageRequestSchema>;

/** Animar una imagen de la marca: el pedido de «Animate» + la marca. */
export const characterUgcAnimateRequestSchema = influencerVideoRequestSchema.extend({
  brandId: z.string().uuid(),
});
export type CharacterUgcAnimateRequest = z.input<typeof characterUgcAnimateRequestSchema>;

export const characterUgcListQuerySchema = z.object({ brandId: z.string().uuid() });

/**
 * `POST /character-models/{id}/ugc/piece`: la pieza en la Library de la
 * marca, por el mismo camino que «Create New» del Content Studio.
 *
 * - `kind: image` → slideshow: la imagen del modelo y después los productos
 *   (0–3), **un texto por slide**.
 * - `kind: video` → wall of text sobre el video, con un texto.
 *
 * Por qué el producto va aparte y no dentro de la imagen: SOUL V2 no acepta
 * imágenes de referencia además del personaje (`/docs/models/soul-2/generate`,
 * verificado 2026-09-24), así que el modelo no puede «tener» el producto en
 * la foto. Se compone en el slideshow.
 */
export const characterUgcPieceRequestSchema = z
  .object({
    brandId: z.string().uuid(),
    kind: z.enum(["image", "video"]),
    sourceMediaId: z.string().uuid(),
    productMediaIds: z
      .array(z.string().uuid())
      .max(CHARACTER_UGC_PRODUCTS_MAX)
      .default([]),
    texts: z
      .array(z.string().max(TEXT_BOX_MAX_LENGTH))
      .min(1)
      .max(1 + CHARACTER_UGC_PRODUCTS_MAX),
  })
  .strict();
export type CharacterUgcPieceRequest = z.input<typeof characterUgcPieceRequestSchema>;
