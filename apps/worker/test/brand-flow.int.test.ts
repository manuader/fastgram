/**
 * Sprint 7, segunda tanda (H) contra Postgres:
 *
 * 1. `P1-ONB-005`: el handler de análisis escribe la fase **real** en la
 *    fuente mientras trabaja y la limpia al terminar (migración `0031`).
 * 2. `P1-ONB-007`: la oferta post-análisis aparece sólo con una fuente que
 *    terminó, y el descarte es por marca.
 * 3. Remix en el refill: la sugerencia guarda `sourceTrendingItemId` y
 *    `remixSourceUrl` — y **no** si la referencia es de otra marca.
 * 4. `audio-extract`: del video del Media Bank a una pista `extracted`,
 *    idempotente por `extractionId`, con códigos estables al fallar.
 *
 * Lo falso son los extremos: el lector de la red, el sintetizador y FFmpeg.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { audioExtractionStatusKey, parseAudioExtractionStatus } from "@fastgram/core";
import {
  APP_ROLE,
  brandAnalysisStore,
  brandFlowStore,
  brandSources,
  companyProfiles,
  discoveryQueueStore,
  media,
  migrateWithUrl,
  trendingItems,
  withCompany,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import type {
  JobContext,
  SocialContentItem,
  SocialProfileSignals,
  SocialReadCapabilities,
  SocialReader,
  SocialReadOutcome,
} from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAudioExtractHandler,
  type AudioExtractor,
} from "../src/audio-extract/handler.js";
import { createBrandSourceAnalysisHandler } from "../src/brand/analysis-handler.js";
import type { BrandSynthesizer } from "../src/brand/synthesizer.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { withRemixSource } from "../src/discovery/refill-handler.js";
import { DATABASE_URL, openDb, seedCompany } from "./helpers/fixtures.js";

const clock = new FixedClock(new Date("2026-09-24T12:00:00.000Z"));
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

const ctx = (payload: unknown, attempt = 1, maxAttempts = 2): JobContext<unknown> => ({
  jobId: `job_${randomUUID()}`,
  payload,
  attempt,
  maxAttempts,
});

async function fase(id: string): Promise<string | null> {
  const [row] = await handle.sql<{ analysis_phase: string | null }[]>`
    select analysis_phase from brand_sources where id = ${id}::uuid`;
  return row?.analysis_phase ?? null;
}

async function seedProfile(companyId: string): Promise<void> {
  await withoutCompany(handle.db, (tx) =>
    tx.insert(companyProfiles).values({ companyId }),
  );
}

async function seedSource(
  companyId: string,
  over: Partial<typeof brandSources.$inferInsert> = {},
): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(brandSources)
      .values({
        companyId,
        sourceType: "instagram",
        handle: `marca_${randomUUID().slice(0, 8)}`,
        canonicalUrl: `https://www.instagram.com/marca_${randomUUID().slice(0, 8)}`,
        acquisitionTier: "B_public_api",
        status: "pending",
        isPrimary: true,
        ...over,
      })
      .returning({ id: brandSources.id });
    if (row === undefined) throw new Error("no se sembró la fuente");
    return row.id;
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Fases del análisis
// ───────────────────────────────────────────────────────────────────────────

const CAPS = (source: "instagram" | "website"): SocialReadCapabilities => ({
  source,
  tiers: ["B_public_api"],
  profileSignals: [],
  contentSignals: [],
  maxContentItems: 10,
  requiresConnection: false,
  renderedFetchEnabled: false,
});

/** Un lector que anota la fase de la fuente cada vez que el handler lo llama. */
function espia(
  source: "instagram" | "website",
  seen: string[],
  sourceId: () => string,
  profile: SocialProfileSignals,
): SocialReader {
  return {
    source,
    capabilities: () => CAPS(source),
    resolve: () => Promise.reject(new Error("no se usa")),
    async readProfile(): Promise<SocialReadOutcome<SocialProfileSignals>> {
      seen.push(`${source}.profile:${String(await fase(sourceId()))}`);
      return { status: "ok", tier: "B_public_api", data: profile };
    },
    async readRecentContent(): Promise<SocialReadOutcome<readonly SocialContentItem[]>> {
      return { status: "ok", tier: "B_public_api", data: [] };
    },
  };
}

describe("P1-ONB-005 — la fase real del análisis", () => {
  it("collecting → reading_links → synthesizing → verifying, y se limpia al terminar", async () => {
    const companyId = await seedCompany(handle);
    await seedProfile(companyId);
    let id = "";
    const seen: string[] = [];
    const synthesizer: BrandSynthesizer = {
      async synthesize(_input, progress) {
        seen.push(`synth:${String(await fase(id))}`);
        await progress?.onVerifying?.();
        seen.push(`verify:${String(await fase(id))}`);
        return { fields: [], rejected: [], fenceEscapeAttempts: 0, model: "m" };
      },
    };
    const handler = createBrandSourceAnalysisHandler({
      db: handle.db,
      readers: {
        instagram: espia("instagram", seen, () => id, {
          bio: "Tazas hechas a mano",
          links: ["https://linktr.ee/marca"],
        }),
        website: espia("website", seen, () => id, { about: "destino del link" }),
      },
      synthesizer,
      rawRetentionDays: 30,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    });
    id = await seedSource(companyId);

    await handler(ctx({ companyId, brandSourceId: id, itemsPerAnalysis: 5 }, 1, 3));

    expect(seen).toEqual([
      "instagram.profile:collecting",
      "website.profile:reading_links",
      "synth:synthesizing",
      "verify:verifying",
    ]);
    const [row] = await handle.sql<{ status: string; analysis_phase: string | null }[]>`
      select status, analysis_phase from brand_sources where id = ${id}::uuid`;
    expect(row?.analysis_phase).toBeNull();
    expect(["ready", "partial"]).toContain(row?.status);
  });

  it("sin links en la bio no pasa por reading_links; un fallo también limpia la fase", async () => {
    const companyId = await seedCompany(handle);
    await seedProfile(companyId);
    let id = "";
    const seen: string[] = [];
    const synthesizer: BrandSynthesizer = {
      async synthesize() {
        seen.push(`synth:${String(await fase(id))}`);
        throw new Error("el LLM se cayó");
      },
    };
    const handler = createBrandSourceAnalysisHandler({
      db: handle.db,
      readers: { instagram: espia("instagram", seen, () => id, { bio: "Tazas" }) },
      synthesizer,
      rawRetentionDays: 30,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    });
    id = await seedSource(companyId);
    // Último intento: el fallo es terminal y la fuente queda `failed`.
    await handler(ctx({ companyId, brandSourceId: id, itemsPerAnalysis: 5 }, 3, 3));
    expect(seen).toEqual(["instagram.profile:collecting", "synth:synthesizing"]);
    const [row] = await handle.sql<{ status: string; analysis_phase: string | null }[]>`
      select status, analysis_phase from brand_sources where id = ${id}::uuid`;
    expect(row).toEqual({ status: "failed", analysis_phase: null });
  });

  it("una fase no se pinta sobre una fuente que ya no analiza", async () => {
    const companyId = await seedCompany(handle);
    const id = await seedSource(companyId, { status: "ready" });
    const wrote = await withCompany(
      handle.db,
      companyId,
      (tx) =>
        brandAnalysisStore.setBrandSourceAnalysisPhase(
          tx,
          { companyId },
          id,
          "synthesizing",
        ),
      { role: APP_ROLE },
    );
    expect(wrote).toBe(false);
    expect(await fase(id)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Oferta post-análisis
// ───────────────────────────────────────────────────────────────────────────

describe("P1-ONB-007 — la oferta, después del análisis y descartable", () => {
  it("sin fuente terminada no hay fuente que ofrecer; con una, sí; descartada, queda", async () => {
    const companyId = await seedCompany(handle);
    await seedProfile(companyId);
    const scope = { companyId };
    const read = () =>
      withCompany(
        handle.db,
        companyId,
        (tx) => brandFlowStore.readPostAnalysisOffer(tx, scope),
        {
          role: APP_ROLE,
        },
      );

    const id = await seedSource(companyId, { status: "analyzing" });
    expect((await read()).analysedSource).toBeNull();

    // Un `failed` también mueve `lastAnalysedAt`: no cuenta como terminado.
    await handle.sql`update brand_sources set status = 'failed', last_analysed_at = now() where id = ${id}::uuid`;
    expect((await read()).analysedSource).toBeNull();

    await handle.sql`update brand_sources set status = 'partial' where id = ${id}::uuid`;
    const ready = await read();
    expect(ready.analysedSource?.sourceType).toBe("instagram");
    expect(ready.dismissedAt).toBeNull();

    const dismissed = await withCompany(
      handle.db,
      companyId,
      (tx) => brandFlowStore.dismissPostAnalysisOffer(tx, scope, new Date(clock.nowMs())),
      { role: APP_ROLE },
    );
    expect(dismissed).toBe(true);
    expect((await read()).dismissedAt?.toISOString()).toBe("2026-09-24T12:00:00.000Z");
  });

  it("el descarte de una marca no toca a otra", async () => {
    const a = await seedCompany(handle);
    const b = await seedCompany(handle);
    await seedProfile(a);
    await seedProfile(b);
    await withoutCompany(handle.db, (tx) =>
      brandFlowStore.dismissPostAnalysisOffer(tx, { companyId: a }, new Date()),
    );
    const other = await withoutCompany(handle.db, (tx) =>
      brandFlowStore.readPostAnalysisOffer(tx, { companyId: b }),
    );
    expect(other.dismissedAt).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Remix en el refill
// ───────────────────────────────────────────────────────────────────────────

async function seedReference(
  companyId: string | null,
  permalink: string,
): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(trendingItems)
      .values({
        companyId,
        origin: companyId === null ? "catalog" : "owner",
        platform: "tiktok",
        permalink,
        title: "referencia",
      })
      .returning({ id: trendingItems.id });
    if (row === undefined) throw new Error("no se sembró la referencia");
    return row.id;
  });
}

const DRAFT = {
  contentType: "wall-of-text",
  aiExplanation: "porque sí",
  angleId: null,
  influencerId: null,
  textStylePresetId: null,
  generatedText: "hola",
  buildPlan: null,
};

describe("remix en el refill — «Remixed From»", () => {
  it("guarda la referencia propia o global, y descarta una ajena", async () => {
    const companyId = await seedCompany(handle);
    const other = await seedCompany(handle);
    const own = await seedReference(companyId, "https://www.tiktok.com/@a/video/1");
    const global = await seedReference(null, "https://www.tiktok.com/@g/video/2");
    const foreign = await seedReference(other, "https://www.tiktok.com/@b/video/3");

    // Sin GUC (trampa 26): lo que se mide es el filtro de la sentencia, no RLS.
    const result = await withoutCompany(handle.db, (tx) =>
      discoveryQueueStore.refillQueue(tx, { companyId }, 10, [
        withRemixSource(
          { ...DRAFT, generatedText: "own" },
          { id: own, permalink: "https://www.tiktok.com/@a/video/1" },
        ),
        withRemixSource(
          { ...DRAFT, generatedText: "global" },
          { id: global, permalink: null },
        ),
        withRemixSource(
          { ...DRAFT, generatedText: "foreign" },
          { id: foreign, permalink: "https://www.tiktok.com/@b/video/3" },
        ),
        { ...DRAFT, generatedText: "original" },
      ]),
    );
    expect(result.insertedIds).toHaveLength(4);

    const rows = await handle.sql<
      {
        generated_text: string;
        source_trending_item_id: string | null;
        remix_source_url: string | null;
      }[]
    >`select generated_text, source_trending_item_id, remix_source_url
        from suggestions where company_id = ${companyId}::uuid order by generated_text`;
    expect(rows).toEqual([
      {
        generated_text: "foreign",
        source_trending_item_id: null,
        remix_source_url: null,
      },
      {
        generated_text: "global",
        source_trending_item_id: global,
        // El borrador no traía link: manda el `permalink` guardado de la referencia.
        remix_source_url: "https://www.tiktok.com/@g/video/2",
      },
      {
        generated_text: "original",
        source_trending_item_id: null,
        remix_source_url: null,
      },
      {
        generated_text: "own",
        source_trending_item_id: own,
        remix_source_url: "https://www.tiktok.com/@a/video/1",
      },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. audio-extract
// ───────────────────────────────────────────────────────────────────────────

class FakeExtractor implements AudioExtractor {
  hasAudio = true;
  duration: number | null = 42;
  ok = true;
  calls = 0;
  async probe(): Promise<{ durationSeconds: number | null; hasAudio: boolean }> {
    return { durationSeconds: this.duration, hasAudio: this.hasAudio };
  }
  async extract(_input: string, output: string): Promise<boolean> {
    this.calls += 1;
    if (!this.ok) return false;
    await writeFile(output, new Uint8Array([1, 2, 3, 4]));
    return true;
  }
}

async function seedVideo(
  storage: MemoryStorage,
  companyId: string,
  over: Partial<typeof media.$inferInsert> = {},
): Promise<string> {
  const key = `media/${companyId}/${randomUUID()}.mp4`;
  await storage.put({
    key,
    body: new Uint8Array([0, 0, 0, 24]),
    contentType: "video/mp4",
  });
  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(media)
      .values({
        companyId,
        mediaType: "video",
        filename: "Mi demo.mp4",
        r2Url: `https://cdn.example.test/${key}`,
        storageKey: key,
        status: "ready",
        sizeMb: 0.1,
        videoDurationSec: 42,
        origin: "manual_upload",
        ...over,
      })
      .returning({ mediaId: media.mediaId });
    if (row === undefined) throw new Error("no se sembró el video");
    return row.mediaId;
  });
}

async function readStatus(storage: MemoryStorage, companyId: string, id: string) {
  const stream = await storage.get(audioExtractionStatusKey(companyId, id));
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  return parseAudioExtractionStatus(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

describe("audio-extract", () => {
  it("crea la pista `extracted` bajo audio/{companyId}/ y un reintento no la duplica", async () => {
    const storage = new MemoryStorage(clock);
    const companyId = await seedCompany(handle);
    const mediaId = await seedVideo(storage, companyId);
    const extractor = new FakeExtractor();
    const handler = createAudioExtractHandler({
      db: handle.db,
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      extractor,
    });
    const extractionId = randomUUID();
    await handler(ctx({ companyId, extractionId, mediaId }));

    const status = await readStatus(storage, companyId, extractionId);
    expect(status?.state).toBe("done");
    const tracks = await handle.sql<
      {
        id: string;
        title: string;
        origin: string;
        storage_key: string;
        duration_sec: number;
        content_type: string;
      }[]
    >`select id, title, origin, storage_key, duration_sec, content_type
        from brand_audio_tracks where company_id = ${companyId}::uuid`;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: status?.trackId,
      title: "Mi demo (audio)",
      origin: "extracted",
      storage_key: `audio/${companyId}/extracted/${extractionId}.m4a`,
      duration_sec: 42,
      content_type: "audio/mp4",
    });

    // Un estado terminal corta: el reintento no vuelve a correr FFmpeg.
    await handler(ctx({ companyId, extractionId, mediaId }));
    expect(extractor.calls).toBe(1);
    const [count] = await handle.sql<{ n: number }[]>`
      select count(*)::int as n from brand_audio_tracks where company_id = ${companyId}::uuid`;
    expect(count?.n).toBe(1);
  });

  it("falla con códigos estables: sin audio, largo, y video ajeno", async () => {
    const storage = new MemoryStorage(clock);
    const companyId = await seedCompany(handle);
    const other = await seedCompany(handle);
    const extractor = new FakeExtractor();
    const handler = createAudioExtractHandler({
      db: handle.db,
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      extractor,
    });

    const mute = await seedVideo(storage, companyId);
    extractor.hasAudio = false;
    const a = randomUUID();
    await handler(ctx({ companyId, extractionId: a, mediaId: mute }));
    expect(await readStatus(storage, companyId, a)).toMatchObject({
      state: "failed",
      error: "no_audio",
    });

    extractor.hasAudio = true;
    const long = await seedVideo(storage, companyId, { videoDurationSec: 900 });
    const b = randomUUID();
    await handler(ctx({ companyId, extractionId: b, mediaId: long }));
    expect(await readStatus(storage, companyId, b)).toMatchObject({
      state: "failed",
      error: "too_long",
    });

    // El video de otra marca, pedido con este `companyId`: no existe.
    const foreign = await seedVideo(storage, other);
    const c = randomUUID();
    await handler(ctx({ companyId, extractionId: c, mediaId: foreign }));
    expect(await readStatus(storage, companyId, c)).toMatchObject({
      state: "failed",
      error: "media_not_found",
    });

    extractor.ok = false;
    const broken = await seedVideo(storage, companyId);
    const d = randomUUID();
    await handler(ctx({ companyId, extractionId: d, mediaId: broken }));
    expect(await readStatus(storage, companyId, d)).toMatchObject({
      state: "failed",
      error: "extract_failed",
    });

    const [count] = await handle.sql<{ n: number }[]>`
      select count(*)::int as n from brand_audio_tracks where company_id = ${companyId}::uuid`;
    expect(count?.n).toBe(0);
  });
});
