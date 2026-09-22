/**
 * El `WHERE companyId` de `base.ts`, **medido sin RLS de por medio**.
 *
 * ## Por qué este archivo existe
 *
 * `createCompanyScopedRepository` produce los 28 repositorios del proyecto, y el
 * aislamiento por workspace de todos ellos descansa en **una línea**: el
 * `eq(config.companyId, scope.companyId)` de `scoped()`.
 *
 * Esa línea estaba cubierta por un solo test, y sólo para `findById`. Medido el
 * 2026-09-22 sacándola y corriendo la suite entera de `packages/db`:
 *
 *     Tests  1 failed | 135 passed | 24 skipped (160)
 *
 * **Un solo rojo.** `repositories-write.int.test.ts` —19 tests escritos justamente
 * para el acceso cruzado— no se enteró, y `rls.int.test.ts` tampoco.
 *
 * ## La razón, que es la trampa 21 y vale para todo el repo
 *
 * IMPL §2.4 pone dos capas: RLS en la base y el `WHERE` en el repositorio. Con el
 * GUC puesto, **la capa 1 tapa el agujero**: la fila ajena no es visible aunque el
 * `WHERE` no exista, así que un test de cross-tenant con scope activo mide RLS y
 * no el filtro. Los dos resultados se ven idénticos desde el llamador.
 *
 * Por eso acá **no hay `SET ROLE` ni GUC**: la conexión de los tests es
 * superusuaria, RLS queda fuera del camino, y lo único que puede aislar es el
 * `WHERE`. Es deliberadamente **menos** realista que `repositories-write`, y por
 * eso mismo mide lo que aquél no puede.
 *
 * ## Qué buscar cuando uno de estos se ponga rojo
 *
 * Que una operación devuelva `null` o `false` **no alcanza**: el bug caro es
 * «respondió que no y sin embargo escribió». Cada aserción de acceso cruzado
 * viene con una segunda que relee la fila víctima y comprueba que está intacta.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withoutCompany } from "../src/tenancy";
import { contentAngleRepository, contentRepository } from "../src/repositories/index";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

/**
 * Sin rol y sin GUC: superusuario. Es lo que saca a RLS del camino.
 *
 * Si alguien lo cambia por `withCompany(..., { role: APP_ROLE })`, el archivo
 * entero deja de medir lo que dice medir y **sigue verde**.
 */
const crudo = <T>(fn: Parameters<typeof withoutCompany<T>>[1]): Promise<T> =>
  withoutCompany(ctx.db, fn);

/** Un ángulo de `beta`: la fila víctima que `alpha` no puede tocar. */
async function angulloDeBeta(titulo: string): Promise<string> {
  const fila = await crudo((tx) =>
    contentAngleRepository.create(tx, { companyId: beta }, { title: titulo }),
  );
  return fila.id;
}

/** Relee como `beta` para comprobar que la fila sigue igual. */
async function leerDeBeta(id: string): Promise<{ title: string } | null> {
  const fila = await crudo((tx) =>
    contentAngleRepository.findById(tx, { companyId: beta }, id),
  );
  return fila === null ? null : { title: fila.title };
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha sin GUC" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta sin GUC" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("lectura: el filtro solo, sin RLS", () => {
  it("findById no encuentra la fila de otro workspace", async () => {
    const id = await angulloDeBeta("findById");

    expect(
      await crudo((tx) => contentAngleRepository.findById(tx, { companyId: alpha }, id)),
    ).toBeNull();
  });

  it("list no incluye filas de otro workspace", async () => {
    const id = await angulloDeBeta("list");

    const page = await crudo((tx) =>
      contentAngleRepository.list(tx, { companyId: alpha }, { limit: 100 }),
    );
    expect(page.items.map((fila) => fila.id)).not.toContain(id);
  });

  it("listByPage tampoco: la paginación numerada usa otro camino", async () => {
    // `listByPage` no comparte código con `list` más allá del filtro, así que un
    // `WHERE` que se pierda sólo ahí no lo vería el test de `list`.
    const id = await angulloDeBeta("listByPage");

    const page = await crudo((tx) =>
      contentAngleRepository.listByPage(
        tx,
        { companyId: alpha },
        { page: 1, limit: 100 },
      ),
    );
    expect(page.items.map((fila) => fila.id)).not.toContain(id);
  });

  it("count no cuenta lo ajeno", async () => {
    await angulloDeBeta("count");

    // `alpha` no tiene ángulos propios en ningún test de este archivo, así que
    // cualquier número distinto de 0 es una fuga.
    expect(
      await crudo((tx) => contentAngleRepository.count(tx, { companyId: alpha }, {})),
    ).toBe(0);
  });
});

describe("escritura: responder que no NO alcanza, hay que no escribir", () => {
  it("update no toca la fila ajena", async () => {
    const id = await angulloDeBeta("update original");

    const resultado = await crudo((tx) =>
      contentAngleRepository.update(tx, { companyId: alpha }, id, { title: "pisado" }),
    );

    expect(resultado).toBeNull();
    // La segunda mitad es la que importa: un `update` que devuelve `null` y
    // escribe igual se ve idéntico a uno correcto, y la ruta lo traduce a un 404
    // impecable mientras corrompe datos de otro workspace.
    expect(await leerDeBeta(id)).toEqual({ title: "update original" });
  });

  it("softDelete no marca la fila ajena", async () => {
    // Va por `contentRepository` y no por los ángulos: `content_angles` no tiene
    // `deletedAt`, así que su `softDelete` lanza antes de llegar al `WHERE`. Un
    // test de aislamiento sobre una operación que ni existe no mide nada.
    const victima = await crudo((tx) =>
      contentRepository.create(tx, { companyId: beta }, { type: "slideshow" }),
    );

    expect(
      await crudo((tx) =>
        contentRepository.softDelete(tx, { companyId: alpha }, victima.id),
      ),
    ).toBe(false);

    const despues = await crudo((tx) =>
      contentRepository.findById(tx, { companyId: beta }, victima.id),
    );
    expect(despues?.deletedAt ?? null).toBeNull();
  });

  it("hardDelete no borra la fila ajena", async () => {
    const id = await angulloDeBeta("hardDelete");

    expect(
      await crudo((tx) =>
        contentAngleRepository.hardDelete(tx, { companyId: alpha }, id),
      ),
    ).toBe(false);
    expect(await leerDeBeta(id)).toEqual({ title: "hardDelete" });
  });
});
