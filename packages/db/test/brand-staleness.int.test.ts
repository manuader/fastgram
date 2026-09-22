/**
 * El barrido de `brand_sources` vencidas — PRD §9.5 #19, `F-026`.
 *
 * ## El test que le da sentido al archivo
 *
 * «Corre como `fastgram_app` y **sin GUC**». Es el que prueba que el
 * `SECURITY DEFINER` de la migración `0009` hace falta, y por qué.
 *
 * Un barrido no es de ningún tenant, así que corre sin `app.current_company`.
 * `brand_sources` tiene `FORCE ROW LEVEL SECURITY` y su política compara
 * `company_id` contra esa función, que sin GUC devuelve NULL: un `UPDATE`
 * pelado afectaría **cero filas, sin error**.
 *
 * Y el modo de falla sería el que este repo ya pagó tres veces: en desarrollo
 * la conexión es superusuaria, saltea RLS y el barrido parece andar; en
 * producción, con `fastgram_app` (NOSUPERUSER, NOBYPASSRLS), no hace nada y
 * nadie se entera. Un test que corra como superusuario **no puede ver la
 * diferencia**.
 *
 * ## El borde de los 90 días es del dominio, no de acá
 *
 * `isStale` de `core/brand/brand-source.ts` dice «89 no, 90 sí», con test
 * propio. Acá se comprueba que el SQL coincide: si el `<=` se volviera `<`, los
 * dos lados dirían cosas distintas sobre el mismo día y nadie lo notaría hasta
 * que un usuario viera una fuente `ready` que la UI llama vencida.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withoutCompany } from "../src/tenancy";
import { brandStalenessStore } from "../src/repositories/index";
import { brandSources } from "../src/schema/brand";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres";

const AHORA = new Date("2026-09-22T12:00:00.000Z");
const DIA_MS = 86_400_000;
/** El mismo que `STALE_AFTER_DAYS` de `packages/core`. Lo pasa el llamador. */
const DIAS = 90;

let ctx: TestDatabase;
let alpha: string;
let beta: string;

const haceDias = (dias: number): Date => new Date(AHORA.getTime() - dias * DIA_MS);

/** Siembra como superusuario: es provisión, no camino de aplicación. */
async function sembrarFuente(
  companyId: string,
  overrides: { status?: string; lastAnalysedAt?: Date | null } = {},
): Promise<string> {
  return withoutCompany(ctx.db, async (tx) => {
    const [fila] = await tx
      .insert(brandSources)
      .values({
        companyId,
        sourceType: "website",
        canonicalUrl: `https://ejemplo-${Math.random().toString(36).slice(2, 10)}.test/`,
        acquisitionTier: "C_page_fetch",
        status: (overrides.status ?? "ready") as never,
        ...(overrides.lastAnalysedAt === null
          ? {}
          : { lastAnalysedAt: overrides.lastAnalysedAt ?? haceDias(DIAS) }),
      })
      .returning({ id: brandSources.id });
    if (fila === undefined) throw new Error("no se sembró la fuente");
    return fila.id;
  });
}

async function estadoDe(id: string): Promise<string> {
  return withoutCompany(ctx.db, async (tx) => {
    const fila = await tx.query.brandSources.findFirst({
      where: (t, { eq }) => eq(t.id, id),
      columns: { status: true },
    });
    if (fila === undefined) throw new Error("no está la fuente");
    return fila.status;
  });
}

/** Como la aplicación en producción: rol `fastgram_app`, sin GUC. */
const comoApp = <T>(fn: Parameters<typeof withoutCompany<T>>[1]): Promise<T> =>
  withoutCompany(ctx.db, fn, { role: APP_ROLE });

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha staleness" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta staleness" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("SECURITY DEFINER: sin esto el barrido no toca nada en producción", () => {
  it("corre como `fastgram_app` y SIN GUC, y marca igual", async () => {
    const id = await sembrarFuente(alpha, { lastAnalysedAt: haceDias(DIAS) });

    const barridas = await comoApp((tx) =>
      brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS),
    );

    expect(barridas).toBeGreaterThanOrEqual(1);
    expect(await estadoDe(id)).toBe("stale");
  });

  it("barre fuentes de MÁS de un workspace: es global por definición", async () => {
    const deAlpha = await sembrarFuente(alpha, { lastAnalysedAt: haceDias(200) });
    const deBeta = await sembrarFuente(beta, { lastAnalysedAt: haceDias(200) });

    await comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS));

    expect(await estadoDe(deAlpha)).toBe("stale");
    expect(await estadoDe(deBeta)).toBe("stale");
  });
});

describe("el borde de los 90 días coincide con el dominio", () => {
  it("89 días NO vence", async () => {
    const id = await sembrarFuente(alpha, { lastAnalysedAt: haceDias(89) });

    await comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS));

    expect(await estadoDe(id)).toBe("ready");
  });

  it("90 días SÍ vence", async () => {
    const id = await sembrarFuente(alpha, { lastAnalysedAt: haceDias(90) });

    await comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS));

    expect(await estadoDe(id)).toBe("stale");
  });
});

describe("lo que no se toca", () => {
  it("una fuente sin `lastAnalysedAt` no vence: nunca se analizó", async () => {
    const id = await sembrarFuente(alpha, { lastAnalysedAt: null });

    await comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS));

    expect(await estadoDe(id)).toBe("ready");
  });

  it("un estado que no es `ready` ni `partial` no se pisa", async () => {
    // Marcar `stale` una fuente `failed` le diría al usuario que refresque algo
    // que nunca funcionó, y le escondería el motivo real del fallo.
    const id = await sembrarFuente(alpha, {
      status: "failed",
      lastAnalysedAt: haceDias(200),
    });

    await comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS));

    expect(await estadoDe(id)).toBe("failed");
  });

  it("`partial` sí se barre: analizó a medias, pero analizó", async () => {
    const id = await sembrarFuente(alpha, {
      status: "partial",
      lastAnalysedAt: haceDias(200),
    });

    await comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS));

    expect(await estadoDe(id)).toBe("stale");
  });
});

describe("idempotencia y validación", () => {
  it("pasarlo dos veces no vuelve a contar lo ya marcado", async () => {
    await sembrarFuente(alpha, { lastAnalysedAt: haceDias(200) });

    const primera = await comoApp((tx) =>
      brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS),
    );
    const segunda = await comoApp((tx) =>
      brandStalenessStore.sweepStaleBrandSources(tx, AHORA, DIAS),
    );

    expect(primera).toBeGreaterThanOrEqual(1);
    // Ya están en `stale`, y `stale` no está en el `WHERE`: la segunda no las ve.
    expect(segunda).toBe(0);
  });

  it("un umbral no entero se rechaza antes de tocar la base", async () => {
    await expect(
      comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, 90.5)),
    ).rejects.toThrow(/entero positivo/u);
  });

  it("un umbral de 0 se rechaza: barrería todo", async () => {
    await expect(
      comoApp((tx) => brandStalenessStore.sweepStaleBrandSources(tx, AHORA, 0)),
    ).rejects.toThrow(/entero positivo/u);
  });
});
