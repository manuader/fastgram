/**
 * La purga del material crudo de los snapshots — PRD §9.5 #20, §9.14,
 * `DATA-032`.
 *
 * ## Lo que tiene que quedar probado
 *
 * 1. **Corre como `fastgram_app` y sin GUC, y purga igual.** Es lo que
 *    justifica el `SECURITY DEFINER` de `0010`: `brand_source_snapshots` tiene
 *    `FORCE ROW LEVEL SECURITY`, y un `UPDATE` pelado sin tenant afecta cero
 *    filas sin error (trampa 16). Hay un test que lo muestra lado a lado.
 * 2. **Qué se borra y qué sobrevive.** `profileSignals` y `contentItems` se
 *    vacían; `derivedFields` sobrevive porque `DATA-032` lo dice; `conflicts`
 *    sobrevive por la decisión conservadora escrita en la migración.
 * 3. **Lo que no se toca**: snapshots no vencidos y sin fecha de retención.
 *
 * Las aserciones sobre lo que NO se toca van antes que las de lo que sí
 * cuando están en el mismo test (trampa 35).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withoutCompany } from "../src/tenancy";
import { snapshotPurgeStore } from "../src/repositories/index";
import { brandSources, brandSourceSnapshots } from "../src/schema/brand";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres";

const AHORA = new Date("2026-09-23T04:00:00.000Z");
const MS = 1;

const SIGNALS = { name: "Ajena", bio: "bio de un tercero", followers: 1234 };
const ITEMS = [
  { externalId: "p1", kind: "post", caption: "texto ajeno", hashtags: ["x"] },
];
const DERIVED = {
  toneOfVoice: { value: "cercano", confidence: "high", excerpt: "texto ajeno" },
};
const CONFLICTS = [{ field: "toneOfVoice", sources: ["a", "b"] }];

let ctx: TestDatabase;
let alpha: string;
let beta: string;

interface Snapshot {
  profileSignals: unknown;
  contentItems: unknown;
  derivedFields: unknown;
  conflicts: unknown;
  rawRetentionExpiresAt: Date | null;
}

/** Siembra como superusuario: es provisión, no camino de aplicación. */
async function sembrarSnapshot(companyId: string, expira: Date | null): Promise<string> {
  return withoutCompany(ctx.db, async (tx) => {
    const [fuente] = await tx
      .insert(brandSources)
      .values({
        companyId,
        sourceType: "website",
        canonicalUrl: `https://purga-${Math.random().toString(36).slice(2, 10)}.test/`,
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
        conflicts: CONFLICTS,
        rawRetentionExpiresAt: expira,
      })
      .returning({ id: brandSourceSnapshots.id });
    if (snap === undefined) throw new Error("no se sembró el snapshot");
    return snap.id;
  });
}

async function leer(id: string): Promise<Snapshot> {
  return withoutCompany(ctx.db, async (tx) => {
    const fila = await tx.query.brandSourceSnapshots.findFirst({
      where: (t, { eq }) => eq(t.id, id),
      columns: {
        profileSignals: true,
        contentItems: true,
        derivedFields: true,
        conflicts: true,
        rawRetentionExpiresAt: true,
      },
    });
    if (fila === undefined) throw new Error("no está el snapshot");
    return fila;
  });
}

/** Como la aplicación en producción: rol `fastgram_app`, sin GUC. */
const purgarComoApp = (now: Date = AHORA): Promise<number> =>
  withoutCompany(ctx.db, (tx) => snapshotPurgeStore.purgeExpiredSnapshotRaw(tx, now), {
    role: APP_ROLE,
  });

function expectIntacto(s: Snapshot): void {
  expect(s.profileSignals).toEqual(SIGNALS);
  expect(s.contentItems).toEqual(ITEMS);
  expect(s.derivedFields).toEqual(DERIVED);
  expect(s.conflicts).toEqual(CONFLICTS);
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha purga" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta purga" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("SECURITY DEFINER: sin esto la purga no toca nada en producción", () => {
  it("un UPDATE pelado como `fastgram_app` sin GUC NO ve la fila; la función sí", async () => {
    const id = await sembrarSnapshot(alpha, new Date(AHORA.getTime() - 1000));

    await withoutCompany(
      ctx.db,
      (tx) =>
        tx.execute(
          sql`update brand_source_snapshots set profile_signals = null, content_items = '[]'::jsonb`,
        ),
      { role: APP_ROLE },
    );
    // Negativa primero: el UPDATE pelado no tocó nada.
    expectIntacto(await leer(id));

    expect(await purgarComoApp()).toBeGreaterThanOrEqual(1);
    expect((await leer(id)).profileSignals).toBeNull();
  });

  it("purga snapshots de MÁS de un workspace: es global", async () => {
    const deAlpha = await sembrarSnapshot(alpha, new Date(AHORA.getTime() - 86_400_000));
    const deBeta = await sembrarSnapshot(beta, new Date(AHORA.getTime() - 86_400_000));

    await purgarComoApp();

    expect((await leer(deAlpha)).contentItems).toEqual([]);
    expect((await leer(deBeta)).contentItems).toEqual([]);
  });
});

describe("qué se borra y qué sobrevive", () => {
  it("vacía el material crudo, conserva derivedFields y conflicts, y limpia la fecha", async () => {
    const id = await sembrarSnapshot(alpha, new Date(AHORA.getTime() - 1000));

    await purgarComoApp();

    const s = await leer(id);
    // Lo que sobrevive primero: si se lo llevara la purga, éste es el rojo.
    expect(s.derivedFields).toEqual(DERIVED);
    expect(s.conflicts).toEqual(CONFLICTS);
    expect(s.profileSignals).toBeNull();
    expect(s.contentItems).toEqual([]);
    expect(s.rawRetentionExpiresAt).toBeNull();
  });
});

describe("el borde y lo que no se toca", () => {
  it("vencido exactamente AHORA se purga (`<=`)", async () => {
    const id = await sembrarSnapshot(alpha, AHORA);

    await purgarComoApp();

    expect((await leer(id)).profileSignals).toBeNull();
  });

  it("un milisegundo en el futuro NO se purga", async () => {
    const futuro = new Date(AHORA.getTime() + MS);
    const id = await sembrarSnapshot(alpha, futuro);

    await purgarComoApp();

    const s = await leer(id);
    expectIntacto(s);
    expect(s.rawRetentionExpiresAt?.toISOString()).toBe(futuro.toISOString());
  });

  it("sin fecha de retención no se toca", async () => {
    const id = await sembrarSnapshot(beta, null);

    await purgarComoApp();

    expectIntacto(await leer(id));
  });
});

describe("idempotencia y validación", () => {
  it("la segunda pasada purga 0", async () => {
    await sembrarSnapshot(alpha, new Date(AHORA.getTime() - 1000));
    await sembrarSnapshot(beta, new Date(AHORA.getTime() - 1000));

    const primera = await purgarComoApp();
    const segunda = await purgarComoApp();

    expect(primera).toBeGreaterThanOrEqual(2);
    expect(segunda).toBe(0);
  });

  it("cuenta exactamente las filas que purgó", async () => {
    // Todo lo anterior ya está purgado; los no vencidos siguen sin vencer a AHORA.
    await purgarComoApp();
    await sembrarSnapshot(alpha, new Date(AHORA.getTime() - 5000));
    await sembrarSnapshot(beta, new Date(AHORA.getTime() - 5000));
    await sembrarSnapshot(beta, new Date(AHORA.getTime() + 5000));

    expect(await purgarComoApp()).toBe(2);
  });

  it("una fecha inválida se rechaza antes de tocar la base", async () => {
    await expect(purgarComoApp(new Date(Number.NaN))).rejects.toThrow(/fecha inválida/u);
  });

  it("la función rechaza un NULL en vez de purgar cero en silencio", async () => {
    await expect(
      withoutCompany(
        ctx.db,
        (tx) => tx.execute(sql`select app.purge_expired_snapshot_raw(null)`),
        { role: APP_ROLE },
      ),
    ).rejects.toThrow(/p_now no puede ser NULL/u);
  });
});

describe("cómo está declarada", () => {
  it("es SECURITY DEFINER, fija el search_path y no la ejecuta PUBLIC", async () => {
    const filas = await ctx.db.execute(sql`
      select p.prosecdef, p.proconfig,
             has_function_privilege('public', 'app.purge_expired_snapshot_raw(timestamptz)', 'EXECUTE') as publico
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'purge_expired_snapshot_raw'
    `);
    expect(filas).toHaveLength(1);
    const f = filas[0] as {
      prosecdef: boolean;
      proconfig: string[] | null;
      publico: boolean;
    };
    expect(f.publico).toBe(false);
    expect(f.prosecdef).toBe(true);
    expect(f.proconfig?.some((c) => c.startsWith("search_path="))).toBe(true);
  });
});
