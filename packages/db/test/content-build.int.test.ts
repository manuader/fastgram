/**
 * `lockContent` bajo concurrencia — `FR-050`, IMPL §2.3.
 *
 * ## Por qué hay un archivo entero para un `SELECT … FOR UPDATE`
 *
 * Porque es lo único que separa a dos procesos que escriben la misma pieza: el
 * worker, que cierra un build, y la API, que aplica una edición. El handler de
 * `content-build` **no puede** tener el render dentro de la transacción —dura
 * 30 s – 2 min, `NFR-001`— así que lee, suelta, trabaja, y vuelve a tomar. Todo
 * lo que hace en la segunda transacción depende de que la fila no se le mueva
 * mientras decide.
 *
 * Sin el bloqueo, con READ COMMITTED:
 *
 * ```
 *   A: lee la pieza, revision = 1, status = BUILDING
 *   B: lee la pieza, revision = 1, status = BUILDING
 *   A: escribe CREATED
 *   B: escribe CREATED            ← pisa a A, con otro resultado
 * ```
 *
 * Los tests del handler (`apps/worker/test/build.int.test.ts`) cubren las
 * decisiones, no el bloqueo: sus dos transacciones son cortas y se ordenarían
 * solas aunque no hubiera `FOR UPDATE`. La única forma de medirlo es desde acá,
 * donde se puede meter una pausa **dentro** de la transacción. Es la misma
 * razón —y la misma forma— que `quota-ledger.int.test.ts`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentBuildStore } from "../src/repositories/index.js";
import { contents } from "../src/schema/index.js";
import { withCompany } from "../src/tenancy.js";
import { APP_ROLE, seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres.js";

let ctx: TestDatabase;
let companyId: string;

const asApp = <T>(id: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, id, fn, { role: APP_ROLE });

/** Una pieza en `BUILDING`, sin cargo: acá lo que se mide es el bloqueo. */
async function nuevaPieza(): Promise<string> {
  return asApp(companyId, async (tx) => {
    const [row] = await tx
      .insert(contents)
      .values({ companyId, type: "wall-of-text", status: "BUILDING" })
      .returning({ id: contents.id });
    if (row === undefined) throw new Error("no se creó la pieza");
    return row.id;
  });
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  companyId = (await seedCompany(ctx.db, { name: "Builds" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("lockContent", () => {
  it("devuelve la fila del workspace", async () => {
    const id = await nuevaPieza();
    const row = await asApp(companyId, (tx) => contentBuildStore.lockContent(tx, { companyId }, id));
    expect(row?.id).toBe(id);
    expect(row?.status).toBe("BUILDING");
  });

  it("no devuelve la de otro workspace", async () => {
    // Mismo `404` invisible de §9.2 bajado al worker: con el scope equivocado la
    // fila **no existe**. Si esto fallara, un payload manipulado podría cerrar la
    // pieza de otro y devolverle el save.
    const otro = (await seedCompany(ctx.db, { name: "Ajeno" })).companyId;
    const id = await nuevaPieza();

    const row = await asApp(otro, (tx) =>
      contentBuildStore.lockContent(tx, { companyId: otro }, id),
    );
    expect(row).toBeNull();
  });

  it("no devuelve una pieza borrada", async () => {
    // El borrado **no** devuelve el content save (DATA-008 y §16.2 lo dicen dos
    // veces). Si el lock la trajera, un build que falla después del borrado
    // reembolsaría — o sea, regalaría cuota por borrar a tiempo.
    const id = await nuevaPieza();
    await asApp(companyId, (tx) =>
      tx.update(contents).set({ deletedAt: new Date() }).where(eq(contents.id, id)),
    );

    const row = await asApp(companyId, (tx) =>
      contentBuildStore.lockContent(tx, { companyId }, id),
    );
    expect(row).toBeNull();
  });
});

describe("concurrencia — lo que este repositorio existe para garantizar", () => {
  it("dos transacciones no deciden sobre la misma fila a la vez", async () => {
    const id = await nuevaPieza();

    // Cada una lee, espera, y escribe **sumando** sobre lo que leyó. Con el
    // bloqueo, la segunda ve el `revision` que dejó la primera y el resultado es
    // 3; sin él, las dos leen 1 y las dos escriben 2 — que es exactamente el
    // "pisar el resultado del otro" que el handler no puede permitirse.
    const avanzar = () =>
      asApp(companyId, async (tx) => {
        const row = await contentBuildStore.lockContent(tx, { companyId }, id);
        if (row === null) throw new Error("la pieza tiene que estar");
        const leida = row.revision;
        // Sin la pausa las dos podrían serializarse por casualidad y el test
        // pasaría sin medir el bloqueo.
        await new Promise((r) => setTimeout(r, 60));
        await tx
          .update(contents)
          .set({ revision: leida + 1 })
          .where(eq(contents.id, id));
        return leida;
      });

    await Promise.all([avanzar(), avanzar()]);

    const final = await asApp(companyId, (tx) =>
      contentBuildStore.lockContent(tx, { companyId }, id),
    );
    expect(final?.revision).toBe(3);
  });

  it("y el bloqueo no cruza workspaces: dos piezas distintas no se esperan", async () => {
    // La otra mitad de la garantía. Un lock por tabla en vez de por fila haría
    // que el build de un cliente frenara al de otro, y con `NFR-025` hablando de
    // 10 builds por minuto eso se nota enseguida — sin que nada falle.
    const a = await nuevaPieza();
    const b = await nuevaPieza();

    const tocar = (id: string) =>
      asApp(companyId, async (tx) => {
        await contentBuildStore.lockContent(tx, { companyId }, id);
        await new Promise((r) => setTimeout(r, 120));
      });

    const empezo = Date.now();
    await Promise.all([tocar(a), tocar(b)]);
    // Si se serializaran, esto tardaría ~240 ms. El margen es amplio a propósito:
    // lo que se afirma es que NO se serializan, no un número de milisegundos.
    expect(Date.now() - empezo).toBeLessThan(220);
  });
});
