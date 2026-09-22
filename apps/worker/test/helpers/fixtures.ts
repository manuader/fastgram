/**
 * Fixtures de integración del worker.
 *
 * Lo que hace falta sembrar acá es distinto de lo de `apps/api`: no hay API
 * keys ni recursos de listado. Lo que se necesita es **una pieza con un cargo
 * hecho**: `contents` en `BUILDING` con su `saveBucket` y su `savePeriod`, y el
 * `quota_ledgers` del período con el contador ya movido. Sin las dos cosas, el
 * reembolso no tiene nada que devolver y el test mediría un camino vacío.
 *
 * Se inserta con el query builder y fuera de scope (`withoutCompany`) a
 * propósito, igual que en `apps/api/test/helpers/fixtures.ts`: es código de
 * fixture, no de request. El `companyId` va explícito en cada fila, así que no
 * hay ningún `WHERE` de tenant que olvidar.
 */
import {
  companies,
  connections,
  contents,
  createDb,
  migrateWithUrl,
  posts,
  users,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import { randomUUID } from "node:crypto";

/**
 * La base de los tests de integración del worker — **propia, y se crea sola**.
 *
 * No puede ser la misma que la de `apps/api`: sus fixtures arrancan con un
 * `truncate … restart identity cascade` sobre `companies` y `contents`, que son
 * justo las tablas que siembra esta suite. Con las dos apuntando a `fastgram`,
 * `pnpm test:int` (que las corre por turbo) le borra las filas a esta **en medio
 * de un test**, y el fallo se ve como un bug propio: piezas que desaparecen,
 * ledgers en cero. La primera corrida pasó igual, por timing, que es la peor
 * forma de tenerlo.
 *
 * El nombre se **deriva** del `DATABASE_URL` compartido en vez de ser un literal
 * aparte: así un `DATABASE_URL` distinto —CI usa `fastgram_test`— arrastra su
 * propia base de worker sin que haya que acordarse de pasar dos variables.
 *
 * Y la crea `ensureDatabase()` desde el `globalSetup`, en vez de pedirla en el
 * `docker-compose`: un `initdb` sólo corre con el volumen vacío, así que a quien
 * ya tiene el contenedor levantado no le llegaría nunca y su `test:int` fallaría
 * con un *"database … does not exist"* que no dice qué hacer.
 */
export const DATABASE_URL = workerDatabaseUrl(
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram",
);

/** `…/fastgram` → `…/fastgram_worker`. Respeta el resto de la URL tal cual. */
export function workerDatabaseUrl(shared: string): string {
  const url = new URL(shared);
  const nombre = url.pathname.replace(/^\//, "");
  if (nombre === "" || nombre.endsWith("_worker")) return shared;
  url.pathname = `/${nombre}_worker`;
  return url.toString();
}

/**
 * Crea la base del worker si falta y le aplica las migraciones.
 *
 * `CREATE DATABASE` no admite `IF NOT EXISTS` en Postgres, así que se pregunta
 * primero. Se conecta a `postgres`, la base de mantenimiento, porque no se puede
 * crear una base desde dentro de sí misma.
 */
export async function ensureDatabase(): Promise<void> {
  const nombre = new URL(DATABASE_URL).pathname.replace(/^\//, "");

  const mantenimiento = new URL(DATABASE_URL);
  mantenimiento.pathname = "/postgres";
  // Por `createDb` y no por `postgres` directo: `postgres` no es dependencia de
  // `apps/worker` y agregarla para esto sería sumar un paquete al `package.json`
  // por cuatro líneas de fixture. `handle.sql` **es** el cliente crudo.
  const admin = createDb({ url: mantenimiento.toString(), max: 1, onnotice: () => {} });
  try {
    const filas = await admin.sql`select 1 from pg_database where datname = ${nombre}`;
    if (filas.length === 0) {
      // `unsafe` porque un identificador no se puede parametrizar. El nombre sale
      // de nuestro propio `DATABASE_URL`, no de la red, y se acota igual.
      if (!/^[a-z_][a-z0-9_]*$/.test(nombre)) {
        throw new Error(`nombre de base inválido: ${JSON.stringify(nombre)}`);
      }
      await admin.sql.unsafe(`create database ${nombre}`);
    }
  } finally {
    await admin.close();
  }

  await migrateWithUrl(DATABASE_URL);
}

export function openDb(): DbHandle {
  return createDb({ url: DATABASE_URL, max: 4, onnotice: () => {} });
}

/** El período de facturación que usan los fixtures. Fijo: el reloj de los tests también. */
export const PERIOD = "2026-09-01";

export const CANVAS = { width: 1080, height: 1920 };
export const MEDIA = {
  url: "https://cdn.example.test/a.mp4",
  drawX: 0,
  drawY: 0,
  drawW: 1080,
  drawH: 1920,
};
export const TEXTO = {
  content: "hola",
  x: 50,
  y: 50,
  width: 800,
  fontSize: 48,
  color: "#FFFFFF",
  textAlign: "center",
};
/** El mismo payload que crea `POST /content` en su propia suite. Sin audio: FR-053.1. */
export const WALL_OF_TEXT = { canvas: CANVAS, video: MEDIA, text: TEXTO };

export interface SeededPiece {
  readonly companyId: string;
  readonly contentId: string;
}

export async function seedCompany(handle: DbHandle): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `ext-${randomUUID()}`,
        email: `owner-${randomUUID()}@example.test`,
        fullName: "Owner de prueba",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");

    const [company] = await tx
      .insert(companies)
      .values({
        name: `worker-${randomUUID()}`,
        ownerUserId: user.id,
        status: "active",
        planId: "growth",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");
    return company.id;
  });
}

export interface SeedPieceOptions {
  readonly type?: "wall-of-text" | "slideshow" | "custom";
  readonly status?: "BUILDING" | "CREATED" | "FAILED";
  readonly buildPayload?: unknown;
  /** `null` = la pieza no cobró save (el caso de `POST /content/custom/video`). */
  readonly saveBucket?: "included" | "purchased" | "overage" | null;
  readonly revision?: number;
  readonly saveRefundedAt?: Date;
}

/**
 * Una pieza cobrada, con su ledger.
 *
 * El contador que sube no es decoración: el reembolso tiene que poder **bajar**
 * algo, y contra un ledger en cero `refundSave` no tiene de dónde restar. El
 * test quedaría verde sin probar nada.
 */
export async function seedPiece(
  handle: DbHandle,
  companyId: string,
  options: SeedPieceOptions = {},
): Promise<string> {
  const bucket = options.saveBucket === undefined ? "included" : options.saveBucket;

  // El cargo **se acumula**: cada pieza cobrada suma uno, igual que hace
  // `consumeContentSave` en la API. Con un `ON CONFLICT DO NOTHING` sólo la
  // primera pieza del workspace dejaba contador, y a partir de la segunda el
  // ledger llegaba en cero: el reembolso no tenía de dónde restar y los tests de
  // reembolso pasaban sin probar nada. Se ve idéntico a un test verde.
  //
  // Va por `handle.sql` —el cliente crudo de postgres.js— y no por el query
  // builder porque `drizzle-orm` **no es alcanzable desde una app**, y eso es a
  // propósito: es lo que impide que un proceso arme su propio `WHERE` y se
  // olvide el tenant. Un fixture que escribe contabilidad directo es código de
  // fixture, no de request.
  await handle.sql`
    insert into quota_ledgers (company_id, period, content_saves_included, content_saves_used)
    values (${companyId}::uuid, ${PERIOD}, 500, ${bucket === null ? 0 : 1})
    on conflict (company_id, period) do update
      set content_saves_used = quota_ledgers.content_saves_used + ${bucket === null ? 0 : 1}
  `;

  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(contents)
      .values({
        companyId,
        type: options.type ?? "wall-of-text",
        status: options.status ?? "BUILDING",
        revision: options.revision ?? 1,
        buildPayload:
          options.buildPayload === undefined ? WALL_OF_TEXT : options.buildPayload,
        ...(bucket === null ? {} : { saveBucket: bucket, savePeriod: PERIOD }),
        ...(options.saveRefundedAt === undefined
          ? {}
          : { saveRefundedAt: options.saveRefundedAt }),
      })
      .returning({ id: contents.id });
    if (row === undefined) throw new Error("no se creó el content");
    return row.id;
  });
}

export interface SeedSwipesOptions {
  readonly period?: string;
  readonly used: number;
  /** `null` = ese workspace nunca hizo un swipe, así que no tiene reloj diario. */
  readonly resetAt: Date | null;
  /** Para comprobar que el barrido no los toca. */
  readonly contentSavesUsed?: number;
  readonly contentSavesPurchased?: number;
}

/**
 * Un ledger con el contador de swipes diarios en un estado concreto.
 *
 * Va por `handle.sql` y no por `writeDailySwipes` porque el barrido tiene que
 * encontrarse con filas que **ya estaban** vencidas, incluido el caso de
 * `daily_swipe_reset_at` nulo, que el repositorio no puede escribir. Es
 * provisión, no camino de aplicación.
 *
 * El instante viaja como **texto ISO** con `::timestamptz` y no como `Date`:
 * `handle.sql` es el mismo cliente postgres.js que `drizzle()` recibió, y
 * drizzle le cambia los serializadores (trampa 18), así que un `Date` puesto
 * como parámetro llega crudo al protocolo y postgres.js muere con *"The
 * \"string\" argument must be … Received an instance of Date"*. Medido: los 12
 * tests de esta suite fallaban en el bind, no en la lógica.
 */
export async function seedSwipes(
  handle: DbHandle,
  companyId: string,
  options: SeedSwipesOptions,
): Promise<string> {
  const period = options.period ?? PERIOD;
  const reset = options.resetAt === null ? null : options.resetAt.toISOString();
  await handle.sql`
    insert into quota_ledgers (
      company_id, period, content_saves_included, content_saves_used,
      content_saves_purchased, daily_swipes_used, daily_swipe_reset_at
    ) values (
      ${companyId}::uuid, ${period}, 500, ${options.contentSavesUsed ?? 0},
      ${options.contentSavesPurchased ?? 0}, ${options.used},
      ${reset}::timestamptz
    )
    on conflict (company_id, period) do update
      set daily_swipes_used = ${options.used},
          daily_swipe_reset_at = ${reset}::timestamptz,
          content_saves_used = ${options.contentSavesUsed ?? 0},
          content_saves_purchased = ${options.contentSavesPurchased ?? 0}
  `;
  return period;
}

export interface LedgerState {
  readonly dailySwipesUsed: number;
  readonly dailySwipeResetAt: Date | null;
  readonly contentSavesUsed: number;
  readonly contentSavesPurchased: number;
  readonly contentSavesIncluded: number;
}

/** El ledger tal como está en la base. Sin scope: es provisión, no request. */
export async function readLedger(
  handle: DbHandle,
  companyId: string,
  period: string = PERIOD,
): Promise<LedgerState> {
  const filas = await handle.sql`
    select daily_swipes_used, daily_swipe_reset_at, content_saves_used,
           content_saves_purchased, content_saves_included
      from quota_ledgers
     where company_id = ${companyId}::uuid and period = ${period}
  `;
  const fila = filas[0] as unknown as {
    daily_swipes_used: number;
    // Por `handle.sql` la marca de tiempo llega **como venga** (string u
    // objeto) y no como el `Date` que devolvería Drizzle: mismo motivo que la
    // nota de `build.int.test.ts`. Se tipa `unknown` y se normaliza acá, una
    // vez, en vez de en cada aserción.
    daily_swipe_reset_at: unknown;
    content_saves_used: number;
    content_saves_purchased: number;
    content_saves_included: number;
  };
  if (fila === undefined) throw new Error(`no hay ledger de ${period}`);
  return {
    dailySwipesUsed: fila.daily_swipes_used,
    dailySwipeResetAt:
      fila.daily_swipe_reset_at === null || fila.daily_swipe_reset_at === undefined
        ? null
        : new Date(fila.daily_swipe_reset_at as string),
    contentSavesUsed: fila.content_saves_used,
    contentSavesPurchased: fila.content_saves_purchased,
    contentSavesIncluded: fila.content_saves_included,
  };
}

/* ------------------------------------------------------------------------ *
 * Publicación — `FR-060`
 * ------------------------------------------------------------------------ */

export interface SeedPostOptions {
  readonly status?: string;
  readonly cancellationPending?: boolean;
  /** Estado de la pieza. `CREATED` con archivos es lo único publicable. */
  readonly contentStatus?: "BUILDING" | "CREATED" | "FAILED";
  readonly files?: readonly string[];
  readonly contentType?: "wall-of-text" | "slideshow";
  readonly caption?: string;
  readonly platform?: "tiktok" | "instagram" | "youtube" | "reddit";
}

export interface SeededPost {
  readonly postId: string;
  readonly contentId: string;
  readonly connectionId: string;
}

/**
 * Un post programado, con su conexión y su contenido.
 *
 * Las tres filas son obligatorias y no es ceremonia: el CHECK
 * `posts_account_exclusive` exige **exactamente una** cuenta no nula y
 * `posts_account_type_matches` que sea la que `accountType` nombra, así que un
 * post huérfano no es un caso que la base permita — y por lo tanto tampoco
 * sirve para probar nada.
 *
 * El contenido nace en `CREATED` **con archivos** porque es lo único
 * publicable: el handler rechaza una pieza sin `files`, que es el caso de un
 * build que nunca terminó.
 */
export async function seedPost(
  handle: DbHandle,
  companyId: string,
  options: SeedPostOptions = {},
): Promise<SeededPost> {
  const sufijo = randomUUID().slice(0, 8);
  return withoutCompany(handle.db, async (tx) => {
    const [content] = await tx
      .insert(contents)
      .values({
        companyId,
        type: options.contentType ?? "wall-of-text",
        status: options.contentStatus ?? "CREATED",
        files: [...(options.files ?? ["https://cdn.example.test/listo.mp4"])],
      })
      .returning({ id: contents.id });
    if (content === undefined) throw new Error("no se creó el content");

    const [connection] = await tx
      .insert(connections)
      .values({
        companyId,
        platform: options.platform ?? "tiktok",
        platformUserId: `tt-${sufijo}`,
        platformUsername: `cuenta-${sufijo}`,
        scopes: ["video.publish"],
        publishable: true,
      })
      .returning({ id: connections.id });
    if (connection === undefined) throw new Error("no se creó la connection");

    const [post] = await tx
      .insert(posts)
      .values({
        companyId,
        contentId: content.id,
        platform: options.platform ?? "tiktok",
        accountType: "oauth",
        connectionId: connection.id,
        scheduledAtUtc: new Date("2026-09-21T10:00:00.000Z"),
        caption: options.caption ?? "hola",
        status: (options.status ?? "SCHEDULED") as never,
        cancellationPending: options.cancellationPending ?? false,
      })
      .returning({ id: posts.id });
    if (post === undefined) throw new Error("no se creó el post");

    return { postId: post.id, contentId: content.id, connectionId: connection.id };
  });
}

/** La fila del post tal como quedó. Lectura cruda: el test mira el estado real. */
export async function readPost(
  handle: DbHandle,
  postId: string,
): Promise<{
  status: string;
  post_url: string | null;
  error_code: string | null;
  error_message: string | null;
  published_caption: string | null;
  tiktok_processing_delayed: boolean;
  posted_at: unknown;
}> {
  const filas = await handle.sql`
    select status, post_url, error_code, error_message, published_caption,
           tiktok_processing_delayed, posted_at
    from posts where id = ${postId}::uuid
  `;
  return filas[0] as never;
}

/* ------------------------------------------------------------------------ *
 * Influencers — `FR-080`
 * ------------------------------------------------------------------------ */

export interface SeedInfluencerOptions {
  readonly status?:
    "generating_variations" | "training" | "ready" | "failed" | "inactive";
  /** `null` = nunca se cobró. Default: 250, el cargo de `FR-080`. */
  readonly creditsCharged?: number | null;
  readonly creditsRefundedAt?: Date;
  /** Créditos de AI Studio ya consumidos en el período. */
  readonly aiCreditsUsed?: number;
}

/**
 * Un influencer con su cargo hecho y el ledger del período movido.
 *
 * El `ai_credits` del ledger arranca **al menos en lo cobrado** porque el
 * reembolso tiene que poder **restar** algo: contra un contador en cero, el
 * `Math.max(0, …)` lo dejaría igual y el test pasaría sin medir nada. Es la
 * misma trampa que ya se pagó con los content saves.
 */
export async function seedInfluencer(
  handle: DbHandle,
  companyId: string,
  options: SeedInfluencerOptions = {},
): Promise<string> {
  const cobrado = options.creditsCharged === undefined ? 250 : options.creditsCharged;
  const usados = options.aiCreditsUsed ?? Math.max(250, cobrado ?? 0);

  await handle.sql`
    insert into quota_ledgers (company_id, period, content_saves_included, ai_credits)
    values (${companyId}::uuid, ${PERIOD}, 500, ${usados})
    on conflict (company_id, period) do update set ai_credits = ${usados}
  `;

  const filas = await handle.sql`
    insert into influencers
      (company_id, name, gender, age, ethnicity, status,
       credits_period, credits_charged, credits_refunded_at)
    values (
      ${companyId}::uuid, ${`inf-${randomUUID().slice(0, 8)}`}, 'woman', 27, 'latina',
      ${options.status ?? "generating_variations"}::influencer_status,
      ${cobrado === null ? null : PERIOD},
      ${cobrado},
      ${options.creditsRefundedAt === undefined ? null : options.creditsRefundedAt.toISOString()}::timestamptz
    )
    returning id
  `;
  return (filas[0] as unknown as { id: string }).id;
}

/** Estado del influencer y del contador de créditos, leídos directo. */
export async function readInfluencer(
  handle: DbHandle,
  influencerId: string,
): Promise<{ status: string; credits_refunded_at: unknown; ai_credits: number }> {
  const filas = await handle.sql`
    select i.status, i.credits_refunded_at, l.ai_credits
    from influencers i
    join quota_ledgers l
      on l.company_id = i.company_id and l.period = ${PERIOD}
    where i.id = ${influencerId}::uuid
  `;
  return filas[0] as never;
}
