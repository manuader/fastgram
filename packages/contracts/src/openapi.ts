/**
 * Generación de OpenAPI a partir de los schemas Zod · ADR-015 (IMPL §3).
 *
 * **Por qué está escrito a mano y no con `zod-to-json-schema`.** El paquete no
 * puede sumar dependencias en esta tarea, y `zod` 3.25 sólo trae
 * `z.toJSONSchema()` bajo el subpath `zod/v4`, que es otra API distinta de la
 * que usan los schemas de este paquete (y el catálogo del workspace declara
 * `zod: ^3.24.1`, rango en el que ese subpath **no** existe). Así que el
 * conversor va acá, cubriendo exactamente los nodos que este contrato usa y
 * fallando ruidosamente ante cualquier otro. Un conversor que cubre lo que hay
 * es más honesto que uno genérico a medio hacer.
 *
 * El conversor describe el **input** del schema (lo que el cliente envía): por
 * eso un `.pipe()` o un `.transform()` se describen por su lado de entrada, que
 * es lo que viaja por el cable.
 */
import { z } from "zod";

import { errorEnvelopeSchema } from "./primitives/errors.js";
import { paginationSchema } from "./primitives/envelope.js";
import {
  cursorQuerySchema,
  numberedPageQuerySchema,
  numberedPaginationSchema,
} from "./primitives/pagination.js";
import { IDEMPOTENCY_KEY_HEADER } from "./primitives/idempotency.js";
import { uploadReservationSchema } from "./primitives/uploads.js";
import * as blitz from "./resources/blitz.js";
import * as angles from "./resources/angles.js";
import * as influencers from "./resources/influencers.js";
import * as media from "./resources/media.js";
import * as content from "./resources/content.js";
import * as posts from "./resources/posts.js";
import * as analytics from "./resources/analytics.js";
import * as connections from "./resources/connections.js";
import * as warmed from "./resources/warmed-accounts.js";
import * as audio from "./resources/audio.js";
import * as sounds from "./resources/tiktok-sounds.js";
import * as brand from "./resources/brand.js";
import * as onboarding from "./resources/onboarding.js";
import * as models from "./resources/models.js";
import * as genai from "./resources/genai.js";
import * as workspaces from "./resources/workspaces.js";
import * as strategy from "./resources/strategy.js";
import * as autopilot from "./resources/autopilot.js";
import * as inspiration from "./resources/inspiration.js";
import * as engagement from "./resources/engagement.js";
import * as automations from "./resources/automations.js";
import * as notifications from "./resources/notifications.js";
import {
  imageUploadReservationRequestSchema,
  mediaUploadReservationRequestSchema,
  videoUploadReservationRequestSchema,
} from "./primitives/uploads.js";

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

export type JsonSchema = {
  type?: string | string[];
  format?: string;
  pattern?: string;
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  description?: string;
  nullable?: boolean;
};

/** Error explícito: es preferible a emitir un `{}` que nadie nota. */
export class UnsupportedZodNodeError extends Error {
  constructor(typeName: string) {
    super(`openapi: unsupported Zod node "${typeName}"`);
    this.name = "UnsupportedZodNodeError";
  }
}

type ZodDef = { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;

// `_def` está tipado como `any` por Zod; el cast lo estrecha a lo que se usa acá
// y evita que ese `any` se propague al resto del archivo.
const defOf = (schema: z.ZodTypeAny): ZodDef => schema._def as ZodDef;

type StringCheck = { kind: string; value?: number; regex?: RegExp };
type NumberCheck = { kind: string; value?: number };

const fromString = (def: ZodDef): JsonSchema => {
  const out: JsonSchema = { type: "string" };
  for (const check of (def["checks"] ?? []) as StringCheck[]) {
    if (check.kind === "min" && check.value !== undefined) out.minLength = check.value;
    if (check.kind === "max" && check.value !== undefined) out.maxLength = check.value;
    if (check.kind === "url") out.format = "uri";
    if (check.kind === "regex" && check.regex !== undefined)
      out.pattern = check.regex.source;
  }
  return out;
};

const fromNumber = (def: ZodDef): JsonSchema => {
  const out: JsonSchema = { type: "number" };
  for (const check of (def["checks"] ?? []) as NumberCheck[]) {
    if (check.kind === "int") out.type = "integer";
    if (check.kind === "min" && check.value !== undefined) out.minimum = check.value;
    if (check.kind === "max" && check.value !== undefined) out.maximum = check.value;
  }
  return out;
};

const fromObject = (def: ZodDef): JsonSchema => {
  const shapeFn = def["shape"] as () => Record<string, z.ZodTypeAny>;
  const shape = shapeFn();
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = toJsonSchema(value);
    if (!value.isOptional()) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties };
  if (required.length > 0) out.required = required;
  if (def["unknownKeys"] === "strict") out.additionalProperties = false;
  return out;
};

/**
 * Convierte un schema Zod a JSON Schema (draft 2020-12, el dialecto de
 * OpenAPI 3.1). Lanza `UnsupportedZodNodeError` ante un nodo no cubierto.
 */
export const toJsonSchema = (schema: z.ZodTypeAny): JsonSchema => {
  const def = defOf(schema);
  const K = z.ZodFirstPartyTypeKind;

  switch (def.typeName) {
    case K.ZodString:
      return fromString(def);
    case K.ZodNumber:
      return fromNumber(def);
    case K.ZodBoolean:
      return { type: "boolean" };
    case K.ZodLiteral:
      return { const: def["value"] };
    case K.ZodEnum:
      return { type: "string", enum: def["values"] as readonly string[] };
    case K.ZodArray: {
      const out: JsonSchema = {
        type: "array",
        items: toJsonSchema(def["type"] as z.ZodTypeAny),
      };
      const min = def["minLength"] as { value: number } | null;
      const max = def["maxLength"] as { value: number } | null;
      if (min !== null && min !== undefined) out.minItems = min.value;
      if (max !== null && max !== undefined) out.maxItems = max.value;
      return out;
    }
    case K.ZodObject:
      return fromObject(def);
    case K.ZodRecord:
      return {
        type: "object",
        additionalProperties: toJsonSchema(def["valueType"] as z.ZodTypeAny),
      };
    case K.ZodUnion:
      return { anyOf: (def["options"] as z.ZodTypeAny[]).map(toJsonSchema) };
    case K.ZodDiscriminatedUnion:
      return { anyOf: (def["options"] as z.ZodTypeAny[]).map(toJsonSchema) };
    case K.ZodOptional:
      return toJsonSchema(def["innerType"] as z.ZodTypeAny);
    case K.ZodNullable: {
      const inner = toJsonSchema(def["innerType"] as z.ZodTypeAny);
      return { anyOf: [inner, { type: "null" }] };
    }
    case K.ZodDefault: {
      const inner = toJsonSchema(def["innerType"] as z.ZodTypeAny);
      const getDefault = def["defaultValue"] as () => unknown;
      return { ...inner, default: getDefault() };
    }
    // refine / superRefine / transform: se describe el lado de entrada.
    case K.ZodEffects:
      return toJsonSchema(def["schema"] as z.ZodTypeAny);
    case K.ZodBranded:
      return toJsonSchema(def["type"] as z.ZodTypeAny);
    case K.ZodPipeline:
      return toJsonSchema(def["in"] as z.ZodTypeAny);
    case K.ZodUnknown:
    case K.ZodAny:
      return {};
    default:
      throw new UnsupportedZodNodeError(String(def.typeName));
  }
};

// ---------------------------------------------------------------------------
// Documento OpenAPI
// ---------------------------------------------------------------------------

type ParameterObject = {
  name: string;
  in: "query" | "path" | "header";
  required: boolean;
  schema: JsonSchema;
};

type OperationObject = {
  operationId: string;
  summary: string;
  parameters?: ParameterObject[];
  requestBody?: { required: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: JsonSchema }> }
  >;
};

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  paths: Record<
    string,
    Partial<Record<"get" | "post" | "put" | "patch" | "delete", OperationObject>>
  >;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, JsonSchema>;
  };
  security: Record<string, string[]>[];
};

const json = (schema: JsonSchema) => ({ "application/json": { schema } });

/** Envelope de éxito `{"data": …}` (§9.3, PRD:2256). */
const dataOf = (schema: JsonSchema): JsonSchema => ({
  type: "object",
  properties: { data: schema },
  required: ["data"],
  additionalProperties: false,
});

/** Envelope paginado `{"data": [...], "pagination": {...}}` (§9.3, PRD:2256). */
const pageOf = (item: JsonSchema): JsonSchema => ({
  type: "object",
  properties: {
    data: { type: "array", items: item },
    pagination: toJsonSchema(paginationSchema),
  },
  required: ["data", "pagination"],
  additionalProperties: false,
});

/**
 * Envelope de la paginación **numerada** (`GET /blitz/angles/page`, §9.10).
 *
 * `pagination` es otro objeto que el del cursor: sin `cursor` y con
 * `page`/`totalPages`. Ver `numberedPaginationSchema`.
 */
const numberedPageOf = (item: JsonSchema): JsonSchema => ({
  type: "object",
  properties: {
    data: { type: "array", items: item },
    pagination: toJsonSchema(numberedPaginationSchema),
  },
  required: ["data", "pagination"],
  additionalProperties: false,
});

const errorResponse = (description: string) => ({
  description,
  content: json(toJsonSchema(errorEnvelopeSchema)),
});

/**
 * Query por cursor como parámetros sueltos. OpenAPI no acepta un objeto en
 * `query`, así que el objeto Zod se desarma en parámetros.
 */
const queryParams = (schema: z.ZodTypeAny): ParameterObject[] => {
  const js = toJsonSchema(schema);
  const required = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {}).map(([name, prop]) => ({
    name,
    in: "query" as const,
    required: required.has(name),
    schema: prop,
  }));
};

const pathParam = (name: string): ParameterObject => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", minLength: 1 },
});

/** §9.3 (PRD:2288) — `Idempotency-Key` obligatoria en los endpoints facturables. */
const idempotencyParam: ParameterObject = {
  name: IDEMPOTENCY_KEY_HEADER,
  in: "header",
  required: true,
  schema: { type: "string", minLength: 1 },
};

/**
 * Construye el documento OpenAPI 3.1 de la API v1 a partir de los schemas Zod.
 * Una sola definición, tres usos: tipos, validación en runtime y este documento
 * (ADR-015).
 */
export const buildOpenApiDocument = (): OpenApiDocument => {
  const contentJs = toJsonSchema(content.contentSchema);
  const postJs = toJsonSchema(posts.postSchema);
  const mediaJs = toJsonSchema(media.mediaSchema);
  const angleJs = toJsonSchema(angles.contentAngleSchema);
  const influencerJs = toJsonSchema(influencers.influencerSchema);
  const reservationJs = toJsonSchema(uploadReservationSchema);

  const ok = (description: string, schema: JsonSchema) => ({
    description,
    content: json(schema),
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "FastGram API",
      version: "1.0.0",
      description:
        "Contrato público v1. Envelopes `{data}` / `{error:{code,message,details}}` y " +
        "paginación por cursor opaco (limit 1–100, default 20). Generado desde " +
        "packages/contracts — no editar a mano.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerApiKey: [] }],
    components: {
      securitySchemes: {
        // FR-180 (PRD:1860): `Authorization: Bearer fsln_live_<32 base62>`.
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "fsln_live_<32 base62>",
        },
      },
      schemas: {
        ErrorEnvelope: toJsonSchema(errorEnvelopeSchema),
        Pagination: toJsonSchema(paginationSchema),
        Content: contentJs,
        Post: postJs,
        Media: mediaJs,
        ContentAngle: angleJs,
        Influencer: influencerJs,
        Connection: toJsonSchema(connections.connectionSchema),
        WarmedAccount: toJsonSchema(warmed.warmedAccountSchema),
        AudioTrack: toJsonSchema(audio.audioTrackSchema),
        TiktokSound: toJsonSchema(sounds.tiktokSoundSchema),
        BlitzPreferences: toJsonSchema(blitz.blitzPreferencesSchema),
        UploadReservation: reservationJs,
        BrandSource: toJsonSchema(brand.brandSourceSchema),
        CompanyProfile: toJsonSchema(brand.companyProfileSchema),
      },
    },
    paths: {
      "/blitz": {
        post: {
          operationId: "runBlitz",
          summary:
            "Saca una sugerencia lista de la discovery queue (o la de `suggestionId`) y lanza su build. No idempotente.",
          requestBody: {
            required: false,
            content: json(toJsonSchema(blitz.runBlitzRequestSchema)),
          },
          responses: {
            "202": ok("Build encolado", dataOf(contentJs)),
            "400": errorResponse("bad_request — contentType o aspectRatio no reconocido"),
            "404": errorResponse(
              "not_found — la discovery queue está vacía, o `suggestionId` no existe en este workspace",
            ),
            "409": errorResponse(
              "company_profile_not_ready / conflict — `suggestionId` ya no está en cola",
            ),
            "422": errorResponse(
              "content_unavailable_for_type — la sugerencia no se puede construir; se descartó sin cobrar",
            ),
            "429": errorResponse(
              "blitz_quota_exceeded / content_quota_exceeded / rate_limited",
            ),
          },
        },
      },
      "/blitz/queue": {
        get: {
          operationId: "listBlitzQueue",
          summary:
            "Sugerencias en cola, en el orden en que POST /blitz las consume. Pide relleno si hay menos de 5. No cobra.",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(blitz.blitzQueueSchema))),
          },
        },
      },
      "/blitz/queue/counts": {
        get: {
          operationId: "countBlitzQueues",
          summary:
            "Tarjetas en cola por marca (brands=current|all, sólo marcas del mismo dueño). No pide relleno ni cobra.",
          parameters: queryParams(blitz.blitzQueueCountsQuerySchema),
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(blitz.blitzQueueCountsSchema))),
            "400": errorResponse("bad_request"),
          },
        },
      },
      "/blitz/queue/{id}/discard": {
        post: {
          operationId: "discardBlitzSuggestion",
          summary: "Descarta una sugerencia en cola sin cobrar y pide relleno.",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Descartada" },
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — la sugerencia ya no está en cola"),
          },
        },
      },
      "/blitz/generate": {
        post: {
          operationId: "generateBlitzFromPrompt",
          summary:
            "Crea sugerencias desde un tema (PU-BLITZ-003): encola un job y devuelve el requestId. Entran primeras en la cola. No cobra. Requiere Idempotency-Key.",
          parameters: [idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(blitz.generateBlitzRequestSchema)),
          },
          responses: {
            "202": ok(
              "Pedido encolado",
              dataOf(toJsonSchema(blitz.generateBlitzAcceptedSchema)),
            ),
            "400": errorResponse("bad_request — prompt, contentType o count inválidos"),
            "409": errorResponse("conflict — Idempotency-Key en uso con otro body"),
            "503": errorResponse("service_unavailable — no hay cola montada"),
          },
        },
      },
      "/blitz/generate/{requestId}": {
        get: {
          operationId: "getBlitzPromptRequest",
          summary:
            "Estado de un pedido de crear desde prompt: queued | running | done | failed, con las sugerencias o el motivo.",
          parameters: [pathParam("requestId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(blitz.blitzPromptRequestSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      // Inspiration de uso personal (FR-040 adaptado, OQ-13): tablero de referencias propio.
      "/inspiration": {
        post: {
          operationId: "createInspiration",
          summary:
            "Guarda una referencia por link (TikTok/IG/X/YouTube, o cualquier sitio que lea yt-dlp) o un clip subido (mediaId). La metadata sin login se lee en el worker. Idempotency-Key opcional.",
          parameters: [{ ...idempotencyParam, required: false }],
          requestBody: {
            required: true,
            content: json(toJsonSchema(inspiration.createInspirationRequestSchema)),
          },
          responses: {
            "201": ok(
              "Referencia guardada (ingestState pending si hay link)",
              dataOf(toJsonSchema(inspiration.inspirationItemSchema)),
            ),
            "400": errorResponse(
              "bad_request — url o mediaId (uno solo); details.reason = unsupported_url",
            ),
            "404": errorResponse("not_found — el mediaId no es de este workspace"),
            "409": errorResponse("conflict — misma Idempotency-Key con otro body"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
        get: {
          operationId: "listInspiration",
          summary:
            "El tablero de la marca: búsqueda, filtro por formato y etiqueta, paginado",
          parameters: queryParams(inspiration.listInspirationQuerySchema),
          responses: {
            "200": ok(
              "OK",
              numberedPageOf(toJsonSchema(inspiration.inspirationItemSchema)),
            ),
          },
        },
      },
      "/inspiration/tags": {
        get: {
          operationId: "listInspirationTags",
          summary: "Las etiquetas en uso en el tablero de la marca",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(inspiration.inspirationTagsSchema))),
          },
        },
      },
      "/inspiration/{itemId}": {
        get: {
          operationId: "getInspiration",
          summary: "Una referencia",
          parameters: [pathParam("itemId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(inspiration.inspirationItemSchema))),
            "404": errorResponse("not_found"),
          },
        },
        patch: {
          operationId: "updateInspiration",
          summary: "Reemplaza las etiquetas de la referencia",
          parameters: [pathParam("itemId")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(inspiration.updateInspirationRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(inspiration.inspirationItemSchema))),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          operationId: "deleteInspiration",
          summary:
            "Borra la referencia (las piezas remixadas conservan su link de origen)",
          parameters: [pathParam("itemId")],
          responses: {
            "204": { description: "Borrada" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/inspiration/{itemId}/remix": {
        post: {
          operationId: "remixInspiration",
          summary:
            "Remix this: genera sugerencias de Blitz inspiradas en la referencia, adaptadas a la marca activa. Mismo pipeline y respuesta que POST /blitz/generate; el estado se consulta en /blitz/generate/{requestId}. Idempotency-Key opcional.",
          parameters: [pathParam("itemId"), { ...idempotencyParam, required: false }],
          requestBody: {
            required: false,
            content: json(toJsonSchema(inspiration.remixInspirationRequestSchema)),
          },
          responses: {
            "202": ok(
              "Pedido encolado",
              dataOf(toJsonSchema(blitz.generateBlitzAcceptedSchema)),
            ),
            "400": errorResponse("bad_request"),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — misma Idempotency-Key con otro body"),
            "503": errorResponse("service_unavailable — no hay cola montada"),
          },
        },
      },
      // Automations (FR-150, MOD-015): campañas multi-semana con revisión antes de publicar.
      "/automations": {
        get: {
          operationId: "listAutomations",
          summary:
            "Las campañas de la marca, más nuevas primero, con progreso por estado de slot",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(automations.automationListSchema))),
          },
        },
        post: {
          operationId: "createAutomation",
          summary:
            "Crea una campaña DRAFT (F-210/F-211). prefsSnapshot = preferencias de Blitz de la marca + overrides, congeladas (F-212).",
          requestBody: {
            required: true,
            content: json(toJsonSchema(automations.createAutomationRequestSchema)),
          },
          responses: {
            "201": ok("Creada", dataOf(toJsonSchema(automations.automationSchema))),
            "400": errorResponse(
              "bad_request — rangos, una cuenta por red, conexión ajena o de otra red",
            ),
          },
        },
      },
      "/automations/{automationId}": {
        get: {
          operationId: "getAutomation",
          summary: "Una campaña con progreso y totales de sus posts (F-218)",
          parameters: [pathParam("automationId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(automations.automationSchema))),
            "404": errorResponse("not_found"),
          },
        },
        patch: {
          operationId: "updateAutomation",
          summary:
            "Renombra en cualquier estado; el resto de la configuración sólo en DRAFT (409 si no)",
          parameters: [pathParam("automationId")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(automations.updateAutomationRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(automations.automationSchema))),
            "400": errorResponse("bad_request"),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — la configuración se bloquea al generar"),
          },
        },
        delete: {
          operationId: "deleteAutomation",
          summary: "Borra una campaña que no esté BUILDING ni ACTIVE (F-219)",
          parameters: [pathParam("automationId")],
          responses: {
            "204": { description: "Borrada" },
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — está BUILDING o ACTIVE: cancelala primero"),
          },
        },
      },
      "/automations/{automationId}/generate": {
        post: {
          operationId: "generateAutomation",
          summary:
            "DRAFT → GENERATING: crea los slots y encola la generación (F-213). 422 AUTOMATION_NO_CONTENT_TYPE_SELECTED / AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO; 400 con details.reason para YouTube con slideshow, sin destinos o tipo sin media.",
          parameters: [pathParam("automationId")],
          responses: {
            "202": ok("Generando", dataOf(toJsonSchema(automations.automationSchema))),
            "400": errorResponse(
              "bad_request — details.reason: AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW | AUTOMATION_NO_DESTINATIONS | AUTOMATION_CONTENT_TYPE_NEEDS_MEDIA",
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — no está en DRAFT"),
            "422": errorResponse(
              "AUTOMATION_NO_CONTENT_TYPE_SELECTED | AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO",
            ),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/automations/{automationId}/slots": {
        get: {
          operationId: "listAutomationSlots",
          summary: "Los slots de la campaña en orden de hora, con sus posts",
          parameters: [pathParam("automationId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(automations.automationSlotListSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/automations/{automationId}/slots/{slotId}": {
        patch: {
          operationId: "updateAutomationSlot",
          summary:
            "Edita un slot READY en REVIEW (F-214): texts (+ generatedText), captionsByPlatform (reemplaza el mapa), scheduledAt",
          parameters: [pathParam("automationId"), pathParam("slotId")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(automations.updateAutomationSlotRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(automations.automationSlotSchema))),
            "400": errorResponse("bad_request"),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "conflict — la campaña no está en REVIEW o el slot no está READY",
            ),
          },
        },
        delete: {
          operationId: "removeAutomationSlot",
          summary: "Remove suggestion: el slot queda CANCELLED (Won't post)",
          parameters: [pathParam("automationId"), pathParam("slotId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(automations.automationSlotSchema))),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict"),
          },
        },
      },
      "/automations/{automationId}/slots/{slotId}/reroll": {
        post: {
          operationId: "rerollAutomationSlot",
          summary:
            "Re-roll this suggestion (F-215): descarta la sugerencia (irrecuperable), consume cuota de la campaña y regenera. contentType opcional (nunca uno con peso 0, ni slideshow con YouTube).",
          parameters: [pathParam("automationId"), pathParam("slotId")],
          requestBody: {
            required: false,
            content: json(toJsonSchema(automations.rerollAutomationSlotRequestSchema)),
          },
          responses: {
            "202": ok(
              "Regenerando",
              dataOf(toJsonSchema(automations.automationSlotSchema)),
            ),
            "400": errorResponse(
              "bad_request — details.reason: excluded_type | youtube_slideshow",
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — cuota de la campaña agotada, o estado"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/automations/{automationId}/slots/{slotId}/content": {
        post: {
          operationId: "materializeAutomationSlotContent",
          summary:
            "Edit post en el editor: crea (una vez) la pieza del slot en BUILDING y devuelve su contentId para /library/{id}/edit. El launch la reusa.",
          parameters: [pathParam("automationId"), pathParam("slotId")],
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(automations.automationSlotContentSchema)),
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "conflict — el slot no está READY o la campaña no está en REVIEW",
            ),
            "429": errorResponse("content_quota_exceeded — fuera del modo personal"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/automations/{automationId}/launch-validation": {
        get: {
          operationId: "getAutomationLaunchValidation",
          summary:
            "launchValidation (F-216): todos los gates incumplidos. Se guarda en la campaña.",
          parameters: [pathParam("automationId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(automations.launchValidationSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/automations/{automationId}/launch": {
        post: {
          operationId: "launchAutomation",
          summary:
            "Launch (F-217): revalida, registra los saves, crea una pieza por slot READY, reserva un slot planificado por destino y arranca los builds. No reversible.",
          parameters: [pathParam("automationId")],
          responses: {
            "200": ok("Lanzada", dataOf(toJsonSchema(automations.automationSchema))),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — details.gates con los gates incumplidos"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/automations/{automationId}/cancel": {
        post: {
          operationId: "cancelAutomation",
          summary:
            "Cancel automation (F-219): revoca los posts programados, borra los slots planificados, lo restante queda CANCELLED. Lo publicado sigue vivo. Irreversible.",
          parameters: [pathParam("automationId")],
          responses: {
            "200": ok("Cancelada", dataOf(toJsonSchema(automations.automationSchema))),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — DRAFT o ya terminada"),
          },
        },
      },
      "/blitz/preferences": {
        get: {
          operationId: "getBlitzPreferences",
          summary: "Preferencias del motor de generación",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(blitz.blitzPreferencesSchema))),
          },
        },
        patch: {
          operationId: "updateBlitzPreferences",
          summary:
            "Actualiza preferencias. 3 req/min. Sólo afecta a generaciones futuras.",
          requestBody: {
            required: true,
            content: json(toJsonSchema(blitz.updateBlitzPreferencesRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(blitz.blitzPreferencesSchema))),
            "400": errorResponse(
              "bad_request — body vacío, set parcial de pesos o settingsApplication",
            ),
            "429": errorResponse("rate_limited"),
          },
        },
      },
      "/blitz/angles": {
        get: {
          operationId: "listBlitzAngles",
          summary: "Lista de content angles",
          parameters: queryParams(cursorQuerySchema),
          responses: { "200": ok("OK", pageOf(angleJs)) },
        },
        post: {
          operationId: "createBlitzAngle",
          summary:
            "Crea un content angle y reconcilia angleWeights en la misma transacción",
          requestBody: {
            required: true,
            content: json(toJsonSchema(angles.createContentAngleRequestSchema)),
          },
          responses: {
            "201": ok("Creado", dataOf(angleJs)),
            "400": errorResponse(
              "bad_request — MAX_ANGLES_EXCEEDED / MAX_ANGLES_PER_INFLUENCER_EXCEEDED",
            ),
          },
        },
      },
      /**
       * **Este path faltaba**, y lo encontró `apps/api/test/openapi-routes.test.ts`
       * en su primera corrida: la ruta existe desde que se escribieron los
       * ángulos, §9.3 la lista, y el documento no la nombraba. El test anterior
       * sólo comprobaba que estuvieran 27 paths de una lista escrita a mano, así
       * que un path **de menos** era invisible — igual que los cinco de `/brand`
       * eran invisibles de más.
       *
       * Es la única ruta con paginación **numerada** (§9.10, `Page X of Y`).
       */
      "/blitz/angles/page": {
        get: {
          operationId: "listBlitzAnglesByPage",
          summary: "Content angles por página numerada (Page X of Y) · §9.10",
          parameters: queryParams(numberedPageQuerySchema),
          responses: {
            "200": ok("OK", numberedPageOf(angleJs)),
          },
        },
      },
      "/blitz/angles/{id}": {
        patch: {
          operationId: "updateBlitzAngle",
          summary: "Edita un content angle. Desactivar borra sus enlaces de influencer.",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(angles.updateContentAngleRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(angleJs)),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          operationId: "deleteBlitzAngle",
          summary: "Soft-delete (desactivación) reversible por PATCH",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Borrado" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/blitz/angles/generate": {
        post: {
          operationId: "generateBlitzAngle",
          summary: "Genera un ángulo sin persistirlo. 5 exitosos/min. No idempotente.",
          requestBody: {
            required: true,
            content: json(toJsonSchema(angles.generateContentAngleRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(angles.generatedContentAngleSchema))),
            "429": errorResponse("rate_limited"),
          },
        },
      },
      "/influencers": {
        get: {
          operationId: "listInfluencers",
          summary: "Influencers activos y entrenados",
          parameters: queryParams(cursorQuerySchema),
          responses: { "200": ok("OK", pageOf(influencerJs)) },
        },
        post: {
          operationId: "createInfluencer",
          summary:
            "Crea el personaje (con fotos de referencia: Soul ID de Higgsfield). Requiere Idempotency-Key.",
          parameters: [idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.createInfluencerRequestSchema)),
          },
          responses: {
            "202": ok("Pipeline encolado", dataOf(influencerJs)),
            "402": errorResponse(
              "payment_required — cap de 50, créditos, storage o tope mensual agotado",
            ),
            "409": errorResponse(
              "conflict — upload no alcanzable, idempotency key en uso o sin Higgsfield",
            ),
          },
        },
      },
      "/influencers/{id}": {
        get: {
          operationId: "getInfluencer",
          summary: "Estado y progress del influencer",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(influencerJs)),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/influencers/setup": {
        get: {
          operationId: "getInfluencerSetup",
          summary:
            "PU-LATER-004: si se puede crear un personaje (Higgsfield configurado, saldo del mes)",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(influencers.influencerSetupSchema))),
          },
        },
      },
      "/influencers/{id}/images/estimate": {
        post: {
          operationId: "estimateInfluencerImages",
          summary: "Costo estimado de imágenes del personaje (estimador de Higgsfield)",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.influencerImageRequestSchema)),
          },
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(influencers.influencerImageEstimateSchema)),
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "conflict — el personaje no está listo o sin Higgsfield",
            ),
          },
        },
      },
      "/influencers/{id}/images": {
        post: {
          operationId: "generateInfluencerImages",
          summary:
            "Estima, reserva en el tope mensual y encola imágenes del personaje (202)",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.influencerImageRequestSchema)),
          },
          responses: {
            "202": ok(
              "Accepted",
              dataOf(toJsonSchema(influencers.influencerGenerationSchema)),
            ),
            "402": errorResponse("payment_required — details.reason = budget_exceeded"),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "conflict — el personaje no está listo o sin Higgsfield",
            ),
            "503": errorResponse("service_unavailable — sin cola o proveedor caído"),
          },
        },
      },
      "/influencers/{id}/generations": {
        get: {
          operationId: "listInfluencerGenerations",
          summary: "Pedidos de imágenes del personaje, más nuevos primero",
          parameters: [pathParam("id")],
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(influencers.influencerGenerationListSchema)),
            ),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/influencers/base-image/upload-url": {
        post: {
          operationId: "reserveInfluencerBaseImageUpload",
          summary: "Reserva de subida de la base image (≤10 MB)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(imageUploadReservationRequestSchema)),
          },
          responses: { "200": ok("Reserva creada", dataOf(reservationJs)) },
        },
      },
      "/connections": {
        get: {
          operationId: "listConnections",
          summary: "Conexiones OAuth del workspace",
          responses: {
            "200": ok(
              "OK",
              dataOf({
                type: "array",
                items: toJsonSchema(connections.connectionSchema),
              }),
            ),
          },
        },
      },
      /**
       * OAuth por marca y credenciales de las apps — `PU-PUB-001`, `PU-PUB-002`,
       * `P3-OAUTH-002`. Fuera de la §9.3 del PRD (uso personal). Ninguna
       * respuesta lleva un token ni un secret; los errores llevan el motivo en
       * `details.reason` (ver `resources/connections.ts`).
       */
      "/integrations": {
        get: {
          operationId: "getIntegrations",
          summary: "Apps de desarrollador por plataforma (sin secrets) y redirect URIs",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(connections.integrationsOverviewSchema))),
          },
        },
      },
      "/integrations/{platform}": {
        put: {
          operationId: "updateIntegration",
          summary: "Guarda client id y (opcional) secret de la app de una plataforma",
          parameters: [pathParam("platform")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(connections.updateIntegrationRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(connections.integrationAppSchema))),
            "400": errorResponse("bad_request — con details.field"),
            "404": errorResponse("not_found — plataforma sin OAuth"),
          },
        },
        delete: {
          operationId: "deleteIntegration",
          summary: "Borra las credenciales de la app de una plataforma",
          parameters: [pathParam("platform")],
          responses: {
            "204": { description: "Borradas" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/connections/accounts": {
        get: {
          operationId: "listConnectionAccounts",
          summary: "Cuentas conectadas de la marca, con avatar y estado (sin tokens)",
          responses: {
            "200": ok(
              "OK",
              dataOf({
                type: "array",
                items: toJsonSchema(connections.connectionAccountSchema),
              }),
            ),
          },
        },
      },
      "/connections/{platform}/authorize": {
        get: {
          operationId: "authorizeConnection",
          summary:
            "URL de autorización de la plataforma con `state` firmado (marca + nonce + vencimiento)",
          parameters: [pathParam("platform")],
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(connections.authorizeConnectionResponseSchema)),
            ),
            "404": errorResponse("not_found — plataforma sin OAuth"),
            "409": errorResponse(
              "conflict — integration_not_configured | https_redirect_required",
            ),
          },
        },
      },
      "/connections/{platform}/callback": {
        post: {
          operationId: "completeConnection",
          summary:
            "Intercambia el code (lo llama la ruta de callback de la web) y crea/actualiza la conexión de la marca",
          parameters: [pathParam("platform")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(connections.connectionCallbackRequestSchema)),
          },
          responses: {
            "200": ok(
              "Conectada, o Páginas de Facebook para elegir",
              dataOf(toJsonSchema(connections.connectionCallbackResultSchema)),
            ),
            "400": errorResponse(
              "bad_request — oauth_state_invalid | oauth_state_wrong_brand | oauth_denied | oauth_exchange_failed | no_pages",
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — integration_not_configured"),
            "503": errorResponse("service_unavailable — oauth_provider_unavailable"),
          },
        },
      },
      "/connections/facebook/pages/{selectionId}": {
        get: {
          operationId: "getFacebookPageSelection",
          summary: "Páginas de Facebook ofrecidas tras el login, para elegir una",
          parameters: [pathParam("selectionId")],
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(connections.facebookPageSelectionSchema)),
            ),
            "404": errorResponse("not_found — selection_expired"),
          },
        },
      },
      "/connections/facebook/pages": {
        post: {
          operationId: "selectFacebookPage",
          summary: "Conecta la Página elegida",
          requestBody: {
            required: true,
            content: json(toJsonSchema(connections.selectFacebookPageRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(connections.connectionAccountSchema))),
            "404": errorResponse("not_found — selection_expired o Página desconocida"),
          },
        },
      },
      /** LinkedIn (`PU-LATER-002`): perfil y Páginas que administra, para elegir. */
      "/connections/linkedin/pages/{selectionId}": {
        get: {
          operationId: "getLinkedInPageSelection",
          summary:
            "Perfil y Páginas de LinkedIn ofrecidos tras el login, para elegir uno",
          parameters: [pathParam("selectionId")],
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(connections.facebookPageSelectionSchema)),
            ),
            "404": errorResponse("not_found — selection_expired"),
          },
        },
      },
      "/connections/linkedin/pages": {
        post: {
          operationId: "selectLinkedInPage",
          summary: "Conecta el perfil o la Página de LinkedIn elegida",
          requestBody: {
            required: true,
            content: json(toJsonSchema(connections.selectFacebookPageRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(connections.connectionAccountSchema))),
            "404": errorResponse("not_found — selection_expired o cuenta desconocida"),
          },
        },
      },
      "/connections/accounts/{connectionId}/refresh": {
        post: {
          operationId: "refreshConnection",
          summary:
            "Refresca el token ya; si la plataforma lo rechaza, la conexión queda `expired`",
          parameters: [pathParam("connectionId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(connections.connectionAccountSchema))),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "conflict — connection_expired | connection_inactive | integration_not_configured",
            ),
            "503": errorResponse("service_unavailable — oauth_provider_unavailable"),
          },
        },
      },
      "/connections/accounts/{connectionId}": {
        delete: {
          operationId: "disconnectConnection",
          summary: "Desconecta: `revoked` y sin tokens (la fila queda por los posts)",
          parameters: [pathParam("connectionId")],
          responses: {
            "204": { description: "Desconectada" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/warmed-accounts": {
        get: {
          operationId: "listWarmedAccounts",
          summary: "Cuentas warmed (máx. 100 visibles, sin cursor)",
          responses: {
            "200": ok("OK", toJsonSchema(warmed.listWarmedAccountsResponseSchema)),
          },
        },
      },
      "/tiktok/sounds": {
        get: {
          operationId: "listTiktokSounds",
          summary: "Sonidos comerciales de TikTok para una cuenta warmed",
          parameters: queryParams(sounds.listTiktokSoundsQuerySchema),
          responses: {
            "200": ok(
              "OK",
              dataOf({ type: "array", items: toJsonSchema(sounds.tiktokSoundSchema) }),
            ),
          },
        },
      },
      "/audio": {
        get: {
          operationId: "listAudio",
          summary: "Catálogo de audio compartido, curado por tipo de contenido",
          parameters: queryParams(audio.listAudioQuerySchema),
          responses: { "200": ok("OK", pageOf(toJsonSchema(audio.audioTrackSchema))) },
        },
      },
      // Sprint 7: la biblioteca de audio de la marca (migración 0025).
      "/audio/library": {
        get: {
          operationId: "listBrandAudio",
          summary:
            "La biblioteca de audio de la marca, más nuevas primero; q busca en el título",
          parameters: queryParams(audio.listBrandAudioQuerySchema),
          responses: {
            "200": ok("OK", pageOf(toJsonSchema(audio.brandAudioTrackSchema))),
          },
        },
        post: {
          operationId: "finalizeBrandAudio",
          summary: "Finaliza la subida de audio y crea la pista en la biblioteca",
          requestBody: {
            required: true,
            content: json(toJsonSchema(audio.finalizeBrandAudioRequestSchema)),
          },
          responses: {
            "201": ok("Creada", dataOf(toJsonSchema(audio.brandAudioTrackSchema))),
            "404": errorResponse(
              "not_found — la reserva no existe o es de otro workspace",
            ),
            "409": errorResponse("conflict — el objeto no llegó o ya se finalizó"),
            "410": errorResponse("gone — reserva expirada"),
          },
        },
      },
      "/audio/library/upload-url": {
        post: {
          operationId: "reserveBrandAudioUpload",
          summary: "Reserva de subida de audio (MP3/M4A/AAC/WAV, ≤20 MB)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(audio.brandAudioUploadRequestSchema)),
          },
          responses: { "200": ok("Reserva creada", dataOf(reservationJs)) },
        },
      },
      "/audio/library/{audioId}": {
        patch: {
          operationId: "updateBrandAudio",
          summary: "Renombra la pista o la saca del sorteo de Blitz (autoUse)",
          parameters: [pathParam("audioId")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(audio.updateBrandAudioRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(audio.brandAudioTrackSchema))),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          operationId: "deleteBrandAudio",
          summary:
            "Borra la pista de la biblioteca (el archivo queda: las piezas que ya la usan se siguen pudiendo renderizar)",
          parameters: [pathParam("audioId")],
          responses: {
            "204": { description: "Borrada" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/media/upload-url": {
        post: {
          operationId: "reserveMediaUpload",
          summary: "Reserva de subida al Media Bank (imagen ≤10 MB, video ≤50 MB)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(mediaUploadReservationRequestSchema)),
          },
          responses: {
            "200": ok("Reserva creada", dataOf(reservationJs)),
            "409": errorResponse("conflict"),
            "410": errorResponse("gone — reserva expirada"),
          },
        },
      },
      "/media": {
        post: {
          operationId: "finalizeMedia",
          summary: "Finaliza la subida y crea el asset",
          requestBody: {
            required: true,
            content: json(toJsonSchema(media.finalizeMediaRequestSchema)),
          },
          /*
           * Las respuestas de error son las que `apps/api/src/routes/v1/media.ts`
           * devuelve de verdad. Hasta el 2026-09-23 sólo estaba el `201`, y
           * un SDK generado desde acá trataba el 410 de una reserva vencida
           * —que el cliente **tiene** que distinguir para pedir otra— como
           * error desconocido. `media.test.ts` de `apps/api` ata esta lista al
           * tipo `UploadRejection`: un status nuevo allá no compila sin
           * declararlo acá.
           */
          responses: {
            "201": ok("Creado", dataOf(mediaJs)),
            "404": errorResponse(
              "not_found — la reserva no existe o es de otro workspace (§9.2)",
            ),
            "409": errorResponse(
              "conflict — la reserva ya se finalizó, o el objeto todavía no está en " +
                "el storage (terminar el PUT y reintentar la misma reserva)",
            ),
            "410": errorResponse("gone — reserva expirada; hay que pedir otra"),
            "429": errorResponse("rate_limited"),
            "503": errorResponse(
              "service_unavailable — un video sin cola de `media-normalization` " +
                "no se crea; la reserva queda intacta y reintentable",
            ),
          },
        },
        get: {
          operationId: "listMedia",
          summary: "Media Bank del workspace",
          parameters: queryParams(media.listMediaQuerySchema),
          responses: { "200": ok("OK", pageOf(mediaJs)) },
        },
      },
      // Sprint 7 (F): etiquetas, Media Sets e importación de posts propios.
      "/media/tags": {
        get: {
          operationId: "listMediaTags",
          summary: "Etiquetas en uso en el Media Bank, con su cuenta (P2-MEDIA-007)",
          responses: { "200": ok("OK", dataOf({ type: "array" })) },
        },
      },
      "/media/sets": {
        get: {
          operationId: "listMediaSets",
          summary: "Media Sets de la marca (DATA-011, F-127)",
          responses: {
            "200": ok(
              "OK",
              dataOf({ type: "array", items: toJsonSchema(media.mediaSetSchema) }),
            ),
          },
        },
        post: {
          operationId: "createMediaSet",
          summary: "Crea un set con al menos 5 assets vivos de la marca",
          requestBody: {
            required: true,
            content: json(toJsonSchema(media.createMediaSetRequestSchema)),
          },
          responses: {
            "201": ok("Creado", dataOf(toJsonSchema(media.mediaSetSchema))),
            "400": errorResponse("bad_request — details.missingMediaIds"),
          },
        },
      },
      "/media/sets/{id}": {
        delete: {
          operationId: "deleteMediaSet",
          summary: "Borra el set (no toca los assets)",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Borrado" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/media/own-posts/import": {
        post: {
          operationId: "importOwnPosts",
          summary:
            "Importa los posts propios al Media Bank (FR-011.5.1, opt-in): cuenta conectada " +
            "(Instagram, YouTube) o link de perfil público (TikTok, YouTube). Asíncrono.",
          requestBody: {
            required: true,
            content: json(toJsonSchema(media.ownPostImportRequestSchema)),
          },
          responses: {
            "202": ok("Encolado", dataOf(toJsonSchema(media.ownPostImportSchema))),
            "400": errorResponse(
              "bad_request — details.reason = unsupported_url | unsupported_platform | connection_unavailable",
            ),
            "404": errorResponse("not_found — la conexión no existe o es de otra marca"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/media/own-posts/imports": {
        get: {
          operationId: "listOwnPostImports",
          summary: "Los últimos imports de posts propios",
          responses: {
            "200": ok(
              "OK",
              dataOf({ type: "array", items: toJsonSchema(media.ownPostImportSchema) }),
            ),
          },
        },
      },
      "/media/own-posts/import/{id}": {
        get: {
          operationId: "getOwnPostImport",
          summary: "Estado de un import de posts propios",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(media.ownPostImportSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/media/brand-kit": {
        post: {
          operationId: "generateBrandKit",
          summary:
            "Encola fondos de marca generados localmente (PU-MEDIA-002). Idempotency-Key opcional.",
          parameters: [{ ...idempotencyParam, required: false }],
          requestBody: {
            required: false,
            content: json(toJsonSchema(media.brandKitRequestSchema)),
          },
          responses: {
            "202": ok(
              "Generación encolada",
              dataOf(toJsonSchema(media.brandKitJobSchema)),
            ),
            "400": errorResponse("bad_request"),
            "409": errorResponse("conflict — misma Idempotency-Key con otro body"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/media/import": {
        post: {
          operationId: "importMedia",
          summary:
            "Importa un video o audio por link con yt-dlp (PU-MEME-001). Asíncrono: " +
            "el estado se consulta en /media/import/{id}. Idempotency-Key opcional.",
          parameters: [{ ...idempotencyParam, required: false }],
          requestBody: {
            required: true,
            content: json(toJsonSchema(media.mediaImportRequestSchema)),
          },
          responses: {
            "202": ok("Import encolado", dataOf(toJsonSchema(media.mediaImportSchema))),
            "400": errorResponse("bad_request — details.reason = unsupported_url"),
            "409": errorResponse("conflict — misma Idempotency-Key con otro body"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/media/import/{id}": {
        get: {
          operationId: "getMediaImport",
          summary: "Estado de un import por link (queued, downloading, imported, failed)",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(media.mediaImportSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/media/meta": {
        get: {
          operationId: "getMediaMeta",
          summary:
            "Origen, etiquetas y recorte de los clips importados (PU-MEME-003); ids separados por coma",
          parameters: queryParams(media.mediaMetaQuerySchema),
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(media.mediaMetaListSchema))),
            "400": errorResponse("bad_request"),
          },
        },
      },
      "/media/{id}": {
        get: {
          operationId: "getMedia",
          summary: "Un asset del Media Bank",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(mediaJs)),
            "404": errorResponse("not_found"),
          },
        },
        patch: {
          operationId: "updateMedia",
          summary: "Reemplaza por completo las categorías del asset",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(media.updateMediaRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(mediaJs)),
            "404": errorResponse("not_found"),
          },
        },
        /**
         * `P2-MEDIA-004` (sprint 7): el `409 media_in_use` de `FR-100` vuelve
         * **con** la ruta. "En uso" está definido en
         * `packages/db/src/repositories/media-usage.ts` (pieza no borrada,
         * personaje activo o media set). Un id ajeno o inexistente sigue
         * siendo `204` (§9.2: no revela existencia); el `409` sólo sale para
         * una media propia y viva, así que tampoco revela nada ajeno.
         */
        delete: {
          operationId: "deleteMedia",
          summary:
            "Borrado idempotente: 204 también para un id ajeno o inexistente; 409 si sigue en uso",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Borrado" },
            "409": errorResponse("media_in_use"),
          },
        },
      },
      "/content": {
        post: {
          operationId: "createContent",
          summary: "Crea contenido desde un payload de build. Requiere Idempotency-Key.",
          parameters: [idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(content.createContentRequestSchema)),
          },
          responses: {
            "202": ok("Build encolado", dataOf(contentJs)),
            "400": errorResponse("bad_request — URL de media ajena al workspace"),
            "409": errorResponse("conflict — misma key con body distinto"),
            "429": errorResponse("content_quota_exceeded / rate_limited"),
          },
        },
        get: {
          operationId: "listContent",
          summary: "Contenido del workspace, newest first",
          parameters: queryParams(content.listContentQuerySchema),
          responses: { "200": ok("OK", pageOf(contentJs)) },
        },
      },
      "/content/{id}": {
        get: {
          operationId: "getContent",
          summary: "Estado del contenido (polling ~10 s durante el build)",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(contentJs)),
            "404": errorResponse("not_found"),
          },
        },
        patch: {
          operationId: "updateContent",
          summary:
            "Edición menor con concurrencia optimista: cajas de texto y, opcionalmente, swap de media (`assets`). Requiere Idempotency-Key.",
          parameters: [pathParam("id"), idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(content.updateContentRequestSchema)),
          },
          responses: {
            "202": ok("Rebuild encolado", dataOf(contentJs)),
            "400": errorResponse(
              "bad_request: caja o slot de media inexistente, o URL fuera del Media Bank / catálogo de audio",
            ),
            "409": errorResponse(
              "stale_revision / content_edit_in_progress / content_has_linked_posts / unsupported_content_state",
            ),
            "422": errorResponse("content_not_editable"),
          },
        },
        delete: {
          operationId: "deleteContent",
          summary: "Soft-delete; no devuelve el content save",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Borrado" },
            "409": errorResponse("content_still_building / content_has_linked_posts"),
          },
        },
      },
      "/content/{id}/editable": {
        get: {
          operationId: "getEditableContent",
          summary:
            "Representación editable: canvas, cajas de texto y media vigente (`assets`)",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(content.editableContentSchema))),
            "422": errorResponse("content_not_editable"),
          },
        },
      },
      "/content/{id}/regenerate": {
        post: {
          operationId: "regenerateContent",
          summary:
            "Reescribe toda la copy preservando media y layout. Requiere Idempotency-Key.",
          parameters: [pathParam("id"), idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(content.regenerateContentRequestSchema)),
          },
          responses: {
            "202": ok("Rebuild encolado", dataOf(contentJs)),
            "402": errorResponse("payment_required"),
            "429": errorResponse("rate_limited"),
          },
        },
      },
      "/content/{id}/schedule": {
        post: {
          operationId: "scheduleContent",
          summary: "Crea un Post por cada (contenido × plataforma × cuenta)",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(posts.scheduleContentRequestSchema)),
          },
          responses: {
            "201": ok("Programado", dataOf({ type: "array", items: postJs })),
            "400": errorResponse(
              "connection_ambiguous / posting_mode_not_supported_for_platform / privacy_level_required / invalid_privacy_level / caption de x > 280, threads > 500 o facebook > 2200 (por code point)",
            ),
            "402": errorResponse("payment_required — autoCaptions o post slots warmed"),
            "403": errorResponse("forbidden — falta tiktokDirect o warmed posting"),
            "409": errorResponse("conflict — cuenta warmed no postable"),
            "429": errorResponse(
              "tiktok_post_limit_exceeded / youtube_post_limit_exceeded / instagram_post_limit_exceeded",
            ),
            "503": errorResponse("tiktok_creator_info_unavailable"),
          },
        },
      },
      "/content/studio": {
        post: {
          operationId: "createStudioContent",
          summary:
            "Content Studio · Create New: el servidor arma el payload de FR-070 desde ids " +
            "del Media Bank, textos y estilo; con `ai`, el texto lo escribe el modelo de la " +
            "tarea text antes del render.",
          parameters: [idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(content.studioContentRequestSchema)),
          },
          responses: {
            "201": ok("Creado (BUILDING)", dataOf(contentJs)),
            "400": errorResponse("bad_request — details.mediaIds"),
            "402": errorResponse("content_quota_exceeded"),
            "503": errorResponse("service_unavailable — la API no tiene cola"),
          },
        },
      },
      "/content/custom/video/upload-url": {
        post: {
          operationId: "reserveCustomVideoUpload",
          summary: "Reserva de subida de video propio (≤50 MB, MP4/MOV)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(videoUploadReservationRequestSchema)),
          },
          responses: { "200": ok("Reserva creada", dataOf(reservationJs)) },
        },
      },
      "/content/custom/video": {
        post: {
          operationId: "createCustomVideoContent",
          summary: "Finaliza la subida y crea contenido de tipo custom",
          requestBody: {
            required: true,
            content: json(toJsonSchema(content.createCustomVideoContentRequestSchema)),
          },
          responses: { "201": ok("Creado", dataOf(contentJs)) },
        },
      },
      "/posts": {
        get: {
          operationId: "listPosts",
          summary: "Posts del workspace, newest first",
          parameters: queryParams(posts.listPostsQuerySchema),
          responses: { "200": ok("OK", pageOf(postJs)) },
        },
      },
      "/posts/{id}": {
        get: {
          operationId: "getPost",
          summary: "Un post con su estado y métricas de la última sincronización",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(postJs)),
            "404": errorResponse("not_found"),
          },
        },
        // Sprint 7 (publish-flow): editar caption/hora de un post que no salió.
        patch: {
          operationId: "updatePost",
          summary:
            "Edita caption/descripción y/o la hora de un post que no salió (cambiar la hora recrea el post: otro _id)",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(posts.updatePostRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(postJs)),
            "400": errorResponse("bad_request — caption de más para la red"),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — el post ya salió o está en curso"),
          },
        },
      },
      // Sprint 7 (publish-flow): reintentar un post fallido.
      "/posts/{id}/retry": {
        post: {
          operationId: "retryPost",
          summary:
            "Re-encola un post FAILED (ahora + margen, o a scheduledAtUtc). confirmNotPublished si la entrega fue incierta",
          parameters: [pathParam("id")],
          requestBody: {
            required: false,
            content: json(toJsonSchema(posts.retryPostRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(postJs)),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — no está FAILED o falta confirmNotPublished"),
            "503": errorResponse("service_unavailable — sin cola"),
          },
        },
      },
      // Sprint 7 (publish-flow): caption con IA y opciones del diálogo de Schedule.
      "/content/{id}/caption": {
        post: {
          operationId: "generateCaption",
          summary:
            "Genera (regenerate) o mejora (improve) la caption de una red con el modelo text",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(posts.generateCaptionRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(posts.generatedCaptionSchema))),
            "400": errorResponse("bad_request"),
            "404": errorResponse("not_found"),
            "503": errorResponse(
              "service_unavailable — sin modelo text, el modelo no respondió o su respuesta no sirvió (details.reason)",
            ),
          },
        },
      },
      "/content/{id}/schedule-options": {
        get: {
          operationId: "getScheduleOptions",
          summary:
            "Captions por defecto, conexiones, redes de la estrategia y próximo horario libre para el diálogo de Schedule",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(posts.scheduleOptionsSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/posts/cancel": {
        post: {
          operationId: "cancelPosts",
          summary: "Cancela hasta 100 posts. Todo o nada.",
          requestBody: {
            required: true,
            content: json(toJsonSchema(posts.cancelPostsRequestSchema)),
          },
          responses: {
            "200": ok("Cancelados", dataOf({ type: "array", items: postJs })),
            "409": errorResponse("conflict — details.failures con el motivo por id"),
          },
        },
      },
      "/posts/delete": {
        post: {
          operationId: "deletePosts",
          summary: "Borra hasta 100 posts. Todo o nada.",
          requestBody: {
            required: true,
            content: json(toJsonSchema(posts.deletePostsRequestSchema)),
          },
          responses: {
            "200": ok("Borrados", dataOf({ type: "array", items: postJs })),
            "409": errorResponse("conflict — details.failures con el motivo por id"),
          },
        },
      },
      "/posts/{id}/mark-posted": {
        post: {
          operationId: "markPostPosted",
          summary:
            "Borrador de TikTok terminado en la app: IN_USER_INBOX → POSTED (brandId opcional, del mismo dueño)",
          parameters: [pathParam("id")],
          requestBody: {
            required: false,
            content: json(toJsonSchema(posts.markPostedRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(postJs)),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — el post no está IN_USER_INBOX"),
          },
        },
      },
      "/analytics/posts": {
        post: {
          operationId: "getPostAnalytics",
          summary: "Métricas de hasta 100 posts. Éxito parcial por id desconocido.",
          requestBody: {
            required: true,
            content: json(toJsonSchema(analytics.postAnalyticsRequestSchema)),
          },
          responses: {
            "200": ok(
              "OK",
              dataOf({
                type: "array",
                items: toJsonSchema(analytics.postAnalyticsResultSchema),
              }),
            ),
            "400": errorResponse("bad_request — details.invalidIds"),
          },
        },
      },
      /**
       * `/analytics` — `P3-ANALYT-001/002`, `PU-AUTO-004`. Fuera de la §9.3
       * del PRD (uso personal). Ver la cabecera de la sección en
       * `resources/analytics.ts`.
       */
      "/analytics/summary": {
        get: {
          operationId: "getAnalyticsSummary",
          summary:
            "Totales, desglose por red y por tipo y top posts de los últimos N días, de esta marca o de todas",
          parameters: queryParams(analytics.analyticsSummaryQuerySchema),
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(analytics.analyticsSummarySchema))),
          },
        },
      },
      "/analytics/mix": {
        get: {
          operationId: "getAnalyticsMix",
          summary: "Pesos de formato, estado del auto-tune y su historial de ajustes",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(analytics.analyticsMixSchema))),
          },
        },
      },
      "/analytics/mix/autotune": {
        put: {
          operationId: "setMixAutotune",
          summary: "Prende o apaga el auto-tune semanal del content mix de la marca",
          requestBody: {
            required: true,
            content: json(toJsonSchema(analytics.mixAutotuneRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(analytics.mixAutotuneSchema))),
          },
        },
      },
      "/analytics/sync": {
        post: {
          operationId: "requestMetricsSync",
          summary:
            "Pide un sync de métricas ya para la marca activa (encola metrics-sync)",
          responses: {
            "202": ok(
              "Accepted",
              dataOf(toJsonSchema(analytics.analyticsSyncResponseSchema)),
            ),
            "503": errorResponse("service_unavailable — sin cola"),
          },
        },
      },
      /**
       * ── Brand Sources · EXTENSION EXT-001 ────────────────────────────────
       *
       * Estos cinco paths estaban acá **describiendo rutas que no existían**:
       * `apps/api` no tenía una sola ruta `/brand`, y el test de este archivo
       * fijaba un número de paths en vez de compararlos contra nada, así que la
       * mentira podía durar indefinidamente. Ahora las rutas existen
       * (`apps/api/src/routes/v1/brand.ts`) y `apps/api/test/openapi-routes.test.ts`
       * compara **este documento contra las rutas que Fastify registra de
       * verdad**, en los dos sentidos.
       *
       * Lo que cambió respecto de lo que estaba escrito, y por qué:
       *  - `GET /brand/sources` pasa a envelope **paginado**. §9.14 dice
       *    "misma convención de envelope, **cursor** e idempotencia que el
       *    resto", y un `{data: [...]}` suelto era la única lista de la v1 sin
       *    `pagination`. Con el cap de 5 fuentes `hasMore` siempre es `false`,
       *    pero la forma es la misma que las otras seis listas.
       *  - Se documentan los errores que las rutas **devuelven**, no los que
       *    parecían razonables: el `409` de alta (unicidad global) y el `503`
       *    de cola ausente no estaban, y sí estaban.
       */
      "/brand/sources/resolve": {
        post: {
          operationId: "resolveBrandSource",
          summary: "EXTENSION · resuelve un texto libre a una fuente, sin crear nada",
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.resolveBrandSourceRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.resolveBrandSourceResponseSchema))),
            "400": errorResponse(
              "bad_request — no se reconoce (ERR-B02), es un @handle sin plataforma " +
                "(ERR-B03, details.candidates) o la URL cayó en la protección SSRF",
            ),
            "503": errorResponse(
              "service_unavailable — un enlace a un post de Instagram, YouTube o " +
                "LinkedIn no lleva el handle del autor y resolverlo exige consultar " +
                "la plataforma; no hay adaptador `SocialReader` montado",
            ),
          },
        },
      },
      "/brand/sources": {
        post: {
          operationId: "createBrandSource",
          summary:
            "EXTENSION · crea la fuente y encola el análisis. Requiere Idempotency-Key.",
          parameters: [idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.createBrandSourceRequestSchema)),
          },
          responses: {
            "202": ok("Análisis encolado", dataOf(toJsonSchema(brand.brandSourceSchema))),
            "400": errorResponse(
              "bad_request — máx. 5 fuentes por workspace (ERR-B10), entrada no " +
                "reconocida (ERR-B02) o ambigua (ERR-B03)",
            ),
            "409": errorResponse(
              "conflict — esa fuente ya está registrada (ERR-B06). La unicidad de " +
                "`(sourceType, handle)` es GLOBAL, y la respuesta es idéntica tanto " +
                "si el choque es con este workspace como si es con otro",
            ),
            "503": errorResponse(
              "service_unavailable — sin cola no se encola el análisis",
            ),
          },
        },
        get: {
          operationId: "listBrandSources",
          summary: "EXTENSION · fuentes del workspace",
          parameters: queryParams(cursorQuerySchema),
          responses: {
            "200": ok("OK", pageOf(toJsonSchema(brand.brandSourceSchema))),
          },
        },
      },
      "/brand/sources/{id}": {
        get: {
          operationId: "getBrandSource",
          summary: "EXTENSION · polling de estado del análisis",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.brandSourceSchema))),
            "404": errorResponse("not_found"),
          },
        },
        patch: {
          operationId: "updateBrandSource",
          summary: "EXTENSION · sólo isPrimary, y sólo para promover",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.updateBrandSourceRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.brandSourceSchema))),
            "400": errorResponse(
              "bad_request — `isPrimary: false` no se acepta: FR-011.6 exige " +
                "exactamente una primaria, así que se promueve otra, no se degrada ésta",
            ),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          operationId: "deleteBrandSource",
          summary: "EXTENSION · rechazado si es la única fuente del perfil",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Borrada" },
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — el perfil quedaría sin origen"),
          },
        },
      },
      "/brand/sources/{id}/reanalyse": {
        post: {
          operationId: "reanalyseBrandSource",
          summary: "EXTENSION · sujeto al límite por fuente y día",
          parameters: [pathParam("id")],
          responses: {
            "202": ok("Análisis encolado", dataOf(toJsonSchema(brand.brandSourceSchema))),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — ya se está analizando"),
            "429": errorResponse(
              "rate_limited — ERR-B11, con `Retry-After` y `details.retryAfterMs`",
            ),
            "503": errorResponse(
              "service_unavailable — sin cola no se encola el análisis",
            ),
          },
        },
      },
      "/brand/sources/{id}/assist": {
        post: {
          operationId: "assistBrandSource",
          summary:
            "EXTENSION · tier D (P1-BRAND-014): sintetiza sobre la bio y los captions pegados. No consume el cupo de re-análisis.",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.assistBrandSourceRequestSchema)),
          },
          responses: {
            "202": ok("Análisis encolado", dataOf(toJsonSchema(brand.brandSourceSchema))),
            "400": errorResponse(
              "bad_request — nada pegado, textos de más, o la fuente no es de una red social",
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — ya se está analizando"),
            "503": errorResponse(
              "service_unavailable — sin cola no se encola el análisis",
            ),
          },
        },
      },
      "/brand/profile": {
        get: {
          operationId: "getCompanyProfile",
          summary: "EXTENSION · perfil con fieldMeta (confianza, origen, extracto)",
          responses: {
            // Nunca 404: el perfil es una propiedad del workspace, no un recurso
            // aparte. Un workspace sin fila devuelve el perfil vacío en `pending`.
            "200": ok("OK", dataOf(toJsonSchema(brand.companyProfileSchema))),
          },
        },
        patch: {
          operationId: "updateCompanyProfile",
          summary: "EXTENSION · edición manual; marca editedByUser en los campos tocados",
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.updateCompanyProfileRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.companyProfileSchema))),
            "400": errorResponse("bad_request — body vacío"),
            "409": errorResponse(
              "conflict — expectedBrandRevision no coincide (details.reason = brand_revision_changed)",
            ),
          },
        },
      },
      "/brand/profile/proposals": {
        get: {
          operationId: "listCompanyProfileProposals",
          summary:
            "EXTENSION · P1-BRANDPG-005 · lo que las fuentes proponen para campos editados a mano o sin procedencia (ERR-B14)",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.brandProfileProposalsSchema))),
          },
        },
      },
      "/brand/profile/proposals/{field}": {
        post: {
          operationId: "resolveCompanyProfileProposal",
          summary: "EXTENSION · aceptar o descartar la propuesta vigente de un campo",
          parameters: [pathParam("field")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.resolveBrandProfileProposalRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.companyProfileSchema))),
            "404": errorResponse("not_found — el campo no existe"),
            "409": errorResponse(
              "conflict — la revisión o la propuesta cambiaron (brand_revision_changed | proposal_changed)",
            ),
          },
        },
      },
      "/brand/logo": {
        get: {
          operationId: "getBrandLogo",
          summary: "EXTENSION · P1-ONB-003 · el logo de la marca (data: URL) o null",
          responses: { "200": ok("OK", dataOf(toJsonSchema(brand.brandLogoSchema))) },
        },
        put: {
          operationId: "updateBrandLogo",
          summary:
            "EXTENSION · P1-ONB-003 · sube el logo (PNG/JPEG/WebP ≤ 256 KB como data: URL)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.updateBrandLogoRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.brandLogoSchema))),
            "400": errorResponse("bad_request — tipo o tamaño inválido"),
          },
        },
        delete: {
          operationId: "deleteBrandLogo",
          summary: "EXTENSION · P1-ONB-003 · borra el logo",
          responses: { "200": ok("OK", dataOf(toJsonSchema(brand.brandLogoSchema))) },
        },
      },
      "/brand/ocr": {
        post: {
          operationId: "readBrandScreenshot",
          summary:
            "EXTENSION · P1-BRAND-014 · texto de una captura de perfil (OCR o modelo de visión); no persiste nada",
          requestBody: {
            required: true,
            content: json(toJsonSchema(brand.brandOcrRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(brand.brandOcrResultSchema))),
            "400": errorResponse(
              "bad_request — no es una imagen soportada o supera 700 KB",
            ),
            "503": errorResponse(
              "service_unavailable — sin servicio de visión ni modelo `vision`",
            ),
          },
        },
      },
      /**
       * Onboarding — `FR-010`.
       *
       * **La superficie v1 de §9.3 no los enumera**, y no es un descuido del
       * PRD: `FR-010` especifica el wizard entero sin decir por qué cable
       * viaja. Se documentan igual porque `apps/api` los registra, y
       * `apps/api/test/openapi-routes.test.ts` compara el documento contra las
       * rutas que Fastify monta en los dos sentidos: una ruta viva sin
       * documentar es superficie pública que nadie revisó.
       *
       * Son **tres**, no los cinco pasos del wizard: el paso 1 ya tiene
       * `POST /brand/sources` y el paso 2 (`Company Name`, `Company
       * Description`, `Company Logo`) no tiene endpoint porque `packages/db`
       * no expone escritura sobre `companies`. Está en el reporte.
       */
      "/onboarding": {
        get: {
          operationId: "getOnboarding",
          summary:
            "Dónde retomar el wizard de alta (FR-010 criterio 3: recargar conserva el progreso)",
          responses: {
            // Nunca 404, por el mismo motivo que `/brand/profile`: el
            // onboarding es un estado del workspace, no un recurso aparte.
            "200": ok("OK", dataOf(toJsonSchema(onboarding.onboardingStateSchema))),
          },
        },
      },
      "/onboarding/profiling": {
        post: {
          operationId: "submitOnboardingProfiling",
          summary:
            "Cuestionario de perfilado (F-006). Las seis claves son obligatorias; los valores los valida el dominio",
          requestBody: {
            required: true,
            content: json(
              toJsonSchema(onboarding.submitOnboardingProfilingRequestSchema),
            ),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(onboarding.onboardingStateSchema))),
            "400": errorResponse(
              "bad_request — copy literal de FR-010 por campo, con details.field",
            ),
            "429": errorResponse("rate_limited"),
          },
        },
      },
      "/onboarding/complete": {
        post: {
          operationId: "completeOnboarding",
          summary:
            "Cierra el wizard y arranca el relleno de la discovery queue (FR-010 System behavior, PRD:759)",
          // Encola trabajo, así que lleva key: la misma regla de §9.3 que
          // `POST /brand/sources`.
          parameters: [idempotencyParam],
          responses: {
            "202": ok(
              "Aceptado",
              dataOf(toJsonSchema(onboarding.onboardingCompletionSchema)),
            ),
            "400": errorResponse("bad_request — falta un paso del wizard"),
            // Cerrar un alta ya cerrada NO es 409: es idempotente y devuelve 202
            // con `step: "ready"` y `discoveryRefillQueued: false`
            // (`apps/api/src/routes/v1/onboarding.ts`). El único 409 es el de la key.
            "409": errorResponse("conflict — la key se reusó con otro cuerpo"),
            "429": errorResponse("rate_limited"),
            "503": errorResponse(
              "service_unavailable — sin cola no se puede arrancar el relleno",
            ),
          },
        },
      },
      "/mode": {
        get: {
          operationId: "getMode",
          summary: "Modo de la instancia: personal | standard (PU-RUN-002, D-06)",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(workspaces.modeSchema))),
          },
        },
      },
      "/workspaces": {
        get: {
          operationId: "listWorkspaces",
          summary:
            "Marcas vivas del dueño de la key, por created_at asc (PU-BRAND-001). 404 fuera del modo personal",
          responses: {
            "200": ok(
              "OK",
              dataOf({ type: "array", items: toJsonSchema(workspaces.workspaceSchema) }),
            ),
            "404": errorResponse("not_found — modo standard"),
          },
        },
        post: {
          operationId: "createWorkspace",
          summary: "Crea una marca: plan pro, perfil pending (PU-BRAND-001)",
          parameters: [idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(workspaces.createWorkspaceRequestSchema)),
          },
          responses: {
            "201": ok("Creada", dataOf(toJsonSchema(workspaces.workspaceSchema))),
            "400": errorResponse("bad_request"),
            "404": errorResponse("not_found — modo standard"),
            "409": errorResponse("conflict — la key se reusó con otro cuerpo"),
          },
        },
      },
      "/workspaces/{id}": {
        patch: {
          operationId: "renameWorkspace",
          summary: "Renombra una marca del dueño",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(workspaces.updateWorkspaceRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(workspaces.workspaceSchema))),
            "400": errorResponse("bad_request"),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          operationId: "deleteWorkspace",
          summary: "Soft delete. La última marca, o la de la key en uso → 409",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Borrada" },
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — última marca o marca de la key"),
          },
        },
      },
      /**
       * Registro de modelos por tarea — `PU-MODEL-001`/`002`, D-14. Fuera de la
       * §9.3 del PRD (uso personal). Ninguna respuesta lleva una API key.
       * Probar y listar responden 200 con `ok: false` cuando falla el
       * proveedor: ver la cabecera de `resources/models.ts`.
       */
      "/models": {
        get: {
          operationId: "getModels",
          summary: "Configuración de modelos por tarea y presets de proveedores",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(models.modelsOverviewSchema))),
          },
        },
      },
      "/models/{task}": {
        put: {
          operationId: "updateModelTask",
          summary:
            "Guarda el proveedor, la base URL, el modelo y (opcional) la key de una tarea",
          parameters: [pathParam("task")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(models.updateModelTaskRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(models.modelTaskConfigSchema))),
            "400": errorResponse("bad_request — con details.field"),
            "404": errorResponse("not_found — la tarea no existe"),
            "503": errorResponse("service_unavailable — no se pudo escribir el registro"),
          },
        },
        delete: {
          operationId: "clearModelTaskOverride",
          summary:
            "Borra el modelo propio de un punto de decisión de juicio (P1-JUDGE-004): vuelve a heredar `judgment`",
          parameters: [pathParam("task")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(models.modelTaskConfigSchema))),
            "404": errorResponse("not_found — no es un override de juicio"),
          },
        },
      },
      "/models/test": {
        post: {
          operationId: "testModelConnection",
          summary:
            "Lista los modelos del proveedor y, con `model`, hace una llamada mínima",
          requestBody: {
            required: true,
            content: json(toJsonSchema(models.testModelConnectionRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(models.modelConnectionTestSchema))),
            "400": errorResponse("bad_request — base URL inválida"),
          },
        },
      },
      "/models/providers/{provider}/models": {
        get: {
          operationId: "listProviderModels",
          summary: "GET {baseUrl}/models del proveedor, con la key guardada de `task`",
          parameters: [
            pathParam("provider"),
            ...queryParams(models.providerModelsQuerySchema),
          ],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(models.providerModelsSchema))),
            "400": errorResponse("bad_request — base URL inválida o faltante"),
            "404": errorResponse("not_found — el proveedor no existe"),
          },
        },
      },
      /**
       * AI Studio y el tope mensual — `PU-LATER-005`, `PU-MODEL-003`/`004`/`005`.
       * Fuera de la §9.3 del PRD (uso personal). Ver la cabecera de
       * `resources/genai.ts`.
       */
      "/models/budget": {
        get: {
          operationId: "getModelBudget",
          summary: "Gasto de generación del mes (UTC) y tope mensual",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.budgetSummarySchema))),
          },
        },
        put: {
          operationId: "updateModelBudget",
          summary: "Cambia el tope mensual; null vuelve al entorno o al default",
          requestBody: {
            required: true,
            content: json(toJsonSchema(genai.updateBudgetRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.budgetSummarySchema))),
            "400": errorResponse("bad_request — monto inválido"),
          },
        },
      },
      "/ai-studio/options": {
        get: {
          operationId: "getAiStudioOptions",
          summary: "Modelos de imagen y video configurados, su catálogo y el presupuesto",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.aiStudioOptionsSchema))),
          },
        },
      },
      "/ai-studio/estimate": {
        post: {
          operationId: "estimateAiStudioGeneration",
          summary: "Costo estimado de un pedido y si entra en el tope",
          requestBody: {
            required: true,
            content: json(toJsonSchema(genai.generationRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.generationEstimateSchema))),
            "400": errorResponse("bad_request — con details.field"),
            "409": errorResponse("conflict — la tarea no está configurada"),
            "503": errorResponse(
              "service_unavailable — el proveedor falló (details.reason)",
            ),
          },
        },
      },
      "/ai-studio/generations": {
        get: {
          operationId: "listAiStudioGenerations",
          summary: "Generaciones de la marca, más nuevas primero",
          parameters: [...queryParams(genai.generationListQuerySchema)],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.generationListSchema))),
          },
        },
        post: {
          operationId: "createAiStudioGeneration",
          summary: "Estima, reserva el gasto y encola (202)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(genai.generationRequestSchema)),
          },
          responses: {
            "202": ok("Accepted", dataOf(toJsonSchema(genai.generationSchema))),
            "400": errorResponse("bad_request — con details.field"),
            "402": errorResponse("payment_required — details.reason = budget_exceeded"),
            "409": errorResponse("conflict — la tarea no está configurada"),
            "503": errorResponse("service_unavailable — sin cola"),
          },
        },
      },
      "/ai-studio/generations/{id}": {
        get: {
          operationId: "getAiStudioGeneration",
          summary: "Una generación con su estado y su media",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.generationSchema))),
            "404": errorResponse("not_found — no existe o es de otra marca"),
          },
        },
      },
      /**
       * Sprint 7 (agente G): formatos generativos (`P4-FORMAT-001`/`002`) e
       * influencers (Configuration, templates, base por texto, video). Fuera
       * de la §9.3 del PRD (uso personal). Ver `resources/genai.ts` e
       * `influencers.ts`.
       */
      "/ai-studio/formats": {
        get: {
          operationId: "listGenerativeFormats",
          summary:
            "Los 17 formatos generativos (disponibles o bloqueados con el motivo), modelos de texto a video y tope",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.generativeFormatsViewSchema))),
          },
        },
      },
      "/ai-studio/formats/{format}/estimate": {
        post: {
          operationId: "estimateFormatRun",
          summary: "Costo estimado del clip de un formato generativo",
          parameters: [pathParam("format")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(genai.formatRunRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.formatRunEstimateSchema))),
            "400": errorResponse("bad_request — con details.field"),
            "404": errorResponse("not_found — el formato no existe"),
            "409": errorResponse("conflict — sin modelo de texto a video"),
            "503": errorResponse("service_unavailable — el proveedor falló"),
          },
        },
      },
      "/ai-studio/formats/{format}/runs": {
        post: {
          operationId: "createFormatRun",
          summary:
            "Estima, reserva en el tope y encola el clip; al terminar arma la pieza (202)",
          parameters: [pathParam("format")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(genai.formatRunRequestSchema)),
          },
          responses: {
            "202": ok("Accepted", dataOf(toJsonSchema(genai.formatRunSchema))),
            "400": errorResponse("bad_request — con details.field"),
            "402": errorResponse("payment_required — details.reason = budget_exceeded"),
            "404": errorResponse("not_found — el formato no existe"),
            "409": errorResponse("conflict — sin modelo de texto a video"),
            "503": errorResponse("service_unavailable — sin cola o proveedor caído"),
          },
        },
      },
      "/ai-studio/format-runs": {
        get: {
          operationId: "listFormatRuns",
          summary: "Corridas de formatos de la marca, más nuevas primero",
          parameters: [...queryParams(genai.generationListQuerySchema)],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.formatRunListSchema))),
          },
        },
      },
      "/ai-studio/format-runs/{id}": {
        get: {
          operationId: "getFormatRun",
          summary: "Una corrida con su estado, su clip y la pieza",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.formatRunSchema))),
            "404": errorResponse("not_found — no existe o es de otra marca"),
          },
        },
      },
      "/influencers/templates": {
        get: {
          operationId: "getInfluencerTemplates",
          summary: "Templates de prompt de la marca (los de fábrica si no se editaron)",
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(influencers.influencerTemplatesViewSchema)),
            ),
          },
        },
        put: {
          operationId: "updateInfluencerTemplates",
          summary: "Reemplaza los templates; null vuelve a los de fábrica",
          requestBody: {
            required: true,
            content: json(
              toJsonSchema(influencers.updateInfluencerTemplatesRequestSchema),
            ),
          },
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(influencers.influencerTemplatesViewSchema)),
            ),
            "400": errorResponse("bad_request — lista inválida"),
          },
        },
      },
      "/influencers/base-image/estimate": {
        post: {
          operationId: "estimateInfluencerBaseImage",
          summary: "Costo de generar la imagen base por texto",
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.influencerBaseImageRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(genai.generationEstimateSchema))),
            "400": errorResponse("bad_request — nada que describir"),
            "409": errorResponse("conflict — sin modelo de imagen"),
          },
        },
      },
      "/influencers/base-image": {
        post: {
          operationId: "generateInfluencerBaseImage",
          summary:
            "Genera la imagen base por texto (una generación de AI Studio); regenerar = persona nueva (202)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.influencerBaseImageRequestSchema)),
          },
          responses: {
            "202": ok("Accepted", dataOf(toJsonSchema(genai.generationSchema))),
            "400": errorResponse("bad_request — nada que describir"),
            "402": errorResponse("payment_required — details.reason = budget_exceeded"),
            "409": errorResponse("conflict — sin modelo de imagen"),
            "503": errorResponse("service_unavailable — sin cola"),
          },
        },
      },
      "/influencers/{id}/config": {
        get: {
          operationId: "getInfluencerConfig",
          summary: "Configuration (FR-083): ángulos, cuentas y sets, y entre qué elegir",
          parameters: [pathParam("id")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(influencers.influencerConfigViewSchema))),
            "404": errorResponse("not_found"),
          },
        },
        put: {
          operationId: "updateInfluencerConfig",
          summary: "Auto-guardado de la Configuration",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.updateInfluencerConfigRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(influencers.influencerConfigViewSchema))),
            "400": errorResponse("bad_request — un id que no es de la marca"),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/influencers/{id}/videos/estimate": {
        post: {
          operationId: "estimateInfluencerVideo",
          summary:
            "Costo de animar una imagen del personaje (image-to-video de Higgsfield)",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.influencerVideoRequestSchema)),
          },
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(influencers.influencerImageEstimateSchema)),
            ),
            "400": errorResponse("bad_request — con details.field"),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — sin Higgsfield"),
          },
        },
      },
      "/influencers/{id}/videos": {
        post: {
          operationId: "generateInfluencerVideo",
          summary: "Anima una imagen del personaje: reserva en el tope y encola (202)",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.influencerVideoRequestSchema)),
          },
          responses: {
            "202": ok(
              "Accepted",
              dataOf(toJsonSchema(influencers.influencerGenerationSchema)),
            ),
            "400": errorResponse("bad_request — con details.field"),
            "402": errorResponse("payment_required — details.reason = budget_exceeded"),
            "404": errorResponse("not_found"),
            "409": errorResponse("conflict — sin Higgsfield"),
            "503": errorResponse("service_unavailable — sin cola o proveedor caído"),
          },
        },
      },
      /**
       * Estrategia por marca y calendario — `PU-BRAND-002`, `PU-CAL-001`,
       * `PU-CAL-002`. Fuera de la §9.3 del PRD (uso personal). Ver la cabecera
       * de `resources/strategy.ts`.
       */
      "/strategy": {
        get: {
          operationId: "getStrategy",
          summary:
            "Estrategia de publicación de la marca; la por defecto (isDefault) si nunca se guardó",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(strategy.strategySchema))),
          },
        },
        put: {
          operationId: "updateStrategy",
          summary: "Reemplaza la estrategia de la marca (y su zona horaria)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(strategy.updateStrategyRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(strategy.strategySchema))),
            "400": errorResponse("bad_request"),
          },
        },
      },
      "/content/{id}/autoschedule": {
        post: {
          operationId: "autoscheduleContent",
          summary:
            "Aprobar → próximo horario libre por red de la estrategia: post si hay una conexión activa única, slot planificado si no",
          parameters: [pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(strategy.autoscheduleRequestSchema)),
          },
          responses: {
            "201": ok(
              "Programado",
              dataOf(toJsonSchema(strategy.autoscheduleResultSchema)),
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "unsupported_content_state — la pieza falló; conflict — ninguna red activa",
            ),
            "503": errorResponse(
              "service_unavailable — hace falta un post y no hay cola",
            ),
          },
        },
      },
      "/calendar": {
        get: {
          operationId: "getCalendar",
          summary:
            "Posts y slots planificados en [from, to) por fecha efectiva, de esta marca o de todas las del dueño",
          parameters: queryParams(strategy.calendarQuerySchema),
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(strategy.calendarSchema))),
            "400": errorResponse("bad_request — rango inválido o mayor a 62 días"),
          },
        },
      },
      "/calendar/items/{kind}/{id}": {
        patch: {
          operationId: "moveCalendarItem",
          summary:
            "Mueve un post no publicado o un slot planificado a otra hora (brandId opcional, del mismo dueño)",
          parameters: [pathParam("kind"), pathParam("id")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(strategy.moveCalendarItemRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(strategy.calendarItemSchema))),
            "400": errorResponse("out_of_range — la hora no es futura"),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "conflict / invalid_state — ya salió, carril lento o warmed",
            ),
            "503": errorResponse("service_unavailable — mover un post necesita la cola"),
          },
        },
      },
      /**
       * Piloto automático — `PU-AUTO-001…003`. Fuera de la §9.3 del PRD (uso
       * personal, `D-08`). Ver la cabecera de `resources/autopilot.ts`.
       */
      "/autopilot/digest": {
        get: {
          operationId: "getAutopilotDigest",
          summary:
            "Resumen del día por marca: generadas, aprobadas solas, rechazadas con motivo, en espera, publicadas y fallidas",
          parameters: queryParams(autopilot.autopilotDigestQuerySchema),
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(autopilot.autopilotDigestSchema))),
            "400": errorResponse("bad_request — fecha inválida"),
          },
        },
      },
      "/autopilot/policy": {
        get: {
          operationId: "getAutopilotPolicy",
          summary:
            "Cómo decide el piloto: horizonte, objetivo de la cola, cupo por corrida y umbrales del pre-chequeo",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(autopilot.autopilotPolicySchema))),
          },
        },
      },
      /**
       * Engagement (Reddit) — `FR-140`, `P4-ENGAGE-001…012`. Ver la cabecera
       * de `resources/engagement.ts`.
       */
      "/engagement/overview": {
        get: {
          operationId: "getEngagementOverview",
          summary:
            "Configuración, app y cuenta de Reddit, estado del descubrimiento y ban meter (calculado en código)",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.engagementOverviewSchema))),
          },
        },
      },
      "/engagement/settings": {
        put: {
          operationId: "updateEngagementSettings",
          summary: "Subreddits, palabras clave, tono y reglas propias de respuesta",
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.updateEngagementSettingsRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.engagementSettingsSchema))),
            "400": errorResponse("invalid_subreddits / invalid_keywords"),
          },
        },
      },
      "/engagement/reddit-app": {
        put: {
          operationId: "updateRedditApp",
          summary: "Credenciales de la app de Reddit (el secret nunca vuelve)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.updateRedditAppRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.redditAppSchema))),
            "400": errorResponse("bad_request"),
          },
        },
        delete: {
          operationId: "deleteRedditApp",
          summary: "Borra las credenciales de la app de Reddit",
          responses: { "204": { description: "Borradas" } },
        },
      },
      "/engagement/reddit/authorize": {
        get: {
          operationId: "authorizeReddit",
          summary:
            "URL de autorización de Reddit con state firmado (scopes identity read submit)",
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(engagement.redditAuthorizeResponseSchema)),
            ),
            "409": errorResponse("reddit_app_not_configured"),
          },
        },
      },
      "/engagement/reddit/callback": {
        post: {
          operationId: "redditCallback",
          summary: "Cambia el code por tokens (cifrados) y conecta la cuenta a la marca",
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.redditCallbackRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.redditCallbackResultSchema))),
            "400": errorResponse(
              "oauth_state_invalid / oauth_state_wrong_brand / oauth_denied",
            ),
            "502": errorResponse("reddit_rejected / reddit_unavailable"),
          },
        },
      },
      "/engagement/reddit/account": {
        delete: {
          operationId: "disconnectReddit",
          summary: "Desconecta la cuenta de Reddit de la marca (tokens borrados)",
          responses: { "204": { description: "Desconectada" } },
        },
      },
      "/engagement/discover": {
        post: {
          operationId: "discoverLeads",
          summary: "Encola una corrida de descubrimiento para la marca",
          responses: {
            "202": ok(
              "Encolado",
              dataOf(toJsonSchema(engagement.engagementQueuedSchema)),
            ),
            "409": errorResponse("reddit_not_connected"),
            "503": errorResponse("service_unavailable — sin cola"),
          },
        },
      },
      "/engagement/leads": {
        get: {
          operationId: "listLeads",
          summary: "Leads visibles (JV-2): vistas all / top / engaged, unseen y búsqueda",
          parameters: queryParams(engagement.leadListQuerySchema),
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.leadListSchema))),
          },
        },
        post: {
          operationId: "createManualLead",
          summary: "Agrega un post de Reddit a mano (funciona sin la API de Reddit)",
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.createManualLeadRequestSchema)),
          },
          responses: {
            "201": ok("Creado", dataOf(toJsonSchema(engagement.leadSchema))),
            "400": errorResponse("invalid_reddit_url"),
          },
        },
      },
      "/engagement/leads/{leadId}": {
        get: {
          operationId: "getLead",
          summary: "Detalle del lead, respuestas enviadas y revisión del borrador",
          parameters: [pathParam("leadId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.leadDetailSchema))),
            "404": errorResponse("not_found"),
          },
        },
        delete: {
          operationId: "deleteLead",
          summary: "Descarta el lead (no vuelve a aparecer)",
          parameters: [pathParam("leadId")],
          responses: {
            "204": { description: "Descartado" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/engagement/leads/{leadId}/seen": {
        post: {
          operationId: "markLeadSeen",
          summary: "Marca el lead como visto (y apaga «New activity»)",
          parameters: [pathParam("leadId")],
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.leadSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/engagement/leads/{leadId}/reply/generate": {
        post: {
          operationId: "generateLeadReply",
          summary: "Genera o regenera el borrador de respuesta (LLM en el worker)",
          parameters: [pathParam("leadId")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.generateReplyRequestSchema)),
          },
          responses: {
            "202": ok("Encolado", dataOf(toJsonSchema(engagement.leadSchema))),
            "404": errorResponse("not_found"),
            "503": errorResponse("service_unavailable — sin cola"),
          },
        },
      },
      "/engagement/leads/{leadId}/reply": {
        put: {
          operationId: "saveLeadReplyDraft",
          summary: "Guarda el borrador editado",
          parameters: [pathParam("leadId")],
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.saveReplyDraftRequestSchema)),
          },
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.leadDetailSchema))),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/engagement/leads/{leadId}/send": {
        post: {
          operationId: "sendLeadReply",
          summary:
            "Publica la respuesta en Reddit. Exige confirm: true e Idempotency-Key; bloqueado con el ban meter en danger",
          parameters: [pathParam("leadId"), idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.sendReplyRequestSchema)),
          },
          responses: {
            "201": ok(
              "Publicada",
              dataOf(toJsonSchema(engagement.sendReplyResultSchema)),
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse(
              "ban_meter_danger / reply_blocked / reddit_not_connected / reddit_reconnect_required / lead_locked",
            ),
            "429": errorResponse("reddit_rate_limited"),
            "502": errorResponse("reddit_rejected / reddit_unavailable"),
          },
        },
      },
      "/engagement/leads/{leadId}/mark-sent": {
        post: {
          operationId: "markLeadReplySent",
          summary:
            "Registra una respuesta publicada a mano (Copy & open thread) para el ban meter",
          parameters: [pathParam("leadId"), { ...idempotencyParam, required: false }],
          requestBody: {
            required: true,
            content: json(toJsonSchema(engagement.markSentRequestSchema)),
          },
          responses: {
            "201": ok(
              "Registrada",
              dataOf(toJsonSchema(engagement.sendReplyResultSchema)),
            ),
            "404": errorResponse("not_found"),
          },
        },
      },
      "/engagement/leads/{leadId}/sync": {
        post: {
          operationId: "syncLeadThread",
          summary: "Sync with Reddit: relee el hilo y actualiza su estado (encola)",
          parameters: [pathParam("leadId")],
          responses: {
            "202": ok(
              "Encolado",
              dataOf(toJsonSchema(engagement.engagementQueuedSchema)),
            ),
            "404": errorResponse("not_found"),
            "409": errorResponse("reddit_not_connected"),
          },
        },
      },
      "/engagement/ban-meter/refresh": {
        post: {
          operationId: "refreshBanMeter",
          summary:
            "Refresh ban meter: recalcula el nivel en código sobre las etiquetas guardadas y encola las que faltan",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(engagement.banMeterSchema))),
          },
        },
      },
      /**
       * Notificaciones — `P5-NOTIF-001…004`, PRD §13 (sprint 7). Ver la
       * cabecera de `resources/notifications.ts`.
       */
      "/notifications": {
        get: {
          operationId: "listNotifications",
          summary: "La campana: avisos de las marcas del dueño, más nuevos primero",
          parameters: queryParams(notifications.listNotificationsQuerySchema),
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(notifications.notificationListSchema))),
          },
        },
      },
      "/notifications/{id}/read": {
        post: {
          operationId: "markNotificationRead",
          summary: "Marca un aviso como leído (idempotente)",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Leído" },
            "404": errorResponse("not_found"),
          },
        },
      },
      "/notifications/read-all": {
        post: {
          operationId: "markAllNotificationsRead",
          summary: "Marca todos los avisos como leídos",
          requestBody: {
            required: false,
            content: json(
              toJsonSchema(notifications.markAllNotificationsReadRequestSchema),
            ),
          },
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(notifications.markAllNotificationsReadResponseSchema)),
            ),
          },
        },
      },
      "/notifications/connection-alerts": {
        get: {
          operationId: "listConnectionAlerts",
          summary: "Conexiones vencidas o por vencer (≤7 días) de las marcas del dueño",
          responses: {
            "200": ok("OK", dataOf(toJsonSchema(notifications.connectionAlertsSchema))),
          },
        },
      },
      "/notifications/settings": {
        get: {
          operationId: "getNotificationSettings",
          summary: "Preferencias por categoría y canales (ntfy, Telegram), enmascarados",
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(notifications.notificationSettingsSchema)),
            ),
          },
        },
        put: {
          operationId: "updateNotificationSettings",
          summary: "Actualiza preferencias y canales; un secreto omitido se conserva",
          requestBody: {
            required: true,
            content: json(
              toJsonSchema(notifications.updateNotificationSettingsRequestSchema),
            ),
          },
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(notifications.notificationSettingsSchema)),
            ),
            "400": errorResponse("bad_request"),
          },
        },
      },
      "/notifications/test": {
        post: {
          operationId: "sendTestNotification",
          summary:
            "Manda un aviso de prueba por un canal; el fallo del canal es 200 con ok=false",
          requestBody: {
            required: true,
            content: json(toJsonSchema(notifications.testNotificationRequestSchema)),
          },
          responses: {
            "200": ok(
              "OK",
              dataOf(toJsonSchema(notifications.notificationTestResultSchema)),
            ),
          },
        },
      },
    },
  };
};
