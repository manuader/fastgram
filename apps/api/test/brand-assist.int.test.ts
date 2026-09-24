/**
 * `POST /brand/sources/:id/assist` contra Postgres real — tier D asistido,
 * `P1-BRAND-014`, PRD `FR-011.4` (fila D), `FR-011.9`.
 *
 * Lo que mide:
 *  - que lo pegado llega **al payload del job** tal cual lo va a leer el worker
 *    (recortado, sin captions vacíos), con una clave distinta por pedido
 *    (trampa 45);
 *  - que no consume el cupo de re-análisis (`ERR-B11`): una fuente con el cupo
 *    agotado igual acepta el texto pegado;
 *  - los rechazos: nada pegado, textos de más, web (no social), analizando, y
 *    el 404 cruzado de §9.2.
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
  await api.handle.sql`delete from brand_sources`;
  await api.handle.sql`delete from company_profiles`;
});

async function seed(values: {
  readonly sourceType?: string;
  readonly handle?: string;
  readonly status?: string;
  readonly analysisCount?: number;
  readonly companyId?: string;
}): Promise<string> {
  const id = randomUUID();
  const type = values.sourceType ?? "instagram";
  const handle = values.handle ?? `acme${id.slice(0, 6)}`;
  const canonical =
    type === "website" ? `https://${handle}.example` : `https://instagram.com/${handle}`;
  await api.handle.sql`
    insert into brand_sources
      (id, company_id, source_type, handle, canonical_url, is_primary,
       acquisition_tier, status, failure_reason, analysis_count, last_analysed_at)
    values (${id}::uuid, ${values.companyId ?? api.data.a.companyId}::uuid, ${type},
            ${handle}, ${canonical}, true, 'D_assisted', ${values.status ?? "failed"},
            ${values.status === undefined || values.status === "failed" ? "unsupported_platform" : null},
            ${values.analysisCount ?? 0},
            ${new Date(api.clock.nowMs() - 3_600_000).toISOString()}::timestamptz)
  `;
  return id;
}

const assist = (id: string, body: unknown, token?: string) =>
  api.request({
    method: "POST",
    path: `/api/v1/brand/sources/${id}/assist`,
    ...(token === undefined ? {} : { token }),
    body,
  });

const brandJobs = () => api.queue.forQueue(JOB_QUEUES.brandSourceAnalysis);

describe("POST /brand/sources/:id/assist — P1-BRAND-014", () => {
  it("encola el análisis con lo pegado en el payload y pasa a `analyzing`", async () => {
    const id = await seed({});
    const res = await assist(id, {
      bio: "  Tazas hechas a mano en Valencia.  ",
      captions: ["Nueva tanda #ceramica", "   ", "Torno a las 6 am"],
    });

    expect(res.status).toBe(202);
    expect(dataOf(res)).toMatchObject({
      _id: id,
      status: "analyzing",
      sourceType: "instagram",
    });
    // `failureReason` se limpia: la fuente ya no está fallida.
    expect(dataOf(res)["failureReason"] ?? null).toBeNull();

    const jobs = brandJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      brandSourceId: id,
      companyId: api.data.a.companyId,
      assisted: {
        bio: "Tazas hechas a mano en Valencia.",
        captions: ["Nueva tanda #ceramica", "Torno a las 6 am"],
      },
    });
    expect(jobs[0]?.options?.singletonKey).toMatch(
      new RegExp(`^brand-source:${id}:assist:`),
    );
  });

  it("NO consume el cupo de re-análisis: con el cupo agotado, igual acepta", async () => {
    const id = await seed({ analysisCount: 3 });
    const res = await assist(id, { bio: "Mi bio" });
    expect(res.status).toBe(202);
    expect(dataOf(res)["analysisCount"]).toBe(3);
  });

  it("dos pegados en instantes distintos son dos jobs (trampa 45)", async () => {
    const id = await seed({});
    expect((await assist(id, { bio: "uno" })).status).toBe(202);
    await api.handle
      .sql`update brand_sources set status = 'ready' where id = ${id}::uuid`;
    api.clock.advanceHours(1);
    expect((await assist(id, { bio: "dos" })).status).toBe(202);
    expect(brandJobs()).toHaveLength(2);
  });

  it.each<[unknown, string]>([
    [{}, "nada pegado"],
    [{ bio: "   ", captions: ["", " "] }, "sólo espacios"],
    [{ bio: "x".repeat(4001) }, "bio de más"],
    [{ captions: Array.from({ length: 25 }, () => "c") }, "captions de más"],
    [{ bio: "ok", extra: true }, "clave desconocida"],
  ])("400 con %j (%s) y no encola", async (body) => {
    const id = await seed({});
    const res = await assist(id, body);
    expect(res.status).toBe(400);
    expect(brandJobs()).toHaveLength(0);
  });

  it("una web no es para pegar la bio: 400", async () => {
    const id = await seed({ sourceType: "website", handle: "tienda" });
    const res = await assist(id, { bio: "hola" });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("bad_request");
    expect(brandJobs()).toHaveLength(0);
  });

  it("una fuente que ya se está analizando: 409, sin encolar", async () => {
    const id = await seed({ status: "analyzing" });
    const res = await assist(id, { bio: "hola" });
    expect(res.status).toBe(409);
    expect(brandJobs()).toHaveLength(0);
  });

  it("una fuente de otro workspace es 404, igual que una inexistente", async () => {
    const ajena = await seed({ companyId: api.data.b.companyId });
    const res = await assist(ajena, { bio: "hola" });
    const inexistente = await assist(randomUUID(), { bio: "hola" });
    expect(res.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(brandJobs()).toHaveLength(0);
  });
});
