/**
 * El cobro de créditos de `POST /influencers`, extremo a extremo — `FR-080`,
 * `NFR-025`, PRD §16.2 y §9.4.
 *
 * Hasta acá esta ruta **no cobraba nada**: validaba, creaba la fila y encolaba un
 * pipeline de 250 créditos y 15–20 minutos de GPU sin mirar el saldo. Un workspace
 * Free con 10 créditos podía encolar pipelines indefinidamente. Y no había ni un
 * test de integración sobre el `POST`: lo único que tocaba `/influencers` era el
 * `GET` de `tenant-isolation`.
 *
 * ## Lo que esta suite persigue, y lo que deliberadamente no
 *
 * No persigue "descuenta 250". Persigue las tres cosas que hacen que el cargo sea
 * correcto **y** devolvible:
 *
 *  1. que el saldo se lea del ledger del período con la misma clave que los content
 *     saves (`billingPeriodKey`), no de otra;
 *  2. que el replay de idempotencia y el fallo al encolar **no** dejen el cargo;
 *  3. que quede escrito en la fila **a qué período** y **cuánto** se cobró, que es
 *     lo único que permite el reembolso cuando el pipeline falle.
 *
 * ## Por qué cada test escribe `ai_credits` antes de medir
 *
 * `quota_ledgers` no está en la lista del `truncate` del fixture. Llega a vaciarse
 * igual —tiene FK a `companies` y el `truncate … cascade` la arrastra, verificado
 * contra la base— pero eso es un efecto lateral de una FK que nadie está mirando.
 * Y dentro de un mismo archivo los tests comparten la fila del período. Así que
 * ninguno asume de qué valor parte: cada uno escribe el saldo que quiere medir.
 * Es el mismo criterio de `quota.int.test.ts`, por el mismo motivo: un test de "no
 * alcanzan los créditos" que parte de un saldo desconocido pasa sin probar nada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AI_STUDIO_COST, billingPeriodKey, HARD_CAPS, PLANS } from "@fastgram/core";
import { MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE } from "@fastgram/contracts";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

/** El cupo del plan del fixture (`growth`). El saldo se mide contra esto. */
const CUPO = PLANS.growth.aiStudioCredits;
const COSTE = AI_STUDIO_COST.influencer;

const BODY = {
  name: "Ella",
  gender: "woman",
  age: 27,
  ethnicity: "latina",
};

let n = 0;
const crear = (): ReturnType<ApiHarness["request"]> =>
  api.request({
    method: "POST",
    path: "/api/v1/influencers",
    body: BODY,
    idempotencyKey: `influ-${String((n += 1))}-${String(Date.now())}`,
  });

const periodo = (): string => billingPeriodKey(new Date(api.clock.nowMs()), 1);

/**
 * Créditos **consumidos** en el período, leídos directo.
 *
 * `handle.sql` es el cliente crudo de postgres.js: `drizzle-orm` no es alcanzable
 * desde `apps/api`, y eso es a propósito — es lo que impide que una ruta arme su
 * propio `WHERE` y se olvide el tenant. Un test que lee contabilidad directo es
 * código de fixture, no de request.
 */
async function consumidos(): Promise<number> {
  const filas = await api.handle.sql`
    select ai_credits from quota_ledgers
    where company_id = ${api.data.a.companyId}::uuid and period = ${periodo()}
  `;
  const fila = filas[0] as unknown as { ai_credits: number } | undefined;
  if (fila === undefined) throw new Error("no hay ledger del período");
  return fila.ai_credits;
}

/** El registro del cargo que quedó en la fila del influencer. */
async function cargoDe(influencerId: string): Promise<{
  period: string;
  charged: number;
  operation: string;
  refundedAtMs: number | null;
} | null> {
  const filas = await api.handle.sql`
    select internal_refs from influencers where id = ${influencerId}::uuid
  `;
  const fila = filas[0] as unknown as
    { internal_refs: Record<string, unknown> | null } | undefined;
  const refs = fila?.internal_refs ?? null;
  if (refs === null) return null;
  return (refs["aiStudioCharge"] ?? null) as never;
}

/**
 * Deja el workspace `a` con un saldo conocido y sin influencers de otro test.
 *
 * El del fixture no se borra —lo usan otras suites por id— y cuenta como **uno en
 * vuelo**, porque nace en `generating_variations`. Eso también es determinista, que
 * es lo que importa.
 */
async function reset(consumidosPrevios: number): Promise<void> {
  await api.handle.sql`
    delete from influencers
    where company_id = ${api.data.a.companyId}::uuid
      and id <> ${api.data.a.influencerId}::uuid
  `;
  await api.handle.sql`
    insert into quota_ledgers (company_id, period, ai_credits)
    values (${api.data.a.companyId}::uuid, ${periodo()}, ${consumidosPrevios})
    on conflict (company_id, period)
      do update set ai_credits = ${consumidosPrevios}
  `;
  api.queue.reset();
}

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(async () => {
  // Saldo lleno salvo que el test diga otra cosa.
  await reset(0);
});

describe("POST /influencers cobra", () => {
  it("descuenta los 250 créditos del período", async () => {
    const res = await crear();
    expect(res.status).toBe(201);
    expect(await consumidos()).toBe(COSTE);
  });

  it("deja escrito el período y el monto en la fila", async () => {
    // Sin estos dos datos el reembolso de `releaseAiStudioGeneration` es imposible:
    // no se sabría a qué ledger devolver ni cuánto. Es el equivalente de
    // `contents.save_bucket` / `save_period` para el content save.
    const res = await crear();
    const cargo = await cargoDe(String(dataOf(res)["_id"]));

    expect(cargo).not.toBeNull();
    expect(cargo?.period).toBe(periodo());
    expect(cargo?.charged).toBe(COSTE);
    expect(cargo?.operation).toBe("influencer");
    // El hueco que queda abierto: nadie lo pone todavía, y por eso está en null.
    expect(cargo?.refundedAtMs).toBeNull();
  });

  it("el cargo NO sale por la API", async () => {
    // `internalRefs` es "nunca expuesto" en DATA-013. El tipo de retorno de
    // `toInfluencer` ya lo impide; esto lo comprueba sobre el JSON real.
    const res = await crear();
    // Control positivo. Tres `not.toContain` sobre un cuerpo vacío pasan solos, y
    // eso es la trampa 23: un test que se llama "no expone X" y en realidad no mira
    // nada. Esto fija que el cuerpo es el del influencer creado antes de afirmar
    // qué NO trae.
    expect(res.status).toBe(201);
    expect(res.raw).toContain(String(dataOf(res)["_id"]));
    expect(res.raw).toContain("Ella");

    expect(res.raw).not.toContain("aiStudioCharge");
    expect(res.raw).not.toContain("internalRefs");
    expect(res.raw).not.toContain("internal_refs");
  });

  it("le pasa al pipeline el período y el monto cobrados", async () => {
    // El handler del job tiene que poder devolver los créditos sin volver a derivar
    // el período: el ancla de facturación puede cambiar entre el cargo y el fallo.
    const res = await crear();
    const jobs = api.queue.forQueue("influencer-pipeline");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      influencerId: dataOf(res)["_id"],
      creditsPeriod: periodo(),
      creditsCharged: COSTE,
    });
  });

  it("el replay de idempotencia NO cobra dos veces", async () => {
    // Es la mitad de la idempotencia que le importa a la factura: un cliente que
    // reintenta por timeout no puede pagar 250 créditos dos veces.
    const key = `replay-influ-${String(Date.now())}`;
    const primera = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      body: BODY,
      idempotencyKey: key,
    });
    expect(primera.status).toBe(201);
    expect(await consumidos()).toBe(COSTE);

    const segunda = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      body: BODY,
      idempotencyKey: key,
    });

    expect(dataOf(segunda)["_id"]).toBe(dataOf(primera)["_id"]);
    expect(await consumidos()).toBe(COSTE);
  });

  it("un fallo al encolar NO deja los créditos cobrados", async () => {
    // El cobro y el encolado van en la misma transacción justamente por esto. Si el
    // cobro se confirmara aparte, el cliente pagaría 250 créditos por un pipeline
    // que no existe — y no habría fila a la que asociar el reembolso.
    api.queue.failNext = true;

    const res = await crear();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await consumidos()).toBe(0);
  });
});

describe("cuando no alcanzan los créditos", () => {
  it("responde 402 payment_required con `balance` y `required`", async () => {
    // Se deja el saldo en 1 escribiendo el contador, no haciendo dos peticiones: lo
    // que se prueba es la respuesta al no alcanzar, no la aritmética —eso ya está en
    // `core/quota/content-saves.test.ts`.
    await reset(CUPO - 1);

    const res = await crear();
    expect(res.status).toBe(402);
    const error = errorOf(res);
    expect(error.code).toBe("payment_required");
    // FR-080 (PRD:1519) nombra los dos campos como parte de la respuesta, y hay un
    // schema del contrato que los tipa. Sin `balance` la UI no puede decir
    // "<N> more credits to continue.".
    expect(error.details).toMatchObject({ balance: 1, required: COSTE });
  });

  it("y NO crea la fila, ni encola, ni mueve el contador", async () => {
    await reset(CUPO);

    const antes = await api.request({ method: "GET", path: "/api/v1/influencers" });
    const cuantos = (antes.body?.["data"] as unknown[]).length;

    const res = await crear();
    expect(res.status).toBe(402);

    const despues = await api.request({ method: "GET", path: "/api/v1/influencers" });
    expect((despues.body?.["data"] as unknown[]).length).toBe(cuantos);
    expect(api.queue.enqueued).toHaveLength(0);
    expect(await consumidos()).toBe(CUPO);
  });

  it("con el saldo justo, pasa", async () => {
    // El borde de `>=` vs `>`: con exactamente 250 tiene que alcanzar. Es el error
    // que ningún test de "0 y 500" detecta.
    await reset(CUPO - COSTE);

    const res = await crear();
    expect(res.status).toBe(201);
    expect(await consumidos()).toBe(CUPO);
  });
});

describe("el cap de concurrencia de NFR-025", () => {
  it("responde 409 con el copy de ERR-R07 cuando hay 10 pipelines en vuelo", async () => {
    await reset(0);
    // El del fixture ya cuenta como uno en vuelo (`generating_variations`), así que
    // hacen falta `cap - 1` más para llegar al tope exacto.
    const faltan = HARD_CAPS.inFlightGenerations - 1;
    await api.handle.sql`
      insert into influencers (company_id, name, gender, age, ethnicity, status)
      select ${api.data.a.companyId}::uuid, 'en vuelo ' || g, 'woman', 27, 'latina',
             'training'::influencer_status
      from generate_series(1, ${faltan}) g
    `;

    const res = await crear();
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("conflict");
    expect(errorOf(res).message).toContain("generations in flight");
    // Y lo que importa de verdad: rechazar por concurrencia **no** cobra. Es el
    // orden que argumenta la cabecera de `startAiStudioGeneration` — primero lo
    // barato, así no hay nada que compensar.
    expect(await consumidos()).toBe(0);
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("con uno menos que el tope, pasa", async () => {
    await reset(0);
    const faltan = HARD_CAPS.inFlightGenerations - 2;
    await api.handle.sql`
      insert into influencers (company_id, name, gender, age, ethnicity, status)
      select ${api.data.a.companyId}::uuid, 'en vuelo ' || g, 'woman', 27, 'latina',
             'training'::influencer_status
      from generate_series(1, ${faltan}) g
    `;

    const res = await crear();
    expect(res.status).toBe(201);
    expect(await consumidos()).toBe(COSTE);
  });

  it("los terminados NO cuentan como en vuelo", async () => {
    // `ready`, `failed` e `inactive` liberan el slot de GPU. Si contaran, un
    // workspace con 10 influencers entrenados no podría crear ninguno más — y el
    // cap de creados es 50, no 10.
    await reset(0);
    await api.handle.sql`
      insert into influencers (company_id, name, gender, age, ethnicity, status)
      select ${api.data.a.companyId}::uuid, 'terminado ' || g, 'woman', 27, 'latina',
             (array['ready','failed','inactive']::influencer_status[])[1 + (g % 3)]
      from generate_series(1, 20) g
    `;

    const res = await crear();
    expect(res.status).toBe(201);
  });
});

describe("el cap de 50 activos de FR-080", () => {
  it("responde 402 y NO cobra, porque se comprueba antes", async () => {
    // El orden importa para la factura: si el cap se comprobara después del cobro,
    // un workspace en el tope pagaría 250 créditos por cada intento rechazado.
    await reset(0);
    const faltan = MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE - 1;
    await api.handle.sql`
      insert into influencers (company_id, name, gender, age, ethnicity, status)
      select ${api.data.a.companyId}::uuid, 'activo ' || g, 'woman', 27, 'latina',
             'ready'::influencer_status
      from generate_series(1, ${faltan}) g
    `;

    const res = await crear();
    expect(res.status).toBe(402);
    const error = errorOf(res);
    expect(error.code).toBe("payment_required");
    expect(error.details).toMatchObject({
      cap: MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
      active: MAX_ACTIVE_INFLUENCERS_PER_WORKSPACE,
    });
    expect(await consumidos()).toBe(0);
  });
});
