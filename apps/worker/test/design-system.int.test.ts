/**
 * `design-system` contra Postgres real — sprint 9 (M), `PU-S9-001/003/004`.
 *
 * Un zip **sintético** con la forma del export de Claude Design (FOCUS): lo
 * que se mide es el circuito entero del worker —storage → fflate → parser de
 * `core` → subidas → `media` → activación— sobre la base con RLS y el rol de
 * aplicación. El render (rasterizar SVG) y el modelo `text` son dobles: el
 * rasterizado real lo mide `services/render`, y el resumen con un modelo real
 * se corre aparte contra Ollama (ver el reporte del sprint).
 */
import { randomUUID } from "node:crypto";

import { FixedClock, HttpMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import type { RenderFetch } from "@fastgram/adapters";
import {
  designSystemRepository,
  lockCompanyDesignSystem,
  APP_ROLE,
  withCompany,
  type DbHandle,
} from "@fastgram/db";
import type {
  BrandBackgroundGenerator,
  JobContext,
  Llm,
  LlmJsonCompletion,
} from "@fastgram/ports";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createBrandBackgroundsHandler } from "../src/brand-kit/handler.js";
import {
  readActiveDesignSystem,
  withDesignSystemStyle,
} from "../src/design-system/blitz.js";
import { createDesignSystemHandler } from "../src/design-system/handler.js";
import type { SvgRasterizer } from "../src/design-system/render-client.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
let handle: DbHandle;

beforeAll(() => {
  handle = openDb();
});
afterAll(async () => {
  await handle?.close();
});

const COLORS = `:root {
  --focus-magenta: #FF00FF;
  --focus-blue: #0033FF;
  --focus-ink: #0A0A0B;
  --focus-paper: #F6F6F4;
  --surface-dark: var(--focus-ink);
  --surface-light: var(--focus-paper);
  --text-on-dark: #FFFFFF;
  --accent-1: var(--focus-magenta);
}`;
const TYPE = `@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600&display=swap');
@font-face { font-family: 'Rotis Semi Sans'; src: url('../assets/fonts/rotis/Semi-Light.otf'); font-weight: 300; }
@font-face { font-family: 'Rotis Semi Sans'; src: url('../assets/fonts/rotis/Semi-Bold.otf'); font-weight: 700; }
:root { --font-display: 'Source Serif 4', serif; --font-body: 'Rotis Semi Sans', sans-serif; }`;
const README = `# FOCUS — Design System

Tagline: *"El punto donde todo cambia."*

## Composition rule

- One sharp point per piece, always off-center.

## Content fundamentals

- Spanish (Argentina), short declarative lines.
- No exclamation points, no emoji.
`;
const MANIFEST = JSON.stringify({
  namespace: "FOCUS_x",
  cards: [{ group: "Brand", name: "Tratamiento", subtitle: "Un solo punto nítido" }],
});
const RINGS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" stroke="currentColor"/></svg>`;
const EVIL = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PNG_LOGO_DARK = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]);
const OTF_LIGHT = strToU8("OTTO-light-bytes");
const OTF_BOLD = strToU8("OTTO-bold-bytes");

function focusZip(extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({
    "FOCUS Design System/SKILL.md": strToU8(
      "---\nname: focus-design\ndescription: FOCUS\n---\n",
    ),
    "FOCUS Design System/readme.md": strToU8(README),
    "FOCUS Design System/_ds_manifest.json": strToU8(MANIFEST),
    "FOCUS Design System/tokens/colors.css": strToU8(COLORS),
    "FOCUS Design System/tokens/typography.css": strToU8(TYPE),
    "FOCUS Design System/assets/fonts/rotis/Semi-Light.otf": OTF_LIGHT,
    "FOCUS Design System/assets/fonts/rotis/Semi-Bold.otf": OTF_BOLD,
    "FOCUS Design System/assets/logo/focus-logo-light.png": PNG,
    "FOCUS Design System/assets/logo/focus-logo-dark.png": PNG_LOGO_DARK,
    "FOCUS Design System/assets/imagery/poster-01.jpg": JPG,
    "FOCUS Design System/assets/motifs/rings.svg": strToU8(RINGS),
    "FOCUS Design System/assets/motifs/evil.svg": strToU8(EVIL),
    // Duplicados de `assets/`: se deduplican por hash.
    "FOCUS Design System/uploads/Asset 1.png": PNG,
    "FOCUS Design System/uploads/Semi-Bold.otf": OTF_BOLD,
    "FOCUS Design System/uploads/TP.pdf": strToU8("%PDF"),
    "FOCUS Design System/scraps/manual-p7-0.png": PNG,
    "FOCUS Design System/templates/deck/Deck.dc.html": strToU8("<html>"),
    ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [`FOCUS Design System/${k}`, v]),
    ),
  });
}

const rasterizadas: string[] = [];
const rasterizer: SvgRasterizer = {
  rasterize(svg, color) {
    rasterizadas.push(color);
    expect(svg).toContain("currentColor");
    return Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]));
  },
};

/** Un `text` que contesta el esquema del resumen de estilo. */
function llmFalso(value: unknown): Llm {
  return {
    complete: () => Promise.reject(new Error("no se usa")),
    completeJson: () =>
      Promise.resolve({
        value,
        raw: JSON.stringify(value),
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "fake",
        deterministic: true,
        latencyMs: 1,
      } satisfies LlmJsonCompletion),
  };
}

const ctx = (payload: unknown, attempt = 1): JobContext<unknown> => ({
  jobId: `job_${randomUUID().slice(0, 8)}`,
  payload,
  attempt,
  maxAttempts: 2,
});

async function reservar(companyId: string, storage: MemoryStorage, zip: Uint8Array) {
  const zipKey = `design-systems/${companyId}/uploads/${randomUUID()}`;
  await storage.put({ key: zipKey, body: zip, contentType: "application/zip" });
  const row = await withCompany(
    handle.db,
    companyId,
    async (tx) => {
      await lockCompanyDesignSystem(tx, { companyId });
      return designSystemRepository.create(
        tx,
        { companyId },
        {
          source: "zip",
          name: "FOCUS.zip",
          status: "importing",
          zipKey,
          zipBytes: zip.byteLength,
        },
      );
    },
    { role: APP_ROLE },
  );
  return { zipKey, id: row.id };
}

function handlerCon(
  storage: MemoryStorage,
  opts: { llm?: Llm | null; generator?: BrandBackgroundGenerator | null } = {},
) {
  return createDesignSystemHandler({
    db: handle.db,
    storage,
    appRole: APP_ROLE,
    logger: silencioso,
    textLlm: () => Promise.resolve(opts.llm ?? null),
    rasterizer,
    generator: opts.generator ?? null,
    imageModel: () => Promise.resolve(null),
    fence: () => "fence-test-1234567890",
  });
}

interface FilaMedia {
  storage_key: string;
  tags: string[];
  categories: string[];
  origin: string;
  status: string;
  filename: string;
}
async function mediaDe(companyId: string): Promise<FilaMedia[]> {
  return (await handle.sql`
    select storage_key, tags, categories, origin::text, status::text, filename
      from media where company_id = ${companyId}::uuid order by storage_key
  `) as unknown as FilaMedia[];
}

describe("design-system — import de un zip sintético (PU-S9-001)", () => {
  it("fila activa + media con tag design-system + fuentes en storage", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const { zipKey, id } = await reservar(companyId, storage, focusZip());

    // Negativa primero: antes del job no hay activo ni media.
    expect(
      await withCompany(handle.db, companyId, (tx) =>
        designSystemRepository.findActive(tx, { companyId }),
      ),
    ).toBeNull();
    expect(await mediaDe(companyId)).toEqual([]);

    await handlerCon(storage, {
      llm: llmFalso({
        voice: "Short declarative lines in Rioplatense Spanish.",
        values: ["Libertad"],
        tagline: null,
        compositionRules: ["One sharp point, off-center."],
        dos: ["Use vos."],
        donts: ["No emoji."],
        language: "es-AR",
      }),
    })(ctx({ kind: "import", companyId, designSystemId: id, zipKey }));

    const row = await withCompany(handle.db, companyId, (tx) =>
      designSystemRepository.findActive(tx, { companyId }),
    );
    expect(row?.id).toBe(id);
    expect(row?.status).toBe("ready");
    expect(row?.name).toBe("FOCUS — Design System");
    expect(row?.version).toBe(1);

    const tokens = row?.tokens as {
      semantic: { surfaceDark: string; accents: string[] };
      families: { id: string; faces: unknown[]; license: string }[];
    };
    expect(tokens.semantic.surfaceDark).toBe("#0A0A0B");
    expect(tokens.semantic.accents).toEqual(["#FF00FF", "#0033FF"]);
    expect(tokens.families.find((f) => f.id === "rotis-semi-sans")).toMatchObject({
      license: "needs_confirmation",
    });

    // El resumen es el del modelo, con el tagline que el modelo no trajo
    // completado por la heurística (nunca inventado).
    expect(row?.style).toMatchObject({
      origin: "model",
      voice: "Short declarative lines in Rioplatense Spanish.",
      tagline: "El punto donde todo cambia.",
      language: "es-AR",
    });

    // Media: logo ×2, imagery ×1, motif ×1 (el SVG malo se saltea con aviso;
    // uploads/, scraps/ y templates/ no entran).
    const media = await mediaDe(companyId);
    expect(media).toHaveLength(4);
    for (const m of media) {
      expect(m.tags[0]).toBe("design-system");
      expect(m.origin).toBe("brand_kit");
      expect(m.status).toBe("ready");
      expect(m.storage_key.startsWith(`media/${companyId}/design-system/${id}/`)).toBe(
        true,
      );
      expect(await storage.head(m.storage_key)).not.toBeNull();
    }
    const porClase = (k: string) => media.filter((m) => m.tags.includes(k));
    expect(porClase("logo")).toHaveLength(2);
    expect(porClase("imagery")).toHaveLength(1);
    expect(porClase("motif")).toHaveLength(1);
    expect(porClase("imagery")[0]?.categories).toEqual([
      "slideshow-image",
      "green-screen-background",
    ]);
    expect(porClase("logo")[0]?.categories).toEqual([]);
    // El motivo se rasterizó con el primer acento.
    expect(porClase("motif")[0]?.filename).toBe("rings.png");
    expect(rasterizadas).toContain("#FF00FF");
    expect(row?.warnings.some((w) => w.includes("evil.svg"))).toBe(true);

    // Fuentes: dos caras, bajo `fonts/<marca>/`, con los bytes del zip.
    const fonts = row?.fonts as {
      fileRef: string;
      storageKey: string;
      contentType: string;
    }[];
    expect(fonts.map((f) => f.fileRef).sort()).toEqual([
      "rotis-semi-sans-300",
      "rotis-semi-sans-700",
    ]);
    for (const f of fonts) {
      expect(f.storageKey.startsWith(`fonts/${companyId}/${id}/`)).toBe(true);
      expect(f.contentType).toBe("font/otf");
      expect(await storage.head(f.storageKey)).not.toBeNull();
    }
    const assets = row?.assets as { mediaId: string; kind: string }[];
    expect(assets).toHaveLength(4);
  });

  it("idempotente: una reentrega de la misma fila no duplica media", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const { zipKey, id } = await reservar(companyId, storage, focusZip());
    const h = handlerCon(storage);
    await h(ctx({ kind: "import", companyId, designSystemId: id, zipKey }));
    const antes = (await mediaDe(companyId)).length;
    // Ya cerrada: no se procesa.
    await h(ctx({ kind: "import", companyId, designSystemId: id, zipKey }));
    // Forzada a `importing` otra vez (reentrega tras un corte): mismas claves.
    await handle.sql`update brand_design_systems set status = 'importing', active = false where id = ${id}::uuid`;
    await h(ctx({ kind: "import", companyId, designSystemId: id, zipKey }));
    expect((await mediaDe(companyId)).length).toBe(antes);
  });

  it("un segundo import activa la versión nueva y conserva la licencia tildada", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const primero = await reservar(companyId, storage, focusZip());
    await handlerCon(storage)(
      ctx({
        kind: "import",
        companyId,
        designSystemId: primero.id,
        zipKey: primero.zipKey,
      }),
    );
    // El dueño tilda la licencia de Rotis en la versión 1.
    await withCompany(handle.db, companyId, async (tx) => {
      const r = await designSystemRepository.findById(tx, { companyId }, primero.id);
      const t = r?.tokens as { families: { id: string; licenseConfirmed: boolean }[] };
      t.families = t.families.map((f) =>
        f.id === "rotis-semi-sans" ? { ...f, licenseConfirmed: true } : f,
      );
      await designSystemRepository.update(tx, { companyId }, primero.id, { tokens: t });
    });
    const segundo = await reservar(companyId, storage, focusZip());
    await handlerCon(storage)(
      ctx({
        kind: "import",
        companyId,
        designSystemId: segundo.id,
        zipKey: segundo.zipKey,
      }),
    );
    const filas = (await handle.sql`
      select id, version, active from brand_design_systems where company_id = ${companyId}::uuid order by version
    `) as unknown as { id: string; version: number; active: boolean }[];
    expect(filas.map((f) => [f.version, f.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    const activo = await withCompany(handle.db, companyId, (tx) =>
      designSystemRepository.findActive(tx, { companyId }),
    );
    const fams = (
      activo?.tokens as { families: { id: string; licenseConfirmed: boolean }[] }
    ).families;
    expect(fams.find((f) => f.id === "rotis-semi-sans")?.licenseConfirmed).toBe(true);
  });

  it("zip con path traversal o bomba → failed con su código, sin tocar el activo", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const malo = zipSync({ "readme.md": strToU8("# x"), "../../evil.css": strToU8("x") });
    const r1 = await reservar(companyId, storage, malo);
    await handlerCon(storage)(
      ctx({ kind: "import", companyId, designSystemId: r1.id, zipKey: r1.zipKey }),
    );
    const bomba = zipSync(
      {
        "readme.md": strToU8("# x"),
        "assets/imagery/bomb.jpg": new Uint8Array(50 * 1024 * 1024),
      },
      { level: 9 },
    );
    const r2 = await reservar(companyId, storage, bomba);
    await handlerCon(storage)(
      ctx({ kind: "import", companyId, designSystemId: r2.id, zipKey: r2.zipKey }),
    );
    const filas = (await handle.sql`
      select status, failure_code, active from brand_design_systems
       where company_id = ${companyId}::uuid order by version
    `) as unknown as { status: string; failure_code: string; active: boolean }[];
    expect(filas).toEqual([
      { status: "failed", failure_code: "unsafe_path", active: false },
      { status: "failed", failure_code: "zip_bomb", active: false },
    ]);
    expect(await mediaDe(companyId)).toEqual([]);
  });
});

describe("design-system en Blitz (PU-S9-003) y generación (PU-S9-004)", () => {
  const BASE = "http://render.test:3002";
  function servicio() {
    const pedidos: { palette: readonly string[]; seed: string }[] = [];
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
    const fetch: RenderFetch = (input, init) => {
      const path = input.slice(BASE.length);
      if (path === "/brand-backgrounds") {
        pedidos.push(
          JSON.parse(init.body ?? "{}") as { palette: string[]; seed: string },
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              contentType: "image/jpeg",
              sizeBytes: jpeg.length,
              width: 1080,
              height: 1350,
              href: "/artifact/i.jpg",
              cache: "miss",
              warnings: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (path === "/artifact/i.jpg") {
        return Promise.resolve(
          new Response(jpeg, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(jpeg.length),
            },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    };
    return {
      pedidos,
      generator: new HttpMediaRenderer({
        baseUrl: BASE,
        engineVersion: "t",
        grantSecret: "c".repeat(40),
        fetch,
      }),
    };
  }

  it("el kit de fondos usa la paleta del design system; las sugerencias llevan su estilo", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const { zipKey, id } = await reservar(companyId, storage, focusZip());
    await handlerCon(storage)(
      ctx({ kind: "import", companyId, designSystemId: id, zipKey }),
    );

    const svc = servicio();
    await createBrandBackgroundsHandler({
      db: handle.db,
      generator: svc.generator,
      storage,
      appRole: APP_ROLE,
      logger: silencioso,
    })({
      jobId: "j",
      payload: { companyId, seed: "kit-ds", images: 1, videos: 0 },
      attempt: 1,
      maxAttempts: 3,
    });
    expect(svc.pedidos[0]?.palette).toEqual(["#0A0A0B", "#FF00FF", "#0033FF", "#F6F6F4"]);

    const inTx = <R>(
      fn: (tx: Parameters<Parameters<typeof withCompany>[2]>[0]) => Promise<R>,
    ) => withCompany(handle.db, companyId, fn, { role: APP_ROLE });
    const active = await inTx((tx) => readActiveDesignSystem(tx, { companyId }));
    expect(active?.copyStyle?.voice).toContain("Spanish (Argentina)");
    const drafts = await withDesignSystemStyle(
      [{ buildPlan: { version: 1, texts: ["x"] } }, { buildPlan: null }],
      inTx,
      { companyId },
    );
    expect(drafts[0]?.buildPlan).toMatchObject({
      textStyle: { color: "#FFFFFF", backgroundColor: "#0A0A0B", strokeWidth: 0 },
    });
    expect(drafts[1]?.buildPlan).toBeNull();
  });

  it("generar: pendientes con la paleta, idempotente por pedido", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const { zipKey, id } = await reservar(companyId, storage, focusZip());
    await handlerCon(storage)(
      ctx({ kind: "import", companyId, designSystemId: id, zipKey }),
    );
    const svc = servicio();
    const h = handlerCon(storage, { generator: svc.generator });
    const requestId = randomUUID();
    const job = {
      kind: "generate",
      companyId,
      designSystemId: id,
      requestId,
      localImages: 2,
      modelImages: 1,
    };
    await h(ctx(job));
    await h(ctx(job));
    const row = await withCompany(handle.db, companyId, (tx) =>
      designSystemRepository.findById(tx, { companyId }, id),
    );
    const pending = row?.pendingAssets as { storageKey: string; generator: string }[];
    // Sin modelo `image`: sólo las 2 locales, y la segunda entrega no duplica.
    expect(pending).toHaveLength(2);
    expect(pending.every((p) => p.generator === "local")).toBe(true);
    expect(svc.pedidos).toHaveLength(2);
    expect(svc.pedidos[0]?.palette[0]).toBe("#0A0A0B");
    for (const p of pending) {
      expect(
        p.storageKey.startsWith(
          `media/${companyId}/design-system/${id}/generated/${requestId}/`,
        ),
      ).toBe(true);
    }
    // Pendientes no son media todavía.
    expect(
      (await mediaDe(companyId)).some((m) => m.storage_key.includes("/generated/")),
    ).toBe(false);
  });
});
