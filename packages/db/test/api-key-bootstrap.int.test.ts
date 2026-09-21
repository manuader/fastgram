/**
 * `app.resolve_api_key` — el bootstrap de autenticación (PRD §9.1, `FR-180`).
 *
 * Resolver una API key es **el único acceso a datos del sistema que no puede
 * llevar scope de `companyId`**, porque el `companyId` es justamente lo que
 * está averiguando. Eso choca con el `FORCE ROW LEVEL SECURITY` de `api_keys`.
 *
 * La consecuencia es del tipo peor: **funciona en desarrollo y no en
 * producción**. En desarrollo la conexión suele ser superusuario y saltea RLS;
 * con `fastgram_app` devuelve cero filas y **toda la API responde 401**. No un
 * endpoint: todos.
 *
 * Por eso el primer test de este archivo comprueba que el camino ingenuo
 * **falla**. Sin él, el resto pasaría también sobre una base sin RLS y no
 * estaría midiendo nada.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiKeys } from "../src/schema/index";
import { APP_ROLE } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let companyId: string;
const HASH_VIVA = "hash_viva_" + randomUUID();
const HASH_REVOCADA = "hash_revocada_" + randomUUID();
const HASH_VENCIDA = "hash_vencida_" + randomUUID();

beforeAll(async () => {
  ctx = await startTestDatabase();
  const alpha = await seedCompany(ctx.db, { name: "Alpha" });
  companyId = alpha.companyId;

  await ctx.db.insert(apiKeys).values([
    { companyId, label: "viva", hash: HASH_VIVA },
    { companyId, label: "revocada", hash: HASH_REVOCADA, revokedAt: new Date() },
    {
      companyId,
      label: "vencida",
      hash: HASH_VENCIDA,
      expiresAt: new Date(Date.now() - 60_000),
    },
  ]);
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

/** Corre `fn` con el rol de la aplicación, que es el de producción. */
async function comoApp<T>(
  fn: (tx: Parameters<Parameters<typeof ctx.db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return ctx.db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return fn(tx);
  });
}

describe("el problema que la función resuelve", () => {
  it("un SELECT directo con el rol de la app NO ve la clave", async () => {
    // Es el camino ingenuo, y es el que estaba escrito en `apps/api`. Si este
    // test empezara a pasar, sería que alguien aflojó RLS sobre `api_keys` —
    // y entonces todos los demás tests de este archivo dejarían de medir nada.
    const filas = await comoApp((tx) =>
      tx.execute(sql`select 1 from api_keys where hash = ${HASH_VIVA}`),
    );
    expect(filas).toHaveLength(0);
  });
});

describe("app.resolve_api_key", () => {
  it("resuelve una clave viva con el rol de la app", async () => {
    const filas = await comoApp((tx) =>
      tx.execute(sql`select company_id, kind from app.resolve_api_key(${HASH_VIVA})`),
    );
    expect(filas).toHaveLength(1);
    expect((filas[0] as { company_id: string }).company_id).toBe(companyId);
  });

  it("una clave revocada SÍ resuelve, con su `revoked_at` — y es a propósito", async () => {
    // Filtrarla acá sería más corto y perdería información. El PRD distingue
    // ocho causas de 401, y aunque el **cuerpo de la respuesta es idéntico
    // para todas** —para no decirle a quien sondea si el token existe— el
    // **log** sí tiene que distinguirlas: "revocada hace dos días" y "nunca
    // existió" piden respuestas operativas distintas. Filtrar acá las
    // colapsaría a `no_match`. La decisión la toma la aplicación.
    const filas = await comoApp((tx) =>
      tx.execute(sql`select revoked_at from app.resolve_api_key(${HASH_REVOCADA})`),
    );
    expect(filas).toHaveLength(1);
    expect((filas[0] as { revoked_at: unknown }).revoked_at).not.toBeNull();
  });

  it("una clave vencida SÍ resuelve, con su `expires_at` en el pasado", async () => {
    const filas = await comoApp((tx) =>
      tx.execute(sql`select expires_at from app.resolve_api_key(${HASH_VENCIDA})`),
    );
    expect(filas).toHaveLength(1);
    const exp = (filas[0] as { expires_at: string | Date }).expires_at;
    expect(new Date(exp).getTime()).toBeLessThan(Date.now());
  });

  it("una clave viva trae `revoked_at` y `expires_at` en null", async () => {
    const filas = await comoApp((tx) =>
      tx.execute(
        sql`select revoked_at, expires_at from app.resolve_api_key(${HASH_VIVA})`,
      ),
    );
    const f = filas[0] as { revoked_at: unknown; expires_at: unknown };
    expect(f.revoked_at).toBeNull();
    expect(f.expires_at).toBeNull();
  });

  it("un hash inexistente no resuelve", async () => {
    const filas = await comoApp((tx) =>
      tx.execute(sql`select 1 from app.resolve_api_key('no_existe')`),
    );
    expect(filas).toHaveLength(0);
  });

  it("NO expone el hash ni la etiqueta", async () => {
    // Una función SECURITY DEFINER saltea RLS, así que su superficie es la
    // única defensa que queda. Devuelve lo necesario para autenticar y nada
    // más: ni el hash, ni el `label`, ni el resto de la fila.
    const filas = await comoApp((tx) =>
      tx.execute(sql`select * from app.resolve_api_key(${HASH_VIVA})`),
    );
    expect(Object.keys(filas[0] as object).sort()).toEqual([
      "api_key_id",
      "company_id",
      "company_status",
      "expires_at",
      "kind",
      "revoked_at",
    ]);
  });

  it("resuelve el estado del workspace en la misma ida", async () => {
    // `companies` también tiene RLS, así que sin esto harían falta dos
    // consultas privilegiadas en vez de una.
    const filas = await comoApp((tx) =>
      tx.execute(sql`select company_status from app.resolve_api_key(${HASH_VIVA})`),
    );
    expect(typeof (filas[0] as { company_status: string }).company_status).toBe("string");
  });

  it("no permite listar: sin hash no devuelve nada", async () => {
    const filas = await comoApp((tx) =>
      tx.execute(sql`select 1 from app.resolve_api_key('')`),
    );
    expect(filas).toHaveLength(0);
  });
});

describe("cómo está declarada", () => {
  it("es SECURITY DEFINER y fija el search_path", async () => {
    // Sin `search_path` fijo, alguien que pueda crear objetos en un esquema
    // del search_path del llamador puede secuestrar la resolución de nombres
    // y ejecutar código con los privilegios del dueño. Es el modo clásico de
    // convertir una SECURITY DEFINER en escalación de privilegios.
    const filas = await ctx.db.execute(sql`
      select p.prosecdef, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'resolve_api_key'
    `);
    expect(filas).toHaveLength(1);
    const f = filas[0] as { prosecdef: boolean; proconfig: string[] | null };
    expect(f.prosecdef).toBe(true);
    expect(f.proconfig?.some((c) => c.startsWith("search_path="))).toBe(true);
  });

  it("no es ejecutable por PUBLIC", async () => {
    const filas = await ctx.db.execute(sql`
      select has_function_privilege('public', 'app.resolve_api_key(text)', 'EXECUTE') as puede
    `);
    expect((filas[0] as { puede: boolean }).puede).toBe(false);
  });
});
