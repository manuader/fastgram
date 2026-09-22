/**
 * El handler de `influencer-pipeline`, contra Postgres — `FR-080`, §9.4.
 *
 * ## Qué persigue este archivo
 *
 * Que los 250 créditos vuelvan. `POST /influencers` es el endpoint más caro del
 * producto y **ya cobra**; hasta este handler, el personaje se quedaba en
 * `generating_variations` para siempre y el cargo no volvía nunca.
 *
 * Y sobre todo: que **no vuelvan dos veces**. La guarda vive en
 * `influencerCreditsStore.claimCreditsRefund`, que marca y devuelve el cargo en
 * una sola sentencia; acá se comprueba que el handler la respeta y que la
 * propiedad se sostiene **bajo concurrencia real**, que es donde un
 * `SELECT`-y-después-`UPDATE` se rompería.
 *
 * Corre con `SET LOCAL ROLE fastgram_app`: sin el rol, la conexión de
 * desarrollo es superusuaria, saltea RLS, y el archivo mediría la mitad.
 */
import { FixedClock } from "@fastgram/adapters";
import { APP_ROLE, type DbHandle } from "@fastgram/db";
import { PortError, type JobContext } from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInfluencerPipelineHandler,
  type PipelineGenerator,
} from "../src/influencers/pipeline-handler.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import {
  openDb,
  readInfluencer,
  seedCompany,
  seedInfluencer,
} from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const clock = new FixedClock(NOW);
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let companyId: string;

const handler = (generator?: PipelineGenerator) =>
  createInfluencerPipelineHandler({
    db: handle.db,
    ...(generator === undefined ? {} : { generator }),
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
  });

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: "job_1",
  payload,
  attempt: 1,
  // El catálogo le da 2 intentos: cuesta 250 créditos y 15–20 min de GPU, así
  // que reintentar tres veces un fallo permanente quema una hora de GPU para
  // llegar al mismo error.
  maxAttempts: 2,
});

beforeAll(async () => {
  handle = openDb();
  companyId = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

describe("sin generador montado", () => {
  it("cierra el personaje y devuelve los 250 créditos", async () => {
    // Es el estado real de hoy: no hay adaptador de `MediaGeneration`. Dejar el
    // personaje en `generating_variations` ocultaría que no pasa nada, y
    // marcarlo `ready` mentiría sobre un personaje que no se puede usar.
    const influencerId = await seedInfluencer(handle, companyId, { aiCreditsUsed: 250 });

    await handler()(ctx({ companyId, influencerId }));

    const inf = await readInfluencer(handle, influencerId);
    expect(inf.status).toBe("failed");
    expect(inf.ai_credits).toBe(0);
    expect(inf.credits_refunded_at).not.toBeNull();
  });

  it("devuelve exactamente lo cobrado, no lo que costaría hoy", async () => {
    // El monto sale de `credits_charged`. `OQ-21` está abierta sobre el
    // tarifario: si cambiara entre el cobro y el fallo, usar `AI_STUDIO_COST`
    // de hoy le devolvería al cliente un número distinto del que se le sacó.
    const influencerId = await seedInfluencer(handle, companyId, {
      creditsCharged: 180,
      aiCreditsUsed: 500,
    });

    await handler()(ctx({ companyId, influencerId }));

    expect((await readInfluencer(handle, influencerId)).ai_credits).toBe(320);
  });
});

describe("el reembolso ocurre UNA sola vez", () => {
  it("una segunda corrida no devuelve de nuevo", async () => {
    const influencerId = await seedInfluencer(handle, companyId, { aiCreditsUsed: 250 });

    await handler()(ctx({ companyId, influencerId }));
    const despuesDeUna = (await readInfluencer(handle, influencerId)).ai_credits;
    await handler()(ctx({ companyId, influencerId }));

    expect(despuesDeUna).toBe(0);
    expect((await readInfluencer(handle, influencerId)).ai_credits).toBe(0);
  });

  it("un personaje ya reembolsado no se vuelve a tocar", async () => {
    // La guarda propiamente dicha, sembrada a mano: el estado sigue en vuelo
    // pero el cargo ya se devolvió. Sin `claimCreditsRefund`, esto restaría
    // otros 250.
    const influencerId = await seedInfluencer(handle, companyId, {
      creditsRefundedAt: new Date("2026-09-20T00:00:00.000Z"),
      aiCreditsUsed: 250,
    });

    await handler()(ctx({ companyId, influencerId }));

    const inf = await readInfluencer(handle, influencerId);
    expect(inf.status).toBe("failed");
    expect(inf.ai_credits).toBe(250);
  });

  it("tres corridas SIMULTÁNEAS devuelven una sola vez", async () => {
    // **Cuidado con lo que este test mide, porque no es lo que parece.** Lo
    // escribí creyendo que medía la atomicidad de `claimCreditsRefund`, lo
    // rompí para comprobarlo —reemplazándolo por un `SELECT` y después un
    // `UPDATE`, que es la carrera clásica— y **siguió verde**: lo que serializa
    // a las tres transacciones es el `lockInfluencer` que el handler toma
    // antes, no el claim.
    //
    // Así que lo que esto afirma es la propiedad de punta a punta del handler:
    // tres entregas concurrentes del mismo job devuelven el cargo una sola vez.
    // Vale, pero la atomicidad del claim **por sí sola** se mide en
    // `packages/db/test/influencer-credits.int.test.ts`, sin lock de por medio,
    // y ese sí se pone rojo (`expected [Array(2)] to have a length of 1`).
    const influencerId = await seedInfluencer(handle, companyId, { aiCreditsUsed: 250 });

    await Promise.all([
      handler()(ctx({ companyId, influencerId })),
      handler()(ctx({ companyId, influencerId })),
      handler()(ctx({ companyId, influencerId })),
    ]);

    expect((await readInfluencer(handle, influencerId)).ai_credits).toBe(0);
  });
});

describe("lo que no se toca", () => {
  it("un personaje que ya llegó a `ready` no se marca fallido", async () => {
    // Un job reentregado después de que el pipeline terminara bien mataría un
    // personaje usable y le devolvería créditos que sí se gastaron.
    const influencerId = await seedInfluencer(handle, companyId, {
      status: "ready",
      aiCreditsUsed: 250,
    });

    await handler()(ctx({ companyId, influencerId }));

    const inf = await readInfluencer(handle, influencerId);
    expect(inf.status).toBe("ready");
    expect(inf.ai_credits).toBe(250);
  });

  it("un personaje sin cargo se cierra sin tocar el ledger", async () => {
    const influencerId = await seedInfluencer(handle, companyId, {
      creditsCharged: null,
      aiCreditsUsed: 250,
    });

    await handler()(ctx({ companyId, influencerId }));

    const inf = await readInfluencer(handle, influencerId);
    expect(inf.status).toBe("failed");
    expect(inf.ai_credits).toBe(250);
  });

  it("el de otro workspace no se toca", async () => {
    const otro = await seedCompany(handle);
    const ajeno = await seedInfluencer(handle, otro, { aiCreditsUsed: 250 });

    await handler()(ctx({ companyId, influencerId: ajeno }));

    expect((await readInfluencer(handle, ajeno)).status).toBe("generating_variations");
  });
});

describe("con generador montado", () => {
  it("si arranca bien, no se toca nada", async () => {
    const influencerId = await seedInfluencer(handle, companyId, { aiCreditsUsed: 250 });
    let arrancado = false;

    await handler({
      start: async () => {
        arrancado = true;
      },
    })(ctx({ companyId, influencerId }));

    expect(arrancado).toBe(true);
    const inf = await readInfluencer(handle, influencerId);
    expect(inf.status).toBe("generating_variations");
    expect(inf.ai_credits).toBe(250);
  });

  it("si falla al arrancar, devuelve los créditos", async () => {
    const influencerId = await seedInfluencer(handle, companyId, { aiCreditsUsed: 250 });

    await handler({
      start: async () => {
        throw new PortError("provider_unavailable", "la GPU no responde", {
          source: "t",
        });
      },
    })(ctx({ companyId, influencerId }));

    const inf = await readInfluencer(handle, influencerId);
    expect(inf.status).toBe("failed");
    expect(inf.ai_credits).toBe(0);
  });
});

describe("payloads que no son de este mundo", () => {
  it("sin `influencerId` se descarta", async () => {
    await expect(handler()(ctx({ companyId }))).resolves.toBeUndefined();
  });

  it("un `creditsCharged` fraccionario se rechaza antes de tocar la base", async () => {
    // Restar un fraccionario dejaría el contador en un valor imposible, y un
    // negativo haría fallar el CHECK y la transacción entera — el personaje se
    // quedaría sin cerrar.
    await expect(
      handler()(ctx({ companyId, influencerId: "x", creditsCharged: 12.5 })),
    ).resolves.toBeUndefined();
  });
});
