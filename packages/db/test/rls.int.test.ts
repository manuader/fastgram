/**
 * Row Level Security — P1-DATA-010 · IMPL §2.4.
 *
 * ## Cómo está construido este test, y por qué importa
 *
 * Un test de RLS que sólo comprueba *"no veo lo del otro"* **pasa igual si alguien
 * borra la política**: con RLS activo y sin políticas, Postgres niega todo, y "no veo
 * nada" se confunde con "el aislamiento funciona". Por eso cada caso afirma las dos
 * direcciones:
 *
 *   - **lo propio se ve** → se rompe si se borra la política;
 *   - **lo ajeno no se ve** → se rompe si se desactiva RLS.
 *
 * Los dos últimos tests del archivo demuestran esa propiedad: desactivan RLS / borran
 * la política dentro de una transacción que después se revierte, y verifican que el
 * comportamiento cambia. Si alguna vez dejan de cambiar, es que las aserciones de
 * arriba dejaron de medir algo.
 *
 * Además: todo esto corre con `SET LOCAL ROLE fastgram_app`. Un superusuario saltea
 * RLS y el archivo entero daría verde sin probar nada.
 */

import { randomUUID } from "node:crypto";
import { getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentAngles } from "../src/schema/index";
import { COMPANY_SCOPED_TABLES, TENANT_ROOT_TABLE } from "../src/schema/index";
import { contentAngleRepository } from "../src/repositories/index";
import { withCompany, withoutCompany, APP_ROLE } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: { companyId: string; ownerUserId: string };
let beta: { companyId: string; ownerUserId: string };
let alphaAngleId: string;
let betaAngleId: string;

beforeAll(async () => {
  ctx = await startTestDatabase();

  alpha = await seedCompany(ctx.db, { name: "Alpha" });
  beta = await seedCompany(ctx.db, { name: "Beta" });

  alphaAngleId = randomUUID();
  betaAngleId = randomUUID();

  // Sembrado como superusuario (camino de provisión), no como la aplicación.
  await ctx.db.insert(contentAngles).values([
    { id: alphaAngleId, companyId: alpha.companyId, title: "Ángulo de Alpha" },
    { id: betaAngleId, companyId: beta.companyId, title: "Ángulo de Beta" },
  ]);
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("configuración de RLS", () => {
  it("toda tabla de cliente tiene RLS habilitado, forzado y con política", async () => {
    const rows = await ctx.db.execute<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    `);
    const byName = new Map(rows.map((r) => [r.relname, r]));

    const policies = await ctx.db.execute<{ tablename: string }>(
      sql`select tablename from pg_policies where schemaname = 'public'`,
    );
    const withPolicy = new Set(policies.map((p) => p.tablename));

    const mustBeProtected = [
      ...COMPANY_SCOPED_TABLES.map((t) => getTableName(t)),
      getTableName(TENANT_ROOT_TABLE),
    ];

    for (const name of mustBeProtected) {
      const row = byName.get(name);
      expect(row, `no existe la tabla ${name}`).toBeDefined();
      expect(row?.relrowsecurity, `${name} sin ENABLE ROW LEVEL SECURITY`).toBe(true);
      // Sin FORCE, el dueño de la tabla —que es quien corre las migraciones y, si
      // nadie lo corrige, también la app— saltea su propia política.
      expect(row?.relforcerowsecurity, `${name} sin FORCE ROW LEVEL SECURITY`).toBe(true);
      expect(withPolicy.has(name), `${name} sin política`).toBe(true);
    }
  });
});

describe("aislamiento entre workspaces", () => {
  it("con scope propio se ve lo propio (se rompe si se borra la política)", async () => {
    const rows = await withCompany(
      ctx.db,
      alpha.companyId,
      (tx) => tx.select().from(contentAngles),
      { role: APP_ROLE },
    );
    expect(rows.map((r) => r.id)).toEqual([alphaAngleId]);
  });

  it("no se ve lo ajeno (se rompe si se desactiva RLS)", async () => {
    const rows = await withCompany(
      ctx.db,
      alpha.companyId,
      (tx) =>
        tx
          .select()
          .from(contentAngles)
          .where(sql`${contentAngles.id} = ${betaAngleId}`),
      { role: APP_ROLE },
    );
    expect(rows).toEqual([]);
  });

  it("el repositorio devuelve null para un id ajeno, no un 403 (PRD §9.2)", async () => {
    const [propio, ajeno] = await withCompany(
      ctx.db,
      alpha.companyId,
      async (tx) => [
        await contentAngleRepository.findById(
          tx,
          { companyId: alpha.companyId },
          alphaAngleId,
        ),
        await contentAngleRepository.findById(
          tx,
          { companyId: alpha.companyId },
          betaAngleId,
        ),
      ],
      { role: APP_ROLE },
    );
    expect(propio?.title).toBe("Ángulo de Alpha");
    // Indistinguible de "no existe" — es el requisito, no una simplificación.
    expect(ajeno).toBeNull();
  });

  it("no se puede escribir en otro workspace (WITH CHECK)", async () => {
    await expect(
      withCompany(
        ctx.db,
        alpha.companyId,
        (tx) =>
          tx
            .insert(contentAngles)
            .values({ companyId: beta.companyId, title: "Inyectado" }),
        { role: APP_ROLE },
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("no se puede actualizar una fila ajena: afecta 0 filas", async () => {
    const updated = await withCompany(
      ctx.db,
      alpha.companyId,
      (tx) =>
        tx.execute(
          sql`update ${contentAngles} set title = 'secuestrado'
               where id = ${betaAngleId} returning 1 as ok`,
        ),
      { role: APP_ROLE },
    );
    expect(updated).toHaveLength(0);

    // Y la fila de Beta quedó intacta (verificado fuera de RLS).
    const beta$ = await ctx.db.execute<{ title: string }>(
      sql`select title from ${contentAngles} where id = ${betaAngleId}`,
    );
    expect(beta$[0]?.title).toBe("Ángulo de Beta");
  });

  it("sin `app.current_company` no se ve nada — falla cerrado", async () => {
    const rows = await withoutCompany(ctx.db, (tx) => tx.select().from(contentAngles), {
      role: APP_ROLE,
    });
    expect(rows).toEqual([]);
  });

  it("no se puede borrar una fila ajena", async () => {
    const deleted = await withCompany(
      ctx.db,
      alpha.companyId,
      (tx) =>
        tx.execute(sql`delete from ${contentAngles} where id = ${betaAngleId}
                       returning 1 as ok`),
      { role: APP_ROLE },
    );
    expect(deleted).toHaveLength(0);
  });
});

describe("la red es la que bloquea, no el WHERE", () => {
  /**
   * Estos dos tests prueban que los de arriba miden algo. Cada uno rompe RLS dentro de
   * una transacción y la revierte: si el comportamiento **no** cambiara, sería que las
   * aserciones de aislamiento pasan por otra razón (un WHERE en el repositorio, por
   * ejemplo) y no por la política.
   */

  it("desactivar RLS filtra el workspace ajeno", async () => {
    const leaked = await runAndRollback(async (tx) => {
      await tx.execute(
        sql.raw(`alter table "content_angles" disable row level security`),
      );
      await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(
        sql`select set_config('app.current_company', ${alpha.companyId}, true)`,
      );
      return tx.select().from(contentAngles);
    });
    // Sin RLS se ven los dos ángulos: la política era lo único que separaba.
    expect(leaked).toHaveLength(2);
  });

  it("borrar la política corta también el acceso propio", async () => {
    const own = await runAndRollback(async (tx) => {
      await tx.execute(
        sql.raw(`drop policy "content_angles_tenant_isolation" on "content_angles"`),
      );
      await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(
        sql`select set_config('app.current_company', ${alpha.companyId}, true)`,
      );
      return tx.select().from(contentAngles);
    });
    // RLS activo y sin políticas ⇒ deny all. Por eso el test de "veo lo mío" es la
    // mitad que detecta una política borrada.
    expect(own).toEqual([]);
  });

  /** Corre `fn` en una transacción y la revierte siempre. */
  async function runAndRollback<T>(
    fn: (tx: Parameters<Parameters<typeof ctx.db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    const marker = "__rollback__";
    let captured: T | undefined;
    try {
      await ctx.db.transaction(async (tx) => {
        captured = await fn(tx);
        throw new Error(marker);
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== marker) throw error;
    }
    return captured as T;
  }
});
