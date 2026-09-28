/**
 * Lo que el planificador de reels lee de una marca, en una transacción con su
 * scope — sprint 9 (U), `PU-S9-014`.
 *
 * Una sola lectura por corrida: estrategia, zona, perfil, ángulos con sus
 * pesos de Blitz, design system activo (tokens, archivos de fuente, logos y
 * motivos), preferencias aprendidas, y los candidatos de assets de la marca:
 * clips y fondos del Media Bank y música de su biblioteca de audio. Los de la
 * biblioteca global (D-19) se piden por rol al decidir (`materialize.ts`).
 * Lo que falla al leer una parte
 * opcional (preferencias, design system, biblioteca) no corta la corrida: se
 * sigue sin eso, como antes del sprint 9.
 */
import {
  formatMixSchema,
  networkStrategySchema,
  type NetworkStrategy,
} from "@fastgram/contracts";
import {
  copyStyleFrom,
  loadPreferences,
  readDesignSystemStyle,
  readDesignSystemTokens,
  readStoredAssets,
  readStoredFontFiles,
  type CopyBrandProfile,
  type CopyDesignStyle,
  type DesignSystemTokens,
  type LearnedPreferences,
  type ReelPlanningAngle,
  type StoredDesignFontFile,
} from "@fastgram/core";
import {
  blitzPreferencesRepository,
  brandAudioRepository,
  brandStrategyRepository,
  companyProfileRepository,
  companyRepository,
  contentAngleRepository,
  designSystemRepository,
  findLiveMedia,
  preferenceSnapshotStore,
  searchMedia,
  type Transaction,
} from "@fastgram/db";
import { z } from "zod";

/** Un asset que puede ir en un reel, venga de la marca o de la biblioteca global. */
export interface ReelMediaCandidate {
  /** Nuestro id (media o library_assets). */
  readonly id: string;
  readonly source: "brand" | "library";
  readonly mediaType: "image" | "video";
  readonly url: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly durationSec: number | null;
  /** Clips: croma del archivo. */
  readonly chroma: "green" | "blue" | "alpha" | "none";
  readonly hasSpeech: boolean | null;
  /** Biblioteca: el tipo de licencia (el decisor exige una verificable). */
  readonly license: string | null;
}

export interface ReelTrackCandidate {
  readonly id: string;
  readonly source: "brand" | "library";
  readonly url: string;
  readonly title: string;
  readonly durationSec: number | null;
  readonly license: string | null;
}

export interface ReelBrandContext {
  readonly companyId: string;
  readonly timezone: string;
  readonly businessName: string;
  readonly profile: CopyBrandProfile;
  /** `null` = la marca no guardó estrategia: no se planifica. */
  readonly strategy: {
    readonly networks: readonly { enabled: boolean; perDay: number; dailyCap: number }[];
    readonly formatMix: Readonly<Record<string, number>>;
    readonly language: string;
    readonly autonomy: "manual" | "autopilot";
    readonly networkPlans: readonly NetworkStrategy[];
  } | null;
  readonly angles: readonly (ReelPlanningAngle & { readonly description: string | null })[];
  readonly prefs: LearnedPreferences | null;
  readonly designSystem: {
    readonly tokens: DesignSystemTokens;
    readonly fontFiles: readonly StoredDesignFontFile[];
    readonly logos: readonly { readonly url: string }[];
    readonly motifs: readonly { readonly url: string }[];
    readonly imagery: readonly ReelMediaCandidate[];
    readonly copyStyle: CopyDesignStyle | null;
    /** `tokens.logoLayer.enabled` de S, si la marca lo tocó. */
    readonly logoEnabled: boolean | null;
    readonly styleRules: string | null;
  } | null;
  readonly clips: readonly ReelMediaCandidate[];
  readonly backgrounds: readonly ReelMediaCandidate[];
  readonly tracks: readonly ReelTrackCandidate[];
}

const ORIGINS = ["manual_upload", "brand_kit", "imported", "generated"] as const;

/** Un recorte con alfa (`PU-MEME-002`) llega como webm/mov; el resto, verde (mismo criterio que P). */
const chromaOfUrl = (url: string): "green" | "alpha" =>
  /\.(webm|mov)(\?|$)/iu.test(url) ? "alpha" : "green";

async function savepoint<T>(tx: Transaction, fn: (sp: Transaction) => Promise<T>): Promise<T | null> {
  try {
    return await tx.transaction(fn);
  } catch {
    return null;
  }
}

function parseAngleWeights(raw: unknown): Record<string, number> {
  const parsed = z.record(z.string(), z.number()).safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export async function readReelBrandContext(
  tx: Transaction,
  companyId: string,
  nowMs: number,
): Promise<ReelBrandContext> {
  const scope = { companyId };
  const company = await companyRepository.load(tx, scope);
  const profile = (await companyProfileRepository.list(tx, scope, { limit: 1 })).items[0];
  const row = await brandStrategyRepository.find(tx, scope);
  const networks = z.array(networkStrategySchema).safeParse(row?.networks ?? []);
  const mix = formatMixSchema.safeParse(row?.formatMix ?? {});
  const strategy =
    row === null || row === undefined || !networks.success
      ? null
      : {
          networks: networks.data,
          formatMix: mix.success ? (mix.data as Record<string, number>) : {},
          language: row.language,
          autonomy: row.autonomy,
          networkPlans: networks.data,
        };

  const angleRows = (
    await contentAngleRepository.listByPage(tx, scope, { page: 1, limit: 100 })
  ).items.filter((a) => a.isActive);
  const prefsRow = await blitzPreferencesRepository.findById(tx, scope, companyId);
  const weights = parseAngleWeights(prefsRow?.angleWeights);
  const hasWeights = angleRows.some((a) => (weights[a.id] ?? 0) > 0);
  const angles = angleRows.map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description ?? null,
    // Sin pesos guardados, todos iguales (el refill hace lo mismo al reconciliar).
    weight: hasWeights ? (weights[a.id] ?? 0) : 1,
  }));

  const prefs = await savepoint(tx, (sp) =>
    loadPreferences(preferenceSnapshotStore(sp), companyId, { nowMs }),
  );

  const designSystem = await savepoint(tx, async (sp) => {
    const ds = await designSystemRepository.findActive(sp, scope);
    if (ds === null) return null;
    const tokens = readDesignSystemTokens(ds.tokens);
    if (tokens === null) return null;
    const stored = readStoredAssets(ds.assets);
    const live = new Map(
      (await findLiveMedia(sp, scope, stored.map((a) => a.mediaId))).map((m) => [m.mediaId, m]),
    );
    const urlsOf = (kind: "logo" | "motif") =>
      stored.flatMap((a) => {
        const m = live.get(a.mediaId);
        return a.kind === kind && m !== undefined ? [{ url: m.url }] : [];
      });
    const imagery: ReelMediaCandidate[] = stored.flatMap((a) => {
      const m = live.get(a.mediaId);
      if (a.kind !== "imagery" || m === undefined) return [];
      return [
        {
          id: a.mediaId,
          source: "brand" as const,
          mediaType: m.mediaType,
          url: m.url,
          title: a.filename,
          tags: ["design-system", "imagery"],
          durationSec: null,
          chroma: "none" as const,
          hasSpeech: null,
          license: null,
        },
      ];
    });
    const style = readDesignSystemStyle(ds.style);
    const layer = (tokens as { readonly logoLayer?: { readonly enabled?: unknown } }).logoLayer;
    return {
      tokens,
      fontFiles: readStoredFontFiles(ds.fonts),
      logos: urlsOf("logo"),
      motifs: urlsOf("motif"),
      imagery,
      copyStyle: copyStyleFrom(style),
      logoEnabled: typeof layer?.enabled === "boolean" ? layer.enabled : null,
      styleRules:
        style === null ? null : [...style.compositionRules, ...style.donts].slice(0, 6).join(" / "),
    };
  });

  const search = async (mediaType: "image" | "video", category: string | undefined) =>
    (
      await searchMedia(tx, scope, {
        limit: 50,
        mediaType,
        origins: [...ORIGINS],
        ...(category === undefined ? {} : { category }),
      })
    ).items.filter((m) => m.status === "ready");
  const clipRows = await search("video", "green-screen-video");
  let bgRows = [
    ...(await search("image", "green-screen-background")),
    ...(await search("video", "wall-of-text-video")),
  ];
  if (bgRows.length === 0) bgRows = await search("image", undefined);
  const media = (m: (typeof clipRows)[number], clip: boolean): ReelMediaCandidate => ({
    id: m.mediaId,
    source: "brand",
    mediaType: m.mediaType,
    url: m.r2Url,
    title: m.filename,
    tags: m.tags ?? [],
    durationSec: m.videoDurationSec ?? null,
    chroma: clip ? chromaOfUrl(m.r2Url) : "none",
    hasSpeech: null,
    license: null,
  });
  const clips = clipRows.map((m) => media(m, true));
  const backgrounds = bgRows.map((m) => media(m, false));

  const trackRows = await brandAudioRepository.listAutoUse(tx, scope, 50);
  const tracks: ReelTrackCandidate[] = trackRows.map((t) => ({
    id: t.id,
    source: "brand",
    url: t.url,
    title: t.title,
    durationSec: t.durationSec ?? null,
    license: null,
  }));

  // D-19: la biblioteca global entra por rol en `materialize.ts`
  // (`createLibrarySource` de T: candidatos por texto y, si gana, copia a la marca).

  return {
    companyId,
    timezone: company?.timezone ?? "UTC",
    businessName: company?.name ?? "",
    profile: profile ?? {},
    strategy,
    angles,
    prefs,
    designSystem,
    clips,
    backgrounds: [...(designSystem?.imagery ?? []), ...backgrounds],
    tracks,
  };
}
