/**
 * El cargo de 250 créditos de un influencer — `P1-DATA-016`, `FR-080`, §9.4.
 *
 * ## Qué se mide acá y qué no
 *
 * Tres cosas que sólo se pueden verificar contra un Postgres de verdad:
 *
 *  1. **Que la base rechaza** los estados imposibles del cargo. Un CHECK escrito
 *     en el schema de Drizzle y no aplicado por la migración es un comentario, y
 *     nada más lo notaría.
 *  2. **Que el reembolso se entrega a lo sumo una vez**, incluso con dos
 *     llamadas concurrentes. Es la guarda contra los 250 créditos regalados, y
 *     la trampa 24 del handoff es exactamente el caso de una guarda que el test
 *     no alcanzaba.
 *  3. **Que el backfill de la migración mueve lo que hay en `internal_refs`** —y
 *     que falla ruidosamente con lo que no puede mover. Es un movimiento de
 *     datos de una sola oportunidad: si se lo deja sin probar, la primera vez
 *     que corre es también la última.
 *
 * El (3) ejecuta el SQL **leído del archivo de migración**, entre los marcadores
 * `-- >>> backfill` y `-- <<< backfill`. No es una copia: una copia se
 * desincroniza y termina midiendo otra cosa. Lo que sí es distinto del camino
 * real es el momento —acá el bloque corre una segunda vez, con las columnas ya
 * creadas y en NULL, que es el mismo estado en el que lo encuentra la
 * migración— y eso queda dicho.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { influencerCreditsStore } from "../src/repositories/index";
import { MIGRATIONS_FOLDER } from "../src/migrate";
import { influencers } from "../src/schema/index";
import { withCompany } from "../src/tenancy";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres";

let ctx: TestDatabase;
let companyId: string;
let otroCompanyId: string;

const asApp = <T>(id: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, id, fn, { role: APP_ROLE });

const base = (overrides: Record<string, unknown> = {}) => ({
  name: "Nadia",
  gender: "woman",
  age: 27,
  ethnicity: "latina",
  ...overrides,
});

/** Un influencer con el cargo ya anotado en las columnas nuevas. */
async function conCargo(
  id = companyId,
  charged = 250,
  period = "2026-09-01",
): Promise<string> {
  return asApp(id, async (tx) => {
    const [row] = await tx
      .insert(influencers)
      .values({
        companyId: id,
        ...base({ creditsPeriod: period, creditsCharged: charged }),
      })
      .returning({ id: influencers.id });
    if (row === undefined) throw new Error("no se creó el influencer");
    return row.id;
  });
}

/** Un influencer sin cargo: el caso de las filas creadas antes del cobro. */
async function sinCargo(): Promise<string> {
  return asApp(companyId, async (tx) => {
    const [row] = await tx
      .insert(influencers)
      .values({ companyId, ...base() })
      .returning({ id: influencers.id });
    if (row === undefined) throw new Error("no se creó el influencer");
    return row.id;
  });
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  companyId = (await seedCompany(ctx.db, { name: "Créditos" })).companyId;
  otroCompanyId = (await seedCompany(ctx.db, { name: "Ajeno" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

// ───────────────────────────────────────────────────────────────────────────
// 1. Los CHECK — que los rechaza LA BASE, no el código
// ───────────────────────────────────────────────────────────────────────────

describe("los CHECK del cargo", () => {
  // Todo esto va como superusuario y sin `SET ROLE`: los CHECK no dependen de
  // RLS, y mezclarlos haría ambiguo cuál de los dos rechazó.
  it("acepta una fila sin cargo, que es el estado de las que no se cobraron", async () => {
    await expect(
      ctx.db.insert(influencers).values({ companyId, ...base() }),
    ).resolves.toBeDefined();
  });

  it("acepta período + monto juntos", async () => {
    await expect(
      ctx.db.insert(influencers).values({
        companyId,
        ...base({ creditsPeriod: "2026-09-01", creditsCharged: 250 }),
      }),
    ).resolves.toBeDefined();
  });

  it("rechaza el período sin el monto", async () => {
    // Sería un cargo del que se sabe a qué ledger volvería pero no cuánto.
    await expect(
      ctx.db
        .insert(influencers)
        .values({ companyId, ...base({ creditsPeriod: "2026-09-01" }) }),
    ).rejects.toThrow(/influencers_credits_period_with_charged/);
  });

  it("rechaza el monto sin el período", async () => {
    // Y éste es el peor de los dos: 250 créditos que nadie sabe dónde devolver.
    await expect(
      ctx.db.insert(influencers).values({ companyId, ...base({ creditsCharged: 250 }) }),
    ).rejects.toThrow(/influencers_credits_period_with_charged/);
  });

  it("rechaza marcar un reembolso sobre algo que nunca se cobró", async () => {
    await expect(
      ctx.db
        .insert(influencers)
        .values({ companyId, ...base({ creditsRefundedAt: new Date() }) }),
    ).rejects.toThrow(/influencers_refund_requires_charge/);
  });

  it("rechaza un cargo de 0 y uno negativo", async () => {
    // Un cargo de 0 no es un cargo; uno negativo le quita créditos al cliente
    // cuando se "devuelve".
    await expect(
      ctx.db.insert(influencers).values({
        companyId,
        ...base({ creditsPeriod: "2026-09-01", creditsCharged: 0 }),
      }),
    ).rejects.toThrow(/influencers_credits_charged_positive/);
    await expect(
      ctx.db.insert(influencers).values({
        companyId,
        ...base({ creditsPeriod: "2026-09-01", creditsCharged: -250 }),
      }),
    ).rejects.toThrow(/influencers_credits_charged_positive/);
  });

  it("y el UPDATE tampoco puede dejar la fila a medias", async () => {
    // El INSERT no es el único camino: el handler del pipeline escribe con
    // UPDATE, y un CHECK que sólo cubriera la creación no serviría de nada.
    const id = await conCargo();
    await expect(
      ctx.db
        .update(influencers)
        .set({ creditsCharged: null })
        .where(eq(influencers.id, id)),
    ).rejects.toThrow(/influencers_credits_period_with_charged/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. `lockInfluencer`
// ───────────────────────────────────────────────────────────────────────────

describe("lockInfluencer", () => {
  it("devuelve la fila del workspace, con el cargo", async () => {
    const id = await conCargo();
    const row = await asApp(companyId, (tx) =>
      influencerCreditsStore.lockInfluencer(tx, { companyId }, id),
    );
    expect(row?.id).toBe(id);
    expect(row?.creditsCharged).toBe(250);
    expect(row?.creditsPeriod).toBe("2026-09-01");
    expect(row?.creditsRefundedAt).toBeNull();
  });

  it("no devuelve la de otro workspace (las dos capas juntas)", async () => {
    // El `404` invisible de §9.2 bajado al worker. Si esto trajera la fila, un
    // payload manipulado en la cola alcanzaría para reembolsar contra el ledger
    // de otro cliente.
    const id = await conCargo();
    const row = await asApp(otroCompanyId, (tx) =>
      influencerCreditsStore.lockInfluencer(tx, { companyId: otroCompanyId }, id),
    );
    expect(row).toBeNull();
  });

  it("…y tampoco con RLS fuera del camino: el WHERE aísla por sí solo", async () => {
    // El de arriba NO mide este repositorio. Verificado quitándole el
    // `eq(companyId)` al `where`: sigue verde, porque la otra capa —RLS, que
    // corre porque el test usa `fastgram_app` con el GUC puesto— tapa el
    // agujero. Es la redundancia que IMPL §2.4 quiere, y es también la razón
    // por la que ese test solo no dice nada del código que estoy escribiendo.
    //
    // Éste corre como superusuario, sin `SET ROLE` y sin GUC, así que RLS está
    // fuera del camino y lo único que queda entre la llamada y la fila ajena es
    // el `WHERE` de `lockInfluencer`.
    const id = await conCargo();
    const row = await influencerCreditsStore.lockInfluencer(
      ctx.db,
      { companyId: otroCompanyId },
      id,
    );
    expect(row).toBeNull();
  });

  it("SÍ devuelve un influencer desactivado — el pipeline falló igual", async () => {
    // `isActive` es el activar/desactivar reversible del cap de 50, no un
    // borrado. Si el lock lo escondiera, desactivar mientras entrena haría que
    // el fallo posterior no encontrara la fila y los 250 créditos no volvieran.
    const id = await conCargo();
    await asApp(companyId, (tx) =>
      tx.update(influencers).set({ isActive: false }).where(eq(influencers.id, id)),
    );
    const row = await asApp(companyId, (tx) =>
      influencerCreditsStore.lockInfluencer(tx, { companyId }, id),
    );
    expect(row?.id).toBe(id);
  });

  it("dos transacciones no deciden sobre la misma fila a la vez", async () => {
    const id = await conCargo();

    // Cada una lee, espera, y escribe sumando sobre lo que leyó. Con el bloqueo
    // la segunda ve lo que dejó la primera y el progreso final es 2; sin él las
    // dos leen 0 y las dos escriben 1.
    const avanzar = () =>
      asApp(companyId, async (tx) => {
        const row = await influencerCreditsStore.lockInfluencer(tx, { companyId }, id);
        if (row === null) throw new Error("el influencer tiene que estar");
        const leido = row.progress;
        // Sin la pausa las dos podrían serializarse por casualidad y el test
        // pasaría sin medir el bloqueo (trampa 22).
        await new Promise((r) => setTimeout(r, 60));
        await tx
          .update(influencers)
          .set({ progress: leido + 1 })
          .where(eq(influencers.id, id));
      });

    await Promise.all([avanzar(), avanzar()]);

    const final = await asApp(companyId, (tx) =>
      influencerCreditsStore.lockInfluencer(tx, { companyId }, id),
    );
    expect(final?.progress).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. `claimCreditsRefund` — la guarda contra los 250 créditos regalados
// ───────────────────────────────────────────────────────────────────────────

describe("claimCreditsRefund", () => {
  const ahora = new Date("2026-09-22T12:00:00.000Z");

  it("entrega el cargo una vez y marca la fila", async () => {
    const id = await conCargo();
    const cargo = await asApp(companyId, (tx) =>
      influencerCreditsStore.claimCreditsRefund(tx, { companyId }, id, ahora),
    );
    expect(cargo).toEqual({ period: "2026-09-01", charged: 250 });

    const row = await asApp(companyId, (tx) =>
      influencerCreditsStore.lockInfluencer(tx, { companyId }, id),
    );
    expect(row?.creditsRefundedAt?.toISOString()).toBe(ahora.toISOString());
  });

  it("la segunda vez devuelve null: el handler puede reintentarse", async () => {
    // Éste es el test que la trampa 24 dice que hay que saber romper. Quitando
    // el `isNull(creditsRefundedAt)` del WHERE, las dos llamadas devuelven el
    // cargo y el cliente se lleva 500 créditos por un cobro de 250.
    const id = await conCargo();
    const primera = await asApp(companyId, (tx) =>
      influencerCreditsStore.claimCreditsRefund(tx, { companyId }, id, ahora),
    );
    const segunda = await asApp(companyId, (tx) =>
      influencerCreditsStore.claimCreditsRefund(tx, { companyId }, id, ahora),
    );
    expect(primera).not.toBeNull();
    expect(segunda).toBeNull();
  });

  it("y con dos llamadas concurrentes gana exactamente una", async () => {
    // La versión sin pausa que desenmascara: acá no hay nada que serialice a
    // las dos salvo el propio UPDATE, que es el mecanismo que se afirma.
    const id = await conCargo();
    const resultados = await Promise.all([
      asApp(companyId, (tx) =>
        influencerCreditsStore.claimCreditsRefund(tx, { companyId }, id, ahora),
      ),
      asApp(companyId, (tx) =>
        influencerCreditsStore.claimCreditsRefund(tx, { companyId }, id, ahora),
      ),
    ]);
    expect(resultados.filter((r) => r !== null)).toHaveLength(1);
  });

  it("devuelve null si nunca se cobró, y no marca nada", async () => {
    const id = await sinCargo();
    const cargo = await asApp(companyId, (tx) =>
      influencerCreditsStore.claimCreditsRefund(tx, { companyId }, id, ahora),
    );
    expect(cargo).toBeNull();

    // Y la fila queda intacta: marcar un reembolso sobre algo que no se cobró
    // sería además una violación del CHECK, así que esto verifica las dos.
    const row = await asApp(companyId, (tx) =>
      influencerCreditsStore.lockInfluencer(tx, { companyId }, id),
    );
    expect(row?.creditsRefundedAt).toBeNull();
  });

  it("con el scope de otro workspace no toca la fila (las dos capas juntas)", async () => {
    // Lo importante no es que devuelva null: es que la fila del dueño siga sin
    // marcar. Un claim cruzado que marcara dejaría al dueño sin su reembolso —
    // y como la marca es irreversible, sin forma de recuperarlo.
    const id = await conCargo();
    const cargo = await asApp(otroCompanyId, (tx) =>
      influencerCreditsStore.claimCreditsRefund(
        tx,
        { companyId: otroCompanyId },
        id,
        ahora,
      ),
    );
    expect(cargo).toBeNull();

    const row = await asApp(companyId, (tx) =>
      influencerCreditsStore.lockInfluencer(tx, { companyId }, id),
    );
    expect(row?.creditsRefundedAt).toBeNull();
    expect(row?.creditsCharged).toBe(250);
  });

  it("…y con RLS fuera del camino tampoco: el WHERE aísla por sí solo", async () => {
    // Misma corrección que en `lockInfluencer`: el test de arriba sigue verde
    // con el `eq(companyId)` quitado, porque lo tapa RLS. Éste corre como
    // superusuario —sin `SET ROLE`, sin GUC— y entonces el único aislamiento
    // que queda es el de este repositorio.
    const id = await conCargo();
    const cargo = await influencerCreditsStore.claimCreditsRefund(
      ctx.db,
      { companyId: otroCompanyId },
      id,
      ahora,
    );
    expect(cargo).toBeNull();

    const [row] = await ctx.db.select().from(influencers).where(eq(influencers.id, id));
    expect(row?.creditsRefundedAt).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. El backfill de la migración `0007`
// ───────────────────────────────────────────────────────────────────────────

/**
 * El bloque de backfill, leído del archivo de migración entre sus marcadores.
 * Si alguien los borra, esto falla acá y no en producción.
 */
function backfillSql(): string {
  const archivo = readFileSync(
    join(MIGRATIONS_FOLDER, "0007_influencer_credits.sql"),
    "utf8",
  );
  const desde = archivo.indexOf("-- >>> backfill");
  const hasta = archivo.indexOf("-- <<< backfill");
  if (desde === -1 || hasta === -1) {
    throw new Error(
      "No encontré los marcadores `-- >>> backfill` / `-- <<< backfill` en " +
        "0007_influencer_credits.sql. Si los renombraste, actualizá este test: " +
        "es el único que ejercita el movimiento de datos.",
    );
  }
  return archivo.slice(desde, hasta);
}

describe("el backfill de internal_refs → columnas", () => {
  /**
   * Se ejecuta por el cliente pelado de postgres.js y no por `db.execute`,
   * porque es la misma vía que usa el migrador y el bloque tiene varias
   * sentencias. Sin parámetros, así que la trampa 18 (los serializadores que
   * `drizzle()` le cambia al cliente compartido) no aplica.
   */
  const correrBackfill = () => ctx.handle.sql.unsafe(backfillSql());

  it("mueve un cargo completo a las columnas", async () => {
    const [fila] = await ctx.db
      .insert(influencers)
      .values({
        companyId,
        ...base({
          internalRefs: {
            aiStudioCharge: {
              period: "2026-08-01",
              charged: 250,
              operation: "influencer",
              chargedAtMs: 1_787_000_000_000,
              refundedAtMs: null,
            },
          },
        }),
      })
      .returning({ id: influencers.id });
    if (fila === undefined) throw new Error("no se creó el influencer");

    await correrBackfill();

    const [migrada] = await ctx.db
      .select()
      .from(influencers)
      .where(eq(influencers.id, fila.id));
    expect(migrada?.creditsPeriod).toBe("2026-08-01");
    expect(migrada?.creditsCharged).toBe(250);
    expect(migrada?.creditsRefundedAt).toBeNull();
    // El jsonb NO se borra: es la única copia en el instante en que esto corre.
    expect(migrada?.internalRefs).not.toBeNull();
  });

  it("traduce un reembolso ya hecho, en vez de reabrirlo", async () => {
    // `refundedAtMs` es ms epoch. Si el backfill lo ignorara, la fila migrada
    // quedaría con `credits_refunded_at` en null y el próximo fallo del pipeline
    // devolvería por segunda vez unos créditos ya devueltos.
    const refundedAtMs = 1_787_100_000_000;
    const [fila] = await ctx.db
      .insert(influencers)
      .values({
        companyId,
        ...base({
          internalRefs: {
            aiStudioCharge: {
              period: "2026-08-01",
              charged: 250,
              operation: "influencer",
              chargedAtMs: 1_787_000_000_000,
              refundedAtMs,
            },
          },
        }),
      })
      .returning({ id: influencers.id });
    if (fila === undefined) throw new Error("no se creó el influencer");

    await correrBackfill();

    const [migrada] = await ctx.db
      .select()
      .from(influencers)
      .where(eq(influencers.id, fila.id));
    expect(migrada?.creditsRefundedAt?.getTime()).toBe(refundedAtMs);

    // Y la consecuencia que importa: ya no hay nada que reclamar.
    const cargo = await asApp(companyId, (tx) =>
      influencerCreditsStore.claimCreditsRefund(
        tx,
        { companyId },
        fila.id,
        new Date("2026-09-22T12:00:00.000Z"),
      ),
    );
    expect(cargo).toBeNull();
  });

  it("no toca a los que no tienen la clave", async () => {
    const id = await sinCargo();
    await correrBackfill();
    const [fila] = await ctx.db.select().from(influencers).where(eq(influencers.id, id));
    expect(fila?.creditsCharged).toBeNull();
    expect(fila?.creditsPeriod).toBeNull();
  });

  it("FALLA RUIDOSAMENTE si un registro no se puede migrar", async () => {
    // Es la mitad del backfill que más importa. Una fila con la clave pero con
    // forma inesperada quedaría atrás en silencio, que es exactamente la forma
    // en que este proyecto viene perdiendo cargos. Acá se comprueba que el DO
    // block la levanta y corta la migración.
    const [fila] = await ctx.db
      .insert(influencers)
      .values({
        // Sin `period`: hay monto pero no hay a qué ledger devolverlo.
        companyId,
        ...base({ internalRefs: { aiStudioCharge: { charged: 250 } } }),
      })
      .returning({ id: influencers.id });
    if (fila === undefined) throw new Error("no se creó el influencer");

    try {
      await expect(correrBackfill()).rejects.toThrow(/no se pudieron migrar/);
    } finally {
      // Se limpia para no dejar el resto de la suite con una mina puesta.
      await ctx.db.delete(influencers).where(eq(influencers.id, fila.id));
    }
  });

  it("y un monto de 0 es de los que levanta, no de los que migra en silencio", async () => {
    const [fila] = await ctx.db
      .insert(influencers)
      .values({
        companyId,
        ...base({
          internalRefs: { aiStudioCharge: { period: "2026-08-01", charged: 0 } },
        }),
      })
      .returning({ id: influencers.id });
    if (fila === undefined) throw new Error("no se creó el influencer");

    try {
      await expect(correrBackfill()).rejects.toThrow(/no se pudieron migrar/);
    } finally {
      await ctx.db.delete(influencers).where(eq(influencers.id, fila.id));
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Que la migración dejó lo que dice haber dejado
// ───────────────────────────────────────────────────────────────────────────

describe("la migración 0007", () => {
  it("dejó los tres CHECK en la tabla", async () => {
    // Un CHECK declarado en el schema de Drizzle pero ausente de la migración
    // no protege nada, y nada más lo notaría: Drizzle no valida en el cliente.
    const filas = await ctx.db.execute<{ conname: string }>(sql`
      select c.conname
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
       where t.relname = 'influencers' and c.contype = 'c'
    `);
    const nombres = new Set(filas.map((f) => f.conname));
    for (const esperado of [
      "influencers_credits_period_with_charged",
      "influencers_refund_requires_charge",
      "influencers_credits_charged_positive",
    ]) {
      expect(nombres.has(esperado), `falta el CHECK ${esperado}`).toBe(true);
    }
  });
});
