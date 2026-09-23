/**
 * El handler de `snapshot-purge`, contra Postgres — PRD §9.5 #20, §9.14,
 * `DATA-032`.
 *
 * El detalle de la función SQL (borde `<=`, qué columnas se vacían, qué se
 * declara) lo cubre `packages/db/test/snapshot-purge.int.test.ts`. Acá se
 * prueba lo que sólo el worker puede romper:
 *
 *  - que use **el reloj inyectado** y no `Date.now()`: con un `FixedClock` en
 *    el pasado, un snapshot vencido «hoy» no se purga;
 *  - que corra con **el rol de la aplicación** y aun así purgue: sin la
 *    función `SECURITY DEFINER`, con `fastgram_app` y sin GUC, afectaría cero
 *    filas sin error (trampa 16);
 *  - que ignore el payload: un `companyId` en el payload no lo acota.
 *
 * La base del worker es compartida y persiste entre corridas, así que cada
 * test que cuenta filas purga antes lo que haya quedado vencido de otras.
 */
import { FixedClock } from "@fastgram/adapters";
import {
  APP_ROLE,
  brandSources,
  brandSourceSnapshots,
  migrateWithUrl,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import type { JobContext } from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSnapshotPurgeHandler } from "../src/brand/snapshot-purge-handler.js";
import { DATABASE_URL, openDb, seedCompany } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-23T04:00:00.000Z");
const DIA_MS = 86_400_000;

const SIGNALS = { name: "Ajena", bio: "bio de un tercero" };
const ITEMS = [{ externalId: "p1", kind: "post", caption: "texto ajeno" }];
const DERIVED = { toneOfVoice: { value: "cercano", confidence: "high", excerpt: "x" } };

let handle: DbHandle;

class LoggerEspia {
  readonly infos: Record<string, unknown>[] = [];
  info(obj: Record<string, unknown>): void {
    this.infos.push(obj);
  }
  warn(): void {}
  error(): void {}
}

const ctx = (payload: unknown = {}): JobContext<unknown> => ({
  jobId: "job_snapshot_purge",
  payload,
  attempt: 1,
  maxAttempts: 5,
});

/** Corre el handler como en producción: rol de aplicación, reloj inyectado. */
async function correr(
  now: Date = NOW,
  payload: unknown = {},
): Promise<{ purgados: unknown; logger: LoggerEspia }> {
  const logger = new LoggerEspia();
  await createSnapshotPurgeHandler({
    db: handle.db,
    clock: new FixedClock(now),
    appRole: APP_ROLE,
    logger,
  })(ctx(payload));
  expect(logger.infos).toHaveLength(1);
  return { purgados: logger.infos[0]?.["purgados"], logger };
}

/** Siembra fuera de scope: provisión, no camino de aplicación. */
async function sembrarSnapshot(companyId: string, expira: Date | null): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [fuente] = await tx
      .insert(brandSources)
      .values({
        companyId,
        sourceType: "website",
        canonicalUrl: `https://purga-worker-${Math.random().toString(36).slice(2, 10)}.test/`,
        acquisitionTier: "C_page_fetch",
        status: "ready",
      })
      .returning({ id: brandSources.id });
    if (fuente === undefined) throw new Error("no se sembró la fuente");
    const [snap] = await tx
      .insert(brandSourceSnapshots)
      .values({
        brandSourceId: fuente.id,
        companyId,
        tier: "C_page_fetch",
        profileSignals: SIGNALS,
        contentItems: ITEMS,
        derivedFields: DERIVED,
        rawRetentionExpiresAt: expira,
      })
      .returning({ id: brandSourceSnapshots.id });
    if (snap === undefined) throw new Error("no se sembró el snapshot");
    return snap.id;
  });
}

async function leer(id: string) {
  return withoutCompany(handle.db, async (tx) => {
    const fila = await tx.query.brandSourceSnapshots.findFirst({
      where: (t, { eq }) => eq(t.id, id),
      columns: {
        profileSignals: true,
        contentItems: true,
        derivedFields: true,
        rawRetentionExpiresAt: true,
      },
    });
    if (fila === undefined) throw new Error("no está el snapshot");
    return fila;
  });
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

describe("el handler de snapshot-purge", () => {
  it("con el rol de la aplicación purga snapshots de dos workspaces y lo loguea", async () => {
    await correr(); // limpia lo vencido que hayan dejado otras corridas
    const alpha = await seedCompany(handle);
    const beta = await seedCompany(handle);
    const deAlpha = await sembrarSnapshot(alpha, new Date(NOW.getTime() - DIA_MS));
    const deBeta = await sembrarSnapshot(beta, new Date(NOW.getTime() - DIA_MS));

    const { purgados } = await correr();

    expect(purgados).toBe(2);
    for (const id of [deAlpha, deBeta]) {
      const s = await leer(id);
      expect(s.derivedFields).toEqual(DERIVED);
      expect(s.profileSignals).toBeNull();
      expect(s.contentItems).toEqual([]);
      expect(s.rawRetentionExpiresAt).toBeNull();
    }
  });

  it("usa el reloj inyectado: con el reloj un día antes, lo vencido hoy NO se purga", async () => {
    const company = await seedCompany(handle);
    const id = await sembrarSnapshot(company, new Date(NOW.getTime() - 1000));

    await correr(new Date(NOW.getTime() - DIA_MS));
    // Negativa primero (trampa 35): con `Date.now()` real —2026 en adelante—
    // este snapshot ya estaría purgado.
    expect((await leer(id)).profileSignals).toEqual(SIGNALS);

    await correr(NOW);
    expect((await leer(id)).profileSignals).toBeNull();
  });

  it("no toca lo que vence en el futuro ni lo que no tiene fecha", async () => {
    const company = await seedCompany(handle);
    const futuro = await sembrarSnapshot(company, new Date(NOW.getTime() + DIA_MS));
    const sinFecha = await sembrarSnapshot(company, null);

    await correr();

    expect((await leer(futuro)).contentItems).toEqual(ITEMS);
    expect((await leer(sinFecha)).contentItems).toEqual(ITEMS);
  });

  it("ignora el payload: un companyId ahí no acota el barrido", async () => {
    await correr();
    const alpha = await seedCompany(handle);
    const beta = await seedCompany(handle);
    await sembrarSnapshot(alpha, new Date(NOW.getTime() - DIA_MS));
    const deBeta = await sembrarSnapshot(beta, new Date(NOW.getTime() - DIA_MS));

    const { purgados } = await correr(NOW, { companyId: alpha });

    expect(purgados).toBe(2);
    expect((await leer(deBeta)).profileSignals).toBeNull();
  });

  it("corre de verdad con el `appRole` que recibe", async () => {
    // Sin este test, un handler que tirara el `appRole` quedaba verde: como
    // superusuario la purga anda igual (medido, 5/5 verdes). Un rol que no
    // existe hace que `SET LOCAL ROLE` falle, y eso sólo pasa si se aplica.
    await expect(
      createSnapshotPurgeHandler({
        db: handle.db,
        clock: new FixedClock(NOW),
        appRole: "rol_que_no_existe",
        logger: new LoggerEspia(),
      })(ctx()),
    ).rejects.toThrow(/rol_que_no_existe/u);
  });

  it("es idempotente: la segunda pasada purga 0", async () => {
    const company = await seedCompany(handle);
    await sembrarSnapshot(company, new Date(NOW.getTime() - DIA_MS));

    const primera = await correr();
    const segunda = await correr();

    expect(primera.purgados).toBeGreaterThanOrEqual(1);
    expect(segunda.purgados).toBe(0);
  });
});
