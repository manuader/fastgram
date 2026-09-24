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
import * as workspaces from "./resources/workspaces.js";
import * as strategy from "./resources/strategy.js";
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
            "Crea y entrena un influencer (250 créditos). Requiere Idempotency-Key.",
          parameters: [idempotencyParam],
          requestBody: {
            required: true,
            content: json(toJsonSchema(influencers.createInfluencerRequestSchema)),
          },
          responses: {
            "202": ok("Pipeline encolado", dataOf(influencerJs)),
            "402": errorResponse("payment_required — cap de 50, créditos o storage"),
            "409": errorResponse(
              "conflict — upload no alcanzable o idempotency key en uso",
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
         * **Acá había un `409 media_in_use` documentado que la ruta no devuelve
         * nunca**, y se quita en vez de dejarlo.
         *
         * `apps/api/src/routes/v1/media.ts` responde `204` siempre — es
         * deliberado (§9.2: *"los borrados idempotentes de media tratan ids
         * ajenos/desconocidos como no-ops seguros que no revelan si el registro
         * existe"*)—, y el `409` de `FR-100` no está implementado porque
         * comprobar que el asset sigue referenciado exige preguntar por
         * pertenencia a un array en `contents`, `influencer_configs` y
         * `media_sets`, y el filtro declarativo de los repositorios no tiene un
         * operador de "contiene" (nota en `media.ts:48-51`).
         *
         * Se quita del documento y no se deja "por si acaso" porque esto **es**
         * el contrato que lee un integrador: un `409` documentado hace que
         * alguien escriba la rama que lo maneja, y esa rama es código muerto.
         * Lo que hace falta para devolverlo está en el reporte; el día que
         * exista, vuelve acá **con** la ruta, no antes.
         */
        delete: {
          operationId: "deleteMedia",
          summary: "Borrado idempotente: 204 también para un id ajeno o inexistente",
          parameters: [pathParam("id")],
          responses: {
            "204": { description: "Borrado" },
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
              "connection_ambiguous / posting_mode_not_supported_for_platform / privacy_level_required / invalid_privacy_level",
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
    },
  };
};
