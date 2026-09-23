/**
 * `companyRepository.completeOnboarding` — el cierre del alta (`FR-010`), la
 * única escritura de estado de `companies`.
 *
 * Lo que la ruta no puede probar desde afuera es la carrera: dos cierres que
 * leen `draft` a la vez. Desde HTTP un test así pasa igual si el segundo llega
 * tarde y **lee** `active` (trampa 22). Acá se fuerza el solapamiento con una
 * transacción que retiene la fila hasta que los dos cierres están esperando su
 * lock (el patrón de `first-workspace.int.test.ts`), y entonces lo único que
 * puede separarlos es el `WHERE status IN (…)` del `UPDATE`.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { companyRepository } from "../src/repositories/index";
import { companies } from "../src/schema/index";
import { withCompany } from "../src/tenancy";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres";

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

type Status = "draft" | "preparing" | "active" | "soft_deleted";

async function workspaceIn(status: Status): Promise<string> {
  const { companyId } = await seedCompany(ctx.db);
  await ctx.db.update(companies).set({ status }).where(eq(companies.id, companyId));
  return companyId;
}

async function statusOf(companyId: string): Promise<string | undefined> {
  const [row] = await ctx.db
    .select({ status: companies.status })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row?.status;
}

const complete = (companyId: string, scopeId: string = companyId) =>
  withCompany(
    ctx.db,
    companyId,
    (tx) => companyRepository.completeOnboarding(tx, { companyId: scopeId }),
    { role: APP_ROLE },
  );

describe("las transiciones", () => {
  it("draft → active", async () => {
    const id = await workspaceIn("draft");
    const result = await complete(id);
    expect(result.kind).toBe("activated");
    expect(await statusOf(id)).toBe("active");
  });

  it("preparing → active", async () => {
    const id = await workspaceIn("preparing");
    expect((await complete(id)).kind).toBe("activated");
    expect(await statusOf(id)).toBe("active");
  });

  it("active → no escribe, y lo dice", async () => {
    const id = await workspaceIn("active");
    const [antes] = await ctx.db
      .select({ updatedAt: companies.updatedAt })
      .from(companies)
      .where(eq(companies.id, id));
    const result = await complete(id);
    const [despues] = await ctx.db
      .select({ updatedAt: companies.updatedAt })
      .from(companies)
      .where(eq(companies.id, id));
    // `updatedAt` quieto: no hubo `UPDATE`, no sólo "el status no cambió".
    expect(despues?.updatedAt.getTime()).toBe(antes?.updatedAt.getTime());
    expect(result.kind).toBe("already_active");
  });

  it("soft_deleted → not_found, y NO se reactiva", async () => {
    const id = await workspaceIn("soft_deleted");
    const result = await complete(id);
    expect(await statusOf(id)).toBe("soft_deleted");
    expect(result.kind).toBe("not_found");
  });
});

describe("scope", () => {
  it("con el scope de otro workspace no toca nada", async () => {
    // GUC de `a`, scope de `b`: RLS esconde `b` y el `WHERE` también. Lo que se
    // mide es que el resultado sea `not_found` y que `b` siga en `draft`.
    const a = await workspaceIn("draft");
    const b = await workspaceIn("draft");
    const result = await complete(a, b);
    expect(await statusOf(b)).toBe("draft");
    expect(await statusOf(a)).toBe("draft");
    expect(result.kind).toBe("not_found");
  });
});

describe("dos cierres simultáneos (trampa 37)", () => {
  it("sale exactamente un `activated`", async () => {
    const id = await workspaceIn("draft");

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const blocker = ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from companies where id = ${id} for update`);
      locked();
      await released;
    });
    await holding;

    const a = complete(id);
    const b = complete(id);

    // Hasta que los dos estén bloqueados en el lock de la fila: si no, uno
    // podría llegar tarde y el test mediría el orden, no la guarda (trampa 34).
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = (await ctx.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()`,
      )) as unknown as { n: number }[];
      if ((rows[0]?.n ?? 0) >= 2) break;
      if (Date.now() > deadline) throw new Error("los dos cierres nunca se bloquearon");
      await new Promise((r) => setTimeout(r, 25));
    }

    release();
    await blocker;
    const results = await Promise.all([a, b]);

    // Negativa primero (trampa 35): lo que no puede pasar es que haya dos.
    expect(results.filter((r) => r.kind === "activated")).toHaveLength(1);
    expect(results.map((r) => r.kind).sort()).toEqual(["activated", "already_active"]);
    expect(await statusOf(id)).toBe("active");
  });
});
