/**
 * `lockBrandSource` — el `WHERE` **sin RLS** (trampa 26), que el bloqueo sea de
 * verdad un bloqueo, y que funcione con el rol de la aplicación.
 *
 * La carrera de punta a punta (dos `POST /reanalyse` → un job) se mide en
 * `apps/api/test/brand-sources.int.test.ts`; acá se mide la pieza.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lockBrandSource } from "../src/repositories/index";
import { brandSources } from "../src/schema/index";
import { APP_ROLE, withCompany, withoutCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

async function fuente(companyId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(brandSources)
    .values({
      companyId,
      sourceType: "website",
      handle: `sitio-${randomUUID().slice(0, 8)}.test`,
      canonicalUrl: "https://sitio.test",
      acquisitionTier: "B_public_api",
      status: "ready",
    })
    .returning({ id: brandSources.id });
  if (row === undefined) throw new Error("no se creó la fuente");
  return row.id;
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha lock" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta lock" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("lockBrandSource", () => {
  it("no ve la fuente ajena, sin RLS: sólo el WHERE aísla", async () => {
    const id = await fuente(beta);
    expect(
      await withoutCompany(ctx.db, (tx) => lockBrandSource(tx, { companyId: alpha }, id)),
    ).toBeNull();
    expect(
      (await withoutCompany(ctx.db, (tx) => lockBrandSource(tx, { companyId: beta }, id)))
        ?.id,
    ).toBe(id);
  });

  it("una fuente inexistente es null, igual que una ajena", async () => {
    expect(
      await withoutCompany(ctx.db, (tx) =>
        lockBrandSource(tx, { companyId: alpha }, randomUUID()),
      ),
    ).toBeNull();
  });

  it("bloquea la fila: otra transacción no la puede tomar mientras está abierta", async () => {
    const id = await fuente(alpha);
    const scope = { companyId: alpha };

    let soltar: () => void = () => {};
    const suelta = new Promise<void>((r) => {
      soltar = r;
    });
    let tomado: () => void = () => {};
    const tomada = new Promise<void>((r) => {
      tomado = r;
    });
    const sostenida = withoutCompany(ctx.db, async (tx) => {
      await lockBrandSource(tx, scope, id);
      tomado();
      await suelta;
    });

    try {
      await tomada;
      // Con `lock_timeout` la segunda no cuelga el test: o falla con 55P03
      // (hay bloqueo), o vuelve con la fila (no lo hay, y el test cae).
      const segunda = withoutCompany(ctx.db, async (tx) => {
        await tx.execute(sql`set local lock_timeout = '200ms'`);
        return lockBrandSource(tx, scope, id);
      });
      await expect(segunda).rejects.toMatchObject({ code: "55P03" });
    } finally {
      soltar();
      await sostenida;
    }
  });

  it("funciona con el rol de la aplicación y el GUC puesto (RLS)", async () => {
    const id = await fuente(alpha);
    const row = await withCompany(
      ctx.db,
      alpha,
      (tx) => lockBrandSource(tx, { companyId: alpha }, id),
      { role: APP_ROLE },
    );
    expect(row?.id).toBe(id);
  });
});
