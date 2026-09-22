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
import { withCompany, withoutCompany } from "../src/tenancy.js";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres.js";

let ctx: TestDatabase;
let companyId: string;

const PERIOD = "2026-09-15";
const DEFAULTS = { contentSavesIncluded: 5 };

const asApp = <T>(id: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, id, fn, { role: APP_ROLE });

/**
 * Fuera de scope y **con el rol de aplicación**, que es la mitad que importa:
 * como superusuario RLS no existe y el barrido mediría lo contrario de lo que
 * dice medir (trampa 16).
 */
const asAppSinScope = <T>(fn: Parameters<typeof withoutCompany<T>>[1]): Promise<T> =>
  withoutCompany(ctx.db, fn, { role: APP_ROLE });

const nuevaCompany = async (name: string): Promise<string> =>
  (await seedCompany(ctx.db, { name })).companyId;

/** Deja `contentSavesPurchased` en un valor, por el camino real de escritura. */
async function ponerComprados(
  id: string,
  period: string,
  purchased: number,
): Promise<void> {
  await withCompany(
    ctx.db,
    id,
    async (tx) => {
      const fila = await quotaLedgerStore.lockPeriod(tx, { companyId: id }, period, {
        contentSavesIncluded: 5,
      });
      await quotaLedgerStore.writeCounters(tx, { companyId: id }, period, {
        contentSavesUsed: fila.contentSavesUsed,
        contentSavesPurchased: purchased,
        overageUnits: fila.overageUnits,
      });
    },
    { role: APP_ROLE },
  );
}

const comprados = async (id: string, period: string): Promise<number | undefined> =>
  (
    await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.readPeriod(tx, { companyId: id }, period),
      { role: APP_ROLE },
    )
  )?.contentSavesPurchased;

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
      quotaLedgerStore.lockPeriod(tx, { companyId }, period, {
        contentSavesIncluded: 10,
      }),
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

describe("el saldo comprado no caduca — P1-QUOTA-012, §16.2", () => {
  it("el período nuevo arranca con el saldo comprado del anterior", async () => {
    // El bug que cierra esta tarea: el cliente compraba saves, terminaba su
    // ciclo, y el saldo comprado desaparecía **sin error, sin log y sin
    // síntoma**. Lo único que se veía era una factura más alta que la que
    // correspondía, un mes después.
    const id = await nuevaCompany("Arrastre");
    await ponerComprados(id, "2026-01-15", 7);

    const nuevo = await withCompany(
      ctx.db,
      id,
      (tx) =>
        quotaLedgerStore.lockPeriod(tx, { companyId: id }, "2026-02-15", {
          contentSavesIncluded: 5,
        }),
      { role: APP_ROLE },
    );

    expect(nuevo.contentSavesPurchased).toBe(7);
    // Y el cupo incluido **sí** se reinicia: es lo que caduca cada ciclo.
    expect(nuevo.contentSavesIncluded).toBe(5);
    expect(nuevo.contentSavesUsed).toBe(0);
  });

  it("sin período anterior arranca en cero", async () => {
    const id = await nuevaCompany("Primer ciclo");
    const fila = await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.lockPeriod(tx, { companyId: id }, "2026-03-15", DEFAULTS),
      { role: APP_ROLE },
    );
    expect(fila.contentSavesPurchased).toBe(0);
  });

  it("arrastra del anterior INMEDIATO, y salta los ciclos sin actividad", async () => {
    // "El anterior" es el de clave máxima menor a la actual, no el mes
    // calendario anterior ni el primero que exista: las claves son `YYYY-MM-DD`
    // con la fecha de inicio del ciclo, y un cliente inactivo tres meses tiene
    // que arrastrar desde el último período que **existe**.
    const id = await nuevaCompany("Anterior inmediato");
    await ponerComprados(id, "2026-01-15", 7);
    await ponerComprados(id, "2026-02-15", 2);

    const marzo = await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.lockPeriod(tx, { companyId: id }, "2026-03-15", DEFAULTS),
      { role: APP_ROLE },
    );
    expect(marzo.contentSavesPurchased).toBe(2);

    // Y tres ciclos de inactividad después, sigue siendo el último que existe.
    const junio = await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.lockPeriod(tx, { companyId: id }, "2026-06-15", DEFAULTS),
      { role: APP_ROLE },
    );
    expect(junio.contentSavesPurchased).toBe(2);
  });

  it("no arrastra de un período POSTERIOR", async () => {
    // Suena imposible hasta que alguien crea el ledger de un ciclo por
    // adelantado —un backfill, un ticket de soporte— y el orden del `order by`
    // decide si el saldo viaja hacia atrás en el tiempo.
    const id = await nuevaCompany("Futuro");
    await ponerComprados(id, "2026-12-15", 9);

    const anterior = await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.lockPeriod(tx, { companyId: id }, "2026-11-15", DEFAULTS),
      { role: APP_ROLE },
    );
    expect(anterior.contentSavesPurchased).toBe(0);
  });

  it("no arrastra el saldo de OTRO workspace", async () => {
    const rico = await nuevaCompany("Con saldo");
    const pobre = await nuevaCompany("Sin saldo");
    await ponerComprados(rico, "2026-01-15", 50);

    const fila = await withCompany(
      ctx.db,
      pobre,
      (tx) =>
        quotaLedgerStore.lockPeriod(tx, { companyId: pobre }, "2026-02-15", DEFAULTS),
      { role: APP_ROLE },
    );
    expect(fila.contentSavesPurchased).toBe(0);
  });

  it("volver a bloquear un período que ya existe NO vuelve a arrastrar", async () => {
    // El caso de la resurrección: si el arrastre fuera un `ON CONFLICT DO
    // UPDATE`, o un `+=` después del bloqueo, **cada petición del ciclo**
    // volvería a sumar el saldo del ciclo anterior. El cliente gastaría los
    // saves comprados y se los encontraría de vuelta en la siguiente petición.
    const id = await nuevaCompany("Sin resurrección");
    await ponerComprados(id, "2026-01-15", 4);

    await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.lockPeriod(tx, { companyId: id }, "2026-02-15", DEFAULTS),
      { role: APP_ROLE },
    );
    // El cliente gasta los cuatro saves comprados.
    await ponerComprados(id, "2026-02-15", 0);

    const otraVez = await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.lockPeriod(tx, { companyId: id }, "2026-02-15", DEFAULTS),
      { role: APP_ROLE },
    );
    expect(otraVez.contentSavesPurchased).toBe(0);
  });

  it("dos transacciones que crean el período nuevo A LA VEZ no arrastran dos veces", async () => {
    // La carrera con plata encima, y el caso que hay que ver rojo para creerle
    // a este archivo.
    //
    // Lo que la evita es que el arrastre viaje **dentro** del INSERT que
    // `ON CONFLICT DO NOTHING` serializa: el segundo concurrente no inserta, y
    // por lo tanto no arrastra. Medido rompiéndolo — con el arrastre movido a un
    // `UPDATE … SET purchased = purchased + n` después del insert, las dos
    // transacciones suman y este test da 10 en vez de 5. Un save regalado por
    // cada carrera, sin error y sin log.
    const id = await nuevaCompany("Carrera de arrastre");
    await ponerComprados(id, "2026-01-15", 5);
    const nuevo = "2026-02-15";

    const crear = () =>
      withCompany(
        ctx.db,
        id,
        async (tx) => {
          const fila = await quotaLedgerStore.lockPeriod(tx, { companyId: id }, nuevo, {
            contentSavesIncluded: 5,
          });
          // La pausa mantiene la transacción abierta para que las dos se
          // solapen de verdad; sin ella podrían serializarse por casualidad.
          await new Promise((r) => setTimeout(r, 60));
          return fila.contentSavesPurchased;
        },
        { role: APP_ROLE },
      );

    const vistos = await Promise.all([crear(), crear(), crear()]);

    expect(await comprados(id, nuevo)).toBe(5);
    // Y ninguna de las tres vio un saldo inflado: si una hubiera leído 10, el
    // `consumeSave` de esa petición habría decidido sobre un saldo inventado.
    expect(vistos).toEqual([5, 5, 5]);
  });
});

describe("el barrido de swipes vencidos — P1-QUOTA-013, §9.5 #17", () => {
  const AHORA = new Date("2026-09-21T00:05:00.000Z");
  /** Lo que `nextDailyResetUtc(AHORA)` devuelve. No se importa `core` desde `db`. */
  const PROXIMO = new Date("2026-09-22T00:00:00.000Z");
  const VENCIDO = new Date("2026-09-20T00:00:00.000Z");

  /** Deja una fila con swipes usados y un instante de reset. */
  async function ponerSwipes(
    id: string,
    period: string,
    used: number,
    resetAt: Date | null,
  ): Promise<void> {
    await withCompany(
      ctx.db,
      id,
      async (tx) => {
        await quotaLedgerStore.lockPeriod(tx, { companyId: id }, period, DEFAULTS);
        if (resetAt !== null) {
          await quotaLedgerStore.writeDailySwipes(
            tx,
            { companyId: id },
            period,
            used,
            resetAt,
          );
        }
      },
      { role: APP_ROLE },
    );
  }

  async function swipes(
    id: string,
    period: string,
  ): Promise<{ used: number; resetAt: Date | null }> {
    const fila = await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.readPeriod(tx, { companyId: id }, period),
      { role: APP_ROLE },
    );
    return {
      used: fila?.dailySwipesUsed ?? -1,
      resetAt: fila?.dailySwipeResetAt ?? null,
    };
  }

  const barrer = (limit = 100): Promise<number> =>
    asAppSinScope((tx) =>
      quotaLedgerStore.sweepExpiredDailySwipes(tx, AHORA, PROXIMO, limit),
    );

  it("pone en cero el contador vencido y adelanta el instante de reset", async () => {
    const id = await nuevaCompany("Swipes vencidos");
    await ponerSwipes(id, "2026-09-01", 9, VENCIDO);

    expect(await barrer()).toBe(1);

    const despues = await swipes(id, "2026-09-01");
    expect(despues.used).toBe(0);
    expect(despues.resetAt?.toISOString()).toBe(PROXIMO.toISOString());
  });

  it("un UPDATE pelado desde el rol de aplicación NO ve ni una fila", async () => {
    // Éste es el test que justifica la función `SECURITY DEFINER`, y el que
    // falta cuando alguien "simplifica" el barrido a un UPDATE normal. Con
    // `FORCE ROW LEVEL SECURITY` y sin `app.current_company`, la política de
    // `quota_ledgers` no deja pasar nada y el UPDATE afecta **cero filas, sin
    // error**. En desarrollo, como superusuario, el mismo código parecería
    // andar: es la trampa 16 exacta.
    const id = await nuevaCompany("RLS del barrido");
    await ponerSwipes(id, "2026-09-02", 4, VENCIDO);

    await asAppSinScope((tx) =>
      tx.execute(sql`update quota_ledgers set daily_swipes_used = 0`),
    );

    expect((await swipes(id, "2026-09-02")).used).toBe(4);
    // Y por la función sí: mismo rol, misma transacción sin scope.
    expect(await barrer()).toBe(1);
    expect((await swipes(id, "2026-09-02")).used).toBe(0);
  });

  it("no toca una fila cuyo reset todavía no venció", async () => {
    const id = await nuevaCompany("Swipes al día");
    await ponerSwipes(id, "2026-09-03", 3, new Date("2026-09-30T00:00:00.000Z"));

    expect(await barrer()).toBe(0);
    expect((await swipes(id, "2026-09-03")).used).toBe(3);
  });

  it("no le inventa un reset a quien nunca hizo un swipe", async () => {
    // `daily_swipe_reset_at` nulo significa que el reloj diario de ese
    // workspace todavía no arrancó. Ponerle uno sería empezarle la cuota diaria
    // desde un cron en vez de desde su primer swipe.
    const id = await nuevaCompany("Sin swipes");
    await ponerSwipes(id, "2026-09-04", 0, null);

    expect(await barrer()).toBe(0);
    expect((await swipes(id, "2026-09-04")).resetAt).toBeNull();
  });

  it("NO toca los content saves — es lo que este job no hace", async () => {
    // El barrido tiene un alcance chico a propósito (§9.5 #17: red, no
    // mecanismo) y la tentación es agrandarlo. Esta aserción es la que se pone
    // roja el día que alguien le agregue "y de paso reinicia los saves": el
    // reset de saves **es** la clave del período, y la fila vieja es historia de
    // facturación.
    const id = await nuevaCompany("Saves intactos");
    await ponerSwipes(id, "2026-09-05", 2, VENCIDO);
    await ponerComprados(id, "2026-09-05", 6);
    await withCompany(
      ctx.db,
      id,
      (tx) =>
        quotaLedgerStore.writeCounters(tx, { companyId: id }, "2026-09-05", {
          contentSavesUsed: 3,
          contentSavesPurchased: 6,
          overageUnits: 1,
        }),
      { role: APP_ROLE },
    );

    expect(await barrer()).toBe(1);

    const fila = await withCompany(
      ctx.db,
      id,
      (tx) => quotaLedgerStore.readPeriod(tx, { companyId: id }, "2026-09-05"),
      { role: APP_ROLE },
    );
    expect(fila?.contentSavesUsed).toBe(3);
    expect(fila?.contentSavesPurchased).toBe(6);
    expect(fila?.overageUnits).toBe(1);
    expect(fila?.contentSavesIncluded).toBe(5);
    // Ni crea ni borra períodos: el barrido no es un recolector de basura.
    expect(
      await withCompany(
        ctx.db,
        id,
        (tx) => quotaLedgerStore.countPeriods(tx, { companyId: id }),
        { role: APP_ROLE },
      ),
    ).toBe(1);
  });

  it("barre los de varios workspaces en una sola llamada", async () => {
    const uno = await nuevaCompany("Barrido A");
    const dos = await nuevaCompany("Barrido B");
    await ponerSwipes(uno, "2026-09-06", 5, VENCIDO);
    await ponerSwipes(dos, "2026-09-06", 5, VENCIDO);

    expect(await barrer()).toBe(2);
    expect((await swipes(uno, "2026-09-06")).used).toBe(0);
    expect((await swipes(dos, "2026-09-06")).used).toBe(0);
  });

  it("respeta el límite, y volver a llamar termina el trabajo", async () => {
    const uno = await nuevaCompany("Límite A");
    const dos = await nuevaCompany("Límite B");
    await ponerSwipes(uno, "2026-09-07", 5, VENCIDO);
    await ponerSwipes(dos, "2026-09-07", 5, VENCIDO);

    expect(await barrer(1)).toBe(1);
    expect(await barrer(1)).toBe(1);
    expect(await barrer(1)).toBe(0);
  });

  it("es idempotente: la segunda corrida no encuentra nada", async () => {
    const id = await nuevaCompany("Idempotente");
    await ponerSwipes(id, "2026-09-08", 7, VENCIDO);

    expect(await barrer()).toBe(1);
    expect(await barrer()).toBe(0);
    expect((await swipes(id, "2026-09-08")).used).toBe(0);
  });

  it("rechaza un `nextResetAt` que no es posterior a `now`", async () => {
    // Sin esta guarda, un llamador con los parámetros invertidos dejaría las
    // filas vencidas al salir y el barrido siguiente las volvería a tomar, para
    // siempre. Es el mismo invariante que `isExpired` afirma en el dominio.
    await expect(
      asAppSinScope((tx) =>
        quotaLedgerStore.sweepExpiredDailySwipes(tx, AHORA, VENCIDO, 10),
      ),
    ).rejects.toThrow();
  });

  it("rechaza un límite que no es un entero positivo", async () => {
    await expect(
      asAppSinScope((tx) =>
        quotaLedgerStore.sweepExpiredDailySwipes(tx, AHORA, PROXIMO, 0),
      ),
    ).rejects.toThrow(/entero positivo/);
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
