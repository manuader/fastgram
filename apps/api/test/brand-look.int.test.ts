/**
 * Sprint 9 (S), `PU-S9-003` — la marca en las piezas clásicas, del lado de la API.
 *
 *  - `PATCH /content/:id` con `brand:<id>`: válida si la familia existe en el
 *    design system activo y tiene licencia; si no, `400` con
 *    `reason: "brand_font_unavailable"` y **nada escrito**.
 *  - `POST /content` con `fontFamily: "brand:<id>"` en el texto: misma regla.
 *  - El logo de la pieza: `GET /editable` dice cuál rige y si hay logo; el
 *    `PATCH` lo prende/saca en `studioState.logo` sin tocar el payload.
 *  - `GET|PUT /design-system/:id/logo-layer`: la preferencia de la marca.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

const TOKENS = (licensed: boolean, logoLayer?: unknown) => ({
  colors: [
    { name: "--ink", hex: "#0A0A0B", aliasOf: null },
    { name: "--paper", hex: "#F6F6F4", aliasOf: null },
  ],
  semantic: {
    surfaceDark: "#0A0A0B",
    surfaceLight: "#F6F6F4",
    textOnDark: "#FFFFFF",
    textOnLight: "#0A0A0B",
    accents: [],
  },
  families: [
    {
      name: "Rotis Semi Sans",
      id: "rotis-semi-sans",
      origin: "file",
      category: "sans",
      license: "needs_confirmation",
      licenseConfirmed: licensed,
      faces: [{ weight: 700, style: "normal", file: "fonts/r-700.otf" }],
      weights: [700],
      fallback: "inter",
    },
  ],
  roles: [
    {
      role: "display",
      stack: ["Rotis Semi Sans", "sans-serif"],
      familyId: "rotis-semi-sans",
    },
  ],
  spacing: [],
  ...(logoLayer === undefined ? {} : { logoLayer }),
});

/** Un design system activo como lo deja el worker, con un logo en el Media Bank. */
async function activeDesignSystem(
  companyId: string,
  opts: { licensed: boolean; withLogo: boolean },
): Promise<string> {
  await api.handle
    .sql`delete from brand_design_systems where company_id = ${companyId}::uuid`;
  const id = randomUUID();
  const assets: unknown[] = [];
  if (opts.withLogo) {
    const mediaId = randomUUID();
    await api.handle.sql`
      insert into media (media_id, company_id, media_type, filename, r2_url, storage_key, size_mb, status, tags, origin)
      values (${mediaId}::uuid, ${companyId}::uuid, 'image', 'logo.png',
              ${`http://storage.test/media/${companyId}/design-system/${id}/logo/a.png`},
              ${`media/${companyId}/design-system/${id}/logo/a.png`}, 0.01, 'ready',
              ${["logo", "design-system"]}::text[], 'brand_kit')
    `;
    assets.push({
      mediaId,
      kind: "logo",
      path: "assets/logo/a.png",
      filename: "logo.png",
    });
  }
  await api.handle.sql`
    insert into brand_design_systems (id, company_id, status, source, active, version, name, tokens, assets)
    values (${id}::uuid, ${companyId}::uuid, 'ready', 'zip', true, 1, 'FOCUS',
            ${JSON.stringify(TOKENS(opts.licensed))}::jsonb, ${JSON.stringify(assets)}::jsonb)
  `;
  return id;
}

const WALL = {
  canvas: { width: 1080, height: 1920 },
  video: {
    url: "https://cdn.example.test/bg.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  text: {
    content: "Hola",
    x: 540,
    y: 960,
    width: 900,
    fontSize: 24,
    color: "#FFFFFF",
    textAlign: "center",
  },
};

async function piece(companyId: string, payload: unknown = WALL): Promise<string> {
  const contentId = randomUUID();
  await api.handle.sql`
    insert into contents (id, company_id, type, status, revision, files, build_payload)
    values (${contentId}::uuid, ${companyId}::uuid, 'wall-of-text', 'CREATED', 1,
            ${["https://cdn.example.test/prev.mp4"]}::text[],
            ${JSON.stringify(payload)}::jsonb)
  `;
  return contentId;
}

const box = (family: string, weight: number) => ({
  id: "slide-0-text-0",
  slideIndex: 0,
  text: "Hola",
  position: { x: 50, y: 50 },
  widthPercent: 83.333333,
  font: { family, weight, size: 24 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
});

const patch = (contentId: string, body: Record<string, unknown>) =>
  api.request({
    method: "PATCH",
    path: `/api/v1/content/${contentId}`,
    body: { revision: 1, ...body },
    idempotencyKey: `brand-look-${randomUUID()}`,
  });

async function savedFamilies(contentId: string): Promise<unknown[]> {
  const rows = await api.handle.sql`
    select font from content_text_boxes where content_id = ${contentId}::uuid
  `;
  return rows.map((r) => (r["font"] as { family: string }).family);
}

describe("PATCH /content/:id · familia de marca", () => {
  it("con licencia: guarda brand:<id> y encola el rebuild", async () => {
    const co = api.data.a.companyId;
    await activeDesignSystem(co, { licensed: true, withLogo: false });
    const id = await piece(co);
    const res = await patch(id, { textBoxes: [box("brand:rotis-semi-sans", 700)] });
    expect(res.status).toBe(200);
    expect(await savedFamilies(id)).toEqual(["brand:rotis-semi-sans"]);
    expect(api.queue.enqueued.length).toBeGreaterThan(0);
  });

  it("licencia sin tildar, id inexistente o sin design system: 400 brand_font_unavailable, nada escrito", async () => {
    const co = api.data.a.companyId;
    for (const [setup, family] of [
      [
        () => activeDesignSystem(co, { licensed: false, withLogo: false }),
        "brand:rotis-semi-sans",
      ],
      [
        () => activeDesignSystem(co, { licensed: true, withLogo: false }),
        "brand:no-existe",
      ],
      [
        async () => {
          await api.handle
            .sql`delete from brand_design_systems where company_id = ${co}::uuid`;
        },
        "brand:rotis-semi-sans",
      ],
    ] as const) {
      await setup();
      const id = await piece(co);
      api.queue.reset();
      const res = await patch(id, { textBoxes: [box(family, 700)] });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toMatchObject({
        code: "bad_request",
        details: { reason: "brand_font_unavailable", families: [family] },
      });
      expect(await savedFamilies(id)).toEqual([]);
      expect(api.queue.enqueued).toHaveLength(0);
    }
  });

  it("forma inválida (brand:Rotis) la corta el contrato", async () => {
    const id = await piece(api.data.a.companyId);
    const res = await patch(id, { textBoxes: [box("brand:Rotis", 700)] });
    expect(res.status).toBe(400);
  });

  it("de la marca B con el design system de A: 400 (cada marca ve el suyo)", async () => {
    await activeDesignSystem(api.data.a.companyId, { licensed: true, withLogo: false });
    await api.handle
      .sql`delete from brand_design_systems where company_id = ${api.data.b.companyId}::uuid`;
    const id = await piece(api.data.b.companyId);
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${id}`,
      body: { revision: 1, textBoxes: [box("brand:rotis-semi-sans", 700)] },
      idempotencyKey: `brand-look-${randomUUID()}`,
      token: api.data.b.token,
    });
    expect(res.status).toBe(400);
  });
});

describe("logo de la pieza", () => {
  it("GET /editable: sin logo en el payload → null; logoAvailable según el design system", async () => {
    const co = api.data.a.companyId;
    await activeDesignSystem(co, { licensed: true, withLogo: true });
    const id = await piece(co);
    const data = dataOf(
      await api.request({ method: "GET", path: `/api/v1/content/${id}/editable` }),
    );
    expect(data["logo"]).toBeNull();
    expect(data["logoAvailable"]).toBe(true);

    const withLogo = await piece(co, {
      ...WALL,
      logo: { corner: "top-right", size: "small", opacity: 0.9 },
    });
    const data2 = dataOf(
      await api.request({ method: "GET", path: `/api/v1/content/${withLogo}/editable` }),
    );
    expect(data2["logo"]).toEqual({ corner: "top-right", size: "small", opacity: 0.9 });
  });

  it("PATCH logo lo guarda en studioState (el payload no se toca); null lo saca", async () => {
    const co = api.data.a.companyId;
    await activeDesignSystem(co, { licensed: true, withLogo: true });
    const id = await piece(co, {
      ...WALL,
      logo: { corner: "top-right", size: "small", opacity: 0.9 },
    });
    const moved = { corner: "bottom-left", size: "large", opacity: 0.5 };
    expect(
      (await patch(id, { textBoxes: [box("inter", 400)], logo: moved })).status,
    ).toBe(200);
    const rows = await api.handle.sql`
      select studio_state, build_payload from contents where id = ${id}::uuid
    `;
    expect((rows[0]?.["studio_state"] as { logo: unknown }).logo).toEqual(moved);
    expect((rows[0]?.["build_payload"] as { logo: unknown }).logo).toEqual({
      corner: "top-right",
      size: "small",
      opacity: 0.9,
    });
    await api.handle.sql`update contents set status = 'CREATED' where id = ${id}::uuid`;
    const res2 = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${id}`,
      body: { revision: 2, textBoxes: [box("inter", 400)], logo: null },
      idempotencyKey: `brand-look-${randomUUID()}`,
    });
    expect(res2.status).toBe(200);
    const data = dataOf(
      await api.request({ method: "GET", path: `/api/v1/content/${id}/editable` }),
    );
    expect(data["logo"]).toBeNull();
  });
});

describe("POST /content con fontFamily de marca", () => {
  it("sin licencia → 400 brand_font_unavailable antes de cobrar", async () => {
    const co = api.data.a.companyId;
    await activeDesignSystem(co, { licensed: false, withLogo: false });
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: { ...WALL, text: { ...WALL.text, fontFamily: "brand:rotis-semi-sans" } },
      idempotencyKey: `brand-look-${randomUUID()}`,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatchObject({ details: { reason: "brand_font_unavailable" } });
  });
});

describe("GET|PUT /design-system/:id/logo-layer", () => {
  it("apagado por defecto; PUT lo prende y sobrevive a una edición de paleta", async () => {
    const co = api.data.a.companyId;
    const dsId = await activeDesignSystem(co, { licensed: true, withLogo: true });
    const path = `/api/v1/design-system/${dsId}/logo-layer`;
    expect(dataOf(await api.request({ method: "GET", path }))).toEqual({
      enabled: false,
      corner: "top-right",
      size: "small",
      opacity: 0.9,
      available: true,
    });
    const on = { enabled: true, corner: "bottom-right", size: "medium", opacity: 0.8 };
    const put = await api.request({ method: "PUT", path, body: on });
    expect(put.status).toBe(200);
    expect(dataOf(put)).toEqual({ ...on, available: true });

    const edit = await api.request({
      method: "PATCH",
      path: `/api/v1/design-system/${dsId}`,
      body: { name: "FOCUS 2" },
    });
    expect(edit.status).toBe(200);
    expect(dataOf(await api.request({ method: "GET", path }))).toMatchObject(on);
  });

  it("de otra marca: 404; body con claves de más: 400", async () => {
    const dsId = await activeDesignSystem(api.data.a.companyId, {
      licensed: true,
      withLogo: false,
    });
    const other = await api.request({
      method: "GET",
      path: `/api/v1/design-system/${dsId}/logo-layer`,
      token: api.data.b.token,
    });
    expect(other.status).toBe(404);
    const bad = await api.request({
      method: "PUT",
      path: `/api/v1/design-system/${dsId}/logo-layer`,
      body: { enabled: true, corner: "top-right", size: "small", opacity: 1, url: "x" },
    });
    expect(bad.status).toBe(400);
  });
});
