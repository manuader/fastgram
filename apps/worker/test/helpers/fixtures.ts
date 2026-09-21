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
  contents,
  createDb,
  users,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import { randomUUID } from "node:crypto";

export const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

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
        buildPayload: options.buildPayload === undefined ? WALL_OF_TEXT : options.buildPayload,
        ...(bucket === null
          ? {}
          : { saveBucket: bucket, savePeriod: PERIOD }),
        ...(options.saveRefundedAt === undefined ? {} : { saveRefundedAt: options.saveRefundedAt }),
      })
      .returning({ id: contents.id });
    if (row === undefined) throw new Error("no se creó el content");
    return row.id;
  });
}
