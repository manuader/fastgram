/**
 * El ledger de cuota bajo concurrencia — `DATA-029`, PRD §9.4.
 *
 * §9.4 pide *"reservas atómicas de cuota antes de trabajo costoso"*, y lo que
 * este archivo persigue es la palabra **atómicas**. Una lectura seguida de una
 * escritura no lo es: con READ COMMITTED, dos peticiones simultáneas del mismo
 * workspace leen el mismo saldo, las dos deciden que alcanza, y las dos
 * consumen. El cliente obtiene un save gratis y **no hay ningún síntoma** — ni
 * error, ni log, sólo un contador más bajo del que corresponde.
 *
 * Ya pasó una vez en este proyecto, en el limitador de tasa: 120 de 120
 * peticiones pasaron contra un límite de 60, y los nueve tests que lo cubrían
 * no lo vieron porque eran secuenciales. Por eso los de acá corren de verdad
 * en paralelo, con dos conexiones distintas.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { quotaLedgerStore } from "../src/repositories/index.js";
import { withCompany } from "../src/tenancy.js";
import { APP_ROLE, seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres.js";

let ctx: TestDatabase;
let companyId: string;

const PERIOD = "2026-09-15";
const DEFAULTS = { contentSavesIncluded: 5 };

const asApp = <T>(id: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, id, fn, { role: APP_ROLE });

beforeAll(async () => {
  ctx = await startTestDatabase();
  companyId = (await seedCompany(ctx.db, { name: "Cuotas" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("lockPeriod", () => {
  it("crea el ledger del período con el cupo del plan", async () => {
    const fila = await asApp(companyId, (tx) =>
      quotaLedgerStore.lockPeriod(tx, { companyId }, PERIOD, DEFAULTS),
    );
    expect(fila.period).toBe(PERIOD);
    expect(fila.contentSavesIncluded).toBe(5);
    expect(fila.contentSavesUsed).toBe(0);
  });

  it("dos llamadas no crean dos filas: la PK es `(companyId, period)`", async () => {
    await asApp(companyId, (tx) =>
      quotaLedgerStore.lockPeriod(tx, { companyId }, PERIOD, DEFAULTS),
    );
    expect(
      await asApp(companyId, (tx) => quotaLedgerStore.countPeriods(tx, { companyId })),
    ).toBe(1);
  });

  it("un período nuevo es una fila nueva, no una sobrescritura", async () => {
    await asApp(companyId, (tx) =>
      quotaLedgerStore.lockPeriod(tx, { companyId }, "2026-10-15", DEFAULTS),
    );
    expect(
      await asApp(companyId, (tx) => quotaLedgerStore.countPeriods(tx, { companyId })),
    ).toBe(2);

    // El cupo del período viejo no se toca: la factura del mes pasado no se
    // reescribe porque empezó uno nuevo.
    const viejo = await asApp(companyId, (tx) =>
      quotaLedgerStore.readPeriod(tx, { companyId }, PERIOD),
    );
    expect(viejo?.contentSavesIncluded).toBe(5);
  });
});

describe("concurrencia — lo que este repositorio existe para garantizar", () => {
  it("dos consumiciones simultáneas sobre un período QUE YA EXISTE", async () => {
    const period = "2026-11-15";

    // El período se crea **antes**, y eso es lo que hace útil al caso: con la
    // fila ya presente, el `ON CONFLICT DO NOTHING` no bloquea a nadie —no hay
    // conflicto— así que lo único que impide la doble consumición es el
    // `FOR UPDATE`. Si el período se creara dentro de las dos transacciones
    // concurrentes, se serializarían por el INSERT y el test pasaría sin
    // probar el bloqueo, que fue exactamente lo que me pasó al escribirlo.
    await asApp(companyId, (tx) =>
      quotaLedgerStore.lockPeriod(tx, { companyId }, period, { contentSavesIncluded: 10 }),
    );

    const consumir = () =>
      asApp(companyId, async (tx) => {
        const fila = await quotaLedgerStore.lockPeriod(tx, { companyId }, period, {
          contentSavesIncluded: 10,
        });
        const usados = fila.contentSavesUsed;
        // Una pausa dentro de la transacción: sin ella, las dos podrían
        // serializarse por casualidad y el test pasaría sin probar nada.
        await new Promise((r) => setTimeout(r, 60));
        await quotaLedgerStore.writeCounters(tx, { companyId }, period, {
          contentSavesUsed: usados + 1,
          contentSavesPurchased: fila.contentSavesPurchased,
          overageUnits: fila.overageUnits,
        });
        return usados;
      });

    await Promise.all([consumir(), consumir()]);

    const fila = await asApp(companyId, (tx) =>
      quotaLedgerStore.readPeriod(tx, { companyId }, period),
    );
    expect(fila?.contentSavesUsed).toBe(2);
  });

  it("y tampoco cuando el período todavía no existía", async () => {
    // El caso más filoso: `SELECT … FOR UPDATE` sobre una fila que no existe no
    // bloquea nada, porque no hay qué bloquear. Por eso `lockPeriod` inserta
    // primero con `ON CONFLICT DO NOTHING`, que sí serializa. Sin ese orden,
    // el primer save de cada período nuevo sería gratis bajo concurrencia.
    const period = "2026-12-15";
    const consumir = () =>
      asApp(companyId, async (tx) => {
        const fila = await quotaLedgerStore.lockPeriod(tx, { companyId }, period, {
          contentSavesIncluded: 10,
        });
        await new Promise((r) => setTimeout(r, 60));
        await quotaLedgerStore.writeCounters(tx, { companyId }, period, {
          contentSavesUsed: fila.contentSavesUsed + 1,
          contentSavesPurchased: fila.contentSavesPurchased,
          overageUnits: fila.overageUnits,
        });
      });

    await Promise.all([consumir(), consumir(), consumir()]);

    const fila = await asApp(companyId, (tx) =>
      quotaLedgerStore.readPeriod(tx, { companyId }, period),
    );
    expect(fila?.contentSavesUsed).toBe(3);
    expect(
      await asApp(companyId, (tx) => quotaLedgerStore.countPeriods(tx, { companyId })),
    ).toBe(4);
  });
});

describe("aislamiento", () => {
  it("no lee el ledger de otro workspace", async () => {
    const otro = (await seedCompany(ctx.db, { name: "Otra" })).companyId;
    await asApp(otro, (tx) =>
      quotaLedgerStore.lockPeriod(tx, { companyId: otro }, PERIOD, {
        contentSavesIncluded: 999,
      }),
    );

    const mio = await asApp(companyId, (tx) =>
      quotaLedgerStore.readPeriod(tx, { companyId }, PERIOD),
    );
    expect(mio?.contentSavesIncluded).toBe(5);

    // Y pedir explícitamente el del otro desde mi scope no lo trae.
    const ajeno = await asApp(companyId, (tx) =>
      quotaLedgerStore.readPeriod(tx, { companyId: otro }, PERIOD),
    );
    expect(ajeno).toBeNull();
  });
});

describe("el CHECK de contadores no negativos", () => {
  it("rechaza un contador en negativo", async () => {
    // Es la red bajo un reembolso mal calculado: un `refundSave` que reste de
    // más dejaría el contador en -1 y el período siguiente arrancaría regalando
    // un save. El CHECK lo convierte en un error ruidoso.
    await expect(
      asApp(companyId, async (tx) => {
        await quotaLedgerStore.lockPeriod(tx, { companyId }, PERIOD, DEFAULTS);
        await tx.execute(
          sql`update quota_ledgers set content_saves_used = -1
              where company_id = ${companyId}::uuid and period = ${PERIOD}`,
        );
      }),
    ).rejects.toThrow();
  });
});
