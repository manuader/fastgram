/**
 * `0011_better_auth_identity` — las tablas de Better Auth sobre `users` (`P1-AUTH-001`).
 *
 * Lo que mide cada caso es una propiedad de la que depende el adaptador
 * `BetterAuthIdentity` y que el adaptador no puede verificar por su cuenta:
 *
 *  - `fastgram_app` puede leer y escribir las tres tablas. En producción Better Auth
 *    se conecta con ese rol; sin el GRANT, todo login respondería error y en
 *    desarrollo —superusuario— andaría (trampa 16/17).
 *  - Borrar el usuario se lleva sesiones y credenciales **en la misma sentencia**. Es
 *    lo que hace atómico a `deleteUser` (§9.1).
 *  - `external_identity_id` es nullable: Better Auth nunca la escribe.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_ROLE } from "../src/tenancy";
import { companies, users } from "../src/schema/index";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await startTestDatabase();
});

afterAll(async () => {
  await ctx?.stop();
});

async function insertBetterAuthStyleUser(): Promise<string> {
  // Las columnas que escribe Better Auth, y ninguna más: sin `external_identity_id`
  // ni `email_verified` explícito. Si alguna fuera NOT NULL sin default, esto falla
  // igual que fallaría cada alta.
  const id = randomUUID();
  await ctx.db.execute(sql`
    insert into users (id, email, full_name, timezone, image, created_at, updated_at)
    values (${id}, ${`ba+${id.slice(0, 8)}@example.test`}, 'Better Auth', 'UTC', null, now(), now())
  `);
  return id;
}

describe("0011 — tablas de Better Auth", () => {
  it("un alta con sólo las columnas de Better Auth entra, y email_verified nace en false", async () => {
    const id = await insertBetterAuthStyleUser();
    const rows = await ctx.db.execute<{
      external_identity_id: string | null;
      email_verified: boolean;
    }>(sql`select external_identity_id, email_verified from users where id = ${id}`);
    expect(rows[0]?.external_identity_id).toBeNull();
    expect(rows[0]?.email_verified).toBe(false);
  });

  it("fastgram_app lee y escribe sesiones, cuentas y verificaciones", async () => {
    const userId = await insertBetterAuthStyleUser();
    const result = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(sql`
        insert into auth_sessions (token, user_id, expires_at)
        values (${`tok_${userId}`}, ${userId}, now() + interval '1 hour')
      `);
      await tx.execute(sql`
        insert into auth_accounts (account_id, provider_id, user_id, password)
        values (${userId}, 'credential', ${userId}, 'hash')
      `);
      await tx.execute(sql`
        insert into auth_verifications (identifier, value, expires_at)
        values (${`reset-password:${userId}`}, ${userId}, now() + interval '1 hour')
      `);
      await tx.execute(sql`delete from auth_verifications where value = ${userId}`);
      return tx.execute<{ n: number }>(
        sql`select count(*)::int as n from auth_sessions where user_id = ${userId}`,
      );
    });
    expect(result[0]?.n).toBe(1);
  });

  it("borrar el usuario se lleva sesiones y credenciales en la misma sentencia (§9.1)", async () => {
    const userId = await insertBetterAuthStyleUser();
    await ctx.db.execute(sql`
      insert into auth_sessions (token, user_id, expires_at)
      values (${`tok_del_${userId}`}, ${userId}, now() + interval '1 hour')
    `);
    await ctx.db.execute(sql`
      insert into auth_accounts (account_id, provider_id, user_id, password)
      values (${userId}, 'credential', ${userId}, 'hash')
    `);

    await ctx.db.execute(sql`delete from users where id = ${userId}`);

    const left = await ctx.db.execute<{ s: number; a: number }>(sql`
      select (select count(*)::int from auth_sessions where user_id = ${userId}) as s,
             (select count(*)::int from auth_accounts where user_id = ${userId}) as a
    `);
    expect(left[0]).toEqual({ s: 0, a: 0 });
  });

  it("un usuario dueño de un workspace no se borra, y sus sesiones sobreviven intactas", async () => {
    // `companies.owner_user_id` es ON DELETE RESTRICT. El borrado de identidad tiene
    // que fallar entero —no dejar la cuenta sin credenciales y con la fila viva—.
    const userId = await insertBetterAuthStyleUser();
    await ctx.db.insert(companies).values({
      name: "Owned",
      ownerUserId: userId,
      planId: "free",
      billingAnchorDay: 1,
      timezone: "UTC",
    });
    await ctx.db.execute(sql`
      insert into auth_sessions (token, user_id, expires_at)
      values (${`tok_own_${userId}`}, ${userId}, now() + interval '1 hour')
    `);

    const error = await ctx.db.execute(sql`delete from users where id = ${userId}`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    expect((error as { code?: string }).code).toBe("23503");

    const left = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::int as n from auth_sessions where user_id = ${userId}`,
    );
    expect(left[0]?.n).toBe(1);
    const still = await ctx.db.select({ id: users.id }).from(users);
    expect(still.some((u) => u.id === userId)).toBe(true);
  });

  it("un token de sesión repetido choca con el índice único", async () => {
    const userId = await insertBetterAuthStyleUser();
    const token = `dup_${userId}`;
    await ctx.db.execute(sql`
      insert into auth_sessions (token, user_id, expires_at)
      values (${token}, ${userId}, now() + interval '1 hour')
    `);
    await expect(
      ctx.db.execute(sql`
        insert into auth_sessions (token, user_id, expires_at)
        values (${token}, ${userId}, now() + interval '1 hour')
      `),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
