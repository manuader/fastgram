/**
 * `companyRepository` — el segundo repositorio que no sale de la fábrica
 * genérica, y el que más fácil se convierte en un agujero.
 *
 * `audio_tracks` no tiene tenant; `companies` **es** el tenant. Los dos se
 * escriben a mano por la misma razón de forma —ninguno tiene una columna
 * `companyId` contra la que filtrar— y por eso los dos hay que probarlos
 * contra RLS y con el rol de la aplicación, que es lo único que distingue un
 * repositorio correcto de uno que funciona sólo porque el test corre como
 * superusuario.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { companyRepository } from "../src/repositories/index";
import { withCompany } from "../src/tenancy";
import { APP_ROLE, seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

const asApp = <T>(companyId: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, companyId, fn, { role: APP_ROLE });

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("lee su propio workspace", () => {
  it("`load` trae la fila", async () => {
    const row = await asApp(alpha, (tx) => companyRepository.load(tx, { companyId: alpha }));
    expect(row?.id).toBe(alpha);
    expect(row?.name).toBe("Alpha");
  });

  it("`billing` trae lo que la capa de cuotas necesita", async () => {
    const row = await asApp(alpha, (tx) =>
      companyRepository.billing(tx, { companyId: alpha }),
    );
    expect(row?.planId).toBe("free");
    expect(typeof row?.billingAnchorDay).toBe("number");
    expect(row?.apiOverageEnabled).toBe(false);
    expect(Array.isArray(row?.entitlements)).toBe(true);
  });

  it("`billing` NO trae el resto de la fila", async () => {
    // La proyección es explícita para que lo que viaja por el sistema sea lo
    // que hace falta para decidir. `ownerUserId` o `logoUrl` en una decisión
    // de cuota no tienen nada que hacer, y tenerlos a mano invita a usarlos.
    const row = await asApp(alpha, (tx) =>
      companyRepository.billing(tx, { companyId: alpha }),
    );
    expect(Object.keys(row!).sort()).toEqual([
      "apiOverageEnabled",
      "billingAnchorDay",
      "companyId",
      "entitlements",
      "planId",
      "status",
      "subscriptionStatus",
      "timezone",
    ]);
  });
});

describe("no lee el de otro", () => {
  it("`load` con el scope de alpha no devuelve a beta", async () => {
    // Lo que se prueba no es que la consulta filtre —eso se ve leyendo el
    // código— sino que **pedir explícitamente el id ajeno** dentro del scope
    // propio no lo traiga. Es el caso que un `findById(id)` suelto rompería.
    const row = await asApp(alpha, (tx) => companyRepository.load(tx, { companyId: beta }));
    expect(row).toBeNull();
  });

  it("`billing` tampoco", async () => {
    const row = await asApp(alpha, (tx) =>
      companyRepository.billing(tx, { companyId: beta }),
    );
    expect(row).toBeNull();
  });

  it("un workspace inexistente y uno ajeno son el mismo `null`", async () => {
    // §9.2: indistinguibles a propósito. Si el ajeno lanzara y el inexistente
    // devolviera `null`, la capa de arriba tendría dos caminos y tarde o
    // temprano uno de los dos sería un 403.
    const inexistente = "00000000-0000-4000-8000-000000000000";
    const ajeno = await asApp(alpha, (tx) =>
      companyRepository.load(tx, { companyId: beta }),
    );
    const nadie = await asApp(alpha, (tx) =>
      companyRepository.load(tx, { companyId: inexistente }),
    );
    expect(ajeno).toBe(nadie);
  });
});

describe("hasEntitlement", () => {
  it("es `false` cuando la lista está vacía", async () => {
    expect(
      await asApp(alpha, (tx) =>
        companyRepository.hasEntitlement(tx, { companyId: alpha }, "tiktokDirect"),
      ),
    ).toBe(false);
  });

  it("es `true` cuando está", async () => {
    await ctx.db.execute(
      // Se escribe como superusuario: es provisión, no camino de aplicación.
      // El repositorio no expone escritura a propósito — ver su cabecera.
      sql`update companies set entitlements = array['tiktokDirect'] where id = ${alpha}::uuid`,
    );
    expect(
      await asApp(alpha, (tx) =>
        companyRepository.hasEntitlement(tx, { companyId: alpha }, "tiktokDirect"),
      ),
    ).toBe(true);
  });

  it("un workspace ajeno devuelve `false`, no el entitlement del otro", async () => {
    expect(
      await asApp(beta, (tx) =>
        companyRepository.hasEntitlement(tx, { companyId: alpha }, "tiktokDirect"),
      ),
    ).toBe(false);
  });
});
