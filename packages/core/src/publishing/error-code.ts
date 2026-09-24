/**
 * Traducción de un fallo de publicación a `errorCode` — `P3-PUB-006`, PRD
 * `DP-006` (§25.1), §10 regla 6, `FR-060`, `DATA-020`.
 *
 * §10 regla 6: «Los errores de plataforma se traducen a **códigos estables
 * neutrales respecto al proveedor** antes de mostrarse». `DP-006` fija el
 * mecanismo: «una tabla de mapeo determinística debe ser la primera línea; el
 * juicio sólo entra para lo que no matchea», y §25.3 lo repite: «`DP-006` no
 * tiene feature propia: se resuelve con tabla determinística y sólo escala al
 * puerto lo que no matchea». Esto es esa tabla. Sin I/O y sin modelo.
 *
 * ## Qué entra
 *
 * Lo que el puerto `SocialPublisher` expone de un fallo: un
 * {@link PublishFailureReason} ya neutral —el adaptador tradujo el crudo— y la
 * plataforma. El puerto lo dice en su cabecera: `instagram_repeated_mention`
 * «se compone como plataforma + `repeated_mention`», y la composición no es
 * del puerto. Acá se hace, pero **por tabla y no por concatenación**: el PRD
 * no enumera `linkedin_post_limit_exceeded` ni `tiktok_repeated_mention`, y
 * concatenar los inventaría.
 *
 * El `message` del fallo entra (para que quien escale a `Judgment` lo tenga a
 * mano) y **no sale**: todo lo que devuelve esta función son constantes de
 * este archivo. Un test lo verifica con un mensaje centinela.
 *
 * ## Qué sale — tres resultados, no dos
 *
 * - `coded` — el PRD enumera un código literal para este caso.
 * - `uncoded` — el caso está clasificado sin ambigüedad (no hay nada que
 *   *entender*, así que no es para `Judgment`: §25.2, «si el resultado se
 *   puede … enumerar con certeza, es código»), pero **el PRD no enumera
 *   `errorCode` para él**. Se devuelve la referencia al catálogo de §19 y su
 *   copy literal cuando aplica, y **ningún código**. Inventarlo acá lo
 *   convertiría en contrato.
 * - `escalate` — no hay mapeo determinístico: `unknown`, o un valor que el
 *   puerto no declara (un adaptador de una versión más nueva). Es lo único que
 *   `DP-006` manda al puerto `Judgment`.
 *
 * Separar `uncoded` de `escalate` es la decisión que importa: si se colapsaran,
 * cada `permissions_missing` terminaría en un modelo para que «decida» algo que
 * ya está decidido.
 *
 * ## Códigos que el PRD enumera literalmente para un fallo de `Post`
 *
 * - `tiktok_post_limit_exceeded`, `youtube_post_limit_exceeded`,
 *   `instagram_post_limit_exceeded` — FR-060 «Límites de plataforma
 *   diferenciados», INT-001/002/003, ERR-R05.
 * - `instagram_repeated_mention` — FR-060, INT-002, DP-006.
 * - `rate_limited` — FR-060: «`429 rate_limited` (límite de plataforma o cuota
 *   de caption)». Es el **genérico** que el PRD define para «límite de
 *   plataforma», y por eso cubre `post_limit_exceeded` en LinkedIn y Reddit,
 *   para los que no hay código diferenciado.
 *
 * `tiktok_creator_info_unavailable` también es literal, pero sale de
 * `getAccountOptions` como `PortError`, no de un `PublishFailure`: no es de
 * esta tabla. §19.5 (ERR-D01…D16) es copy, no códigos.
 */

import type {
  PublishFailure,
  PublishFailureReason,
  PublishPlatform,
} from "@fastgram/ports";

/**
 * Los motivos del puerto, en runtime. El puerto los declara como unión de
 * tipos, así que la lista se escribe acá y tres cosas la atan a él:
 * `satisfies` (no puede tener uno que el puerto no tenga), un test que la
 * compara con las claves de {@link PUBLISH_ERROR_TABLE} (que el compilador
 * obliga a ser exhaustiva), y `scripts/check-consistency.mjs` leyendo el texto
 * de los dos archivos.
 */
export const PUBLISH_FAILURE_REASONS = [
  "post_limit_exceeded",
  "repeated_mention",
  "permissions_missing",
  "account_changed",
  "privacy_level_not_allowed",
  "unsupported_media",
  "unknown",
] as const satisfies readonly PublishFailureReason[];

/** Los únicos `errorCode` que esta tabla puede emitir. Todos literales del PRD. */
export const PUBLISH_ERROR_CODES = [
  "tiktok_post_limit_exceeded",
  "instagram_post_limit_exceeded",
  "youtube_post_limit_exceeded",
  "instagram_repeated_mention",
  "rate_limited",
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

/** Entradas del catálogo de errores de PRD §19 a las que la tabla apunta. */
export type PublishErrorCatalogRef =
  "ERR-R05" | "ERR-D03" | "ERR-D05" | "ERR-D06" | "ERR-D16" | "ERR-P11";

/** Copy **literal** de PRD §19. Sólo donde es verdad para un post fallido. */
export interface PublishErrorCopy {
  readonly title?: string;
  readonly body?: string;
}

export type PublishErrorTranslation =
  | {
      readonly kind: "coded";
      readonly errorCode: PublishErrorCode;
      readonly catalogRef: PublishErrorCatalogRef | null;
      readonly copy: PublishErrorCopy | null;
    }
  | {
      readonly kind: "uncoded";
      readonly catalogRef: PublishErrorCatalogRef | null;
      readonly copy: PublishErrorCopy | null;
    }
  | { readonly kind: "escalate"; readonly decisionPoint: "DP-006" };

export interface PublishFailureInput {
  readonly platform: PublishPlatform;
  readonly failure: PublishFailure;
}

/* ------------------------------------------------------------------------ *
 * Celdas. Constantes congeladas y compartidas: la salida no puede llevar
 * nada que no esté escrito acá.
 * ------------------------------------------------------------------------ */

function coded(
  errorCode: PublishErrorCode,
  catalogRef: PublishErrorCatalogRef | null = null,
): PublishErrorTranslation {
  return Object.freeze({ kind: "coded", errorCode, catalogRef, copy: null });
}

function uncoded(
  catalogRef: PublishErrorCatalogRef | null,
  copy: PublishErrorCopy | null = null,
): PublishErrorTranslation {
  return Object.freeze({
    kind: "uncoded",
    catalogRef,
    copy: copy === null ? null : Object.freeze({ ...copy }),
  });
}

const ESCALATE: PublishErrorTranslation = Object.freeze({
  kind: "escalate",
  decisionPoint: "DP-006",
});

/** `FR-060` genérico para «límite de plataforma» sin código diferenciado. */
const LIMITE_GENERICO = coded("rate_limited");

/** Clasificado, sin código ni copy en el PRD para esta plataforma. */
const SIN_CODIGO = uncoded(null);

/** ERR-D03 · `Permissions Missing` / `Reconnect to upgrade permissions`. */
const PERMISOS_D03 = uncoded("ERR-D03", {
  title: "Permissions Missing",
  body: "Reconnect to upgrade permissions",
});

/**
 * ERR-D06. El cuerpo nombra a Instagram literalmente, así que fuera de
 * Instagram sólo vale el título.
 */
const CUENTA_CAMBIADA_D06 = uncoded("ERR-D06", { title: "Connected Account Changed" });

/**
 * ERR-P11 es el que el puerto asocia a `unsupported_media` («la plataforma
 * rechazó el archivo»). La copy de §19.6 es de lectura de metadatos del
 * video; se devuelve la referencia **sin** copy porque «We couldn't read this
 * video's details» no describe un rechazo de la plataforma.
 */
const MEDIA_P11 = uncoded("ERR-P11");

/**
 * La tabla. Un `Record` sobre las dos uniones: agregar un motivo al puerto o
 * una plataforma a `PUBLISH_PLATFORMS` deja de compilar hasta que alguien
 * decida la celda. Celdas explícitas y no un default, por la misma razón.
 */
export const PUBLISH_ERROR_TABLE: {
  readonly [R in PublishFailureReason]: {
    readonly [P in PublishPlatform]: PublishErrorTranslation;
  };
} = Object.freeze({
  // FR-060, INT-001/002/003, ERR-R05. LinkedIn y Reddit: el genérico de FR-060.
  post_limit_exceeded: Object.freeze({
    tiktok: coded("tiktok_post_limit_exceeded", "ERR-R05"),
    instagram: coded("instagram_post_limit_exceeded", "ERR-R05"),
    youtube: coded("youtube_post_limit_exceeded", "ERR-R05"),
    linkedin: LIMITE_GENERICO,
    reddit: LIMITE_GENERICO,
    // D-09: Threads (250/24 h), Facebook Pages (30 reels/24 h) y X no tienen
    // código diferenciado en el PRD: el genérico de FR-060, igual que LinkedIn.
    x: LIMITE_GENERICO,
    threads: LIMITE_GENERICO,
    facebook: LIMITE_GENERICO,
  }),

  // FR-060, INT-002, DP-006. `captionAdjustmentReason` «actualmente sólo vale
  // `repeated_mention`» y sólo Instagram lo produce: fuera de ahí no hay código.
  repeated_mention: Object.freeze({
    tiktok: SIN_CODIGO,
    instagram: coded("instagram_repeated_mention"),
    youtube: SIN_CODIGO,
    linkedin: SIN_CODIGO,
    reddit: SIN_CODIGO,
    x: SIN_CODIGO,
    threads: SIN_CODIGO,
    facebook: SIN_CODIGO,
  }),

  // ERR-D05 es el de TikTok con copy propia; ERR-D03 el general.
  permissions_missing: Object.freeze({
    tiktok: uncoded("ERR-D05", {
      body: "TikTok permissions are missing. Please disconnect and reconnect your account.",
    }),
    instagram: PERMISOS_D03,
    youtube: PERMISOS_D03,
    linkedin: PERMISOS_D03,
    reddit: PERMISOS_D03,
    x: PERMISOS_D03,
    threads: PERMISOS_D03,
    facebook: PERMISOS_D03,
  }),

  account_changed: Object.freeze({
    tiktok: CUENTA_CAMBIADA_D06,
    instagram: uncoded("ERR-D06", {
      title: "Connected Account Changed",
      body: "A different Instagram account was connected. Open the connect flow again and choose the matching account.",
    }),
    youtube: CUENTA_CAMBIADA_D06,
    linkedin: CUENTA_CAMBIADA_D06,
    reddit: CUENTA_CAMBIADA_D06,
    x: CUENTA_CAMBIADA_D06,
    threads: CUENTA_CAMBIADA_D06,
    facebook: CUENTA_CAMBIADA_D06,
  }),

  // ERR-D16 es de TikTok (privacy levels = INT-001). Su copy **afirma** «Your
  // post was sent to your inbox instead»: sólo es verdad si el estado es
  // `in_user_inbox`, y esta tabla se consulta sobre un `failed`. Referencia sin
  // copy. Fuera de TikTok el motivo no tiene sentido y no hay entrada.
  privacy_level_not_allowed: Object.freeze({
    tiktok: uncoded("ERR-D16"),
    instagram: SIN_CODIGO,
    youtube: SIN_CODIGO,
    linkedin: SIN_CODIGO,
    reddit: SIN_CODIGO,
    x: SIN_CODIGO,
    threads: SIN_CODIGO,
    facebook: SIN_CODIGO,
  }),

  unsupported_media: Object.freeze({
    tiktok: MEDIA_P11,
    instagram: MEDIA_P11,
    youtube: MEDIA_P11,
    linkedin: MEDIA_P11,
    reddit: MEDIA_P11,
    x: MEDIA_P11,
    threads: MEDIA_P11,
    facebook: MEDIA_P11,
  }),

  // Lo único que DP-006 delega: no hay nada determinístico que mirar.
  unknown: Object.freeze({
    tiktok: ESCALATE,
    instagram: ESCALATE,
    youtube: ESCALATE,
    linkedin: ESCALATE,
    reddit: ESCALATE,
    x: ESCALATE,
    threads: ESCALATE,
    facebook: ESCALATE,
  }),
});

/**
 * Traduce un fallo de publicación. Pura: misma entrada, mismo resultado, y el
 * resultado es siempre una celda de {@link PUBLISH_ERROR_TABLE}.
 *
 * Un motivo o una plataforma que no están en la tabla —llegan como `string` de
 * una fila o de un adaptador más nuevo que este código— **escalan** en vez de
 * lanzar: un fallo de publicación ya ocurrió, y romper al traducirlo dejaría
 * la fila sin cerrar.
 */
export function translatePublishFailure(
  input: PublishFailureInput,
): PublishErrorTranslation {
  const table: Readonly<
    Record<string, Readonly<Record<string, PublishErrorTranslation>>>
  > = PUBLISH_ERROR_TABLE;
  const reason: string = input.failure.reason;
  const platform: string = input.platform;
  if (!Object.hasOwn(table, reason)) return ESCALATE;
  const row = table[reason];
  if (row === undefined || !Object.hasOwn(row, platform)) return ESCALATE;
  return row[platform] ?? ESCALATE;
}

export * from "./guards.js";

/* ------------------------------------------------------------------------ *
 * Fallback estable — `P3-PUB-006` (sprint 7)
 * ------------------------------------------------------------------------ */

/**
 * El código **genérico** para un fallo de plataforma que ninguna celda de la
 * tabla clasifica (`escalate`: `unknown`, o un motivo que el puerto no
 * declara). No lo enumera el PRD: es nuestro, neutral y estable, como los de
 * {@link PUBLISH_WORKER_ERROR_CODES}. `DP-006` manda esos casos a `Judgment`;
 * mientras ese escalado no exista, la fila **no** se queda con el motivo crudo
 * de un adaptador más nuevo: se queda con esto.
 */
export const PUBLISH_GENERIC_ERROR_CODE = "publish_failed";

/** Copy nuestro para el fallo genérico. Nunca el mensaje del proveedor. */
export const PUBLISH_GENERIC_ERROR_MESSAGE =
  "The platform couldn't publish this post. Check the account and try again.";

/**
 * `errorCode` + `errorMessage` de un fallo que devolvió la plataforma, listos
 * para la fila. `coded` → el código del PRD; `uncoded` → el motivo neutral del
 * puerto (ya es estable); `escalate` → {@link PUBLISH_GENERIC_ERROR_CODE} con
 * {@link PUBLISH_GENERIC_ERROR_MESSAGE}: un motivo que nadie clasificó no tiene
 * garantía de que su mensaje sea «seguro de mostrar».
 */
export function stablePublishError(
  platform: string,
  failure: { readonly reason: string; readonly message: string },
): { readonly errorCode: string; readonly errorMessage: string } {
  const translation = translatePublishFailure({
    platform: platform as PublishPlatform,
    failure: failure as PublishFailure,
  });
  if (translation.kind === "coded") {
    return { errorCode: translation.errorCode, errorMessage: failure.message };
  }
  if (translation.kind === "uncoded") {
    return { errorCode: failure.reason, errorMessage: failure.message };
  }
  return {
    errorCode: PUBLISH_GENERIC_ERROR_CODE,
    errorMessage: PUBLISH_GENERIC_ERROR_MESSAGE,
  };
}
