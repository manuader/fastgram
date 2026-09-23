/**
 * `createFirstWorkspace` — `P1-TENANT-001`.
 *
 * Todo corre **con el rol de la app** (`fastgram_app`, NOSUPERUSER, FORCE RLS):
 * como superusuario RLS no existe y esta suite no mediría el problema que el
 * repositorio resuelve (trampa 16 de `docs/HANDOFF.md`). El primer caso lo
 * demuestra: sin el GUC apuntando al workspace nuevo, el rol de la app no puede
 * escribir la company.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFirstWorkspace,
  type NewFirstWorkspace,
} from "../src/repositories/first-workspace";
import { resolveSessionWorkspace } from "../src/repositories/session-workspace";
import { companies, users, workspaceMemberships } from "../src/schema/index";
import { APP_ROLE, withCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
const AS_APP = { role: APP_ROLE } as const;

async function nuevoUsuario(
  timezone = "America/Argentina/Buenos_Aires",
): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(users).values({
    id,
    email: `u+${id.slice(0, 8)}@example.test`,
    fullName: `User ${id.slice(0, 8)}`,
    timezone,
  });
  return id;
}

function plan(
  ownerUserId: string,
  overrides: Partial<NewFirstWorkspace> = {},
): NewFirstWorkspace {
  return {
    ownerUserId,
    name: "Acme",
    websiteUrl: null,
    planId: "free",
    subscriptionStatus: "trialing",
    status: "draft",
    billingAnchorDay: 23,
    ownerMembership: { role: "owner", status: "active" },
    setAsDefaultWorkspace: true,
    ...overrides,
  };
}

/** Cuántas companies tiene como dueño, contadas como superusuario (sin RLS). */
async function companiesOf(ownerUserId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.ownerUserId, ownerUserId));
  return rows.length;
}

beforeAll(async () => {
  ctx = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("el problema: RLS sobre companies", () => {
  it("con el rol de la app y SIN GUC, un INSERT directo en companies es rechazado", async () => {
    const user = await nuevoUsuario();
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
        await tx.insert(companies).values({
          name: "Directo",
          ownerUserId: user,
          planId: "free",
          billingAnchorDay: 1,
          timezone: "UTC",
        });
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await companiesOf(user)).toBe(0);
  });
});

describe("el alta, con el rol de la app", () => {
  it("escribe company + membresía owner activa + default, todo con los valores del plan", async () => {
    const user = await nuevoUsuario("Europe/Madrid");
    const result = await createFirstWorkspace(ctx.db, plan(user), AS_APP);

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    const { company } = result;
    expect(company).toMatchObject({
      name: "Acme",
      websiteUrl: null,
      ownerUserId: user,
      status: "draft",
      planId: "free",
      subscriptionStatus: "trialing",
      billingAnchorDay: 23,
      // La zona del dueño: el PRD no da otra.
      timezone: "Europe/Madrid",
    });

    const memberships = await ctx.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, user));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      companyId: company.id,
      role: "owner",
      status: "active",
      invitedBy: null,
    });

    const [owner] = await ctx.db.select().from(users).where(eq(users.id, user));
    expect(owner?.defaultWorkspaceId).toBe(company.id);

    // Lo que la API va a responder en `GET /auth/session`, con el rol de la app.
    const resolved = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
      return resolveSessionWorkspace(tx, user);
    });
    expect(resolved).toBe(company.id);
  });

  it("el workspace nuevo es de su tenant: otro GUC no lo ve (y el suyo sí)", async () => {
    const otro = await seedCompany(ctx.db);
    const user = await nuevoUsuario();
    const result = await createFirstWorkspace(ctx.db, plan(user), AS_APP);
    if (result.kind !== "created") throw new Error(result.kind);

    const desdeOtro = await withCompany(
      ctx.db,
      otro.companyId,
      (tx) => tx.select().from(companies).where(eq(companies.id, result.company.id)),
      AS_APP,
    );
    expect(desdeOtro).toHaveLength(0);

    const desdeSuyo = await withCompany(
      ctx.db,
      result.company.id,
      (tx) => tx.select().from(companies).where(eq(companies.id, result.company.id)),
      AS_APP,
    );
    expect(desdeSuyo).toHaveLength(1);
  });
});

describe("uno solo", () => {
  it("el segundo pedido del mismo usuario devuelve el que ya tiene y no escribe nada", async () => {
    const user = await nuevoUsuario();
    const first = await createFirstWorkspace(ctx.db, plan(user), AS_APP);
    if (first.kind !== "created") throw new Error(first.kind);

    const second = await createFirstWorkspace(
      ctx.db,
      plan(user, { name: "Otra" }),
      AS_APP,
    );
    expect(await companiesOf(user)).toBe(1);
    expect(second).toEqual({
      kind: "already_has_workspace",
      companyId: first.company.id,
    });
  });

  it("ser miembro activo de un workspace ajeno también cuenta como «ya tiene»", async () => {
    const ajeno = await seedCompany(ctx.db);
    const user = await nuevoUsuario();
    await ctx.db.insert(workspaceMemberships).values({
      companyId: ajeno.companyId,
      userId: user,
      role: "member",
      status: "active",
    });

    const result = await createFirstWorkspace(ctx.db, plan(user), AS_APP);
    expect(await companiesOf(user)).toBe(0);
    expect(result).toEqual({ kind: "already_has_workspace", companyId: ajeno.companyId });
  });

  it("una membresía sólo invitada NO cuenta: puede crear el suyo", async () => {
    const ajeno = await seedCompany(ctx.db);
    const user = await nuevoUsuario();
    await ctx.db.insert(workspaceMemberships).values({
      companyId: ajeno.companyId,
      userId: user,
      role: "member",
      status: "invited",
    });
    const result = await createFirstWorkspace(ctx.db, plan(user), AS_APP);
    expect(result.kind).toBe("created");
  });

  it("si su único workspace está soft_deleted, puede crear otro (misma regla que la sesión)", async () => {
    const user = await nuevoUsuario();
    const first = await createFirstWorkspace(ctx.db, plan(user), AS_APP);
    if (first.kind !== "created") throw new Error(first.kind);
    await ctx.db
      .update(companies)
      .set({ status: "soft_deleted" })
      .where(eq(companies.id, first.company.id));

    const second = await createFirstWorkspace(ctx.db, plan(user), AS_APP);
    expect(second.kind).toBe("created");
  });
});

describe("dos pedidos simultáneos del mismo usuario (trampa 37)", () => {
  /**
   * Una transacción ajena retiene la fila del usuario hasta que **los dos**
   * pedidos están esperando un lock. Con la guarda, esperan en el
   * `FOR NO KEY UPDATE` y se serializan. Sin ella, pasan la pregunta los dos y
   * esperan recién en el `UPDATE users`: al soltarse, los dos commitean. El
   * solapamiento no depende del azar (trampas 22 y 34).
   */
  it("sale exactamente uno creado, y el otro ve el primero", async () => {
    const user = await nuevoUsuario();

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const blocker = ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from users where id = ${user} for no key update`);
      locked();
      await released;
    });
    await holding;

    const a = createFirstWorkspace(ctx.db, plan(user, { name: "A1" }), AS_APP);
    const b = createFirstWorkspace(ctx.db, plan(user, { name: "B1" }), AS_APP);

    // Hasta que los dos estén bloqueados esperando un lock.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = (await ctx.db.execute(
        sql`select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()`,
      )) as unknown as { n: number }[];
      if ((rows[0]?.n ?? 0) >= 2) break;
      if (Date.now() > deadline) throw new Error("los dos pedidos nunca se bloquearon");
      await new Promise((r) => setTimeout(r, 25));
    }

    release();
    await blocker;
    const results = await Promise.all([a, b]);

    // Negativa primero (trampa 35): lo que no puede pasar es que haya dos.
    expect(await companiesOf(user)).toBe(1);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(["already_has_workspace", "created"]);
    const created = results.find((r) => r.kind === "created");
    const other = results.find((r) => r.kind === "already_has_workspace");
    if (created?.kind !== "created" || other?.kind !== "already_has_workspace") {
      throw new Error("forma inesperada");
    }
    expect(other.companyId).toBe(created.company.id);
  });
});

describe("la web: única global (DATA-002)", () => {
  it("la misma web en un segundo usuario → website_taken, y no queda NADA escrito", async () => {
    const web = `https://acme-${randomUUID().slice(0, 8)}.com`;
    const u1 = await nuevoUsuario();
    const u2 = await nuevoUsuario();
    expect(
      (await createFirstWorkspace(ctx.db, plan(u1, { websiteUrl: web }), AS_APP)).kind,
    ).toBe("created");

    const result = await createFirstWorkspace(
      ctx.db,
      plan(u2, { websiteUrl: web }),
      AS_APP,
    );
    expect(await companiesOf(u2)).toBe(0);
    const memberships = await ctx.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, u2));
    expect(memberships).toHaveLength(0);
    const [owner] = await ctx.db.select().from(users).where(eq(users.id, u2));
    expect(owner?.defaultWorkspaceId).toBeNull();
    expect(result).toEqual({ kind: "website_taken" });
  });

  it("sin web, dos usuarios conviven (índice parcial)", async () => {
    const u1 = await nuevoUsuario();
    const u2 = await nuevoUsuario();
    expect((await createFirstWorkspace(ctx.db, plan(u1), AS_APP)).kind).toBe("created");
    expect((await createFirstWorkspace(ctx.db, plan(u2), AS_APP)).kind).toBe("created");
  });
});

describe("el dueño", () => {
  it("un uuid que no es de nadie → owner_not_found, sin escribir", async () => {
    const ghost = randomUUID();
    expect(await createFirstWorkspace(ctx.db, plan(ghost), AS_APP)).toEqual({
      kind: "owner_not_found",
    });
    expect(await companiesOf(ghost)).toBe(0);
  });

  it("un id que no es uuid → owner_not_found, no un 22P02", async () => {
    expect(await createFirstWorkspace(ctx.db, plan("no-es-uuid"), AS_APP)).toEqual({
      kind: "owner_not_found",
    });
  });
});
