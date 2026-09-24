/**
 * Inteligencia de marca (sprint 7, agente D) contra Postgres real:
 *
 *  - `POST /blitz/angles/generate` con el modelo `text` del registro
 *    (`P2-ANGLE-005`) y la semilla desde lo que mejor rindió (`P1-BRAND-023`);
 *  - `PATCH /brand/profile` con `expectedBrandRevision` → 409 (`P1-BRANDPG-004`);
 *  - propuestas del re-análisis, aceptar y descartar (`P1-BRANDPG-005`);
 *  - logo (`P1-ONB-003`), OCR de capturas con el modelo `vision`
 *    (`P1-BRAND-014`), y links a posts sin 503 (`P1-BRAND-005`);
 *  - `DELETE /models/{task}` sólo para overrides de juicio (`P1-JUDGE-004`).
 *
 * El registro de modelos apunta a un `FASTGRAM_HOME` temporal y a un servidor
 * OpenAI falso **real** (HTTP en loopback): así se atraviesa el adaptador de
 * verdad, no un doble del puerto. Nunca toca `~/.fastgram` del dueño.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
let home: string;
let server: Server;
let baseUrl: string;
const previousHome = process.env["FASTGRAM_HOME"];
const previousVision = process.env["VISION_SERVICE_URL"];

/** Lo que el servidor falso contesta y lo que recibió. */
let nextContent: string = "{}";
let lastBody: Record<string, unknown> | null = null;

async function writeRegistry(tasks: Record<string, unknown>): Promise<void> {
  await writeFile(join(home, "models.json"), JSON.stringify({ version: 1, tasks }), {
    mode: 0o600,
  });
}

const llmEntry = () => ({
  provider: "custom",
  baseUrl: `${baseUrl}/v1`,
  model: "fake-model",
  contextWindowTokens: 32_000,
});

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fg-brand-intel-"));
  process.env["FASTGRAM_HOME"] = home;
  delete process.env["VISION_SERVICE_URL"];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fake-model",
          choices: [{ message: { content: nextContent }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("sin puerto");
  baseUrl = `http://127.0.0.1:${address.port}`;
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousHome;
  if (previousVision !== undefined) process.env["VISION_SERVICE_URL"] = previousVision;
});

beforeEach(async () => {
  lastBody = null;
  await writeRegistry({ text: llmEntry(), vision: llmEntry() });
  await api.handle.sql`delete from brand_sources`;
  await api.handle.sql`delete from company_profiles`;
  await api.handle.sql`delete from content_angles`;
});

const companyId = () => api.data.a.companyId;

async function seedSourceWithSnapshot(options: {
  readonly derivedFields: Record<string, unknown>;
  readonly contentItems?: unknown[];
}): Promise<{ sourceId: string; snapshotId: string }> {
  const sourceId = randomUUID();
  const snapshotId = randomUUID();
  await api.handle.sql`
    insert into brand_sources
      (id, company_id, source_type, handle, canonical_url, is_primary,
       acquisition_tier, status, analysis_count)
    values (${sourceId}::uuid, ${companyId()}::uuid, 'website', ${`acme-${sourceId.slice(0, 6)}.example`},
            ${`https://acme-${sourceId.slice(0, 6)}.example`}, true, 'C_page_fetch', 'ready', 1)
  `;
  await api.handle.sql`
    insert into brand_source_snapshots
      (id, brand_source_id, company_id, tier, content_items, derived_fields)
    values (${snapshotId}::uuid, ${sourceId}::uuid, ${companyId()}::uuid, 'C_page_fetch',
            ${JSON.stringify(options.contentItems ?? [])}::jsonb,
            ${JSON.stringify(options.derivedFields)}::jsonb)
  `;
  return { sourceId, snapshotId };
}

async function seedProfile(values: {
  readonly productOffering?: string;
  readonly brandRevision?: number;
  readonly fieldMeta?: Record<string, unknown>;
}): Promise<void> {
  await api.handle.sql`
    insert into company_profiles (company_id, product_offering, brand_revision, status, field_meta)
    values (${companyId()}::uuid, ${values.productOffering ?? null}, ${values.brandRevision ?? 3},
            'ready', ${JSON.stringify(values.fieldMeta ?? {})}::jsonb)
  `;
}

describe("POST /blitz/angles/generate — P2-ANGLE-005 / P1-BRAND-023", () => {
  it("genera con el modelo `text` del registro y siembra desde lo que mejor rindió", async () => {
    await seedProfile({ productOffering: "Handmade mugs", brandRevision: 7 });
    await seedSourceWithSnapshot({
      derivedFields: {},
      contentItems: [
        {
          externalId: "1",
          caption: "Glaze fail compilation",
          engagement: { likes: 900 },
        },
        { externalId: "2", caption: "Quiet post", engagement: { likes: 1 } },
      ],
    });
    nextContent = JSON.stringify({
      title: "Kiln disasters",
      description: "Show what goes wrong in the kiln and how we fix it.",
      targetAudience: "Ceramics hobbyists",
    });

    const res = await api.request({
      method: "POST",
      path: "/api/v1/blitz/angles/generate",
      body: {},
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual({
      title: "Kiln disasters",
      description: "Show what goes wrong in the kiln and how we fix it.",
      targetAudience: "Ceramics hobbyists",
      brandRevision: 7,
    });
    const sent = JSON.stringify(lastBody);
    expect(sent).toContain("Glaze fail compilation");
    expect(sent).toContain("Handmade mugs");
    // No se persiste (AI-005).
    const rows = await api.handle.sql`select count(*)::int as n from content_angles`;
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("sin modelo `text`: 503 que dice dónde configurarlo", async () => {
    await writeRegistry({});
    const res = await api.request({
      method: "POST",
      path: "/api/v1/blitz/angles/generate",
      body: {},
    });
    // Si el entorno tiene `LLM_*`, el registro vacío cae a ellas: no se puede
    // afirmar el 503 en esa máquina.
    if (process.env["LLM_BASE_URL"] === undefined) {
      expect(res.status).toBe(503);
      expect(errorOf(res).message).toContain("Settings → Models");
    }
  });

  it("una respuesta inutilizable es 503, no un ángulo vacío", async () => {
    nextContent = JSON.stringify({ title: "", description: "", targetAudience: "" });
    const res = await api.request({
      method: "POST",
      path: "/api/v1/blitz/angles/generate",
      body: {},
    });
    expect(res.status).toBe(503);
  });
});

describe("PATCH /brand/profile — expectedBrandRevision (P1-BRANDPG-004)", () => {
  it("409 si el perfil se movió; 200 si coincide", async () => {
    await seedProfile({ productOffering: "A", brandRevision: 5 });
    const stale = await api.request({
      method: "PATCH",
      path: "/api/v1/brand/profile",
      body: { productOffering: "B", expectedBrandRevision: 4 },
    });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).details).toMatchObject({ reason: "brand_revision_changed" });

    const ok = await api.request({
      method: "PATCH",
      path: "/api/v1/brand/profile",
      body: { productOffering: "B", expectedBrandRevision: 5 },
    });
    expect(ok.status).toBe(200);
    expect(dataOf(ok)).toMatchObject({ productOffering: "B", brandRevision: 6 });
  });

  it("sólo con expectedBrandRevision es un body vacío: 400", async () => {
    const res = await api.request({
      method: "PATCH",
      path: "/api/v1/brand/profile",
      body: { expectedBrandRevision: 1 },
    });
    expect(res.status).toBe(400);
  });
});

describe("propuestas del re-análisis — P1-BRANDPG-005 / ERR-B14", () => {
  async function setup(): Promise<{ sourceId: string; snapshotId: string }> {
    const seeded = await seedSourceWithSnapshot({
      derivedFields: {
        productOffering: {
          value: "Handmade mugs",
          excerpt: "we sell handmade mugs",
          confidence: "high",
          confidenceSource: "verifier",
        },
      },
    });
    await seedProfile({
      productOffering: "My words",
      brandRevision: 2,
      fieldMeta: {
        productOffering: {
          confidence: "high",
          sourceId: null,
          excerptRef: null,
          editedByUser: true,
        },
      },
    });
    return seeded;
  }

  it("lista la propuesta y aceptarla escribe el valor con su procedencia", async () => {
    const { sourceId, snapshotId } = await setup();
    const list = await api.request({
      method: "GET",
      path: "/api/v1/brand/profile/proposals",
    });
    expect(list.status).toBe(200);
    expect(dataOf(list)).toEqual({
      brandRevision: 2,
      proposals: [
        {
          field: "productOffering",
          value: "Handmade mugs",
          currentValue: "My words",
          confidence: "high",
          sourceId,
          sourceType: "website",
          excerpt: "we sell handmade mugs",
          excerptRef: `${snapshotId}#productOffering`,
          reason: "edited_by_user",
        },
      ],
    });

    const accepted = await api.request({
      method: "POST",
      path: "/api/v1/brand/profile/proposals/productOffering",
      body: {
        action: "accept",
        excerptRef: `${snapshotId}#productOffering`,
        expectedBrandRevision: 2,
      },
    });
    expect(accepted.status).toBe(200);
    const profile = dataOf(accepted) as Record<string, unknown>;
    expect(profile["productOffering"]).toBe("Handmade mugs");
    expect(profile["brandRevision"]).toBe(3);
    expect((profile["fieldMeta"] as Record<string, unknown>)["productOffering"]).toEqual({
      confidence: "high",
      sourceId,
      excerptRef: `${snapshotId}#productOffering`,
      editedByUser: false,
    });
    const after = await api.request({
      method: "GET",
      path: "/api/v1/brand/profile/proposals",
    });
    expect((dataOf(after) as { proposals: unknown[] }).proposals).toEqual([]);
  });

  it("descartarla conserva el valor, no mueve la revisión y no vuelve", async () => {
    const { snapshotId } = await setup();
    const res = await api.request({
      method: "POST",
      path: "/api/v1/brand/profile/proposals/productOffering",
      body: {
        action: "dismiss",
        excerptRef: `${snapshotId}#productOffering`,
        expectedBrandRevision: 2,
      },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({ productOffering: "My words", brandRevision: 2 });
    const after = await api.request({
      method: "GET",
      path: "/api/v1/brand/profile/proposals",
    });
    expect((dataOf(after) as { proposals: unknown[] }).proposals).toEqual([]);
  });

  it("409 con revisión vieja o propuesta que cambió; 404 con un campo inventado", async () => {
    const { snapshotId } = await setup();
    const stale = await api.request({
      method: "POST",
      path: "/api/v1/brand/profile/proposals/productOffering",
      body: {
        action: "accept",
        excerptRef: `${snapshotId}#productOffering`,
        expectedBrandRevision: 1,
      },
    });
    expect(stale.status).toBe(409);
    const changed = await api.request({
      method: "POST",
      path: "/api/v1/brand/profile/proposals/productOffering",
      body: {
        action: "accept",
        excerptRef: "otro#productOffering",
        expectedBrandRevision: 2,
      },
    });
    expect(changed.status).toBe(409);
    expect(errorOf(changed).details).toMatchObject({ reason: "proposal_changed" });
    const bogus = await api.request({
      method: "POST",
      path: "/api/v1/brand/profile/proposals/nope",
      body: { action: "accept", excerptRef: "x", expectedBrandRevision: 2 },
    });
    expect(bogus.status).toBe(404);
  });

  it("otra marca no ve las propuestas de ésta", async () => {
    await setup();
    const res = await api.request({
      method: "GET",
      path: "/api/v1/brand/profile/proposals",
      token: api.data.b.token,
    });
    expect(res.status).toBe(200);
    expect((dataOf(res) as { proposals: unknown[] }).proposals).toEqual([]);
  });
});

/** Un PNG de 1×1 válido. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("logo — P1-ONB-003", () => {
  afterAll(async () => {
    await api.request({ method: "DELETE", path: "/api/v1/brand/logo" });
  });

  it("guarda un PNG y lo devuelve; borra; rechaza lo que no es la imagen declarada", async () => {
    const dataUrl = `data:image/png;base64,${PNG_1X1}`;
    const put = await api.request({
      method: "PUT",
      path: "/api/v1/brand/logo",
      body: { dataUrl },
    });
    expect(put.status).toBe(200);
    expect(dataOf(put)).toEqual({ logoUrl: dataUrl });
    const got = await api.request({ method: "GET", path: "/api/v1/brand/logo" });
    expect(dataOf(got)).toEqual({ logoUrl: dataUrl });

    const lying = await api.request({
      method: "PUT",
      path: "/api/v1/brand/logo",
      body: { dataUrl: `data:image/jpeg;base64,${PNG_1X1}` },
    });
    expect(lying.status).toBe(400);

    const del = await api.request({ method: "DELETE", path: "/api/v1/brand/logo" });
    expect(dataOf(del)).toEqual({ logoUrl: null });
  });
});

describe("POST /brand/ocr — P1-BRAND-014", () => {
  it("sin servicio de visión, lee la captura con el modelo `vision` del registro", async () => {
    nextContent = JSON.stringify({
      emotion: "none",
      situation: "screenshot",
      people: 0,
      tags: [],
      on_screen_text: [
        "acme.ceramics",
        "Handmade mugs from Rosario",
        "Handmade mugs from Rosario",
      ],
    });
    const res = await api.request({
      method: "POST",
      path: "/api/v1/brand/ocr",
      body: { contentType: "image/png", data: PNG_1X1 },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual({
      text: "acme.ceramics\nHandmade mugs from Rosario",
      engine: "vision_model",
    });
  });

  it("sin OCR ni modelo de visión: 503 que ofrece pegar el texto", async () => {
    await writeRegistry({ text: llmEntry() });
    const res = await api.request({
      method: "POST",
      path: "/api/v1/brand/ocr",
      body: { contentType: "image/png", data: PNG_1X1 },
    });
    expect(res.status).toBe(503);
  });

  it("400 si los bytes no son la imagen declarada", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/brand/ocr",
      body: { contentType: "image/jpeg", data: PNG_1X1 },
    });
    expect(res.status).toBe(400);
  });
});

describe("links a posts — P1-BRAND-005", () => {
  it("LinkedIn /posts/…: resuelve al autor con el aviso de ERR-B12", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/brand/sources/resolve",
      body: {
        input: "https://www.linkedin.com/posts/acme-inc_we-launched-activity-7123-AbCd/",
      },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      sourceType: "linkedin",
      handle: "company/acme-inc",
      resolvedFromPost: true,
    });
  });

  it("Instagram /p/…: 400 con el aviso de tier D, ya no 503", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/brand/sources/resolve",
      body: { input: "https://www.instagram.com/p/ABC123/" },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({
      reason: "post_author_unknown",
      sourceType: "instagram",
    });
  });
});

describe("DELETE /models/{task} — P1-JUDGE-004", () => {
  it("borra un override de juicio y vuelve a heredar; las tareas base no se borran", async () => {
    await writeRegistry({ text: llmEntry(), "judgment.brand": llmEntry() });
    const del = await api.request({
      method: "DELETE",
      path: "/api/v1/models/judgment.brand",
    });
    expect(del.status).toBe(200);
    expect(dataOf(del)).toMatchObject({ task: "judgment.brand", inheritsFrom: "text" });
    const base = await api.request({ method: "DELETE", path: "/api/v1/models/text" });
    expect(base.status).toBe(404);
  });
});
