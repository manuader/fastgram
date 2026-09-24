/**
 * Marcas y modo personal — `PU-BRAND-001`, `PU-RUN-002`.
 *
 * Contra Postgres de verdad y con `SET LOCAL ROLE fastgram_app` en las rutas de
 * tenant, como el resto de la suite. Lo que se prueba y por qué importa:
 *
 *  - que el header `X-Fastgram-Workspace` scopee **rutas que no saben que
 *    existe** (`GET /content`, `GET /posts`): es la promesa de hacerlo en
 *    `auth/scope.ts` y no ruta por ruta;
 *  - que un header ajeno, inexistente, borrado o no-uuid dé el mismo 404;
 *  - que en `standard` el header se ignore y `/workspaces` no exista para el
 *    cliente;
 *  - que en `personal` las cuotas y el rate limit no corten, con el mismo
 *    escenario que en `standard` sí corta (`quota.int.test.ts`,
 *    `influencer-credits.int.test.ts`).
 *
 * El fixture siembra `a` y `b` **con el mismo dueño** (y una tercera borrada),
 * así que `b` es una marca válida para la key de `a`. El dueño ajeno se siembra
 * acá.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_STUDIO_COST, billingPeriodKey, PLANS } from "@fastgram/core";
import { companies, media, suggestions, users, withoutCompany } from "@fastgram/db";
import { FixedClock } from "@fastgram/adapters";

import { TokenBucketLimiter } from "../src/http/rate-limit.js";
import { createMemoryBucketStore } from "../src/support/bucket-store.js";
import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const HEADER = "x-fastgram-workspace";

let api: ApiHarness;
/** Una company de **otro** dueño. Existe de verdad: el 404 tiene que ser por ajena. */
let foreignCompanyId: string;
/** La company `soft_deleted` del fixture, del mismo dueño que `a`. */
let deletedCompanyId: string;

let n = 0;
const key = (label: string): string =>
  `${label}-${String((n += 1))}-${String(Date.now())}`;

const ids = (res: { body: Record<string, unknown> | undefined }): string[] =>
  (res.body?.["data"] as { _id?: string; id?: string }[]).map((r) => r._id ?? r.id ?? "");

beforeAll(async () => {
  // Rate limit REAL (no el `openLimiter` del arnés): el test de "no limita"
  // tiene que correr contra el limitador que sí limitaría en `standard`.
  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  api = await startApi({
    mode: "personal",
    limiter: new TokenBucketLimiter(createMemoryBucketStore(), clock),
  });

  foreignCompanyId = await withoutCompany(api.handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `ext-${randomUUID()}`,
        email: `otro-${randomUUID()}@example.test`,
        fullName: "Otro dueño",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    const [company] = await tx
      .insert(companies)
      .values({
        name: "ajena",
        ownerUserId: user.id,
        status: "active",
        planId: "growth",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company ajena");
    return company.id;
  });

  const [borrada] = await api.handle.sql`
    select id from companies where status = 'soft_deleted' limit 1
  `;
  deletedCompanyId = String((borrada as { id: string }).id);
}, 180_000);

afterAll(async () => {
  await api?.close();
});

describe("GET /mode", () => {
  it("dice personal", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/mode" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { mode: "personal" } });
  });
});

describe("CRUD de /workspaces", () => {
  it("lista las marcas vivas del dueño, en orden de creación, sin la borrada ni la ajena", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/workspaces" });
    expect(res.status).toBe(200);
    const list = res.body?.["data"] as { id: string; name: string }[];
    expect(list.map((w) => w.name)).toEqual(["acme", "globex"]);
    expect(list.map((w) => w.id)).toEqual([api.data.a.companyId, api.data.b.companyId]);
    expect(list.map((w) => w.id)).not.toContain(foreignCompanyId);
    expect(list.map((w) => w.id)).not.toContain(deletedCompanyId);
    // Las del fixture no tienen fila en `company_profiles`: se ven como `pending`.
    expect(list[0]).toMatchObject({ profileStatus: "pending" });
    expect(typeof (list[0] as Record<string, unknown>)["createdAt"]).toBe("string");
  });

  it("crea una marca: 201, plan pro, activa, perfil pending y membresía owner", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "  Nueva marca  " },
      idempotencyKey: key("crear"),
    });
    expect(res.status).toBe(201);
    const ws = dataOf(res);
    expect(ws["name"]).toBe("Nueva marca");
    expect(ws["profileStatus"]).toBe("pending");
    expect(new Date(String(ws["createdAt"])).toISOString()).toBe(ws["createdAt"]);

    const [fila] = await api.handle.sql`
      select c.plan_id, c.status, c.subscription_status, c.owner_user_id,
             (select owner_user_id from companies where id = ${api.data.a.companyId}::uuid) as owner_a,
             (select role from workspace_memberships where company_id = c.id) as role,
             (select status from company_profiles where company_id = c.id) as profile
      from companies c where c.id = ${String(ws["id"])}::uuid
    `;
    expect(fila).toMatchObject({
      plan_id: "pro",
      status: "active",
      subscription_status: "active",
      role: "owner",
      profile: "pending",
    });
    const f = fila as { owner_user_id: string; owner_a: string };
    expect(f.owner_user_id).toBe(f.owner_a);

    const list = await api.request({ method: "GET", path: "/api/v1/workspaces" });
    expect((list.body?.["data"] as { id: string }[]).map((w) => w.id)).toContain(
      ws["id"],
    );
  });

  it("crea la marca en la zona horaria que manda la web; sin ella, hereda la de la key", async () => {
    const conZona = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "Con zona", timezone: "America/Argentina/Buenos_Aires" },
      idempotencyKey: key("tz-con"),
    });
    const sinZona = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "Sin zona" },
      idempotencyKey: key("tz-sin"),
    });
    expect([conZona.status, sinZona.status]).toEqual([201, 201]);
    const zonas = await api.handle.sql`
      select id::text, timezone from companies
       where id in (${String(dataOf(conZona)["id"])}::uuid, ${String(dataOf(sinZona)["id"])}::uuid,
                    ${api.data.a.companyId}::uuid)`;
    const tz = (id: unknown) =>
      (zonas as unknown as { id: string; timezone: string }[]).find((z) => z.id === id)
        ?.timezone;
    expect(tz(dataOf(conZona)["id"])).toBe("America/Argentina/Buenos_Aires");
    expect(tz(dataOf(sinZona)["id"])).toBe(tz(api.data.a.companyId));
  });

  it("una zona horaria que Intl no conoce → 400 y no crea nada", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "Zona rara", timezone: "Mars/Olympus_Mons" },
      idempotencyKey: key("tz-mala"),
    });
    expect(res.status).toBe(400);
    const [fila] = await api.handle
      .sql`select count(*)::int as n from companies where name = 'Zona rara'`;
    expect((fila as { n: number }).n).toBe(0);
  });

  it("POST sin Idempotency-Key → 400", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "sin key" },
    });
    expect(res.status).toBe(400);
  });

  it("POST con nombre vacío (tras recortar) o de más de 80 → 400", async () => {
    for (const name of ["   ", "x".repeat(81)]) {
      const res = await api.request({
        method: "POST",
        path: "/api/v1/workspaces",
        body: { name },
        idempotencyKey: key("invalido"),
      });
      expect(res.status, name).toBe(400);
    }
  });

  it("el replay de idempotencia no crea dos marcas", async () => {
    const k = key("replay");
    const primera = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "Replay" },
      idempotencyKey: k,
    });
    const segunda = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "Replay" },
      idempotencyKey: k,
    });
    expect(dataOf(segunda)["id"]).toBe(dataOf(primera)["id"]);
    const [c] = await api.handle
      .sql`select count(*)::int as n from companies where name = 'Replay'`;
    expect((c as { n: number }).n).toBe(1);
  });

  it("renombra", async () => {
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/workspaces/${api.data.b.companyId}`,
      body: { name: "Globex renombrada" },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      id: api.data.b.companyId,
      name: "Globex renombrada",
    });
  });

  it("PATCH/DELETE de una ajena, inexistente, borrada o no-uuid → 404", async () => {
    for (const id of [
      foreignCompanyId,
      api.data.unknownId,
      deletedCompanyId,
      "no-es-uuid",
    ]) {
      const patch = await api.request({
        method: "PATCH",
        path: `/api/v1/workspaces/${id}`,
        body: { name: "x" },
      });
      expect(patch.status, `PATCH ${id}`).toBe(404);
      expect(errorOf(patch).code).toBe("not_found");

      const del = await api.request({
        method: "DELETE",
        path: `/api/v1/workspaces/${id}`,
      });
      expect(del.status, `DELETE ${id}`).toBe(404);
    }
    // Y la ajena no se tocó.
    const [f] = await api.handle
      .sql`select name, status from companies where id = ${foreignCompanyId}::uuid`;
    expect(f).toMatchObject({ name: "ajena", status: "active" });
  });

  it("borrar la marca de la key → 409 (dejaría la app sin credencial)", async () => {
    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/workspaces/${api.data.a.companyId}`,
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("conflict");
  });

  it("borra (soft delete) y después la última → 409", async () => {
    const list = await api.request({ method: "GET", path: "/api/v1/workspaces" });
    const others = (list.body?.["data"] as { id: string }[])
      .map((w) => w.id)
      .filter((id) => id !== api.data.a.companyId);
    expect(others.length).toBeGreaterThan(0);

    for (const id of others) {
      const res = await api.request({
        method: "DELETE",
        path: `/api/v1/workspaces/${id}`,
      });
      expect(res.status, id).toBe(204);
      expect(res.body).toBeUndefined();
      const [f] = await api.handle
        .sql`select status from companies where id = ${id}::uuid`;
      expect((f as { status: string }).status).toBe("soft_deleted");
    }

    const after = await api.request({ method: "GET", path: "/api/v1/workspaces" });
    expect((after.body?.["data"] as { id: string }[]).map((w) => w.id)).toEqual([
      api.data.a.companyId,
    ]);

    const last = await api.request({
      method: "DELETE",
      path: `/api/v1/workspaces/${api.data.a.companyId}`,
    });
    expect(last.status).toBe(409);
    expect(errorOf(last).code).toBe("conflict");
    expect(errorOf(last).message).toMatch(/only brand/);

    // La marca borrada ya no sirve como header.
    const viaHeader = await api.request({
      method: "GET",
      path: "/api/v1/content",
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(viaHeader.status).toBe(404);

    // Y se revive `b` para los tests de scoping de abajo.
    await api.handle
      .sql`update companies set status = 'active' where id = ${api.data.b.companyId}::uuid`;
  });
});

describe("X-Fastgram-Workspace scopea rutas que no saben que existe", () => {
  it("GET /content con el header de b devuelve lo de b y nada de a", async () => {
    const sin = await api.request({ method: "GET", path: "/api/v1/content" });
    expect(sin.status).toBe(200);
    expect(ids(sin)).toContain(api.data.a.contentId);
    expect(ids(sin)).not.toContain(api.data.b.contentId);

    const con = await api.request({
      method: "GET",
      path: "/api/v1/content",
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(con.status).toBe(200);
    expect(ids(con)).toContain(api.data.b.contentId);
    expect(ids(con)).not.toContain(api.data.a.contentId);
  });

  it("un recurso de a por id, con el header de b → 404 (el scope es el de b de verdad)", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(res.status).toBe(404);
  });

  it("las escrituras también van a la marca del header", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "creada desde b" },
      idempotencyKey: key("desde-b"),
      headers: { [HEADER]: api.data.b.companyId },
    });
    // Crear una marca es del dueño, no de la marca: la ve la key de `a` igual.
    expect(res.status).toBe(201);
    const list = await api.request({ method: "GET", path: "/api/v1/workspaces" });
    expect((list.body?.["data"] as { name: string }[]).map((w) => w.name)).toContain(
      "creada desde b",
    );
  });

  it("header igual a la marca de la key, o vacío → sin cambio", async () => {
    for (const value of [api.data.a.companyId, api.data.a.companyId.toUpperCase(), ""]) {
      const res = await api.request({
        method: "GET",
        path: "/api/v1/content",
        headers: { [HEADER]: value },
      });
      expect(res.status, JSON.stringify(value)).toBe(200);
      expect(ids(res)).toContain(api.data.a.contentId);
    }
  });

  it("header de otro dueño, inexistente, borrada o no-uuid → 404 not_found", async () => {
    for (const value of [
      foreignCompanyId,
      api.data.unknownId,
      deletedCompanyId,
      "no-es-uuid",
      "'; drop table companies; --",
    ]) {
      const res = await api.request({
        method: "GET",
        path: "/api/v1/content",
        headers: { [HEADER]: value },
      });
      expect(res.status, value).toBe(404);
      expect(errorOf(res).code).toBe("not_found");
    }
  });

  it("sin credencial, el header no cambia nada: 401", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/content",
      token: null,
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(res.status).toBe(401);
  });
});

describe("modo personal: sin cuotas ni rate limit", () => {
  const periodo = (): string => billingPeriodKey(new Date(api.clock.nowMs()), 1);

  const WALL_OF_TEXT = {
    canvas: { width: 1080, height: 1920 },
    video: {
      url: "https://cdn.example.test/a.mp4",
      drawX: 0,
      drawY: 0,
      drawW: 1080,
      drawH: 1920,
    },
    text: {
      content: "Sin cuota",
      x: 50,
      y: 50,
      width: 800,
      fontSize: 48,
      color: "#FFFFFF",
      textAlign: "center",
    },
  };

  it("POST /content con los saves agotados → 201 (en standard sería 429)", async () => {
    const tope = PLANS.growth.contentSaves ?? 0;
    await api.handle.sql`
      insert into quota_ledgers (company_id, period, content_saves_used, content_saves_purchased, overage_units)
      values (${api.data.a.companyId}::uuid, ${periodo()}, ${tope}, 0, 0)
      on conflict (company_id, period)
        do update set content_saves_used = ${tope}, content_saves_purchased = 0, overage_units = 0
    `;
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key("sin-cuota"),
    });
    expect(res.status).toBe(201);
    // Se sigue guardando bucket y período: el reembolso del worker los necesita.
    const [f] = await api.handle.sql`
      select save_bucket, save_period from contents where id = ${String(dataOf(res)["_id"])}::uuid
    `;
    expect(f).toMatchObject({ save_bucket: "included", save_period: periodo() });
  });

  it("POST /influencers sin créditos → 201 (en standard sería 402), y el cargo se cuenta", async () => {
    const cupo = PLANS.growth.aiStudioCredits;
    await api.handle.sql`
      insert into quota_ledgers (company_id, period, ai_credits)
      values (${api.data.a.companyId}::uuid, ${periodo()}, ${cupo})
      on conflict (company_id, period) do update set ai_credits = ${cupo}
    `;
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers",
      body: { name: "Ella", gender: "woman", age: 27, ethnicity: "latina" },
      idempotencyKey: key("sin-creditos"),
    });
    expect(res.status).toBe(201);
    const [f] = await api.handle.sql`
      select ai_credits from quota_ledgers
      where company_id = ${api.data.a.companyId}::uuid and period = ${periodo()}
    `;
    expect((f as { ai_credits: number }).ai_credits).toBe(
      cupo + AI_STUDIO_COST.influencer,
    );
  });

  it("POST /blitz con saves agotados y plan Free+trialing → 202 (en standard: 429 / 503)", async () => {
    // Los dos cortes de Blitz de una vez: el 503 del trial allowance de Free
    // (`blitz-accept.int.test.ts`) y el 429 de saves. En `unlimited` el ledger se
    // evalúa como `pro`, así que no sale ninguno de los dos.
    const companyId = api.data.a.companyId;
    await api.handle.sql`
      update companies set plan_id = 'free', subscription_status = 'trialing'
      where id = ${companyId}::uuid
    `;
    await api.handle.sql`
      insert into company_profiles (company_id, status, core_identity)
      values (${companyId}::uuid, 'ready', 'pymes')
      on conflict (company_id) do update set status = 'ready'
    `;
    // Con Drizzle y no con SQL crudo: `drizzle()` cambia los parsers del cliente
    // que comparte (trampa 18) y un `sql.json` crudo revienta.
    const mediaId = randomUUID();
    const url = `https://bucket.test/media/${companyId}/${mediaId}.mp4`;
    await withoutCompany(api.handle.db, async (tx) => {
      await tx.insert(media).values({
        mediaId,
        companyId,
        mediaType: "video",
        filename: `${mediaId}.mp4`,
        r2Url: url,
        storageKey: `media/${companyId}/${mediaId}.mp4`,
        status: "ready",
        sizeMb: 1,
        categories: ["background-video"],
        origin: "manual_upload",
      });
      await tx.insert(suggestions).values({
        companyId,
        contentType: "wall-of-text",
        generatedText: "copy",
        aiExplanation: "porque sí",
        buildPlan: {
          version: 1,
          media: { format: "wall-of-text", video: { mediaId, url } },
          texts: ["copy"],
        },
      });
    });
    await api.handle.sql`
      update quota_ledgers set content_saves_used = 100000 where company_id = ${companyId}::uuid
    `;

    const res = await api.request({ method: "POST", path: "/api/v1/blitz", body: {} });
    expect(res.status, res.raw).toBe(202);
  });

  it("más de 60 requests por minuto con el limitador real → ningún 429", async () => {
    // `restPerWorkspace` es 60/min y el `FixedClock` no rellena el bucket: en
    // `standard` el request 61 es 429 seguro. Ningún GET cobra rate limit, así
    // que se usa un PATCH que cobra en el `preHandler` y después da 404 sin
    // escribir nada (una fuente que no existe).
    const statuses: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      const res = await api.request({
        method: "PATCH",
        path: `/api/v1/brand/sources/${api.data.unknownId}`,
        body: { isPrimary: true },
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([404]));
  });
});

describe("modo standard (default)", () => {
  let std: ApiHarness;

  beforeAll(async () => {
    // Sin `mode`: lo mismo que `main.ts` sin `FASTGRAM_MODE`.
    std = await startApi();
  }, 180_000);

  afterAll(async () => {
    await std?.close();
  });

  it("GET /mode dice standard", async () => {
    const res = await std.request({ method: "GET", path: "/api/v1/mode" });
    expect(res.body).toEqual({ data: { mode: "standard" } });
  });

  it("el header se ignora: con el de b, GET /content sigue siendo de a", async () => {
    const res = await std.request({
      method: "GET",
      path: "/api/v1/content",
      headers: { [HEADER]: std.data.b.companyId },
    });
    expect(res.status).toBe(200);
    expect(ids(res)).toContain(std.data.a.contentId);
    expect(ids(res)).not.toContain(std.data.b.contentId);
  });

  it("ni siquiera se valida: un header basura no da 404", async () => {
    const res = await std.request({
      method: "GET",
      path: "/api/v1/content",
      headers: { [HEADER]: "no-es-uuid" },
    });
    expect(res.status).toBe(200);
  });

  it("/workspaces no existe para el cliente: 404 en las cuatro operaciones", async () => {
    const list = await std.request({ method: "GET", path: "/api/v1/workspaces" });
    const create = await std.request({
      method: "POST",
      path: "/api/v1/workspaces",
      body: { name: "no" },
      idempotencyKey: key("std"),
    });
    const patch = await std.request({
      method: "PATCH",
      path: `/api/v1/workspaces/${std.data.b.companyId}`,
      body: { name: "no" },
    });
    const del = await std.request({
      method: "DELETE",
      path: `/api/v1/workspaces/${std.data.b.companyId}`,
    });
    expect([list.status, create.status, patch.status, del.status]).toEqual([
      404, 404, 404, 404,
    ]);
    const [c] = await std.handle
      .sql`select count(*)::int as n from companies where name = 'no'`;
    expect((c as { n: number }).n).toBe(0);
  });
});
