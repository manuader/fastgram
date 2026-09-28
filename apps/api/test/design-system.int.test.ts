/**
 * Sprint 9 (M) — `/design-system` (`PU-S9-001…004`).
 *
 * El worker no corre acá: el import lo cierra el test escribiendo la fila como
 * la dejaría el worker (tokens de `parseDesignSystem` de `core`, fuentes en el
 * storage). Lo que se mide es la API: reservas con su prefijo, la fila
 * `importing` + el job en la cola `design-system`, el scope por marca (cruce →
 * 404), las ediciones (paleta, licencia), los bytes de la fuente, generar,
 * aprobar/descartar, derivar y borrar.
 */
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES, parseDesignSystem, type DesignSystemEntry } from "@fastgram/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));

beforeAll(async () => {
  api = await startApi({ storage });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

const CSS = `:root {
  --ink: #0A0A0B; --paper: #F6F6F4; --magenta: #FF00FF;
  --surface-dark: var(--ink); --surface-light: var(--paper);
  --text-on-dark: #FFFFFF; --accent-1: var(--magenta);
  --font-display: 'Source Serif 4', serif; --font-body: 'Rotis Semi Sans', sans-serif;
}
@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600');
@font-face { font-family: 'Rotis Semi Sans'; src: url('../assets/fonts/r-700.otf'); font-weight: 700; }`;

function tokensLikeWorker() {
  const entries: DesignSystemEntry[] = [
    {
      path: "readme.md",
      kind: "text",
      bytes: 10,
      sha256: "r",
      text: '# FOCUS\n\nTagline: "Hola"',
    },
    { path: "tokens/t.css", kind: "text", bytes: CSS.length, sha256: "c", text: CSS },
    { path: "assets/fonts/r-700.otf", kind: "font", bytes: 5, sha256: "f" },
  ];
  const out = parseDesignSystem(entries);
  if (!out.ok) throw new Error(out.detail);
  return out.ds.tokens;
}

async function reserveZip(token?: string) {
  return api.request({
    method: "POST",
    path: "/api/v1/design-system/upload-url",
    body: {
      filename: "FOCUS Design System.zip",
      contentType: "application/zip",
      sizeBytes: 43_483_684,
    },
    ...(token === undefined ? {} : { token }),
  });
}

async function keyOf(uploadId: string): Promise<string> {
  const rows = await api.handle.sql`
    select storage_key from upload_reservations where upload_id = ${uploadId}::uuid
  `;
  return String(rows[0]?.["storage_key"]);
}

/** Reserva + PUT + import. Devuelve el recurso `importing`. */
async function importZip(): Promise<Record<string, unknown>> {
  const reserved = await reserveZip();
  expect(reserved.status).toBe(200);
  const uploadId = String(dataOf(reserved)["uploadId"]);
  await storage.put({
    key: await keyOf(uploadId),
    body: new Uint8Array(64),
    contentType: "application/zip",
  });
  const res = await api.request({
    method: "POST",
    path: "/api/v1/design-system/import",
    body: { uploadId },
  });
  expect(res.status).toBe(202);
  return dataOf(res);
}

/** Lo que haría el worker al terminar bien. */
async function finishLikeWorker(id: string) {
  const companyId = api.data.a.companyId;
  const fontKey = `fonts/${companyId}/${id}/rotis-semi-sans-700.otf`;
  await storage.put({
    key: fontKey,
    body: new TextEncoder().encode("OTTO-font"),
    contentType: "font/otf",
  });
  const fonts = [
    {
      fileRef: "rotis-semi-sans-700",
      familyId: "rotis-semi-sans",
      weight: 700,
      style: "normal",
      storageKey: fontKey,
      url: `http://storage.test/${fontKey}`,
      contentType: "font/otf",
      bytes: 9,
    },
  ];
  await api.handle.sql`
    update brand_design_systems
       set status = 'ready', active = true,
           tokens = ${JSON.stringify(tokensLikeWorker())}::jsonb,
           fonts = ${JSON.stringify(fonts)}::jsonb,
           style = ${JSON.stringify({ voice: "Short lines.", values: [], tagline: "Hola", compositionRules: [], dos: [], donts: [], language: "es-AR", origin: "heuristic" })}::jsonb
     where id = ${id}::uuid
  `;
}

describe("subida e import", () => {
  it("la reserva cae bajo design-systems/{companyId}/uploads; zip de más de 100 MB o no-zip → 400", async () => {
    const res = await reserveZip();
    expect(res.status).toBe(200);
    expect(
      (await keyOf(String(dataOf(res)["uploadId"]))).startsWith(
        `design-systems/${api.data.a.companyId}/uploads/`,
      ),
    ).toBe(true);
    for (const body of [
      {
        filename: "a.zip",
        contentType: "application/zip",
        sizeBytes: 100 * 1024 * 1024 + 1,
      },
      { filename: "a.pdf", contentType: "application/zip", sizeBytes: 10 },
      { filename: "a.zip", contentType: "image/png", sizeBytes: 10 },
    ]) {
      const bad = await api.request({
        method: "POST",
        path: "/api/v1/design-system/upload-url",
        body,
      });
      expect(bad.status).toBe(400);
    }
  });

  it("import: 202, fila importing e inactiva, y el job en la cola design-system", async () => {
    api.queue.enqueued.length = 0;
    const ds = await importZip();
    expect(ds).toMatchObject({
      status: "importing",
      active: false,
      source: "zip",
      name: "FOCUS Design System",
    });
    const jobs = api.queue.forQueue(JOB_QUEUES.designSystem);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      kind: "import",
      companyId: api.data.a.companyId,
      designSystemId: ds["id"],
    });
    // Mientras importa, no hay activo: `latest` lo muestra.
    const state = dataOf(
      await api.request({ method: "GET", path: "/api/v1/design-system" }),
    );
    expect(state["active"]).toBeNull();
    expect((state["latest"] as Record<string, unknown>)["status"]).toBe("importing");
  });

  it("una reserva de otro prefijo (Media Bank) no se importa: 404", async () => {
    const media = await api.request({
      method: "POST",
      path: "/api/v1/media/upload-url",
      body: { filename: "a.png", contentType: "image/png", sizeBytes: 10 },
    });
    expect(media.status).toBe(200);
    const uploadId = String(dataOf(media)["uploadId"]);
    await storage.put({
      key: await keyOf(uploadId),
      body: new Uint8Array(10),
      contentType: "image/png",
    });
    const res = await api.request({
      method: "POST",
      path: "/api/v1/design-system/import",
      body: { uploadId },
    });
    expect(res.status).toBe(404);
  });
});

describe("design system listo", () => {
  let id: string;

  beforeAll(async () => {
    id = String((await importZip())["id"]);
    await finishLikeWorker(id);
  });

  it("GET: paleta, roles, licencia pendiente y defaults de texto con el reemplazo", async () => {
    const state = dataOf(
      await api.request({ method: "GET", path: "/api/v1/design-system" }),
    );
    const ds = state["active"] as Record<string, unknown>;
    expect(ds["id"]).toBe(id);
    expect((ds["semantic"] as Record<string, unknown>)["surfaceDark"]).toBe("#0A0A0B");
    const rotis = (ds["families"] as Record<string, unknown>[]).find(
      (f) => f["id"] === "rotis-semi-sans",
    );
    expect(rotis).toMatchObject({
      license: "needs_confirmation",
      usable: false,
      fallback: "inter",
      fallbackName: "Inter",
    });
    expect((rotis?.["faces"] as Record<string, unknown>[])[0]?.["fileRef"]).toBe(
      "rotis-semi-sans-700",
    );
    expect(ds["textDefaults"]).toMatchObject({
      title: { kind: "registered", family: "playfair", mappedFrom: "Source Serif 4" },
      body: { kind: "registered", family: "inter", reason: "license_not_confirmed" },
      color: "#FFFFFF",
      backgroundColor: "#0A0A0B",
    });
  });

  it("otra marca no lo ve ni lo toca: 404", async () => {
    const b = api.data.b.token;
    const state = dataOf(
      await api.request({ method: "GET", path: "/api/v1/design-system", token: b }),
    );
    expect(state["active"]).toBeNull();
    for (const req of [
      {
        method: "PATCH" as const,
        path: `/api/v1/design-system/${id}`,
        body: { name: "x" },
      },
      {
        method: "GET" as const,
        path: `/api/v1/design-system/${id}/font-files/rotis-semi-sans-700`,
      },
      { method: "DELETE" as const, path: `/api/v1/design-system/${id}` },
      {
        method: "POST" as const,
        path: `/api/v1/design-system/${id}/generate`,
        body: { localImages: 1 },
      },
    ]) {
      const res = await api.request({ ...req, token: b });
      expect(res.status).toBe(404);
    }
    expect(
      (
        await api.request({
          method: "GET",
          path: "/api/v1/design-system/nope/font-files/x",
        })
      ).status,
    ).toBe(404);
  });

  it("PATCH: tildar la licencia cambia el cuerpo a la fuente de la marca; paleta de 1 color → 400", async () => {
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/design-system/${id}`,
      body: { fontLicenses: { "rotis-semi-sans": true } },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["textDefaults"]).toMatchObject({
      body: {
        kind: "brand",
        family: "rotis-semi-sans",
        displayName: "Rotis Semi Sans",
        weight: 700,
      },
    });
    const bad = await api.request({
      method: "PATCH",
      path: `/api/v1/design-system/${id}`,
      body: { palette: [{ hex: "#000000" }, { hex: "#000000" }] },
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).code).toBe("bad_request");
    const ok = await api.request({
      method: "PATCH",
      path: `/api/v1/design-system/${id}`,
      body: {
        palette: [{ name: "--surface-dark", hex: "#111111" }, { hex: "#00FF33" }],
        style: {
          voice: "Vos, corto.",
          values: ["Libertad"],
          tagline: null,
          compositionRules: [],
          dos: [],
          donts: ["No emoji"],
          language: "es-AR",
        },
      },
    });
    expect(ok.status).toBe(200);
    expect((dataOf(ok)["semantic"] as Record<string, unknown>)["surfaceDark"]).toBe(
      "#111111",
    );
    expect(dataOf(ok)["style"]).toMatchObject({ voice: "Vos, corto.", origin: "owner" });
  });

  it("font-files: los bytes como data URL; un fileRef que no está → 404", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/design-system/${id}/font-files/rotis-semi-sans-700`,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["dataUrl"]).toBe(
      `data:font/otf;base64,${Buffer.from("OTTO-font").toString("base64")}`,
    );
    expect(
      (
        await api.request({
          method: "GET",
          path: `/api/v1/design-system/${id}/font-files/../../x`,
        })
      ).status,
    ).toBe(404);
  });

  it("generate: 202 y el job; sin modelo image, las de modelo no se piden", async () => {
    api.queue.enqueued.length = 0;
    const res = await api.request({
      method: "POST",
      path: `/api/v1/design-system/${id}/generate`,
      body: { localImages: 2, modelImages: 2 },
    });
    expect(res.status).toBe(202);
    expect(dataOf(res)).toMatchObject({
      localImages: 2,
      modelImages: 0,
      imageModelConfigured: false,
    });
    expect(api.queue.forQueue(JOB_QUEUES.designSystem)[0]?.payload).toMatchObject({
      kind: "generate",
      designSystemId: id,
      localImages: 2,
      modelImages: 0,
    });
    const soloModelo = await api.request({
      method: "POST",
      path: `/api/v1/design-system/${id}/generate`,
      body: { localImages: 0, modelImages: 1 },
    });
    expect(soloModelo.status).toBe(400);
  });

  it("aprobar un pendiente lo suma al Media Bank con el tag; descartar lo saca", async () => {
    const companyId = api.data.a.companyId;
    const key = (n: number) =>
      `media/${companyId}/design-system/${id}/generated/r/${String(n)}.jpg`;
    await storage.put({
      key: key(1),
      body: new Uint8Array(20),
      contentType: "image/jpeg",
    });
    await storage.put({
      key: key(2),
      body: new Uint8Array(20),
      contentType: "image/jpeg",
    });
    const pending = [1, 2].map((n) => ({
      id: `p-${String(n)}`,
      requestId: "r",
      storageKey: key(n),
      url: `http://storage.test/${key(n)}`,
      generator: "local",
      contentType: "image/jpeg",
      sizeBytes: 20,
      createdAt: 1,
    }));
    await api.handle
      .sql`update brand_design_systems set pending_assets = ${JSON.stringify(pending)}::jsonb where id = ${id}::uuid`;

    const ok = await api.request({
      method: "POST",
      path: `/api/v1/design-system/${id}/pending/p-1/approve`,
    });
    expect(ok.status).toBe(200);
    const mediaId = String(dataOf(ok)["mediaId"]);
    const rows = await api.handle
      .sql`select tags, categories, origin::text from media where media_id = ${mediaId}::uuid`;
    expect(rows[0]).toMatchObject({
      tags: ["design-system", "generated", "local"],
      categories: ["slideshow-image", "green-screen-background"],
      origin: "brand_kit",
    });
    expect(
      (
        await api.request({
          method: "DELETE",
          path: `/api/v1/design-system/${id}/pending/p-2`,
        })
      ).status,
    ).toBe(204);
    expect(await storage.head(key(2))).toBeNull();
    const ds = dataOf(
      await api.request({ method: "GET", path: "/api/v1/design-system" }),
    )["active"] as Record<string, unknown>;
    expect(ds["pendingAssets"]).toEqual([]);
    expect((ds["assets"] as Record<string, unknown>[]).map((a) => a["kind"])).toEqual([
      "generated",
    ]);
    // Aprobar dos veces: el pendiente ya no está.
    expect(
      (
        await api.request({
          method: "POST",
          path: `/api/v1/design-system/${id}/pending/p-1/approve`,
        })
      ).status,
    ).toBe(404);
  });
});

describe("derivar y borrar", () => {
  it("derive: 201, derivado, activo, con Montserrat/Inter; borrar lo saca", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/design-system/derive",
      token: api.data.b.token,
    });
    expect(res.status).toBe(201);
    const ds = dataOf(res);
    expect(ds).toMatchObject({ source: "derived", status: "ready", active: true });
    expect(ds["textDefaults"]).toMatchObject({
      title: { family: "montserrat" },
      body: { family: "inter" },
    });
    expect((ds["palette"] as unknown[]).length).toBeGreaterThanOrEqual(2);
    const del = await api.request({
      method: "DELETE",
      path: `/api/v1/design-system/${String(ds["id"])}`,
      token: api.data.b.token,
    });
    expect(del.status).toBe(204);
    const state = dataOf(
      await api.request({
        method: "GET",
        path: "/api/v1/design-system",
        token: api.data.b.token,
      }),
    );
    expect(state["active"]).toBeNull();
  });
});
