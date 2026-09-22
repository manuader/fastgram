/**
 * El handler de `quota-reset`, contra Postgres — PRD §9.5 #17, `P1-QUOTA-013`.
 *
 * ## Qué persigue este archivo
 *
 * Dos cosas, y la segunda es la difícil.
 *
 * 1. Que el barrido **funcione con el rol de la aplicación**. Es un barrido sin
 *    `companyId`, y `quota_ledgers` tiene `FORCE ROW LEVEL SECURITY`: con
 *    `fastgram_app` y sin `app.current_company`, un `UPDATE` normal afecta cero
 *    filas **sin error**. Como superusuario el mismo código parece andar, así
 *    que un test que no ponga el rol mide justo lo contrario de lo que dice
 *    medir — es la trampa 16, que ya pasó tres veces en este repo.
 * 2. Que el barrido **no haga nada más**. El job es red y no mecanismo, y el
 *    riesgo real no es que falle: es que alguien lo agrande. Por eso hay más
 *    aserciones sobre lo que **no** toca (content saves, ledgers de otros
 *    períodos, workspaces sin reloj diario) que sobre lo que sí.
 *
 * Corre con `SET LOCAL ROLE fastgram_app`, igual que `build.int.test.ts`.
 */
import { FixedClock } from "@fastgram/adapters";
import { nextDailyResetUtc } from "@fastgram/core";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import type { JobContext } from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createQuotaResetHandler,
  type QuotaResetLogger,
} from "../src/jobs/quota-reset-handler.js";
import {
  DATABASE_URL,
  openDb,
  readLedger,
  seedCompany,
  seedSwipes,
} from "./helpers/fixtures.js";

/** 00:05 UTC: la hora a la que el cron diario (`0 0 * * *`) llega en la práctica. */
const NOW = new Date("2026-09-21T00:05:00.000Z");
const PROXIMO = nextDailyResetUtc(NOW);
const VENCIDO = new Date("2026-09-20T00:00:00.000Z");
const FUTURO = new Date("2026-09-30T00:00:00.000Z");

let handle: DbHandle;

const clock = new FixedClock(NOW);

/** Recoge lo logueado: el tope de tandas sólo se ve en el log. */
class LoggerEspia implements QuotaResetLogger {
  readonly infos: Record<string, unknown>[] = [];
  readonly warns: Record<string, unknown>[] = [];
  info(obj: Record<string, unknown>): void {
    this.infos.push(obj);
  }
  warn(obj: Record<string, unknown>): void {
    this.warns.push(obj);
  }
}

function handler(
  logger: QuotaResetLogger,
  options: { batchSize?: number; maxBatches?: number } = {},
) {
  return createQuotaResetHandler({
    db: handle.db,
    clock,
    appRole: APP_ROLE,
    logger,
    ...options,
  });
}

/** El contexto que la cola le pasa. `maxAttempts` 3 = el del catálogo. */
const ctx = (payload: unknown = {}): JobContext<unknown> => ({
  jobId: "job_quota_reset",
  payload,
  attempt: 1,
  maxAttempts: 3,
});

const correr = async (
  options: { batchSize?: number; maxBatches?: number } = {},
  payload: unknown = {},
): Promise<LoggerEspia> => {
  const logger = new LoggerEspia();
  await handler(logger, options)(ctx(payload));
  return logger;
};

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

describe("el barrido de swipes diarios vencidos", () => {
  it("pone el contador en cero y adelanta el instante de reset", async () => {
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, { used: 9, resetAt: VENCIDO });

    await correr();

    const ledger = await readLedger(handle, companyId);
    expect(ledger.dailySwipesUsed).toBe(0);
    expect(ledger.dailySwipeResetAt?.toISOString()).toBe(PROXIMO.toISOString());
  });

  it("funciona con el rol de la aplicación, que es el que tiene RLS encima", async () => {
    // El mismo caso que el de arriba, dicho al revés: lo que este test defiende
    // es que el barrido pase por `app.sweep_expired_daily_swipes`. Sin esa
    // función, con `SET LOCAL ROLE fastgram_app` y sin GUC, la política de
    // `quota_ledgers` no deja pasar nada y el UPDATE afecta cero filas sin
    // error. Verificado del lado de `packages/db`, donde se puede comparar el
    // UPDATE pelado contra la función en la misma transacción.
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, { used: 4, resetAt: VENCIDO });

    const logger = await correr();

    expect((await readLedger(handle, companyId)).dailySwipesUsed).toBe(0);
    // Y el log dice cuántas barrió: un barrido que no afecta filas y no lo
    // reporta es indistinguible de uno que no tenía nada que hacer.
    expect(Number(logger.infos[0]?.["barridas"])).toBeGreaterThanOrEqual(1);
  });

  it("no toca un contador cuyo reset todavía no venció", async () => {
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, { used: 3, resetAt: FUTURO });

    await correr();

    const ledger = await readLedger(handle, companyId);
    expect(ledger.dailySwipesUsed).toBe(3);
    expect(ledger.dailySwipeResetAt?.toISOString()).toBe(FUTURO.toISOString());
  });

  it("no le inventa un reloj diario a quien nunca hizo un swipe", async () => {
    // `dailySwipeResetAt` nulo significa que el reloj de ese workspace todavía
    // no arrancó. Ponerle uno sería empezarle la cuota diaria desde un cron en
    // vez de desde su primer swipe, que es el reloj que el usuario ve.
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, { used: 0, resetAt: null });

    await correr();

    const ledger = await readLedger(handle, companyId);
    expect(ledger.dailySwipeResetAt).toBeNull();
    expect(ledger.dailySwipesUsed).toBe(0);
  });

  it("barre los de varios workspaces, que es la razón de que no lleve scope", async () => {
    const uno = await seedCompany(handle);
    const dos = await seedCompany(handle);
    await seedSwipes(handle, uno, { used: 5, resetAt: VENCIDO });
    await seedSwipes(handle, dos, { used: 6, resetAt: VENCIDO });

    await correr();

    expect((await readLedger(handle, uno)).dailySwipesUsed).toBe(0);
    expect((await readLedger(handle, dos)).dailySwipesUsed).toBe(0);
  });

  it("es idempotente: reejecutarlo no encuentra nada que hacer", async () => {
    // El puerto `Queue` dice que un handler puede reintentarse, y el catálogo
    // le da 3 intentos. Acá la idempotencia sale gratis porque el barrido sólo
    // toca filas vencidas y la primera corrida las deja sin vencer — pero eso
    // es una propiedad que conviene tener medida, no supuesta.
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, { used: 8, resetAt: VENCIDO });

    await correr();
    const segunda = await correr();

    expect(segunda.infos[0]?.["barridas"]).toBe(0);
    expect((await readLedger(handle, companyId)).dailySwipesUsed).toBe(0);
  });
});

describe("lo que este job NO hace — §9.5 #17: red, no mecanismo", () => {
  it("no toca los content saves del período", async () => {
    // La aserción que se pone roja el día que alguien le agregue "y de paso
    // reinicia los saves". El reset de saves **es** la clave del período: al
    // cruzar el ancla aparece una fila nueva y la vieja es historia de
    // facturación. Un UPDATE sobre la vieja reescribe una factura cerrada.
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, {
      used: 7,
      resetAt: VENCIDO,
      contentSavesUsed: 12,
      contentSavesPurchased: 4,
    });

    await correr();

    const ledger = await readLedger(handle, companyId);
    expect(ledger.dailySwipesUsed).toBe(0);
    expect(ledger.contentSavesUsed).toBe(12);
    expect(ledger.contentSavesPurchased).toBe(4);
    expect(ledger.contentSavesIncluded).toBe(500);
  });

  it("no crea el ledger del período siguiente", async () => {
    // Crearlo por adelantado volvería al cron mecanismo —y encima fijaría un
    // arrastre de saldo comprado que todavía puede moverse antes del corte—.
    // Lo crea `lockPeriod` en la primera petición del ciclo (`P1-QUOTA-012`).
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, { used: 2, resetAt: VENCIDO });

    await correr();

    const filas = await handle.sql`
      select count(*)::int as n from quota_ledgers where company_id = ${companyId}::uuid
    `;
    expect((filas[0] as unknown as { n: number }).n).toBe(1);
  });

  it("no borra los períodos viejos", async () => {
    // Son historia de facturación: §16.4 muestra el período en el portal y
    // soporte lo lee. Una retención es una decisión de producto que nadie tomó.
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, {
      period: "2020-01-01",
      used: 3,
      resetAt: VENCIDO,
      contentSavesUsed: 30,
    });

    await correr();

    const viejo = await readLedger(handle, companyId, "2020-01-01");
    expect(viejo.contentSavesUsed).toBe(30);
    expect(viejo.dailySwipesUsed).toBe(0);
  });

  it("ignora el payload: no hay forma de apuntarlo a un workspace", async () => {
    // Un barrido cross-tenant que leyera un `companyId` del payload sería una
    // manera de mover los contadores de otro workspace desde la cola. El
    // payload se descarta, así que un `companyId` ajeno no estrecha ni amplía
    // nada: la fila de la otra company se barre igual.
    const uno = await seedCompany(handle);
    const dos = await seedCompany(handle);
    await seedSwipes(handle, uno, { used: 1, resetAt: VENCIDO });
    await seedSwipes(handle, dos, { used: 1, resetAt: VENCIDO });

    await correr({}, { companyId: uno });

    expect((await readLedger(handle, dos)).dailySwipesUsed).toBe(0);
  });

  it("un payload basura tampoco lo rompe", async () => {
    const companyId = await seedCompany(handle);
    await seedSwipes(handle, companyId, { used: 1, resetAt: VENCIDO });

    await expect(correr({}, "no soy un objeto")).resolves.toBeDefined();

    expect((await readLedger(handle, companyId)).dailySwipesUsed).toBe(0);
  });
});

describe("las tandas", () => {
  it("itera hasta terminar: un límite de 1 barre las dos filas", async () => {
    const uno = await seedCompany(handle);
    const dos = await seedCompany(handle);
    await seedSwipes(handle, uno, { used: 5, resetAt: VENCIDO });
    await seedSwipes(handle, dos, { used: 5, resetAt: VENCIDO });

    const logger = await correr({ batchSize: 1 });

    expect((await readLedger(handle, uno)).dailySwipesUsed).toBe(0);
    expect((await readLedger(handle, dos)).dailySwipesUsed).toBe(0);
    // Tres tandas: dos con trabajo y una corta que corta el bucle.
    expect(Number(logger.infos[0]?.["tandas"])).toBeGreaterThanOrEqual(2);
    expect(logger.warns).toHaveLength(0);
  });

  it("avisa cuando se agota el tope de tandas y quedaba trabajo", async () => {
    // La red contra un barrido que no termina. Sin el aviso, un `dailySwipeResetAt`
    // escrito hacia el pasado dejaría el job trabajando todos los días sobre las
    // mismas filas y el síntoma sería un job lento, no un log.
    const uno = await seedCompany(handle);
    const dos = await seedCompany(handle);
    await seedSwipes(handle, uno, { used: 5, resetAt: VENCIDO });
    await seedSwipes(handle, dos, { used: 5, resetAt: VENCIDO });

    const logger = await correr({ batchSize: 1, maxBatches: 1 });

    expect(logger.warns).toHaveLength(1);
    expect(Number(logger.infos[0]?.["barridas"])).toBe(1);
  });
});
