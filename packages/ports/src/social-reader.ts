/**
 * Puerto SocialReader — PRD `INT-014`, `FR-011`, `AI-016`, §9.14, §10 regla 7.
 *
 * Qué lo obliga, y por qué está separado de `SocialPublisher`: `INT-014` lo
 * dice como requisito, no como sugerencia — «el alcance de lectura para marca
 * debe poder concederse **sin** conceder publicación, para no obligar a
 * comprometerse a publicar sólo para darse de alta». La regla 7 transversal de
 * §10 lo repite en los dos sentidos: «conectar para analizar no debe implicar
 * conceder publicación, ni al revés». Dos puertos es la forma de que eso no
 * dependa de que alguien se acuerde: un módulo que sólo recibe `SocialReader`
 * no tiene cómo publicar aunque quiera.
 *
 * `INT-014` además fija que esto es **estrictamente de lectura**: «Datos
 * enviados: ninguno». No hay método de escritura en esta interfaz y no debe
 * haberlo.
 *
 * La forma de la interfaz la fija §9.14: «un **extractor por plataforma**
 * detrás de una interfaz común, más un sintetizador único que consume
 * cualquier snapshot. **Añadir una plataforma nueva debe ser escribir un
 * extractor, no tocar el resto del sistema**». Por eso el puerto está atado a
 * una fuente ({@link SocialReader.source}) en vez de recibir la plataforma por
 * parámetro.
 *
 * Y por qué hay {@link SocialReadCapabilities}: `OQ-19` dice que «es probable
 * que la cobertura útil sin OAuth sea desigual entre las cinco», y
 * `P1-BRAND-002` manda hacer el spike **antes** de escribir los extractores.
 * Un puerto que asumiera que las cinco plataformas exponen lo mismo estaría
 * decidiendo por adelantado lo que el spike todavía no sabe.
 *
 * Errores y resultados — la división importa:
 *  - `not_found`, `private` e `insufficient_content` son **resultados**, no
 *    excepciones. `INT-014` los lista como errores, pero §19.5.1 fija el
 *    principio rector: «ninguno bloquea el alta. Como mucho degradan al tier D
 *    y piden ayuda concreta». La escalera B → C → A → D de `FR-011.4` es
 *    control de flujo normal, y escribirla con `try/catch` la volvería ilegible.
 *    Ver {@link SocialReadOutcome}.
 *  - `PortError` queda para las fallas de infraestructura: `rate_limited`
 *    (`ERR-B08`: «We'll keep trying in the background»), `provider_unavailable`
 *    (`ERR-B07`), `timeout`, `unauthorized` (token del tier A vencido),
 *    `bad_request` (entrada que no resuelve a ninguna fuente, `ERR-B02`),
 *    `forbidden` (la URL cayó en la protección SSRF de `NFR-017` — host
 *    bloqueado, IP privada, localhost).
 *
 * Lo que este puerto NO hace: no transcribe ni hace OCR. Devuelve
 * {@link SocialContentItem.mediaUrls} y la etapa de enriquecimiento de `AI-016`
 * los pasa por `Ocr`/`Asr` **en memoria**, sin persistirlos (`DATA-032`).
 */

/**
 * Las cinco de `D-02`, más los orígenes no sociales de `FR-011.1`.
 *
 * Es el enum `brand_source_type` de `DATA-031` **menos `manual`**, a propósito:
 * una fuente manual es texto que pega el usuario (tier D), no algo que este
 * puerto lea. `@fastgram/core` la vuelve a sumar (`CoreBrandSourceType`).
 * `scripts/check-consistency.mjs` compara esta lista con `packages/db` y
 * `packages/contracts` exigiendo que la **única** diferencia sea `manual`.
 * Orden: el del `CREATE TYPE`, sin `manual`.
 */
export const BRAND_SOURCE_TYPES = [
  "website",
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
  "other_url",
] as const;
export type BrandSourceType = (typeof BRAND_SOURCE_TYPES)[number];

/**
 * Niveles de `FR-011.4`, en runtime y como fuente única del tipo.
 *
 * **Los cuatro nombres son literales del PRD** (tabla de `acquisitionTier` en
 * `DATA-031`, y el evento `brand_source_analysis_completed` de §20), y además
 * son los valores del enum `acquisition_tier` de Postgres
 * (`packages/db/drizzle/0000_initial_schema.sql`). No son nombres de este
 * puerto: renombrar cualquiera de los cuatro exige una migración de la base,
 * así que acá no se tocan.
 *
 * Esto es una lista y no una unión suelta por dos razones concretas, las dos
 * aprendidas del bug de `P1-BRAND-013`:
 *
 *  1. El comentario que estaba acá afirmaba que «sólo `A_oauth` aparece
 *     literal en el PRD» y que «sólo el prefijo A/B/C/D es normativo». Era
 *     falso, y de esa creencia salió la divergencia: este puerto llamó
 *     `C_rendered_fetch` a lo que la base llama `C_page_fetch`, y
 *     `acquisitionPlan()` de `@fastgram/core` quedó pudiendo devolver un
 *     valor que Postgres rechaza con
 *     `invalid input value for enum acquisition_tier`. No explotaba sólo
 *     porque el tier C está apagado hasta `OQ-16`.
 *  2. Una unión de literales no se puede leer desde fuera de TypeScript. Con
 *     la lista, `scripts/check-consistency.mjs` y el test de paridad de
 *     `@fastgram/core` pueden compararla contra `packages/db` y
 *     `packages/contracts` sin importarlos —que es justo lo que `ports` no
 *     puede hacer, y por eso el bug vivió sin que nada lo viera.
 *
 * El orden es el de la escalera B → C → A → D leído como A/B/C/D, y coincide
 * con el orden del `CREATE TYPE` de la migración.
 */
export const ACQUISITION_TIERS = [
  /** API oficial con el OAuth del propio usuario. La mejor señal. */
  "A_oauth",
  /** API pública oficial / oEmbed / OpenGraph. El punto de partida (`D-01`). */
  "B_public_api",
  /** Fetch de la página pública renderizada. Apagado hasta `OQ-16`. */
  "C_page_fetch",
  /** Asistido: el usuario pega su bio o sube capturas. No pasa por este puerto. */
  "D_assisted",
] as const;

/**
 * Derivado de {@link ACQUISITION_TIERS} a propósito: si el tipo se escribiera
 * aparte, volvería a poder divergir de la lista sin que nada se queje.
 */
export type AcquisitionTier = (typeof ACQUISITION_TIERS)[number];

/** §9.14 y `FR-011.3`: 24 ítems por análisis, configurable. */
export const DEFAULT_CONTENT_ITEMS = 24;

/** `INT-018` / §9.14: un nivel de enlaces, cinco destinos, sin recursión. */
export const LINK_IN_BIO_MAX_DEPTH = 1;
export const LINK_IN_BIO_MAX_DESTINATIONS = 5;

/* ------------------------------------------------------------------------ *
 * Señales
 * ------------------------------------------------------------------------ */

/**
 * Unión de lo que las seis fuentes de `FR-011.3` exponen. Todo opcional
 * porque **ninguna plataforma las da todas**, y cuáles da cada una lo dice
 * {@link SocialReadCapabilities.profileSignals} en vez de que quien llama lo
 * adivine.
 */
export interface SocialProfileSignals {
  readonly displayName?: string;
  readonly handle?: string;
  readonly bio?: string;
  /** Categoría de negocio declarada (Instagram) o industria (LinkedIn). */
  readonly category?: string;
  readonly tagline?: string;
  readonly about?: string;
  readonly companySize?: string;
  readonly headquarters?: string;
  readonly location?: string;
  readonly country?: string;
  /** Link en bio y demás enlaces salientes. Entrada de `INT-018`. */
  readonly links?: readonly string[];
  readonly avatarUrl?: string;
  readonly followerCount?: number;
  readonly followingCount?: number;
  /** TikTok: likes totales de la cuenta. */
  readonly likeCount?: number;
  readonly subscriberCount?: number;
  /** Instagram: títulos de highlights. */
  readonly highlights?: readonly string[];
}

export type ProfileSignal = keyof SocialProfileSignals;

export type SocialContentKind =
  "image" | "carousel" | "video" | "short" | "text" | "other";

export interface SocialEngagement {
  readonly likes?: number;
  readonly comments?: number;
  readonly views?: number;
  readonly shares?: number;
}

export interface SocialContentItem {
  readonly externalId: string;
  readonly kind: SocialContentKind;
  /** Permalink público. Va a `remixSourceUrl` cuando aplica (`AI-003`). */
  readonly permalink?: string;
  readonly caption?: string;
  /** Título, donde la plataforma lo separa de la descripción (YouTube). */
  readonly title?: string;
  readonly hashtags: readonly string[];
  readonly mentions: readonly string[];
  readonly postedAt?: Date;
  /**
   * `AI-016` pondera por engagement: «lo que más funcionó pesa más al inferir
   * tono y audiencia». Sin esto, el orden de los ítems no significa nada.
   */
  readonly engagement: SocialEngagement;
  /**
   * URLs de media para la etapa de enriquecimiento (OCR en Fase 1, ASR en
   * Fase 2). **Se descargan a memoria y se descartan** (`DATA-032`): no se
   * guardan ni se sirven.
   */
  readonly mediaUrls: readonly string[];
  /** TikTok: sonido usado (`FR-011.3`). */
  readonly soundId?: string;
  /** X: post fijado (`FR-011.3`). */
  readonly isPinned?: boolean;
  /** Comentarios destacados, cuando la plataforma los expone. */
  readonly topComments?: readonly string[];
}

export type ContentSignal = keyof SocialContentItem;

/* ------------------------------------------------------------------------ *
 * Capacidades
 * ------------------------------------------------------------------------ */

export interface SocialReadCapabilities {
  readonly source: BrandSourceType;
  /**
   * Tiers que este adaptador sabe usar, en el orden de preferencia de
   * `FR-011.4` (`B → C → A → D`). Un adaptador que sólo hace tier B declara
   * uno solo; el orquestador ve el hueco en vez de descubrirlo fallando.
   */
  readonly tiers: readonly AcquisitionTier[];
  /** Qué campos de {@link SocialProfileSignals} puede traer. */
  readonly profileSignals: readonly ProfileSignal[];
  /** Qué campos de {@link SocialContentItem} puede traer. */
  readonly contentSignals: readonly ContentSignal[];
  /** Techo real de ítems. Puede ser menor que {@link DEFAULT_CONTENT_ITEMS}. */
  readonly maxContentItems: number;
  /** `true` si sin `Connection` (tier A) no lee nada. */
  readonly requiresConnection: boolean;
  /**
   * `false` mientras `OQ-16` siga abierto y el tier C esté apagado
   * (`P1-BRAND-013`). Es una bandera de configuración, no del código.
   */
  readonly renderedFetchEnabled: boolean;
}

/* ------------------------------------------------------------------------ *
 * Resultados
 * ------------------------------------------------------------------------ */

export interface SocialReadOk<T> {
  readonly status: "ok";
  /**
   * Con qué tier se resolvió de verdad.
   *
   * `FR-011.4` pide que **la UI nunca lo exponga**, salvo cuando degrada a D.
   * El puerto igual lo devuelve: el orquestador lo necesita para decidir si
   * ofrecer el upgrade a OAuth, y `DATA-032` lo persiste en el snapshot.
   */
  readonly tier: AcquisitionTier;
  readonly data: T;
}

export interface SocialReadUnavailable {
  /**
   * `not_found` → `ERR-B04`. `private` → `ERR-B05`. `insufficient_content` →
   * `ERR-B09`. Los tres degradan; ninguno bloquea el alta (§19.5.1).
   */
  readonly status: "not_found" | "private" | "insufficient_content";
  /** Qué se intentó antes de rendirse. Alimenta el siguiente escalón y el log. */
  readonly attemptedTiers: readonly AcquisitionTier[];
}

export type SocialReadOutcome<T> = SocialReadOk<T> | SocialReadUnavailable;

/**
 * Lo que devuelve `POST /brand/sources/resolve` (§9.14): «sin crear nada.
 * Alimenta la detección en vivo del input. Idempotente y barato».
 */
export interface ResolvedSocialSource {
  readonly sourceType: BrandSourceType;
  readonly handle: string;
  readonly canonicalUrl: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  /** `false` ⇒ existe la forma pero no la cuenta. `ERR-B04`. */
  readonly available: boolean;
  /**
   * `true` si la entrada era un enlace a un post concreto y se resolvió al
   * perfil de su autor. `FR-011.1` obliga a avisarlo (`ERR-B12`).
   */
  readonly resolvedFromPost?: boolean;
}

export interface ResolveSourceRequest {
  /** Texto libre: URL con o sin esquema, o `@handle`. `FR-011.1`. */
  readonly input: string;
}

export interface ReadProfileRequest {
  readonly handle: string;
  /**
   * Credencial del tier A, ya descifrada por quien llama. El puerto nunca la
   * guarda ni la devuelve (`NFR-007`). Sin esto, el adaptador intenta B/C.
   */
  readonly accessToken?: string;
}

export interface ReadContentRequest extends ReadProfileRequest {
  /** Default {@link DEFAULT_CONTENT_ITEMS}, techo {@link SocialReadCapabilities.maxContentItems}. */
  readonly limit?: number;
}

/* ------------------------------------------------------------------------ *
 * El puerto
 * ------------------------------------------------------------------------ */

export interface SocialReader {
  /** Una implementación por plataforma (`P1-BRAND-001`). */
  readonly source: BrandSourceType;

  /** Estático por adaptador. No hace red. */
  capabilities(): SocialReadCapabilities;

  /** Detección en vivo del input. No crea nada y no consume presupuesto. */
  resolve(
    request: ResolveSourceRequest,
  ): Promise<SocialReadOutcome<ResolvedSocialSource>>;

  /** Señales de perfil de `FR-011.3`. */
  readProfile(
    request: ReadProfileRequest,
  ): Promise<SocialReadOutcome<SocialProfileSignals>>;

  /**
   * Últimos N ítems, **ordenados del más reciente al más viejo**. El orden es
   * parte del contrato: `AI-016` pondera por engagement y `FR-011.3` habla de
   * «últimos N ítems»; sin un orden fijo, dos adaptadores darían perfiles
   * distintos para la misma cuenta.
   */
  readRecentContent(
    request: ReadContentRequest,
  ): Promise<SocialReadOutcome<readonly SocialContentItem[]>>;
}
