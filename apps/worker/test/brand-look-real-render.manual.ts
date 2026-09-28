/**
 * La marca en piezas clásicas contra el render **de verdad** — sprint 9 (S),
 * `PU-S9-003`. No es parte de la suite (no matchea `*.int.test.ts`): se corre
 * a mano para **mirar el frame**.
 *
 *   DATABASE_URL=postgres://…/fastgram_agent_s \
 *   RENDER_URL=http://127.0.0.1:3121 RENDER_GRANT_SECRET=… \
 *   FOCUS_DIR=<carpeta del zip de FOCUS descomprimido> OUT_DIR=<salida> \
 *   npx tsx test/brand-look-real-render.manual.ts
 *
 * Qué es real: Postgres (`…_worker`, nunca la del dueño), el handler de
 * `content-build`, el adaptador HTTP con grant firmado y `services/render`
 * levantado aparte (con el mismo secreto). El storage es `MemoryStorage`
 * servido por HTTP en 127.0.0.1:3131 para que el render pueda bajar la media,
 * las fuentes y los logos. Las fuentes y los logos son los de FOCUS.
 *
 * Deja en `OUT_DIR` los artefactos de tres builds: green-screen con licencia +
 * logo, el mismo sin licencia, y un slideshow claro/oscuro con logo abajo.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { FixedClock, MemoryStorage, canonicalObjectUrl } from "@fastgram/adapters";
import { APP_ROLE, migrateWithUrl } from "@fastgram/db";

import {
  createContentBuildHandler,
  type BuildLogger,
} from "../src/content/build-handler.js";
import { createRenderServiceRenderers } from "../src/media/render-service.js";
import { DATABASE_URL, openDb, seedCompany, seedPiece } from "./helpers/fixtures.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`falta ${name}`);
  return v;
};
if (!DATABASE_URL.includes("_agent_")) throw new Error("usá una base de agente");

const FOCUS = env("FOCUS_DIR");
/** Fondos oscuros sin logo propio (los posters de FOCUS ya traen el suyo). */
const BG_DARK = env("BG_DARK");
const OUT = env("OUT_DIR");
const PORT = 3131;
const BASE = `http://127.0.0.1:${String(PORT)}/obj`;
mkdirSync(OUT, { recursive: true });

const logger: BuildLogger = {
  info: (o, m) => console.log("[info]", m, JSON.stringify(o)),
  warn: (o, m) => console.log("[warn]", m, JSON.stringify(o)),
  error: (o, m) => console.log("[error]", m, JSON.stringify(o)),
};

const clock = new FixedClock();

/**
 * `MemoryStorage` codifica la clave entera (`media%2Fco%2Fa.jpg`) y la política
 * del render corta prefijos en `/`: con `%2F` ningún prefijo del grant calza.
 * El S3 real da claves con `/` literales; acá se imita eso.
 */
class SlashStorage extends MemoryStorage {
  override async createDownloadUrl(
    request: Parameters<MemoryStorage["createDownloadUrl"]>[0],
  ): ReturnType<MemoryStorage["createDownloadUrl"]> {
    const signed = await super.createDownloadUrl(request);
    return { ...signed, url: `${BASE}/${request.key}?sig=mem` };
  }
}
const storage = new SlashStorage(clock, BASE);

// El «bucket» por HTTP: /obj/<clave codificada>.
const server = createServer((req, res) => {
  void (async () => {
    const raw = (req.url ?? "").split("?")[0] ?? "";
    const key = decodeURIComponent(raw.replace(/^\/obj\//u, ""));
    const head = await storage.head(key);
    if (head === null) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const c of await storage.get(key)) chunks.push(c);
    const body = Buffer.concat(chunks);
    res.writeHead(200, {
      "content-type": head.contentType,
      "content-length": String(body.length),
    });
    res.end(body);
  })();
});
await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

async function put(key: string, file: string, contentType: string): Promise<string> {
  await storage.put({ key, body: readFileSync(file), contentType });
  return canonicalObjectUrl(storage, key);
}

const handle = openDb();
await migrateWithUrl(DATABASE_URL);
const companyId = await seedCompany(handle);
const t0 = Date.now();

// ── media de la pieza ──
const bgDark = await put(`media/${companyId}/bg-dark.jpg`, BG_DARK, "image/jpeg");
// Un fondo claro sin logo: papel de FOCUS en degradé.
const lightFile = path.join(OUT, "bg-light.png");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "gradients=s=1080x1350:c0=0xF6F6F4:c1=0xCFCFCB:x0=0:y0=0:x1=1080:y1=1350:d=1",
  "-frames:v",
  "1",
  lightFile,
]);
const bgLight = await put(`media/${companyId}/bg-light.png`, lightFile, "image/png");
// Fondo mixto: el poster con la manga clara sobre fondo oscuro abajo a la izquierda.
const bgMixed = await put(
  `media/${companyId}/bg-mixed.jpg`,
  path.join(FOCUS, "assets/imagery/reference-poster-01.jpg"),
  "image/jpeg",
);
const clipFile = path.join(OUT, "clip.mp4");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x00FF00:s=720x720:d=3:r=30",
  "-f",
  "lavfi",
  "-i",
  "color=c=0xE5007E:s=260x260:d=3:r=30",
  "-filter_complex",
  "[0][1]overlay=x='230+120*sin(t*2)':y=230",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  clipFile,
]);
const clip = await put(`media/${companyId}/clip.mp4`, clipFile, "video/mp4");

// ── design system activo con Rotis y los dos logos de FOCUS ──
async function designSystem(licensed: boolean, logo: { corner: string; size: string }) {
  await handle.sql`delete from brand_design_systems where company_id = ${companyId}::uuid`;
  const id = randomUUID();
  const faces = [
    { weight: 300, file: "RotisSemiSansStd-Light.otf" },
    { weight: 700, file: "RotisSemiSansStd-Bold.otf" },
    { weight: 800, file: "RotisSemiSansStd-ExtraBold.otf" },
  ];
  const fonts = [];
  for (const f of faces) {
    const key = `fonts/${companyId}/${id}/rotis-semi-sans-${String(f.weight)}.otf`;
    fonts.push({
      fileRef: `rotis-semi-sans-${String(f.weight)}`,
      familyId: "rotis-semi-sans",
      weight: f.weight,
      style: "normal",
      storageKey: key,
      url: await put(key, path.join(FOCUS, "uploads", f.file), "font/otf"),
      contentType: "font/otf",
      bytes: 1,
    });
  }
  const assets = [];
  for (const variant of ["light", "dark"]) {
    const mediaId = randomUUID();
    const key = `media/${companyId}/design-system/${id}/logo/${variant}.png`;
    const url = await put(
      key,
      path.join(FOCUS, `assets/logo/focus-logo-${variant}.png`),
      "image/png",
    );
    await handle.sql`
      insert into media (media_id, company_id, media_type, filename, r2_url, storage_key,
                         size_mb, status, tags, origin)
      values (${mediaId}::uuid, ${companyId}::uuid, 'image', ${`focus-logo-${variant}.png`},
              ${url}, ${key}, 0.02, 'ready', ${["logo", "design-system"]}::text[], 'brand_kit')
    `;
    assets.push({
      mediaId,
      kind: "logo",
      path: `assets/logo/focus-logo-${variant}.png`,
      filename: "",
    });
  }
  const tokens = {
    colors: [
      { name: "--focus-ink", hex: "#0A0A0B", aliasOf: null },
      { name: "--focus-paper", hex: "#F6F6F4", aliasOf: null },
      { name: "--focus-magenta", hex: "#E5007E", aliasOf: null },
    ],
    semantic: {
      surfaceDark: "#0A0A0B",
      surfaceLight: "#F6F6F4",
      textOnDark: "#FFFFFF",
      textOnLight: "#0A0A0B",
      accents: ["#E5007E"],
    },
    families: [
      {
        name: "Rotis Semi Sans",
        id: "rotis-semi-sans",
        origin: "file",
        category: "sans",
        license: "needs_confirmation",
        licenseConfirmed: licensed,
        faces: faces.map((f) => ({
          weight: f.weight,
          style: "normal",
          file: `uploads/${f.file}`,
        })),
        weights: faces.map((f) => f.weight),
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
    logoLayer: { enabled: true, corner: logo.corner, size: logo.size, opacity: 1 },
  };
  await handle.sql`
    insert into brand_design_systems (id, company_id, status, source, active, version,
                                      name, tokens, assets, fonts)
    values (${id}::uuid, ${companyId}::uuid, 'ready', 'zip', true, 1, 'FOCUS',
            ${JSON.stringify(tokens)}::jsonb, ${JSON.stringify(assets)}::jsonb,
            ${JSON.stringify(fonts)}::jsonb)
  `;
}

const renderers = await createRenderServiceRenderers({
  baseUrl: env("RENDER_URL"),
  grantSecret: env("RENDER_GRANT_SECRET"),
});
const build = createContentBuildHandler({
  db: handle.db,
  renderer: renderers.build,
  storage,
  clock,
  appRole: APP_ROLE,
  logger,
});

// Lo que Blitz escribe con el estilo del design system: caja oscura, texto claro.
const caption = (content: string, y: number) => ({
  content,
  x: 540,
  y,
  width: 900,
  fontSize: 30,
  color: "#FFFFFF",
  textAlign: "center",
  fontWeight: 600,
  strokeWidth: 0,
  backgroundColor: "#0A0A0B",
});

async function run(name: string, type: string, payload: unknown): Promise<void> {
  const contentId = await seedPiece(handle, companyId, {
    type: type as "slideshow",
    buildPayload: payload,
  });
  const started = Date.now();
  await build({
    jobId: name,
    payload: { companyId, contentId, contentType: type, revision: 1, reason: "create" },
    attempt: 1,
    maxAttempts: 1,
  });
  const rows = await handle.sql`
    select status, files, build_payload from contents where id = ${contentId}::uuid
  `;
  const row = rows[0] as { status: string; files: string[]; build_payload: unknown };
  console.log(`== ${name}: ${row.status} en ${String(Date.now() - started)} ms`);
  console.log(
    `   payload persistido: ${JSON.stringify(row.build_payload).slice(0, 400)}`,
  );
  for (const [i, url] of row.files.entries()) {
    const key = url.slice(BASE.length + 1);
    const chunks: Uint8Array[] = [];
    for await (const c of await storage.get(key)) chunks.push(c);
    const ext = type === "slideshow" ? "jpg" : "mp4";
    const file = path.join(OUT, `${name}-${String(i)}.${ext}`);
    writeFileSync(file, Buffer.concat(chunks));
    if (ext === "mp4") {
      execFileSync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "1.5",
        "-i",
        file,
        "-frames:v",
        "1",
        path.join(OUT, `${name}-${String(i)}.png`),
      ]);
    }
    console.log(`   → ${file}`);
  }
}

const greenScreen = {
  canvas: { width: 1080, height: 1920 },
  image: { url: bgDark, drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 },
  video: { url: clip, drawX: 0, drawY: 960, drawW: 1080, drawH: 960, fit: "contain" },
  text: caption("Menos ruido. Más foco.", 560),
};

try {
  await designSystem(true, { corner: "top-right", size: "medium" });
  await run("gs-licensed", "green-screen", greenScreen);
  await designSystem(false, { corner: "top-right", size: "medium" });
  await run("gs-unlicensed", "green-screen", greenScreen);
  await designSystem(true, { corner: "bottom-left", size: "medium" });
  const slide = (url: string, content: string) => ({
    canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
    image: { url, drawX: 0, drawY: 0, drawW: 1080, drawH: 1350 },
    texts: [caption(content, 400)],
  });
  await run("slides", "slideshow", {
    num_images: 3,
    images: [
      slide(bgLight, "Diseño que se nota"),
      slide(bgDark, "Hecho con foco"),
      slide(bgMixed, "Mirar no alcanza"),
    ],
  });
} finally {
  console.log(`total ${String(Date.now() - t0)} ms`);
  await handle.sql`delete from brand_design_systems where company_id = ${companyId}::uuid`;
  await handle.close();
  server.close();
}
