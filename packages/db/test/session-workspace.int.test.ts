/**
 * `app.resolve_session_workspace` — de qué workspace es una sesión (`0012`).
 *
 * Mismo problema que `api-key-bootstrap.int.test.ts`, del lado del usuario:
 * `workspace_memberships` tiene `FORCE ROW LEVEL SECURITY` sobre el `company_id`
 * que todavía no se conoce. El primer caso demuestra que el camino ingenuo **no
 * ve nada** con el rol de la app; sin él, el resto podría pasar sobre una base
 * sin RLS y no mediría nada.
 *
 * Los casos de aislamiento corren **como superusuario, sin `SET ROLE` y sin
 * GUC** (trampa 26): la función es `SECURITY DEFINER`, RLS no la alcanza, y lo
 * único que separa a un usuario de las membresías de otro es su `WHERE`.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveSessionWorkspace } from "../src/repositories/session-workspace";
import { companies, users, workspaceMemberships } from "../src/schema/index";
import { APP_ROLE } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;

async function comoApp<T>(
  fn: (tx: Parameters<Parameters<typeof ctx.db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return fn(tx);
  });
}

async function nuevoUsuario(defaultWorkspaceId: string | null = null): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(users).values({
    id,
    email: `u+${id.slice(0, 8)}@example.test`,
    fullName: `User ${id.slice(0, 8)}`,
    timezone: "UTC",
    defaultWorkspaceId,
  });
  return id;
}

async function membresia(
  companyId: string,
  userId: string,
  status: "invited" | "active" | "removed",
  createdAt: Date,
  id: string = randomUUID(),
): Promise<void> {
  await ctx.db
    .insert(workspaceMemberships)
    .values({ id, companyId, userId, role: "member", status, createdAt });
}

beforeAll(async () => {
  ctx = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("el problema que la función resuelve", () => {
  it("un SELECT directo con el rol de la app NO ve las membresías del usuario", async () => {
    const w = await seedCompany(ctx.db);
    const user = await nuevoUsuario();
    await membresia(w.companyId, user, "active", new Date("2026-01-01T00:00:00Z"));

    const directo = await comoApp((tx) =>
      tx.execute(sql`select 1 from workspace_memberships where user_id = ${user}`),
    );
    expect(directo).toHaveLength(0);

    // Y la función sí, con el mismo rol.
    expect(await comoApp((tx) => resolveSessionWorkspace(tx, user))).toBe(w.companyId);
  });
});

describe("aislamiento por usuario — sin GUC y sin SET ROLE (sólo el WHERE aísla)", () => {
  it("cada usuario resuelve SU workspace aunque existan membresías de otros", async () => {
    const wa = await seedCompany(ctx.db, { name: "A" });
    const wb = await seedCompany(ctx.db, { name: "B" });
    const ua = await nuevoUsuario();
    const ub = await nuevoUsuario();
    // La de `ub` es MÁS VIEJA: sin el filtro por usuario, la regla "la más
    // vieja" le daría a `ua` el workspace de `ub`.
    await membresia(wb.companyId, ub, "active", new Date("2020-01-01T00:00:00Z"));
    await membresia(wa.companyId, ua, "active", new Date("2026-01-01T00:00:00Z"));

    expect(await resolveSessionWorkspace(ctx.db, ua)).toBe(wa.companyId);
    expect(await resolveSessionWorkspace(ctx.db, ub)).toBe(wb.companyId);
  });

  it("un usuario sin membresías no hereda la de nadie: null", async () => {
    const w = await seedCompany(ctx.db);
    const otro = await nuevoUsuario();
    await membresia(w.companyId, otro, "active", new Date("2019-01-01T00:00:00Z"));
    const solo = await nuevoUsuario();
    expect(await resolveSessionWorkspace(ctx.db, solo)).toBeNull();
  });

  it("un default_workspace_id ajeno (sin membresía) no se elige", async () => {
    const mio = await seedCompany(ctx.db);
    const ajeno = await seedCompany(ctx.db);
    const user = await nuevoUsuario(ajeno.companyId);
    await membresia(mio.companyId, user, "active", new Date("2026-02-01T00:00:00Z"));
    expect(await resolveSessionWorkspace(ctx.db, user)).toBe(mio.companyId);
  });
});

describe("la regla de elección", () => {
  it("prefiere users.default_workspace_id sobre la membresía más vieja", async () => {
    const vieja = await seedCompany(ctx.db);
    const preferida = await seedCompany(ctx.db);
    const user = await nuevoUsuario(preferida.companyId);
    await membresia(vieja.companyId, user, "active", new Date("2020-01-01T00:00:00Z"));
    await membresia(
      preferida.companyId,
      user,
      "active",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(await resolveSessionWorkspace(ctx.db, user)).toBe(preferida.companyId);
  });

  it("sin default, la más vieja; con empate de fecha, el id menor (orden estable)", async () => {
    const w1 = await seedCompany(ctx.db);
    const w2 = await seedCompany(ctx.db);
    const w3 = await seedCompany(ctx.db);
    const user = await nuevoUsuario();
    const mismaFecha = new Date("2024-06-01T00:00:00Z");
    await membresia(w3.companyId, user, "active", new Date("2025-01-01T00:00:00Z"));
    await membresia(
      w2.companyId,
      user,
      "active",
      mismaFecha,
      "ffffffff-0000-4000-8000-000000000000",
    );
    await membresia(
      w1.companyId,
      user,
      "active",
      mismaFecha,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(await resolveSessionWorkspace(ctx.db, user)).toBe(w1.companyId);
    // Dos veces, lo mismo.
    expect(await resolveSessionWorkspace(ctx.db, user)).toBe(w1.companyId);
  });

  it("ignora membresías invited y removed, aunque sean el default", async () => {
    const invitado = await seedCompany(ctx.db);
    const removido = await seedCompany(ctx.db);
    const activo = await seedCompany(ctx.db);
    const user = await nuevoUsuario(invitado.companyId);
    await membresia(
      invitado.companyId,
      user,
      "invited",
      new Date("2020-01-01T00:00:00Z"),
    );
    await membresia(
      removido.companyId,
      user,
      "removed",
      new Date("2020-01-02T00:00:00Z"),
    );
    await membresia(activo.companyId, user, "active", new Date("2026-01-01T00:00:00Z"));
    expect(await resolveSessionWorkspace(ctx.db, user)).toBe(activo.companyId);

    const soloInvitado = await nuevoUsuario();
    await membresia(invitado.companyId, soloInvitado, "invited", new Date());
    expect(await resolveSessionWorkspace(ctx.db, soloInvitado)).toBeNull();
  });

  it("ignora workspaces soft_deleted, aunque sean el default", async () => {
    const borrado = await seedCompany(ctx.db);
    const vivo = await seedCompany(ctx.db);
    await ctx.db
      .update(companies)
      .set({ status: "soft_deleted" })
      .where(sql`${companies.id} = ${borrado.companyId}`);
    const user = await nuevoUsuario(borrado.companyId);
    await membresia(borrado.companyId, user, "active", new Date("2020-01-01T00:00:00Z"));
    await membresia(vivo.companyId, user, "active", new Date("2026-01-01T00:00:00Z"));
    expect(await resolveSessionWorkspace(ctx.db, user)).toBe(vivo.companyId);
  });

  it("un id que no es uuid es null, no un error de sintaxis de Postgres", async () => {
    expect(await resolveSessionWorkspace(ctx.db, "no-es-un-uuid")).toBeNull();
  });
});

describe("cómo está declarada", () => {
  it("es SECURITY DEFINER, fija el search_path y no la ejecuta PUBLIC", async () => {
    const filas = await ctx.db.execute(sql`
      select p.prosecdef, p.proconfig,
             has_function_privilege('public', 'app.resolve_session_workspace(uuid)', 'EXECUTE') as publico,
             has_function_privilege(${APP_ROLE}, 'app.resolve_session_workspace(uuid)', 'EXECUTE') as app
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'resolve_session_workspace'
    `);
    expect(filas).toHaveLength(1);
    const f = filas[0] as {
      prosecdef: boolean;
      proconfig: string[] | null;
      publico: boolean;
      app: boolean;
    };
    expect(f.prosecdef).toBe(true);
    expect(f.proconfig?.some((c) => c.startsWith("search_path="))).toBe(true);
    expect(f.publico).toBe(false);
    expect(f.app).toBe(true);
  });
});
