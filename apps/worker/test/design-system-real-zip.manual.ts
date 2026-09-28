/**
 * Import de un zip **real** de Claude Design contra una base de test — sprint
 * 9 (M). No es parte de la suite (no matchea `*.int.test.ts`): se corre a mano
 * para ver qué extrae el import de un export de verdad.
 *
 *   DATABASE_URL=postgres://…/fastgram_agent_m \
 *   RENDER_URL=http://127.0.0.1:3101 \
 *   npx tsx test/design-system-real-zip.manual.ts "<ruta al zip>"
 *
 * Qué usa de verdad: el worker (`createDesignSystemHandler`), Postgres (la
 * base `…_worker` que deriva `DATABASE_URL`, **nunca** la del dueño), el
 * render para rasterizar los SVG (si `RENDER_URL` está) y el modelo `text` del
 * registro de modelos para el resumen de estilo (si hay uno). El storage es
 * `MemoryStorage`: el zip y los assets no salen del proceso.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  FileModelRegistry,
  FixedClock,
  MemoryStorage,
  modelRegistryPath,
} from "@fastgram/adapters";
import {
  APP_ROLE,
  designSystemRepository,
  lockCompanyDesignSystem,
  withCompany,
} from "@fastgram/db";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createDesignSystemHandler } from "../src/design-system/handler.js";
import { createRenderRasterizer } from "../src/design-system/render-client.js";
import { createLlmSource } from "../src/llm/registry-llm.js";
import { DATABASE_URL, openDb, seedCompany } from "./helpers/fixtures.js";

const zipPath = process.argv[2];
if (zipPath === undefined) throw new Error("uso: design-system-real-zip.manual.ts <zip>");
if (!DATABASE_URL.includes("_agent_") && !DATABASE_URL.includes("_test")) {
  throw new Error(
    `no corro contra ${new URL(DATABASE_URL).pathname}: usá una base de test`,
  );
}

const logger: BuildLogger = {
  info: (o, m) => console.log("[info]", m, JSON.stringify(o)),
  warn: (o, m) => console.log("[warn]", m, JSON.stringify(o)),
  error: (o, m) => console.log("[error]", m, JSON.stringify(o)),
};

const handle = openDb();
const storage = new MemoryStorage(new FixedClock());
const llmSource = createLlmSource({
  registry: new FileModelRegistry({ path: modelRegistryPath(process.env) }),
  legacy: null,
  secrets: process.env,
  logger,
});

try {
  const companyId = await seedCompany(handle);
  const zip = new Uint8Array(readFileSync(zipPath));
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
          status: "importing",
          name: "real zip",
          zipKey,
          zipBytes: zip.byteLength,
        },
      );
    },
    { role: APP_ROLE },
  );

  const t0 = Date.now();
  await createDesignSystemHandler({
    db: handle.db,
    storage,
    appRole: APP_ROLE,
    logger,
    textLlm: async () => (await llmSource.current("text"))?.llm ?? null,
    rasterizer:
      process.env["RENDER_URL"] === undefined
        ? null
        : createRenderRasterizer({ baseUrl: process.env["RENDER_URL"] }),
    generator: null,
    imageModel: () => Promise.resolve(null),
  })({
    jobId: "manual",
    payload: { kind: "import", companyId, designSystemId: row.id, zipKey },
    attempt: 1,
    maxAttempts: 2,
  });
  const ms = Date.now() - t0;

  const done = await withCompany(handle.db, companyId, (tx) =>
    designSystemRepository.findById(tx, { companyId }, row.id),
  );
  const media = (await handle.sql`
    select tags, categories, filename, size_mb from media where company_id = ${companyId}::uuid order by filename
  `) as unknown as {
    tags: string[];
    categories: string[];
    filename: string;
    size_mb: number;
  }[];
  const tokens = done?.tokens as {
    colors: { name: string; hex: string; aliasOf: string | null }[];
    semantic: unknown;
    families: {
      name: string;
      origin: string;
      license: string;
      weights: number[];
      faces: unknown[];
      fallback: string;
    }[];
    roles: { role: string; familyId: string | null }[];
    spacing: { name: string; px: number }[];
  };
  const byKind: Record<string, number> = {};
  for (const m of media) {
    const k = m.tags[1] ?? "?";
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  console.log(
    JSON.stringify(
      {
        ms,
        status: done?.status,
        active: done?.active,
        failure: done?.failureCode,
        name: done?.name,
        palette: tokens.colors.map(
          (c) => `${c.name} ${c.hex}${c.aliasOf === null ? "" : ` ← ${c.aliasOf}`}`,
        ),
        semantic: tokens.semantic,
        families: tokens.families.map(
          (f) =>
            `${f.name} [${f.origin}, ${f.license}] pesos ${f.weights.join("/")} · ${String(f.faces.length)} archivos · reemplazo ${f.fallback}`,
        ),
        roles: tokens.roles.map((r) => `${r.role} → ${r.familyId ?? "-"}`),
        spacing: tokens.spacing.map((s) => `${s.name}=${String(s.px)}px`),
        mediaByKind: byKind,
        media: media.map(
          (m) =>
            `${m.tags.join(",")} · ${m.filename} · ${m.size_mb.toFixed(2)} MB · [${m.categories.join(",")}]`,
        ),
        fontFiles: (done?.fonts as { fileRef: string; bytes: number }[]).map(
          (f) => `${f.fileRef} (${String(f.bytes)} B)`,
        ),
        warnings: done?.warnings,
        style: done?.style,
      },
      null,
      2,
    ),
  );
} finally {
  await handle.close();
}
