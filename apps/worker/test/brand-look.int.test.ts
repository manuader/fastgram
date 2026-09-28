/**
 * Sprint 9 (S), `PU-S9-003` — la marca viaja en el build real de una pieza
 * clásica. Postgres real (`…_worker`), el handler de `content-build` de
 * verdad, el adaptador HTTP de verdad y un `services/render` falso que sólo
 * guarda lo que le llega: lo que se mide es **el request**.
 *
 *  - licencia tildada → los textos piden `brand:rotis-semi-sans`, el request
 *    lleva `brandFonts` con las URLs de `fonts/{companyId}/`, el grant firmado
 *    cubre ese prefijo y lista esas URLs, y el payload estampado se persiste;
 *  - con la preferencia de logo prendida → `logo` con las variantes del design
 *    system, también en el grant;
 *  - licencia sin tildar → el reemplazo registrado (`inter`), sin `brandFonts`;
 *  - licencia destildada **después** del primer build → el rebuild no falla:
 *    reemplaza la familia y no manda las caras;
 *  - sin design system → el request de siempre, sin claves nuevas.
 *
 * El frame de verdad (render levantado en 3121) lo produce
 * `brand-look-real-render.manual.ts`.
 */
import { randomUUID } from "node:crypto";

import {
  FixedClock,
  HttpMediaRenderer,
  MemoryStorage,
  canonicalObjectUrl,
  type RenderFetch,
} from "@fastgram/adapters";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import type { JobContext } from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createContentBuildHandler } from "../src/content/build-handler.js";
import { createContentRebuildHandler } from "../src/content/rebuild-handler.js";
import { DATABASE_URL, openDb, seedCompany, seedPiece } from "./helpers/fixtures.js";

const clock = new FixedClock(new Date("2026-09-28T12:00:00.000Z"));
const silencioso = { info: () => {}, warn: () => {}, error: () => {} };
const BASE = "http://render.test:3121";
const SECRET = "s".repeat(32);

let handle: DbHandle;
let companyId: string;
let storage: MemoryStorage;

interface Sent {
  readonly payload: {
    readonly texts?: readonly { font: { family: string; weight: number } }[];
    readonly slides?: readonly { texts: readonly { font: { family: string } }[] }[];
  };
  readonly grant?: {
    readonly body: { mediaPrefixes: string[]; sharedPrefixes: string[]; urls?: string[] };
  };
  readonly brandFonts?: readonly { id: string; weight: number; url: string }[];
  readonly logo?: { images: { url: string }[]; corner: string };
}

/** Un `services/render` que responde un artefacto y guarda cada `POST /render`. */
function fakeRender(): { fetch: RenderFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  const fetch: RenderFetch = (input, init) => {
    const path = input.slice(BASE.length);
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path === "/render") {
      const body = JSON.parse(init.body ?? "{}") as Sent & { payload: { type: string } };
      sent.push(body);
      const n = body.payload.slides?.length ?? 1;
      return Promise.resolve(
        json({
          type: body.payload.type,
          artifacts: Array.from({ length: n }, (_u, index) => ({
            kind: body.payload.type === "slideshow" ? "image" : "video",
            index,
            bytes: bytes.length,
            href: `/artifact/a${String(index)}.${body.payload.type === "slideshow" ? "jpg" : "mp4"}`,
          })),
          warnings: [],
          cache: { base: "miss", build: "miss" },
          keys: {},
        }),
      );
    }
    if (path.startsWith("/artifact/")) {
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": path.endsWith(".jpg") ? "image/jpeg" : "video/mp4",
            "content-length": String(bytes.length),
          },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  return { fetch, sent };
}

function renderer(fetch: RenderFetch): HttpMediaRenderer {
  return new HttpMediaRenderer({
    baseUrl: BASE,
    engineVersion: "test-engine",
    fetch,
    clock,
    grantSecret: SECRET,
  });
}

const deps = (r: HttpMediaRenderer) => ({
  db: handle.db,
  renderer: r,
  storage,
  clock,
  appRole: APP_ROLE,
  logger: silencioso,
});

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: `job_${randomUUID()}`,
  payload,
  attempt: 1,
  maxAttempts: 1,
});

const TOKENS = (licensed: boolean, logoOn: boolean) => ({
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
      faces: [
        { weight: 300, style: "normal", file: "uploads/RotisSemiSansStd-Light.otf" },
        { weight: 700, style: "normal", file: "uploads/RotisSemiSansStd-Bold.otf" },
      ],
      weights: [300, 700],
      fallback: "inter",
    },
  ],
  roles: [
    {
      role: "display",
      stack: ["Rotis Semi Sans", "sans-serif"],
      familyId: "rotis-semi-sans",
    },
    {
      role: "body",
      stack: ["Rotis Semi Sans", "sans-serif"],
      familyId: "rotis-semi-sans",
    },
  ],
  spacing: [],
  ...(logoOn
    ? { logoLayer: { enabled: true, corner: "top-right", size: "small", opacity: 0.9 } }
    : {}),
});

/** Un design system activo con dos caras de Rotis y dos logos, como lo deja el import de M. */
async function seedDesignSystem(opts: {
  licensed: boolean;
  logoOn: boolean;
}): Promise<{ id: string; fontUrls: string[]; logoUrls: string[] }> {
  await handle.sql`delete from brand_design_systems where company_id = ${companyId}::uuid`;
  const id = randomUUID();
  const fonts = [];
  const fontUrls: string[] = [];
  for (const weight of [300, 700]) {
    const key = `fonts/${companyId}/${id}/rotis-semi-sans-${String(weight)}.otf`;
    const url = await canonicalObjectUrl(storage, key);
    fontUrls.push(url);
    fonts.push({
      fileRef: `rotis-semi-sans-${String(weight)}`,
      familyId: "rotis-semi-sans",
      weight,
      style: "normal",
      storageKey: key,
      url,
      contentType: "font/otf",
      bytes: 10,
    });
  }
  const assets = [];
  const logoUrls: string[] = [];
  for (const variant of ["light", "dark"]) {
    const mediaId = randomUUID();
    const key = `media/${companyId}/design-system/${id}/logo/${variant}.png`;
    const url = await canonicalObjectUrl(storage, key);
    logoUrls.push(url);
    await handle.sql`
      insert into media (media_id, company_id, media_type, filename, r2_url, storage_key,
                         size_mb, status, tags, origin)
      values (${mediaId}::uuid, ${companyId}::uuid, 'image', ${`logo-${variant}.png`},
              ${url}, ${key}, 0.01, 'ready', ${["logo", "design-system"]}::text[],
              'brand_kit')
    `;
    assets.push({
      mediaId,
      kind: "logo",
      path: `assets/logo/${variant}.png`,
      filename: "",
    });
  }
  await handle.sql`
    insert into brand_design_systems (id, company_id, status, source, active, version,
                                      name, tokens, assets, fonts)
    values (${id}::uuid, ${companyId}::uuid, 'ready', 'zip', true, 1, 'FOCUS',
            ${JSON.stringify(TOKENS(opts.licensed, opts.logoOn))}::jsonb,
            ${JSON.stringify(assets)}::jsonb, ${JSON.stringify(fonts)}::jsonb)
  `;
  return { id, fontUrls, logoUrls };
}

const GREEN_SCREEN = {
  canvas: { width: 1080, height: 1920 },
  image: {
    url: "https://cdn.example.test/bg.jpg",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  video: {
    url: "https://cdn.example.test/clip.mp4",
    drawX: 0,
    drawY: 960,
    drawW: 1080,
    drawH: 960,
    fit: "contain",
  },
  text: {
    content: "Menos ruido, más foco",
    x: 540,
    y: 480,
    width: 900,
    fontSize: 28,
    color: "#FFFFFF",
    textAlign: "center",
    fontWeight: 600,
    strokeWidth: 0,
    backgroundColor: "#0A0A0B",
  },
};

async function buildPiece(payload: unknown, type = "green-screen") {
  const contentId = await seedPiece(handle, companyId, {
    type: type as "green-screen",
    buildPayload: payload,
  });
  const render = fakeRender();
  await createContentBuildHandler(deps(renderer(render.fetch)))(
    ctx({ companyId, contentId, contentType: type, revision: 1, reason: "create" }),
  );
  const rows = await handle.sql`
    select status, build_payload from contents where id = ${contentId}::uuid
  `;
  return {
    contentId,
    sent: render.sent,
    status: rows[0]?.["status"] as string,
    payload: rows[0]?.["build_payload"] as Record<string, unknown>,
  };
}

function grantOf(sent: Sent): {
  mediaPrefixes: string[];
  sharedPrefixes: string[];
  urls?: string[];
} {
  if (sent.grant === undefined) throw new Error("el request no lleva grant");
  return sent.grant.body;
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
  companyId = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  storage = new MemoryStorage(clock, "memory://bucket");
});

describe("build de una marca con design system", () => {
  it("licencia tildada: brand:<id> en el texto, brandFonts en el request, fonts/ en el grant, payload persistido", async () => {
    const ds = await seedDesignSystem({ licensed: true, logoOn: false });
    const out = await buildPiece(GREEN_SCREEN);
    expect(out.status).toBe("CREATED");
    const [sent] = out.sent;
    if (sent === undefined) throw new Error("el render no recibió nada");

    expect(sent.payload.texts?.[0]?.font).toEqual({
      family: "brand:rotis-semi-sans",
      weight: 700, // 600 del estilo de caption → la cara más cercana
      size: 28,
    });
    expect(sent.brandFonts?.map((f) => [f.id, f.weight, f.url])).toEqual([
      ["rotis-semi-sans", 300, ds.fontUrls[0]],
      ["rotis-semi-sans", 700, ds.fontUrls[1]],
    ]);
    expect(sent.logo).toBeUndefined();

    const grant = grantOf(sent);
    expect(grant.mediaPrefixes).toContain(
      await canonicalObjectUrl(storage, `fonts/${companyId}/`),
    );
    for (const url of ds.fontUrls) expect(grant.urls).toContain(url);

    // Persistido: el editor deriva la misma familia que salió en el video.
    expect((out.payload["text"] as Record<string, unknown>)["fontFamily"]).toBe(
      "brand:rotis-semi-sans",
    );
  });

  it("con la preferencia de logo: la capa con las dos variantes, también en el grant y en el payload", async () => {
    const ds = await seedDesignSystem({ licensed: true, logoOn: true });
    const out = await buildPiece(GREEN_SCREEN);
    const [sent] = out.sent;
    expect(sent?.logo).toEqual({
      images: ds.logoUrls.map((url) => ({ url })),
      corner: "top-right",
      size: "small",
      opacity: 0.9,
    });
    const grant = grantOf(sent as Sent);
    for (const url of ds.logoUrls) expect(grant.urls).toContain(url);
    expect(out.payload["logo"]).toEqual({
      corner: "top-right",
      size: "small",
      opacity: 0.9,
    });
  });

  it("licencia sin tildar: el reemplazo (inter), sin brandFonts", async () => {
    await seedDesignSystem({ licensed: false, logoOn: false });
    const out = await buildPiece(GREEN_SCREEN);
    const [sent] = out.sent;
    expect(sent?.payload.texts?.[0]?.font.family).toBe("inter");
    expect(sent?.brandFonts).toBeUndefined();
    expect((out.payload["text"] as Record<string, unknown>)["fontFamily"]).toBe("inter");
  });

  it("slideshow: primer slide con el título, el resto con el cuerpo", async () => {
    await seedDesignSystem({ licensed: true, logoOn: false });
    const slide = (content: string) => ({
      canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
      image: {
        url: `https://cdn.example.test/${content}.jpg`,
        drawX: 0,
        drawY: 0,
        drawW: 1080,
        drawH: 1350,
      },
      texts: [{ ...GREEN_SCREEN.text, content }],
    });
    const out = await buildPiece(
      { num_images: 2, images: [slide("uno"), slide("dos")] },
      "slideshow",
    );
    const families = out.sent[0]?.payload.slides?.map((s) => s.texts[0]?.font.family);
    expect(families).toEqual(["brand:rotis-semi-sans", "brand:rotis-semi-sans"]);
  });

  it("licencia destildada después del build: el rebuild reemplaza y no manda las caras", async () => {
    await seedDesignSystem({ licensed: true, logoOn: false });
    const out = await buildPiece(GREEN_SCREEN);
    // El dueño destilda la licencia; la pieza ya tiene brand:… persistido.
    await handle.sql`
      update brand_design_systems
         set tokens = jsonb_set(tokens, '{families,0,licenseConfirmed}', 'false')
       where company_id = ${companyId}::uuid
    `;
    await handle.sql`
      update contents set status = 'BUILDING', revision = 2 where id = ${out.contentId}::uuid
    `;
    const render = fakeRender();
    await createContentRebuildHandler(deps(renderer(render.fetch)))(
      ctx({
        companyId,
        contentId: out.contentId,
        contentType: "green-screen",
        revision: 2,
        reason: "edit",
      }),
    );
    const [sent] = render.sent;
    expect(sent?.payload.texts?.[0]?.font.family).toBe("inter");
    expect(sent?.brandFonts).toBeUndefined();
    const rows =
      await handle.sql`select status from contents where id = ${out.contentId}::uuid`;
    expect(rows[0]?.["status"]).toBe("CREATED");
  });

  it("sin design system: el request de siempre, sin claves nuevas, payload sin tocar", async () => {
    await handle.sql`delete from brand_design_systems where company_id = ${companyId}::uuid`;
    const out = await buildPiece(GREEN_SCREEN);
    const [sent] = out.sent;
    expect(Object.keys(sent ?? {}).sort()).toEqual(["grant", "payload"]);
    expect(sent?.payload.texts?.[0]?.font.family).toBe("inter");
    expect(out.payload).toEqual(GREEN_SCREEN);
  });
});
