/**
 * Onboarding contra Postgres real — `FR-010`, `FLOW-001`, `FLOW-009`.
 *
 * ## Los tres casos que justifican el archivo
 *
 * **1. El disparador que el PRD nombra tres veces.** PRD:759, 1890 y 2006 dicen
 * que al cerrar el alta hay que *"arrancar el relleno de la discovery queue"*.
 * Hasta este archivo, el único sitio del repo que encolaba `discovery-refill`
 * era `POST /blitz` con la cola vacía — el *otro* momento, no éste. Lo que se
 * verifica no es que la ruta devuelva 202: es que el job salga, con el
 * `companyId` del que pidió y en la cola que el worker escucha.
 *
 * **2. El paso del wizard no está guardado.** `packages/db` no expone
 * repositorio de `onboarding_records`, así que la ruta **deriva** el paso del
 * estado persistido. Eso sólo se puede probar contra la base: hay que escribir
 * una fuente, luego un `coreIdentity`, luego el cuestionario, y ver que el paso
 * se mueve solo. Con un doble no hay nada que derivar.
 *
 * **3. La copy de `FR-010` llega entera.** Los mensajes de validación son
 * CONFIRMED y literales, y el camino que los trae —`DomainError("out_of_range")`
 * → `asApiRejection` → `translateError`— tiene tres capas donde perderse. Lo que
 * se compara es el **string exacto**, no que haya habido un 400.
 *
 * ## Por qué pone las companies en `draft`
 *
 * El fixture compartido las siembra en `active`, que para la derivación
 * significa *"el alta ya cerró"* — y entonces todo el wizard responde `ready` y
 * `complete` responde 409. Es el estado correcto para un fixture de rutas
 * normales y el equivocado para éste, así que cada caso arranca en `draft`, que
 * es el default de la columna y el estado en el que nace un workspace real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(async () => {
  api.queue.reset();
  // La unicidad de `brand_sources` es GLOBAL: un residuo de otro caso choca con
  // un 409 que no tiene nada que ver con lo que se mide.
  await api.handle.sql`delete from brand_sources`;
  await api.handle.sql`delete from company_profiles`;
  await api.handle.sql`delete from idempotency_records`;
  await api.handle.sql`delete from content_angles`;
  await api.handle.sql`
    update companies set status = 'draft' where status <> 'soft_deleted'
  `;
});

const get = (token?: string): ReturnType<ApiHarness["request"]> =>
  api.request({
    method: "GET",
    path: "/api/v1/onboarding",
    ...(token === undefined ? {} : { token }),
  });

const submitProfiling = (
  body: Record<string, unknown>,
  token?: string,
): ReturnType<ApiHarness["request"]> =>
  api.request({
    method: "POST",
    path: "/api/v1/onboarding/profiling",
    body,
    ...(token === undefined ? {} : { token }),
  });

const complete = (
  options: { readonly key?: string; readonly token?: string } = {},
): ReturnType<ApiHarness["request"]> =>
  api.request({
    method: "POST",
    path: "/api/v1/onboarding/complete",
    idempotencyKey: options.key ?? randomUUID(),
    ...(options.token === undefined ? {} : { token: options.token }),
  });

const refillJobs = (): readonly { companyId: string }[] =>
  api.queue
    .forQueue(JOB_QUEUES.discoveryRefill)
    .map((job) => job.payload as { companyId: string });

const ANSWERS = {
  ownerRole: "founder",
  teamSize: "1-5",
  businessModel: "b2c",
  businessCategories: ["retail"],
  monthlyRevenueBand: "0-10k",
  expectations: ["more reach"],
} as const;

/** Deja el workspace `a` con fuente y descripción: listo para el paso 3. */
async function hastaElCuestionario(): Promise<void> {
  const created = await api.request({
    method: "POST",
    path: "/api/v1/brand/sources",
    idempotencyKey: randomUUID(),
    body: { sourceType: "instagram", handle: "acme" },
  });
  expect(created.status).toBe(202);
  const patched = await api.request({
    method: "PATCH",
    path: "/api/v1/brand/profile",
    body: { coreIdentity: "vendemos zapatillas a runners" },
  });
  expect(patched.status).toBe(200);
}

/* ── GET /onboarding ─────────────────────────────────────────────────────── */

describe("GET /onboarding", () => {
  it("un workspace sin nada arranca en el paso 1, y no es un 404", () => {
    // El onboarding es un estado del workspace, no un recurso con vida propia:
    // un 404 obligaría a cada cliente a tratar "alta recién empezada" como
    // error. Mismo criterio que `GET /brand/profile`.
    return get().then((res) => {
      expect(res.status).toBe(200);
      expect(dataOf(res)).toEqual({
        step: "brand_source",
        sources: [],
        manualBranch: false,
        details: null,
        profiling: null,
        oauthConsents: 0,
      });
    });
  });

  it("con una fuente dada de alta, el paso se mueve solo al 2", async () => {
    // Nadie escribió "paso 2" en ninguna columna: sale de `advanceOnboarding`
    // sobre lo que hay en `brand_sources`.
    await hastaElCuestionario();
    const body = dataOf(await get());
    expect(body["step"]).toBe("profiling");
    expect(body["details"]).toEqual({
      name: expect.any(String),
      description: "vendemos zapatillas a runners",
      logoUrl: null,
    });
  });

  it("sin descripción se queda en el paso 2 aunque haya fuente", async () => {
    const created = await api.request({
      method: "POST",
      path: "/api/v1/brand/sources",
      idempotencyKey: randomUUID(),
      body: { sourceType: "tiktok", handle: "acme" },
    });
    expect(created.status).toBe(202);
    const body = dataOf(await get());
    expect(body["step"]).toBe("company_details");
    expect(body["details"]).toBeNull();
    expect(body["sources"]).toHaveLength(1);
  });

  it("con la company en `active`, el alta está terminada", async () => {
    await api.handle.sql`
      update companies set status = 'active' where id = ${api.data.a.companyId}
    `;
    expect(dataOf(await get())["step"]).toBe("ready");
  });

  it("`D-01`: el alta nunca pidió un consentimiento OAuth", async () => {
    // `FLOW-009` criterio 11. Hoy es cierto por construcción —ninguna columna
    // los cuenta— y el campo viaja igual para que el día que se cuenten, el
    // cliente y este test ya estén mirando.
    await hastaElCuestionario();
    expect(dataOf(await get())["oauthConsents"]).toBe(0);
  });
});

/* ── POST /onboarding/profiling ──────────────────────────────────────────── */

describe("POST /onboarding/profiling", () => {
  it("guarda las seis respuestas y mueve el wizard a `processing`", async () => {
    await hastaElCuestionario();
    const res = await submitProfiling({ ...ANSWERS });
    expect(res.status).toBe(200);
    const body = dataOf(res);
    expect(body["step"]).toBe("processing");
    expect(body["profiling"]).toEqual(ANSWERS);

    // Y sobrevive a la recarga, que es el criterio 3 de `FR-010`.
    expect(dataOf(await get())["profiling"]).toEqual(ANSWERS);
  });

  it("el cuestionario es parte del perfil: mueve `brandRevision`", async () => {
    // DATA-004: *"Incrementa en cada guardado"*. `AI-005` lo usa como
    // `expectedBrandRevision`, así que un perfil que cambia sin moverlo deja
    // sugerencias que se creen vigentes.
    await hastaElCuestionario();
    const antes = dataOf(
      await api.request({ method: "GET", path: "/api/v1/brand/profile" }),
    );
    await submitProfiling({ ...ANSWERS });
    const despues = dataOf(
      await api.request({ method: "GET", path: "/api/v1/brand/profile" }),
    );
    expect(despues["brandRevision"]).toBe((antes["brandRevision"] as number) + 1);
  });

  it.each([
    ["ownerRole", "Please select your role"],
    ["teamSize", "Please select your team size"],
    ["businessModel", "Please select your business model"],
    ["monthlyRevenueBand", "Please select your monthly revenue"],
  ])("la copy literal de FR-010 llega entera: %s", async (field, message) => {
    await hastaElCuestionario();
    const res = await submitProfiling({ ...ANSWERS, [field]: "" });
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe("bad_request");
    expect(error.message).toBe(message);
    // El campo sale con el nombre del **cuerpo**, no con el de `core`: la UI
    // resalta un input que existe.
    expect(error.details).toEqual({ field });
  });

  it("una lista de categorías vacía tiene su propio mensaje", async () => {
    await hastaElCuestionario();
    const res = await submitProfiling({ ...ANSWERS, businessCategories: [] });
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Please select at least one business category");
  });

  it("`expectations` NO es obligatoria: vacía se acepta y se guarda vacía", async () => {
    // `REQUIRED_PROFILING_ANSWERS` tiene cinco claves y ésta no está, porque la
    // lista de **Validation** de `FR-010` no le da mensaje de error. Rechazarla
    // sería inventar copy. Este caso fija esa lectura del PRD: si mañana
    // alguien la hace obligatoria, se entera acá y no en producción.
    await hastaElCuestionario();
    const res = await submitProfiling({ ...ANSWERS, expectations: [] });
    expect(res.status).toBe(200);
    expect(dataOf(res)["profiling"]).toMatchObject({ expectations: [] });
  });

  it("pero la clave `expectations` tiene que venir: un cuerpo sin ella es 400", async () => {
    // La otra mitad de P1-ONB-004. El agujero real no era que se aceptara
    // vacía: era que un cliente que **nunca** la mandaba dejaba la columna sin
    // tocar para siempre y nada lo decía.
    await hastaElCuestionario();
    const { expectations: _omitida, ...sinExpectations } = ANSWERS;
    const res = await submitProfiling({ ...sinExpectations });
    expect(res.status).toBe(400);
  });

  it("y su longitud SÍ se valida: 4 001 caracteres se rechazan", async () => {
    // Es lo que se gana pasándole las seis respuestas a `assertValidProfiling`
    // aunque sólo exija cinco: el bucle de 4 000 caracteres recorre todo lo que
    // reciba. Sin esto, la sexta pregunta sería el único campo del wizard sin
    // límite de longitud.
    await hastaElCuestionario();
    const res = await submitProfiling({
      ...ANSWERS,
      expectations: ["x".repeat(4001)],
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Each answer is limited to 4,000 characters.");
    expect(errorOf(res).details).toEqual({ field: "expectations" });
  });

  it("un campo de más lo rechaza el `.strict()` del contrato", async () => {
    await hastaElCuestionario();
    const res = await submitProfiling({ ...ANSWERS, favouriteColour: "azul" });
    expect(res.status).toBe(400);
  });

  it("nada se escribe cuando la validación falla", async () => {
    await hastaElCuestionario();
    await submitProfiling({ ...ANSWERS, ownerRole: "" });
    expect(dataOf(await get())["profiling"]).toMatchObject({ ownerRole: "" });
  });
});

/* ── POST /onboarding/complete ───────────────────────────────────────────── */

describe("POST /onboarding/complete", () => {
  it("arranca el relleno de la discovery queue — PRD:759, 1890, 2006", async () => {
    await hastaElCuestionario();
    expect((await submitProfiling({ ...ANSWERS })).status).toBe(200);

    const res = await complete();
    expect(res.status).toBe(202);
    expect(dataOf(res)["discoveryRefillQueued"]).toBe(true);

    // El job, en la cola que el worker escucha y con el workspace del que pidió.
    expect(refillJobs()).toEqual([{ companyId: api.data.a.companyId }]);
  });

  it("el `step` que devuelve es `processing`, no `ready`", async () => {
    // `markComplete` no tiene dónde escribirse —`companies` no tiene
    // repositorio de escritura—, así que devolver `ready` sería una mentira que
    // la siguiente lectura desmentiría. Este caso fija esa honestidad: si
    // alguien la "arregla" devolviendo `ready` a secas, se entera acá.
    await hastaElCuestionario();
    await submitProfiling({ ...ANSWERS });
    expect(dataOf(await complete())["step"]).toBe("processing");
    expect(dataOf(await get())["step"]).toBe("processing");
  });

  it("sin completar el cuestionario, el error dice qué falta", async () => {
    await hastaElCuestionario();
    const res = await complete();
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Please select your role");
    expect(refillJobs()).toEqual([]);
  });

  it("sin ninguna fuente, el error es el del paso 1 (ERR-B01)", async () => {
    const res = await complete();
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("Add a website or a social profile to continue");
    expect(errorOf(res).details).toMatchObject({ code: "ERR-B01" });
  });

  it("cerrar un alta ya terminada es 409, no un segundo relleno", async () => {
    await api.handle.sql`
      update companies set status = 'active' where id = ${api.data.a.companyId}
    `;
    const res = await complete();
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toBe("This onboarding is already finished.");
    expect(refillJobs()).toEqual([]);
  });

  it("el doble clic en `Continue to Dashboard` se replica, no se duplica", async () => {
    await hastaElCuestionario();
    await submitProfiling({ ...ANSWERS });
    const key = randomUUID();

    const primera = await complete({ key });
    const segunda = await complete({ key });

    expect(primera.status).toBe(202);
    expect(segunda.status).toBe(202);
    // **Igualdad semántica, no byte a byte**, y no es pereza: el replay sale de
    // `idempotency_records.response`, que es `jsonb`, y `jsonb` reordena las
    // claves (longitud, después bytes). Está medido y documentado en
    // `uncovered-routes.int.test.ts` para `POST /content/:id/regenerate`; acá
    // vuelve a pasar igual. Se comprobó: la primera respuesta abre por
    // `"sources"` y la replicada por `"details"`, con los mismos campos y los
    // mismos valores.
    expect(segunda.body).toEqual(primera.body);
    // Lo que sí tiene que ser exacto: el replay **no vuelve a encolar**. Sin
    // esto, un doble clic en `Continue to Dashboard` pide dos rellenos.
    expect(refillJobs()).toHaveLength(1);
  });

  it("sin `Idempotency-Key` no se cierra nada", async () => {
    await hastaElCuestionario();
    await submitProfiling({ ...ANSWERS });
    const res = await api.request({
      method: "POST",
      path: "/api/v1/onboarding/complete",
    });
    expect(res.status).toBe(400);
    expect(refillJobs()).toEqual([]);
  });
});

/* ── Aislamiento entre workspaces · §9.2 ─────────────────────────────────── */

describe("scope de companyId", () => {
  it("el cuestionario de un workspace no se ve desde el otro", async () => {
    await hastaElCuestionario();
    expect((await submitProfiling({ ...ANSWERS })).status).toBe(200);

    // `b` tiene credencial propia y su propio estado: mismo endpoint, otra
    // respuesta. Si la lectura perdiera el scope, `b` vería el cuestionario
    // de `a` y su paso sería `processing`.
    const desdeB = dataOf(await get(api.data.b.token));
    expect(desdeB["profiling"]).toBeNull();
    expect(desdeB["step"]).toBe("brand_source");
  });

  it("escribir el cuestionario en un workspace no toca el del otro", async () => {
    await hastaElCuestionario();
    await submitProfiling({ ...ANSWERS });

    // El perfil de `b` sigue sin existir: la escritura de `a` no lo creó ni lo
    // pisó.
    const perfilB = dataOf(
      await api.request({
        method: "GET",
        path: "/api/v1/brand/profile",
        token: api.data.b.token,
      }),
    );
    expect(perfilB["ownerRole"]).toBeUndefined();
    expect(perfilB["brandRevision"]).toBe(0);
  });

  it("el relleno se encola para el workspace que pidió, no para otro", async () => {
    // El `companyId` del payload es lo único que el worker va a mirar: si sale
    // el equivocado, el relleno le llega a otro tenant y el que pidió se queda
    // con `/home` vacío. Un fallo que ninguna consulta con scope detecta,
    // porque acá no hay consulta: hay un payload.
    await hastaElCuestionario();
    await submitProfiling({ ...ANSWERS });
    await complete();
    expect(refillJobs()).toEqual([{ companyId: api.data.a.companyId }]);
    expect(refillJobs()[0]?.companyId).not.toBe(api.data.b.companyId);
  });
});

/* ── Sin cola ────────────────────────────────────────────────────────────── */

describe("sin cola montada", () => {
  it("responde 503 y NO quema la Idempotency-Key", async () => {
    // Quemarla por una indisponibilidad de infraestructura impediría el
    // reintento, que es exactamente para lo que el header existe.
    const sinCola = await startApi({ withQueue: false });
    try {
      await sinCola.handle.sql`
        update companies set status = 'draft' where status <> 'soft_deleted'
      `;
      const key = randomUUID();
      const res = await sinCola.request({
        method: "POST",
        path: "/api/v1/onboarding/complete",
        idempotencyKey: key,
      });
      expect(res.status).toBe(503);
      expect(errorOf(res).code).toBe("service_unavailable");

      const registros = await sinCola.handle
        .sql`select count(*)::int as n from idempotency_records where key = ${key}`;
      expect(registros[0]?.["n"]).toBe(0);
    } finally {
      await sinCola.close();
    }
  });
});
