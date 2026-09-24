/**
 * Estrategia por marca, auto-slot y calendario — `PU-BRAND-002`, `PU-CAL-001`,
 * `PU-CAL-002` (`docs/PLAN-USO-PERSONAL.md` §2 pasos 2 y 5, §5; PRD §2.7
 * `D-07`, `D-08`, `D-09`; FR-060; FR-110).
 *
 *   GET   /strategy                      la estrategia de la marca (o la por defecto)
 *   PUT   /strategy                      la reemplaza entera
 *   POST  /content/{id}/autoschedule     aprobar → próximo horario libre por red
 *   GET   /calendar?from&to&brands       posts + slots de esta marca o de todas
 *   PATCH /calendar/items/{kind}/{id}    mover un post o un slot (drag & drop)
 *
 * ## De dónde sale
 *
 * Ninguna ruta está en el PRD original (§9.3): nacen del plan de uso personal.
 * Los números anti-bot (tope 3 por red y día, jitter ±7 min, separación entre
 * marcas 10 min) son **defaults nuestros** (§5: *"ninguna plataforma publica una
 * cadencia segura"*), no datos de las plataformas.
 *
 * ## Slot planificado
 *
 * Un `Post` necesita una cuenta conectada (FR-060) y en el sprint 2 no hay
 * OAuth. Un **slot planificado** es contenido + red + hora, sin cuenta: el
 * calendario lo muestra y se mueve igual que un post, y cuando la marca tenga
 * la conexión se convierte en un `Post` por el flujo de
 * `POST /content/{id}/schedule`. Si la conexión ya existe, el auto-slot crea el
 * post directamente.
 *
 * ## "Todas las marcas"
 *
 * `GET /calendar?brands=all` responde por **todas las marcas del dueño** de la
 * credencial (modo personal, `D-07`). No hace falta mandar un header por marca:
 * el proxy de la web sólo reenvía la marca de su cookie, así que pedir "todas"
 * marca por marca no es posible desde el navegador. Mover un ítem de otra marca
 * lleva su `brandId` en el cuerpo, y la API lo valida contra el dueño (404 si
 * no es suyo), igual que `X-Fastgram-Workspace`.
 */
import { z } from "zod";

import { contentTypeSchema, postStatusSchema } from "../primitives/enums.js";
import { contentIdSchema, msEpochSchema } from "../primitives/ids.js";
import { postSchema } from "./posts.js";

// --- Números -------------------------------------------------------------------

/** `D-09`, en orden. YouTube y LinkedIn van al final. */
export const STRATEGY_NETWORKS = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
] as const;
export const strategyNetworkSchema = z.enum(STRATEGY_NETWORKS);
export type StrategyNetwork = z.infer<typeof strategyNetworkSchema>;

/**
 * `D-09`: se pueden guardar pero todavía no publican; la UI las marca "later".
 * Vacía desde que YouTube y LinkedIn tienen publicador (`PU-LATER-001/002`).
 */
export const LATER_STRATEGY_NETWORKS: readonly StrategyNetwork[] = [];

/** §5.2 — tope propio por red y por día. Subirlo es posible; la UI advierte. */
export const ANTI_BOT_DAILY_CAP_DEFAULT = 3;
/** Techo del contrato para `perDay` y `dailyCap`. No es una recomendación. */
export const STRATEGY_PER_DAY_MAX = 24;
/** §5.3 — ± minutos. */
export const STRATEGY_JITTER_MINUTES_DEFAULT = 7;
export const STRATEGY_JITTER_MINUTES_MAX = 60;
/** §5.3 — minutos entre publicaciones de marcas distintas del mismo dueño. */
export const STRATEGY_BRAND_GAP_MINUTES_DEFAULT = 10;
export const STRATEGY_BRAND_GAP_MINUTES_MAX = 240;
/** Ventanas por día. Más de 24 no tiene sentido con un tope de 24 por día. */
export const STRATEGY_WINDOWS_PER_DAY_MAX = 24;
/** Rango máximo de `GET /calendar` y `GET /posts?from&to`: una vista mes de 6 semanas y margen. */
export const CALENDAR_RANGE_MAX_DAYS = 62;

export const STRATEGY_WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
export const strategyWeekdaySchema = z.enum(STRATEGY_WEEKDAYS);
export type StrategyWeekday = z.infer<typeof strategyWeekdaySchema>;

export const BRAND_AUTONOMIES = ["manual", "autopilot"] as const;
export const brandAutonomySchema = z.enum(BRAND_AUTONOMIES);
export type BrandAutonomy = z.infer<typeof brandAutonomySchema>;

// --- Estrategia ------------------------------------------------------------------

/** `HH:MM` de 00:00 a 23:59, hora local de la marca. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (00:00–23:59).");

export const networkStrategySchema = z
  .object({
    network: strategyNetworkSchema,
    enabled: z.boolean(),
    /** Piezas por día que la estrategia quiere en esta red. */
    perDay: z.number().int().min(0).max(STRATEGY_PER_DAY_MAX),
    /**
     * Tope anti-bot. Aplica a todo lo que se programa en la red, no sólo al
     * auto-slot (el sprint 3 lo hace cumplir al publicar).
     */
    dailyCap: z.number().int().min(1).max(STRATEGY_PER_DAY_MAX),
  })
  .strict()
  .refine((n) => n.perDay <= n.dailyCap, {
    message: "perDay can't exceed dailyCap",
    path: ["perDay"],
  });
export type NetworkStrategy = z.infer<typeof networkStrategySchema>;

const dayWindowsSchema = z.array(timeOfDaySchema).max(STRATEGY_WINDOWS_PER_DAY_MAX);

export const postingWindowsSchema = z
  .object({
    sun: dayWindowsSchema,
    mon: dayWindowsSchema,
    tue: dayWindowsSchema,
    wed: dayWindowsSchema,
    thu: dayWindowsSchema,
    fri: dayWindowsSchema,
    sat: dayWindowsSchema,
  })
  .strict();
export type PostingWindows = z.infer<typeof postingWindowsSchema>;

/** Una zona IANA que el runtime conoce. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (zone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Unknown time zone." },
  );

/** Pesos relativos por tipo de contenido. No tienen que sumar 100. */
export const formatMixSchema = z.record(
  contentTypeSchema,
  z.number().int().min(0).max(100),
);
export type FormatMix = z.infer<typeof formatMixSchema>;

const strategyFields = {
  /** Una entrada por red, sin repetidas. Una red ausente = apagada. */
  networks: z
    .array(networkStrategySchema)
    .max(STRATEGY_NETWORKS.length)
    .refine((list) => new Set(list.map((n) => n.network)).size === list.length, {
      message: "Each network can appear only once.",
    }),
  windows: postingWindowsSchema,
  /** La de la marca (`companies.timezone`). Cambiarla acá cambia la de la marca. */
  timezone: timeZoneSchema,
  /** BCP 47 (`es`, `en-US`, `pt-BR`). El idioma en que se genera el contenido. */
  language: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Use a language tag like es or en-US."),
  /** `D-08`. `autopilot` se guarda; el piloto se implementa en el sprint 5. */
  autonomy: brandAutonomySchema,
  jitterMinutes: z.number().int().min(0).max(STRATEGY_JITTER_MINUTES_MAX),
  brandGapMinutes: z.number().int().min(0).max(STRATEGY_BRAND_GAP_MINUTES_MAX),
  formatMix: formatMixSchema,
};

export const strategySchema = z
  .object({
    ...strategyFields,
    /** `true` si la marca nunca guardó: lo que se ve son los defaults. */
    isDefault: z.boolean(),
    /** ISO. `null` con `isDefault`. */
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Strategy = z.infer<typeof strategySchema>;

export const updateStrategyRequestSchema = z.object(strategyFields).strict();
export type UpdateStrategyRequest = z.infer<typeof updateStrategyRequestSchema>;

export const strategyResponseSchema = z.object({ data: strategySchema });

// --- Slots planificados y auto-slot ------------------------------------------------

export const PLANNED_SLOT_STATUSES = ["planned", "converted"] as const;
export const plannedSlotStatusSchema = z.enum(PLANNED_SLOT_STATUSES);

export const plannedSlotSchema = z
  .object({
    _id: z.string().uuid(),
    contentId: contentIdSchema,
    network: strategyNetworkSchema,
    scheduledAtUtc: msEpochSchema,
    status: plannedSlotStatusSchema,
    /** Presente con `converted`: el post que lo reemplazó. */
    postId: z.string().uuid().optional(),
  })
  .strict();
export type PlannedSlot = z.infer<typeof plannedSlotSchema>;

export const autoscheduleRequestSchema = z
  .object({
    /** Limitar a estas redes. Sin esto, todas las activas de la estrategia. */
    networks: z
      .array(strategyNetworkSchema)
      .min(1)
      .max(STRATEGY_NETWORKS.length)
      .optional(),
  })
  .strict();
export type AutoscheduleRequest = z.infer<typeof autoscheduleRequestSchema>;

/**
 * Por qué una red no recibió nada.
 *
 * - `already_scheduled` — esta pieza ya tiene un post vivo o un slot en la red.
 * - `no_free_slot` — no hay ventana con cupo en los próximos 30 días.
 */
export const autoscheduleSkipReasonSchema = z.enum(["already_scheduled", "no_free_slot"]);

export const autoscheduleResultSchema = z
  .object({
    /** Redes con una conexión activa única: post `SCHEDULED`/`BUILDING` real. */
    posts: z.array(postSchema),
    /** Redes sin conexión (o con varias): slot planificado. */
    plannedSlots: z.array(plannedSlotSchema),
    skipped: z.array(
      z
        .object({ network: strategyNetworkSchema, reason: autoscheduleSkipReasonSchema })
        .strict(),
    ),
  })
  .strict();
export type AutoscheduleResult = z.infer<typeof autoscheduleResultSchema>;

// --- Calendario -----------------------------------------------------------------

export const CALENDAR_ITEM_KINDS = ["post", "slot"] as const;
export const calendarItemKindSchema = z.enum(CALENDAR_ITEM_KINDS);
export type CalendarItemKind = z.infer<typeof calendarItemKindSchema>;

export const CALENDAR_BRAND_SCOPES = ["current", "all"] as const;

export const calendarQuerySchema = z
  .object({
    /** ms epoch, inclusivo. */
    from: z.coerce.number().int().nonnegative(),
    /** ms epoch, exclusivo. */
    to: z.coerce.number().int().nonnegative(),
    brands: z.enum(CALENDAR_BRAND_SCOPES).default("current"),
  })
  .strict();
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const calendarNetworkSchema = z.enum([...STRATEGY_NETWORKS, "reddit"]);
export type CalendarNetwork = z.infer<typeof calendarNetworkSchema>;

export const calendarItemSchema = z
  .object({
    kind: calendarItemKindSchema,
    /** Id del post o del slot, según `kind`. */
    id: z.string().uuid(),
    brandId: z.string().uuid(),
    brandName: z.string(),
    contentId: contentIdSchema,
    /** Ausente si la pieza no se encontró (borrada entre medio). */
    contentType: contentTypeSchema.optional(),
    /** La primera imagen o video de la pieza, si ya tiene archivos. */
    thumbnailUrl: z.string().url().optional(),
    /**
     * La red. Además de las de la estrategia, `reddit`: un post programado a
     * mano por `FR-060` puede ser de Reddit, y el calendario lo muestra igual.
     */
    network: calendarNetworkSchema,
    /** El estado de `FR-060` del post, o `PLANNED` para un slot. */
    status: z.union([postStatusSchema, z.literal("PLANNED")]),
    /** Fecha efectiva: `postedAt` si salió, la programada si no. */
    at: msEpochSchema,
    /** Si el calendario puede ofrecer arrastrarlo (sólo lo que no salió). */
    movable: z.boolean(),
    /**
     * Sólo en posts `FAILED`: los mismos `errorCode`/`errorMessage` de `Post`
     * (FR-060: el mensaje es "siempre seguro de mostrar"). Están acá para que
     * "Today" diga por qué falló un post de **cualquier** marca, no sólo de la
     * activa.
     */
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    /** El permalink en la plataforma, si el post salió y se conoce. */
    postUrl: z.string().url().optional(),
  })
  .strict();
export type CalendarItem = z.infer<typeof calendarItemSchema>;

export const calendarCountsSchema = z
  .object({
    posted: z.number().int().nonnegative(),
    inbox: z.number().int().nonnegative(),
    /** `SCHEDULED` + `BUILDING` + slots planificados. */
    scheduled: z.number().int().nonnegative(),
  })
  .strict();
export type CalendarCounts = z.infer<typeof calendarCountsSchema>;

export const calendarSchema = z
  .object({
    items: z.array(calendarItemSchema),
    /** Las marcas incluidas, con su zona. */
    brands: z.array(
      z
        .object({ id: z.string().uuid(), name: z.string(), timezone: z.string() })
        .strict(),
    ),
    /** Globales (no del rango), de las marcas incluidas. Ver FR-110 criterio 1. */
    counts: calendarCountsSchema,
    /** Alguna marca tenía más ítems que el tope por marca en el rango. */
    truncated: z.boolean(),
  })
  .strict();
export type Calendar = z.infer<typeof calendarSchema>;

export const moveCalendarItemRequestSchema = z
  .object({
    scheduledAtUtc: msEpochSchema,
    /** La marca del ítem. Sin esto, la de la request. */
    brandId: z.string().uuid().optional(),
  })
  .strict();
export type MoveCalendarItemRequest = z.infer<typeof moveCalendarItemRequestSchema>;
