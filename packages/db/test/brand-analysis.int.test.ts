/**
 * `brandAnalysisStore` — el `WHERE` de cada sentencia, **sin RLS** (trampa 26),
 * y las condiciones que hacen idempotente al handler de `brand-source-analysis`.
 *
 * La conexión es superusuaria y sin GUC: lo único que aísla es el filtro del
 * repositorio. Cada «no» se acompaña de una relectura de la fila víctima,
 * porque el bug caro es «respondió que no y escribió igual».
 *
 * Al final, un caso con el rol de la aplicación y el GUC puestos: que las
 * sentencias **funcionen** bajo RLS (trampa 16) es otra propiedad, y ésa no la
 * mide un superusuario.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { brandAnalysisStore } from "../src/repositories/index";
import { brandSources, brandSourceSnapshots, companyProfiles } from "../src/schema/index";
import { APP_ROLE, withCompany, withoutCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

const NOW = new Date("2026-09-23T10:00:00.000Z");
const LATER = new Date("2026-10-23T10:00:00.000Z");

const crudo = <T>(fn: Parameters<typeof withoutCompany<T>>[1]): Promise<T> =>
  withoutCompany(ctx.db, fn);

async function fuente(
  companyId: string,
  overrides: Partial<typeof brandSources.$inferInsert> = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(brandSources)
    .values({
      companyId,
      sourceType: "website",
      handle: `sitio-${randomUUID().slice(0, 8)}.test`,
      canonicalUrl: "https://sitio.test",
      acquisitionTier: "B_public_api",
      status: "pending",
      ...overrides,
    })
    .returning({ id: brandSources.id });
  if (row === undefined) throw new Error("no se creó la fuente");
  return row.id;
}

async function leer(id: string) {
  const [row] = await ctx.db.select().from(brandSources).where(eq(brandSources.id, id));
  if (row === undefined) throw new Error("fila desaparecida");
  return row;
}

async function snapshotsDe(brandSourceId: string) {
  return ctx.db
    .select()
    .from(brandSourceSnapshots)
    .where(eq(brandSourceSnapshots.brandSourceId, brandSourceId));
}

const snapshotInput = (brandSourceId: string, id = randomUUID()) => ({
  id,
  brandSourceId,
  tier: "B_public_api" as const,
  capturedAt: NOW,
  profileSignals: { displayName: "Taller", bio: "tazas" },
  contentItems: [{ externalId: "https://taller.test/", kind: "text", caption: "tazas" }],
  derivedFields: {
    productOffering: { value: "Tazas", confidence: "low", excerpt: "tazas" },
  },
  conflicts: [],
  rawRetentionExpiresAt: LATER,
});

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha análisis" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta análisis" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("aislamiento por workspace, sin RLS", () => {
  it("findBrandSourceForAnalysis no ve la fuente ajena", async () => {
    const id = await fuente(beta);
    expect(
      await crudo((tx) =>
        brandAnalysisStore.findBrandSourceForAnalysis(tx, { companyId: alpha }, id),
      ),
    ).toBeNull();
    expect(
      (
        await crudo((tx) =>
          brandAnalysisStore.findBrandSourceForAnalysis(tx, { companyId: beta }, id),
        )
      )?.id,
    ).toBe(id);
  });

  it("claimBrandSourceAnalysis no reclama la fuente ajena", async () => {
    const id = await fuente(beta);
    expect(
      await crudo((tx) =>
        brandAnalysisStore.claimBrandSourceAnalysis(tx, { companyId: alpha }, id, NOW),
      ),
    ).toBeNull();
    expect((await leer(id)).status).toBe("pending");
  });

  it("completeBrandSourceAnalysis no completa la fuente ajena", async () => {
    const id = await fuente(beta, { status: "analyzing" });
    expect(
      await crudo((tx) =>
        brandAnalysisStore.completeBrandSourceAnalysis(tx, { companyId: alpha }, id, {
          status: "ready",
          acquisitionTier: "B_public_api",
          displayName: "Intruso",
          now: NOW,
        }),
      ),
    ).toBeNull();
    const fila = await leer(id);
    expect(fila.status).toBe("analyzing");
    expect(fila.displayName).toBeNull();
  });

  it("failBrandSourceAnalysis no falla la fuente ajena", async () => {
    const id = await fuente(beta, { status: "analyzing" });
    expect(
      await crudo((tx) =>
        brandAnalysisStore.failBrandSourceAnalysis(tx, { companyId: alpha }, id, {
          failureReason: "not_found",
          acquisitionTier: "D_assisted",
          now: NOW,
        }),
      ),
    ).toBe(false);
    const fila = await leer(id);
    expect(fila.status).toBe("analyzing");
    expect(fila.failureReason).toBeNull();
  });

  it("insertBrandSourceSnapshot no cuelga un snapshot de una fuente ajena", async () => {
    // El caso que la FK y RLS NO atrapan: companyId propio, brandSourceId ajeno.
    const ajena = await fuente(beta);
    expect(
      await crudo((tx) =>
        brandAnalysisStore.insertBrandSourceSnapshot(
          tx,
          { companyId: alpha },
          snapshotInput(ajena),
        ),
      ),
    ).toBeNull();
    expect(await snapshotsDe(ajena)).toHaveLength(0);
  });

  it("latestSnapshotsOfOtherSources no devuelve snapshots de otro workspace", async () => {
    const deBeta = await fuente(beta, { status: "ready" });
    await crudo((tx) =>
      brandAnalysisStore.insertBrandSourceSnapshot(
        tx,
        { companyId: beta },
        snapshotInput(deBeta),
      ),
    );
    const propia = await fuente(alpha, { status: "analyzing" });
    const otras = await crudo((tx) =>
      brandAnalysisStore.latestSnapshotsOfOtherSources(tx, { companyId: alpha }, propia),
    );
    expect(otras.map((o) => o.brandSourceId)).not.toContain(deBeta);
  });

  it("lockCompanyProfile y saveMaterializedProfile no tocan el perfil ajeno", async () => {
    const perfilBeta = await crudo((tx) =>
      brandAnalysisStore.lockCompanyProfile(tx, { companyId: beta }),
    );
    const perfilAlpha = await crudo((tx) =>
      brandAnalysisStore.lockCompanyProfile(tx, { companyId: alpha }),
    );
    expect(perfilAlpha.companyId).toBe(alpha);
    expect(perfilAlpha.id).not.toBe(perfilBeta.id);

    // Id del perfil de beta con el scope de alpha: no escribe.
    expect(
      await crudo((tx) =>
        brandAnalysisStore.saveMaterializedProfile(
          tx,
          { companyId: alpha },
          perfilBeta.id,
          {
            values: { productOffering: "robado" },
            fieldMeta: {},
            brandRevision: 99,
            status: "ready",
            now: NOW,
          },
        ),
      ),
    ).toBeNull();
    const [victima] = await ctx.db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.id, perfilBeta.id));
    expect(victima?.productOffering).toBeNull();
    expect(victima?.brandRevision).toBe(0);
  });
});

describe("las condiciones que hacen idempotente al handler", () => {
  it("reclama pending y reafirma analyzing; no reclama ready/failed", async () => {
    const pendiente = await fuente(alpha);
    const enCurso = await fuente(alpha, { status: "analyzing" });
    const lista = await fuente(alpha, { status: "ready" });
    const fallida = await fuente(alpha, { status: "failed", failureReason: "not_found" });
    const reclamar = (id: string) =>
      crudo((tx) =>
        brandAnalysisStore.claimBrandSourceAnalysis(tx, { companyId: alpha }, id, NOW),
      );
    expect((await reclamar(pendiente))?.status).toBe("analyzing");
    expect((await reclamar(enCurso))?.status).toBe("analyzing");
    expect(await reclamar(lista)).toBeNull();
    expect(await reclamar(fallida)).toBeNull();
    expect((await leer(lista)).status).toBe("ready");
    expect((await leer(fallida)).failureReason).toBe("not_found");
  });

  it("el reclamo no toca analysisCount (el cooldown es de la API)", async () => {
    const id = await fuente(alpha, { analysisCount: 2 });
    await crudo((tx) =>
      brandAnalysisStore.claimBrandSourceAnalysis(tx, { companyId: alpha }, id, NOW),
    );
    expect((await leer(id)).analysisCount).toBe(2);
  });

  it("completar: ready, tier, lastAnalysedAt, displayName; la segunda no pisa", async () => {
    const id = await fuente(alpha, { status: "analyzing", acquisitionTier: "A_oauth" });
    const completar = () =>
      crudo((tx) =>
        brandAnalysisStore.completeBrandSourceAnalysis(tx, { companyId: alpha }, id, {
          status: "partial",
          acquisitionTier: "B_public_api",
          displayName: "Taller",
          avatarUrl: "https://taller.test/logo.png",
          now: NOW,
        }),
      );
    expect((await completar())?.status).toBe("partial");
    const fila = await leer(id);
    expect(fila.acquisitionTier).toBe("B_public_api");
    expect(fila.lastAnalysedAt?.toISOString()).toBe(NOW.toISOString());
    expect(fila.displayName).toBe("Taller");
    expect(await completar()).toBeNull();
  });

  it("un fallo tardío no pisa un ready", async () => {
    const id = await fuente(alpha, { status: "ready" });
    expect(
      await crudo((tx) =>
        brandAnalysisStore.failBrandSourceAnalysis(tx, { companyId: alpha }, id, {
          failureReason: null,
          acquisitionTier: "D_assisted",
          now: NOW,
        }),
      ),
    ).toBe(false);
    expect((await leer(id)).status).toBe("ready");
  });

  it("fallar con motivo null deja failureReason en null y degrada a D", async () => {
    const id = await fuente(alpha, { status: "analyzing" });
    expect(
      await crudo((tx) =>
        brandAnalysisStore.failBrandSourceAnalysis(tx, { companyId: alpha }, id, {
          failureReason: null,
          acquisitionTier: "D_assisted",
          now: NOW,
        }),
      ),
    ).toBe(true);
    const fila = await leer(id);
    expect(fila.status).toBe("failed");
    expect(fila.failureReason).toBeNull();
    expect(fila.acquisitionTier).toBe("D_assisted");
  });

  it("el snapshot guarda lo pedido, con su vencimiento", async () => {
    const id = await fuente(alpha, { status: "analyzing" });
    const input = snapshotInput(id);
    const creado = await crudo((tx) =>
      brandAnalysisStore.insertBrandSourceSnapshot(tx, { companyId: alpha }, input),
    );
    expect(creado?.id).toBe(input.id);
    const [snap] = await snapshotsDe(id);
    expect(snap?.companyId).toBe(alpha);
    expect(snap?.tier).toBe("B_public_api");
    expect(snap?.derivedFields).toEqual(input.derivedFields);
    expect(snap?.contentItems).toEqual(input.contentItems);
    expect(snap?.rawRetentionExpiresAt?.toISOString()).toBe(LATER.toISOString());
  });

  it("latestSnapshotsOfOtherSources: el más nuevo por fuente, sin la propia ni las failed", async () => {
    const empresa = (await seedCompany(ctx.db)).companyId;
    const propia = await fuente(empresa, { status: "analyzing" });
    const lista = await fuente(empresa, { status: "ready", isPrimary: true });
    const fallida = await fuente(empresa, { status: "failed" });
    const viejo = snapshotInput(lista);
    const nuevo = { ...snapshotInput(lista), capturedAt: LATER };
    for (const s of [viejo, nuevo, snapshotInput(fallida), snapshotInput(propia)]) {
      await crudo((tx) =>
        brandAnalysisStore.insertBrandSourceSnapshot(tx, { companyId: empresa }, s),
      );
    }
    const otras = await crudo((tx) =>
      brandAnalysisStore.latestSnapshotsOfOtherSources(
        tx,
        { companyId: empresa },
        propia,
      ),
    );
    expect(otras).toEqual([
      {
        snapshotId: nuevo.id,
        brandSourceId: lista,
        sourceType: "website",
        isPrimary: true,
        derivedFields: nuevo.derivedFields,
      },
    ]);
  });

  it("lockCompanyProfile crea el perfil una sola vez", async () => {
    const empresa = (await seedCompany(ctx.db)).companyId;
    const a = await crudo((tx) =>
      brandAnalysisStore.lockCompanyProfile(tx, { companyId: empresa }),
    );
    const b = await crudo((tx) =>
      brandAnalysisStore.lockCompanyProfile(tx, { companyId: empresa }),
    );
    expect(a.id).toBe(b.id);
  });

  it("lockCompanyProfile bloquea: un UPDATE concurrente espera al commit", async () => {
    const empresa = (await seedCompany(ctx.db)).companyId;
    await crudo((tx) =>
      brandAnalysisStore.lockCompanyProfile(tx, { companyId: empresa }),
    );
    // Pool caliente (trampa 34): la segunda conexión ya existe antes de medir.
    await ctx.db.execute("select 1");

    let liberar!: () => void;
    const sostener = new Promise<void>((r) => (liberar = r));
    let bloqueado = true;
    const conLock = crudo(async (tx) => {
      await brandAnalysisStore.lockCompanyProfile(tx, { companyId: empresa });
      await sostener;
      await tx
        .update(companyProfiles)
        .set({ toneOfVoice: "del worker" })
        .where(eq(companyProfiles.companyId, empresa));
    });
    // Deja que la primera tome el lock.
    await new Promise((r) => setTimeout(r, 100));
    const competidor = ctx.db
      .update(companyProfiles)
      .set({ toneOfVoice: "del usuario" })
      .where(eq(companyProfiles.companyId, empresa))
      .then(() => {
        bloqueado = false;
      });
    await new Promise((r) => setTimeout(r, 200));
    // Negativa primero (trampa 35): mientras el lock está tomado, no terminó.
    expect(bloqueado).toBe(true);
    liberar();
    await conLock;
    await competidor;
    const [p] = await ctx.db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.companyId, empresa));
    expect(p?.toneOfVoice).toBe("del usuario");
  });
});

describe("con el rol de la aplicación y el GUC (trampa 16)", () => {
  it("el ciclo completo funciona bajo RLS", async () => {
    const empresa = (await seedCompany(ctx.db)).companyId;
    const id = await fuente(empresa);
    const scope = { companyId: empresa };
    const resultado = await withCompany(
      ctx.db,
      empresa,
      async (tx) => {
        const reclamada = await brandAnalysisStore.claimBrandSourceAnalysis(
          tx,
          scope,
          id,
          NOW,
        );
        const perfil = await brandAnalysisStore.lockCompanyProfile(tx, scope);
        const completada = await brandAnalysisStore.completeBrandSourceAnalysis(
          tx,
          scope,
          id,
          { status: "ready", acquisitionTier: "B_public_api", now: NOW },
        );
        const snap = await brandAnalysisStore.insertBrandSourceSnapshot(
          tx,
          scope,
          snapshotInput(id),
        );
        const guardado = await brandAnalysisStore.saveMaterializedProfile(
          tx,
          scope,
          perfil.id,
          {
            values: { productOffering: "Tazas", businessCategories: ["Cerámica"] },
            fieldMeta: { productOffering: { confidence: "low" } },
            brandRevision: perfil.brandRevision + 1,
            status: "partial",
            now: NOW,
          },
        );
        return { reclamada, completada, snap, guardado };
      },
      { role: APP_ROLE },
    );
    expect(resultado.reclamada?.status).toBe("analyzing");
    expect(resultado.completada?.status).toBe("ready");
    expect(resultado.snap).not.toBeNull();
    expect(resultado.guardado?.productOffering).toBe("Tazas");
    expect(resultado.guardado?.businessCategories).toEqual(["Cerámica"]);
    expect(resultado.guardado?.brandRevision).toBe(1);
  });
});
