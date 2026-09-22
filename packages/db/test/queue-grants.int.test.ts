/**
 * Privilegios del rol de la aplicación sobre el esquema de pg-boss — migración
 * `0004`, `ADR-005`.
 *
 * ## Por qué este archivo existe
 *
 * Porque es la **tercera vez** que aparece la misma clase de bug en el
 * proyecto, y las tres veces se vio igual: *funciona en desarrollo y no en
 * producción*, porque en desarrollo la conexión es superusuario y saltea todo.
 * Antes fue el bootstrap de API keys contra `FORCE ROW LEVEL SECURITY`
 * (migración `0003`); antes de eso, el `WHERE` que parecía aislar y sólo
 * aislaba porque nadie corría como `fastgram_app`.
 *
 * Acá el síntoma sería que **toda ruta que encole falla**: crear contenido,
 * crear influencer, programar un post, aceptar un Blitz. Medido antes del
 * arreglo, con el rol puesto a mano:
 *
 *     ERROR:  permission denied for schema pgboss
 *
 * ## Qué prueba y qué no
 *
 * No monta pg-boss: eso lo hace `packages/adapters`. Prueba lo único que la
 * migración puede garantizar —que una tabla creada por el dueño **después** de
 * la migración quede alcanzable para `fastgram_app`—, que es exactamente el
 * orden real: Drizzle migra en el deploy, pg-boss crea sus tablas cuando
 * arranca.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_ROLE, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("el esquema de pg-boss existe después de migrar", () => {
  it("lo crea la migración, para poder dejar los privilegios por defecto", async () => {
    // El orden es el punto: si el esquema no existiera acá, el
    // `ALTER DEFAULT PRIVILEGES` no tendría dónde aplicarse y **no fallaría**,
    // simplemente no haría nada. `CREATE SCHEMA IF NOT EXISTS` de pg-boss lo
    // encuentra hecho y sigue.
    const filas = await ctx.db.execute(
      sql`select 1 from information_schema.schemata where schema_name = 'pgboss'`,
    );
    expect(filas).toHaveLength(1);
  });

  it("`fastgram_app` tiene USAGE sobre él", async () => {
    const filas = await ctx.db.execute(
      sql`select has_schema_privilege(${APP_ROLE}, 'pgboss', 'USAGE') as puede`,
    );
    expect((filas[0] as { puede: boolean }).puede).toBe(true);
  });
});

describe("una tabla creada DESPUÉS de la migración", () => {
  it("queda escribible por el rol de la aplicación", async () => {
    // Es el caso real y el que un `GRANT ON ALL TABLES` no cubre: pg-boss crea
    // sus tablas en otro proceso y más tarde. Lo que lo resuelve es el
    // `ALTER DEFAULT PRIVILEGES`.
    await ctx.db.execute(
      sql`create table if not exists pgboss.job_probe (
            id uuid primary key default gen_random_uuid(),
            name text not null
          )`,
    );

    const escrito = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(sql`insert into pgboss.job_probe (name) values ('content-build')`);
      return tx.execute(sql`select count(*)::int as n from pgboss.job_probe`);
    });

    expect((escrito[0] as { n: number }).n).toBe(1);
  });

  it("y también borrable: cancelar un job es un DELETE del worker", async () => {
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(sql`delete from pgboss.job_probe`);
    });

    const filas = await ctx.db.execute(
      sql`select count(*)::int as n from pgboss.job_probe`,
    );
    expect((filas[0] as { n: number }).n).toBe(0);
  });
});
