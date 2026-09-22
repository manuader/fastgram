/**
 * Brand Sources contra Postgres real — EXT-001, PRD §9.14.
 *
 * ## Los dos casos que justifican el archivo
 *
 * **1. La unicidad es GLOBAL.** `brand_sources_type_handle_uq` es
 * `UNIQUE (source_type, handle)` sin `company_id`, así que el alta de una
 * fuente que **otro** workspace ya tiene choca. Y RLS hace que ese choque sea
 * invisible para cualquier `SELECT` con scope: lo único que lo detecta es la
 * violación del índice. Eso **no se puede probar con un doble**: un repositorio
 * falso no tiene índice, y un test que sólo mire el camino feliz nunca ve la
 * rama que traduce el `23505`. Hace falta Postgres, con las dos filas, en dos
 * workspaces distintos.
 *
 * **2. La respuesta no puede distinguir los dos choques.** El test no compara
 * "los dos dan 409": compara **el cuerpo entero, byte a byte**, entre chocar
 * con una fuente propia y chocar con la de otro workspace. Es el mismo criterio
 * que `tenant-isolation.int.test.ts` aplica al 404 de §9.2, y por la misma
 * razón: si se distinguieran, el alta sería un buscador de clientes de FastGram.
 *
 * ## Por qué usa `startApi()` (que trunca) y no siembra lo suyo
 *
 * Porque necesita **dos workspaces con credenciales**, que es exactamente lo
 * que `helpers/fixtures.ts` construye. Sembrar el segundo a mano sería copiar
 * el fixture entero para tener lo mismo.
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
  // Cada caso arranca sin fuentes: la unicidad es global y un residuo de otro
  // caso choca con un `409` que no tiene nada que ver con lo que se mide.
  await api.handle.sql`delete from brand_sources`;
  await api.handle.sql`delete from company_profiles`;
  await api.handle.sql`delete from idempotency_records`;
});

/** Alta por la API. Devuelve la respuesta cruda para poder mirar el status. */
async function create(
  body: Record<string, unknown>,
  options: { readonly token?: string; readonly key?: string } = {},
): ReturnType<ApiHarness["request"]> {
  return api.request({
    method: "POST",
    path: "/api/v1/brand/sources",
    ...(options.token === undefined ? {} : { token: options.token }),
    idempotencyKey: options.key ?? randomUUID(),
    body,
  });
}

const resolve = (input: string): ReturnType<ApiHarness["request"]> =>
  api.request({ method: "POST", path: "/api/v1/brand/sources/resolve", body: { input } });

const brandJobs = (): readonly unknown[] =>
  api.queue.forQueue(JOB_QUEUES.brandSourceAnalysis);

/* ── POST /brand/sources/resolve ─────────────────────────────────────────── */

describe("POST /brand/sources/resolve", () => {
  it("resuelve un perfil de Instagram y dice que está libre", async () => {
    const res = await resolve("https://instagram.com/acme?igshid=abc&utm_source=x");
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual({
      sourceType: "instagram",
      handle: "acme",
      // Los parámetros de tracking se fueron: es lo que hace que la misma
      // cuenta pegada desde dos sitios produzca una sola `canonicalUrl`.
      canonicalUrl: "https://instagram.com/acme",
      displayName: null,
      avatarUrl: null,
      available: true,
    });
  });

  it("twitter.com y x.com son la misma fuente `x` (FR-011.1)", async () => {
    const viaTwitter = dataOf(await resolve("https://twitter.com/acme"));
    const viaX = dataOf(await resolve("https://x.com/acme"));
    expect(viaTwitter).toEqual(viaX);
    expect(viaX["sourceType"]).toBe("x");
  });

  it("un enlace a un post de TikTok avisa que se analiza el perfil entero (ERR-B12)", async () => {
    const body = dataOf(await resolve("https://tiktok.com/@acme/video/123"));
    expect(body["handle"]).toBe("acme");
    expect(body["resolvedFromPost"]).toBe(true);
  });

  it.each([
    ["http://localhost/x", "Localhost URLs are not allowed"],
    ["http://10.0.0.1/", "Private IP addresses are not allowed"],
    ["http://169.254.169.254/", "Private IP addresses are not allowed"],
    // La IP en forma decimal es 127.0.0.1, y el mensaje que sale **no** es el
    // de "Blocked URL for security reasons" que `assertHostAllowed` reserva
    // para los hosts enteros: `new URL()` ya normaliza `2130706433` a
    // `127.0.0.1` antes de que la comprobación lo vea, así que entra por la
    // rama de IP privada. Queda igualmente bloqueado, que es lo que importa —
    // pero significa que la rama `/^\d+$/` de `core` es inalcanzable a través
    // de `detectBrandSource` y sólo la ejercita su test unitario, que la llama
    // directo. Está en el reporte.
    ["http://2130706433/", "Private IP addresses are not allowed"],
  ])("la protección SSRF de core llega hasta la ruta: %s", async (input, message) => {
    const res = await resolve(input);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toEqual({ code: "bad_request", message });
  });

  it("un @handle sin plataforma es una pregunta, no un error de formato (ERR-B03)", async () => {
    const res = await resolve("@acme");
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe("bad_request");
    expect(error.details).toMatchObject({
      code: "ERR-B03",
      handle: "acme",
      candidates: ["instagram", "tiktok", "x", "youtube", "linkedin"],
      // El fixture crea una conexión de TikTok por workspace, así que el
      // desambiguador arranca con ella elegida (FR-011.12, criterio 3).
      preselected: "tiktok",
    });
  });

  it("lo que no se reconoce devuelve el copy literal de ERR-B02", async () => {
    // Una ruta reservada de Instagram: el host se reconoce, el primer segmento
    // no es un handle. `instagram.com/p/<code>` NO sirve para este caso — es un
    // post, y eso es `needs_lookup` (el caso de abajo), no "no se reconoce".
    const res = await resolve("https://instagram.com/explore");
    expect(res.status).toBe(400);
    expect(errorOf(res)).toEqual({
      code: "bad_request",
      message:
        "We couldn't tell what this is. Paste a website URL or a social profile link.",
      details: { code: "ERR-B02" },
    });
  });

  it("un post de Instagram no lleva el handle del autor: 503, no un handle inventado", async () => {
    const res = await resolve("https://instagram.com/p/Cabc123/");
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe("service_unavailable");
  });

  it("`available` es false cuando la fuente ya está en ESTE workspace", async () => {
    expect((await create({ sourceType: "instagram", handle: "acme" })).status).toBe(202);
    expect(dataOf(await resolve("https://instagram.com/acme"))["available"]).toBe(false);
  });
});

/* ── POST /brand/sources ─────────────────────────────────────────────────── */

describe("POST /brand/sources", () => {
  it("crea en `pending`, la marca primaria y encola el análisis", async () => {
    const res = await create({ sourceType: "instagram", handle: "acme" });
    expect(res.status).toBe(202);

    const body = dataOf(res);
    expect(body["status"]).toBe("pending");
    expect(body["isPrimary"]).toBe(true);
    expect(body["handle"]).toBe("acme");
    expect(body["canonicalUrl"]).toBe("https://instagram.com/acme");
    expect(body["analysisCount"]).toBe(0);

    // Sin esto el 202 miente: la fuente quedaría en `pending` para siempre.
    expect(brandJobs()).toHaveLength(1);

    const rows = await api.handle.sql`
      select status, is_primary, acquisition_tier from brand_sources
      where company_id = ${api.data.a.companyId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["status"]).toBe("pending");
    // El fixture no tiene conexión de Instagram, así que el plan de FR-011.4
    // arranca por B. Con una conexión activa arrancaría por A.
    expect(rows[0]?.["acquisition_tier"]).toBe("B_public_api");
  });

  it("con una conexión OAuth activa el plan de FR-011.4 arranca por el tier A", async () => {
    // El fixture crea una `Connection` de TikTok por workspace. `acquisitionPlan`
    // pone `A_oauth` delante **sólo** cuando la credencial ya existe: usarla no
    // le pide nada al usuario, y ése es el matiz de `D-01` que hace que A no vaya
    // primero siempre. Sin este caso, la rama `hasConnection` de `initialTier`
    // no la ejercita nadie.
    expect((await create({ sourceType: "tiktok", handle: "acme" })).status).toBe(202);
    const [row] = await api.handle.sql`
      select acquisition_tier from brand_sources
      where company_id = ${api.data.a.companyId}::uuid
    `;
    expect(row?.["acquisition_tier"]).toBe("A_oauth");
  });

  it("un handle de LinkedIn conserva el prefijo del tipo de página", async () => {
    const body = dataOf(await create({ sourceType: "linkedin", handle: "company/acme" }));
    expect(body["handle"]).toBe("company/acme");
    expect(body["canonicalUrl"]).toBe("https://linkedin.com/company/acme");
  });

  it("la rama web de FR-010 sigue funcionando: `sourceType: website` fija el tipo", async () => {
    // Sin la pista, un host desconocido es `other_url` (frase normativa de
    // FR-011.1); con el chip `Website` es `website`. La diferencia no es
    // cosmética: la precedencia de fusión de FR-011.6 pone `website` primero y
    // `other_url` penúltimo.
    const conPista = dataOf(await create({ sourceType: "website", handle: "acme.test" }));
    expect(conPista["sourceType"]).toBe("website");
    expect(conPista["handle"]).toBe("acme.test");

    const sinPista = dataOf(
      await create({ sourceType: "other_url", canonicalUrl: "https://otra.test/p" }),
    );
    expect(sinPista["sourceType"]).toBe("other_url");
  });

  it("el cap de 5 por workspace se aplica en la sexta (ERR-B10)", async () => {
    for (const handle of ["uno", "dos", "tres", "cuatro", "cinco"]) {
      expect((await create({ sourceType: "instagram", handle })).status).toBe(202);
    }
    const res = await create({ sourceType: "instagram", handle: "seis" });
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toBe("You can analyse up to 5 sources per workspace.");
    expect(errorOf(res).details).toMatchObject({ code: "ERR-B10", cap: 5 });

    // El cap no se limita a responder 400: la sexta fila no existe.
    const [count] = await api.handle.sql`
      select count(*)::int as n from brand_sources
      where company_id = ${api.data.a.companyId}::uuid
    `;
    expect(count?.["n"]).toBe(5);
  });

  it("`manual` no se da de alta por acá", async () => {
    const res = await create({ sourceType: "manual", handle: "loquesea" });
    expect(res.status).toBe(400);
  });

  it("la Idempotency-Key repetida devuelve la respuesta original, no una segunda fuente", async () => {
    const key = randomUUID();
    const body = { sourceType: "instagram", handle: "acme" };
    const first = await create(body, { key });
    const second = await create(body, { key });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    // Se compara el cuerpo **parseado** y no los bytes, y la diferencia es un
    // hallazgo: la respuesta original se guarda en `idempotency_records` como
    // `jsonb`, y Postgres **reordena las claves** de un `jsonb` (por longitud y
    // después bytewise). O sea que ningún replay de esta API es byte a byte
    // idéntico al original. Semánticamente da igual —JSON no ordena—, pero un
    // cliente que firmara o comparara el cuerpo crudo vería dos respuestas
    // distintas para la misma key. Está en el reporte.
    expect(second.body).toEqual(first.body);

    const [count] = await api.handle.sql`
      select count(*)::int as n from brand_sources
      where company_id = ${api.data.a.companyId}::uuid
    `;
    expect(count?.["n"]).toBe(1);
    expect(brandJobs()).toHaveLength(1);
  });
});

/* ── La unicidad global, que es el caso difícil ──────────────────────────── */

describe("unicidad global de (sourceType, handle) · DATA-031", () => {
  it("el choque con OTRO workspace es indistinguible del choque consigo mismo", async () => {
    // `b` se queda con `@shared`. Desde `a`, esa fila es invisible: RLS la
    // esconde y ningún `SELECT` con scope puede verla.
    expect(
      (
        await create(
          { sourceType: "instagram", handle: "shared" },
          { token: api.data.b.token },
        )
      ).status,
    ).toBe(202);

    const cruzado = await create({ sourceType: "instagram", handle: "shared" });

    // Y ahora el choque propio, con otra fuente cualquiera del mismo `a`.
    expect((await create({ sourceType: "instagram", handle: "propia" })).status).toBe(
      202,
    );
    const propio = await create({ sourceType: "instagram", handle: "propia" });

    expect(cruzado.status).toBe(409);
    expect(propio.status).toBe(409);
    // **El cuerpo entero, no campos sueltos.** Acá se rompería un mensaje bien
    // intencionado que dijera "ya está en otro workspace".
    expect(cruzado.raw).toBe(propio.raw);
    expect(errorOf(cruzado)).toEqual({
      code: "conflict",
      message: "This profile is already registered.",
      details: { code: "ERR-B06", reason: "already_registered" },
    });
  });

  it("con el workspace en el cap, re-añadir una fuente propia dice 409, no 'te pasaste de 5'", async () => {
    // El caso que separa el pre-chequeo del índice. Sin el pre-chequeo, el cap
    // se evalúa primero y la respuesta sería `ERR-B10`: un consejo falso —
    // borrar otra fuente no deja añadir una que ya está—. Este caso es lo único
    // que distingue las dos implementaciones: sin él, quitar el pre-chequeo deja
    // la suite entera en verde.
    for (const handle of ["uno", "dos", "tres", "cuatro", "cinco"]) {
      expect((await create({ sourceType: "instagram", handle })).status).toBe(202);
    }
    const res = await create({ sourceType: "instagram", handle: "tres" });
    expect(res.status).toBe(409);
    expect(errorOf(res).details).toMatchObject({ code: "ERR-B06" });
  });

  it("el 409 cruzado no deja fila ni job: el rechazo es total", async () => {
    await create({ sourceType: "tiktok", handle: "shared" }, { token: api.data.b.token });
    api.queue.reset();

    expect((await create({ sourceType: "tiktok", handle: "shared" })).status).toBe(409);

    const [count] = await api.handle.sql`
      select count(*)::int as n from brand_sources
      where company_id = ${api.data.a.companyId}::uuid
    `;
    expect(count?.["n"]).toBe(0);
    expect(brandJobs()).toHaveLength(0);
  });

  it("dos workspaces SÍ pueden tener el mismo handle en plataformas distintas", async () => {
    await create(
      { sourceType: "instagram", handle: "acme" },
      { token: api.data.b.token },
    );
    expect((await create({ sourceType: "tiktok", handle: "acme" })).status).toBe(202);
  });
});

/* ── Lectura y aislamiento ───────────────────────────────────────────────── */

describe("GET /brand/sources", () => {
  it("devuelve el envelope paginado de §9.3, no un array suelto", async () => {
    await create({ sourceType: "instagram", handle: "acme" });
    const res = await api.request({ method: "GET", path: "/api/v1/brand/sources" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body ?? {}).sort()).toEqual(["data", "pagination"]);
    expect(res.body?.["pagination"]).toEqual({ cursor: null, hasMore: false });
  });

  it("no ve las fuentes de otro workspace", async () => {
    await create({ sourceType: "instagram", handle: "deb" }, { token: api.data.b.token });
    const res = await api.request({ method: "GET", path: "/api/v1/brand/sources" });
    expect(res.body?.["data"]).toEqual([]);
  });
});

describe("GET /brand/sources/:id · §9.2", () => {
  it("el id de B con la key de A da exactamente el mismo 404 que un id inventado", async () => {
    const created = dataOf(
      await create(
        { sourceType: "instagram", handle: "deb" },
        { token: api.data.b.token },
      ),
    );
    const foreignId = created["_id"] as string;

    const cruzado = await api.request({
      method: "GET",
      path: `/api/v1/brand/sources/${foreignId}`,
    });
    const inexistente = await api.request({
      method: "GET",
      path: `/api/v1/brand/sources/${api.data.unknownId}`,
    });

    expect(cruzado.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(cruzado.raw).toBe(inexistente.raw);
  });

  it("A sí ve lo suyo (el test anterior no pasa por devolver 404 siempre)", async () => {
    const id = dataOf(await create({ sourceType: "instagram", handle: "acme" }))["_id"];
    const res = await api.request({
      method: "GET",
      path: `/api/v1/brand/sources/${String(id)}`,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["handle"]).toBe("acme");
  });
});

/* ── Primaria ────────────────────────────────────────────────────────────── */

describe("PATCH /brand/sources/:id · FR-011.6", () => {
  it("promover una degrada la anterior en la misma transacción", async () => {
    const primera = dataOf(await create({ sourceType: "instagram", handle: "uno" }));
    const segunda = dataOf(await create({ sourceType: "tiktok", handle: "dos" }));
    expect(primera["isPrimary"]).toBe(true);
    expect(segunda["isPrimary"]).toBe(false);

    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/brand/sources/${String(segunda["_id"])}`,
      body: { isPrimary: true },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["isPrimary"]).toBe(true);

    // `brand_sources_primary_uq` exige exactamente una: si la degradación no
    // ocurriera antes del alta, esto sería un 23505 y un 500.
    const [count] = await api.handle.sql`
      select count(*)::int as n from brand_sources
      where company_id = ${api.data.a.companyId}::uuid and is_primary
    `;
    expect(count?.["n"]).toBe(1);
  });

  it("`isPrimary: false` se rechaza: se promueve otra, no se degrada ésta", async () => {
    const source = dataOf(await create({ sourceType: "instagram", handle: "uno" }));
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/brand/sources/${String(source["_id"])}`,
      body: { isPrimary: false },
    });
    expect(res.status).toBe(400);
  });

  it("un id ajeno da 404, no 403", async () => {
    const ajena = dataOf(
      await create(
        { sourceType: "instagram", handle: "deb" },
        { token: api.data.b.token },
      ),
    );
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/brand/sources/${String(ajena["_id"])}`,
      body: { isPrimary: true },
    });
    expect(res.status).toBe(404);
  });
});

/* ── Borrado ─────────────────────────────────────────────────────────────── */

describe("DELETE /brand/sources/:id", () => {
  it("borrar la primaria promueve la más antigua de las que quedan", async () => {
    const primera = dataOf(await create({ sourceType: "instagram", handle: "uno" }));
    const segunda = dataOf(await create({ sourceType: "tiktok", handle: "dos" }));

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/brand/sources/${String(primera["_id"])}`,
    });
    expect(res.status).toBe(204);

    const rows = await api.handle.sql`
      select id, is_primary from brand_sources
      where company_id = ${api.data.a.companyId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["id"]).toBe(segunda["_id"]);
    expect(rows[0]?.["is_primary"]).toBe(true);
  });

  it("la única fuente NO se borra cuando el perfil ya se materializó (PRD:2373)", async () => {
    const source = dataOf(await create({ sourceType: "instagram", handle: "uno" }));
    await api.handle.sql`
      insert into company_profiles (company_id, status, core_identity)
      values (${api.data.a.companyId}::uuid, 'ready', 'una marca')
    `;

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/brand/sources/${String(source["_id"])}`,
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("conflict");
  });

  it("la única fuente SÍ se borra mientras el perfil sigue en `pending`", async () => {
    // Si no, un workspace que se equivocó de handle en el alta quedaría
    // atrapado: no puede borrar la mala y no puede añadir la buena si el cap
    // fuera 1. El PRD dice "y el perfil quedaría sin origen", que es la segunda
    // mitad de la condición.
    const source = dataOf(await create({ sourceType: "instagram", handle: "uno" }));
    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/brand/sources/${String(source["_id"])}`,
    });
    expect(res.status).toBe(204);
  });

  it("borrar libera el handle para el resto del mundo (la unicidad es global)", async () => {
    const source = dataOf(await create({ sourceType: "instagram", handle: "acme" }));
    await api.request({
      method: "DELETE",
      path: `/api/v1/brand/sources/${String(source["_id"])}`,
    });
    expect(
      (
        await create(
          { sourceType: "instagram", handle: "acme" },
          { token: api.data.b.token },
        )
      ).status,
    ).toBe(202);
  });

  it("un id ajeno da 404 y no borra nada", async () => {
    const ajena = dataOf(
      await create(
        { sourceType: "instagram", handle: "deb" },
        { token: api.data.b.token },
      ),
    );
    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/brand/sources/${String(ajena["_id"])}`,
    });
    expect(res.status).toBe(404);
    const [count] = await api.handle.sql`
      select count(*)::int as n from brand_sources
      where company_id = ${api.data.b.companyId}::uuid
    `;
    expect(count?.["n"]).toBe(1);
  });
});

/* ── Re-análisis ─────────────────────────────────────────────────────────── */

describe("POST /brand/sources/:id/reanalyse", () => {
  /**
   * Siembra una fuente con el contador y la fecha que el caso necesita.
   *
   * Se inserta a mano porque el alta por la API deja siempre `analysisCount: 0`
   * y `lastAnalysedAt: null`, y el cooldown de `ERR-B11` sólo se puede ejercer
   * con una ventana ya empezada. Las fechas se anclan al `FixedClock` del arnés
   * para que el caso no dependa del reloj de la máquina.
   */
  async function seedSource(values: {
    readonly analysisCount: number;
    readonly lastAnalysedAtMs: number | null;
    readonly status?: string;
  }): Promise<string> {
    const id = randomUUID();
    const last =
      values.lastAnalysedAtMs === null
        ? null
        : new Date(values.lastAnalysedAtMs).toISOString();
    await api.handle.sql`
      insert into brand_sources
        (id, company_id, source_type, handle, canonical_url, is_primary,
         acquisition_tier, status, analysis_count, last_analysed_at)
      values (${id}::uuid, ${api.data.a.companyId}::uuid, 'instagram', 'acme',
              'https://instagram.com/acme', true, 'B_public_api',
              ${values.status ?? "ready"}, ${values.analysisCount},
              ${last}::timestamptz)
    `;
    return id;
  }

  it("encola el análisis, sube el contador y pasa a `analyzing`", async () => {
    const id = await seedSource({
      analysisCount: 1,
      lastAnalysedAtMs: api.clock.nowMs() - 3_600_000,
    });

    const res = await api.request({
      method: "POST",
      path: `/api/v1/brand/sources/${id}/reanalyse`,
    });
    expect(res.status).toBe(202);
    expect(dataOf(res)["status"]).toBe("analyzing");
    expect(dataOf(res)["analysisCount"]).toBe(2);
    expect(brandJobs()).toHaveLength(1);
  });

  it("el cuarto re-análisis del día se rechaza con 429 y Retry-After (ERR-B11)", async () => {
    const id = await seedSource({
      analysisCount: 3,
      lastAnalysedAtMs: api.clock.nowMs() - 3_600_000,
    });

    const res = await api.request({
      method: "POST",
      path: `/api/v1/brand/sources/${id}/reanalyse`,
    });
    expect(res.status).toBe(429);
    expect(errorOf(res).code).toBe("rate_limited");
    expect(errorOf(res).details).toMatchObject({ code: "ERR-B11" });
    expect(res.headers["retry-after"]).toBeDefined();
    // Y no encoló nada: un 429 que igual encola no limita nada.
    expect(brandJobs()).toHaveLength(0);
  });

  it("una fuente que ya se está analizando no se re-encola", async () => {
    const id = await seedSource({
      analysisCount: 1,
      lastAnalysedAtMs: api.clock.nowMs() - 3_600_000,
      status: "analyzing",
    });
    const res = await api.request({
      method: "POST",
      path: `/api/v1/brand/sources/${id}/reanalyse`,
    });
    expect(res.status).toBe(409);
    expect(brandJobs()).toHaveLength(0);
  });

  it("un id ajeno da 404", async () => {
    const ajena = dataOf(
      await create(
        { sourceType: "instagram", handle: "deb" },
        { token: api.data.b.token },
      ),
    );
    const res = await api.request({
      method: "POST",
      path: `/api/v1/brand/sources/${String(ajena["_id"])}/reanalyse`,
    });
    expect(res.status).toBe(404);
  });
});

/* ── Perfil ──────────────────────────────────────────────────────────────── */

describe("GET/PATCH /brand/profile · DATA-004, FR-011.6", () => {
  it("un workspace sin perfil devuelve el perfil vacío, no un 404", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/brand/profile" });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      coreIdentity: "",
      status: "pending",
      brandRevision: 0,
      fieldMeta: {},
    });
  });

  it("una edición manual marca editedByUser y sube brandRevision", async () => {
    const res = await api.request({
      method: "PATCH",
      path: "/api/v1/brand/profile",
      body: { productOffering: "Cursos de cerámica" },
    });
    expect(res.status).toBe(200);
    const body = dataOf(res);
    expect(body["productOffering"]).toBe("Cursos de cerámica");
    expect(body["brandRevision"]).toBe(1);
    // FR-011.6: la síntesis siguiente no puede pisar esto. La marca es lo único
    // que se lo dice.
    expect(body["fieldMeta"]).toEqual({
      productOffering: {
        confidence: "high",
        sourceId: null,
        excerptRef: null,
        editedByUser: true,
      },
    });
  });

  it("no marca los campos del cuestionario, que ninguna síntesis escribe", async () => {
    const body = dataOf(
      await api.request({
        method: "PATCH",
        path: "/api/v1/brand/profile",
        body: { teamSize: "2-10", coreIdentity: "Taller de barrio" },
      }),
    );
    expect(Object.keys(body["fieldMeta"] as Record<string, unknown>)).toEqual([
      "coreIdentity",
    ]);
    expect(body["teamSize"]).toBe("2-10");
  });

  it("dos ediciones seguidas conservan la marca anterior y suben la revisión", async () => {
    await api.request({
      method: "PATCH",
      path: "/api/v1/brand/profile",
      body: { productOffering: "Uno" },
    });
    const body = dataOf(
      await api.request({
        method: "PATCH",
        path: "/api/v1/brand/profile",
        body: { toneOfVoice: "Cercano" },
      }),
    );
    expect(body["brandRevision"]).toBe(2);
    expect(Object.keys(body["fieldMeta"] as Record<string, unknown>).sort()).toEqual([
      "productOffering",
      "toneOfVoice",
    ]);
  });

  it("el perfil que se lee es el del workspace de la credencial", async () => {
    await api.request({
      method: "PATCH",
      path: "/api/v1/brand/profile",
      body: { coreIdentity: "de A" },
    });
    const deB = dataOf(
      await api.request({
        method: "GET",
        path: "/api/v1/brand/profile",
        token: api.data.b.token,
      }),
    );
    expect(deB["coreIdentity"]).toBe("");
    expect(deB["brandRevision"]).toBe(0);
  });
});
