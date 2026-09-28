/**
 * Armar un reel del plan — sprint 9 (U), `PU-S9-014`: copy (modelo `text`),
 * assets (decisor de O sobre marca + biblioteca global), la marca (design
 * system de M) y el spec; después el póster. Todo fuera de la transacción: el
 * modelo local tarda decenas de segundos y el póster lanza Chrome.
 *
 * Nada de esto tira la corrida: sin modelo, la copy sale del ángulo; sin
 * juicio, el decisor cae al ranking textual; sin render, no hay póster (la
 * tarjeta muestra el texto). Lo que sí corta un ítem es un spec que no valida
 * contra el contrato: se marca `failed` con el motivo.
 */
import { randomUUID } from "node:crypto";

import {
  reelFontUrls,
  reelMediaUrls,
  reelSpecSchema,
  type ReelSpec,
} from "@fastgram/contracts";
import {
  REEL_DEFAULT_LOOK,
  buildReelCopyRequest,
  parseReelCopy,
  planReel,
  reelCopyFromAngle,
  reelLanguageOf,
  reelLookFromDesignSystem,
  reelSpecFromPlan,
  type AssetCandidate,
  type AssetDecision,
  type AssetDecisionInput,
  type DecisionBrand,
  type PlannedReelCopy,
  type ReelBrandLook,
  type ReelClipAsset,
  type ReelMotion,
  type ReelTemplate,
  type ReelVisualAsset,
} from "@fastgram/core";
import type { Llm, Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { reelMediaAuthorization } from "../content/reel-job.js";
import { runAssetDecision, type AssetJudge } from "../judgment/asset-decider.js";
import type { LibrarySource } from "../judgment/library-source.js";
import type { ReelBrandContext, ReelMediaCandidate, ReelTrackCandidate } from "./context.js";
import type { ReelRenderClient } from "./render-client.js";

/** Plazo del modelo `text` por reel. qwen 7B local tardó 30–60 s por pedido (sprint 8). */
export const REEL_COPY_TIMEOUT_MS = 180_000;

export interface MaterializeDeps {
  readonly logger: BuildLogger;
  readonly storage: Storage;
  readonly llm: Llm | null;
  readonly judge: AssetJudge | null;
  readonly render: ReelRenderClient | null;
  /** El motor de subtítulos del render tiene modelo (si no, el reel va sin subtítulos). */
  readonly captionsAvailable: boolean;
  /**
   * La biblioteca global (T): candidatos por rol y, si uno gana, su **copia**
   * en el Media Bank de la marca (así el grant y el chequeo de media viva son
   * los de siempre). `null` = sin biblioteca.
   */
  readonly library: LibrarySource | null;
}

export interface ReelSlotInput {
  readonly itemId: string;
  readonly template: ReelTemplate;
  readonly motion: ReelMotion;
  readonly angle: { readonly id: string; readonly title: string; readonly description: string | null } | null;
}

export interface ChosenAssets {
  readonly backgrounds: readonly { id: string; source: string; url: string; kind: "image" | "video" }[];
  readonly clip: { id: string; source: string; url: string; chroma: string } | null;
  readonly music: { id: string; source: string; url: string } | null;
  readonly logo: string | null;
  readonly motif: string | null;
  readonly picks: readonly string[];
  readonly modes: Readonly<Record<string, string>>;
}

export type MaterializedReel =
  | {
      readonly ok: true;
      readonly idea: string;
      readonly copy: PlannedReelCopy["copy"];
      readonly copySource: "model" | "angle";
      readonly template: ReelTemplate;
      readonly spec: ReelSpec;
      readonly assets: ChosenAssets;
      /** Media del Media Bank usada (se comprueba viva al aceptar). */
      readonly mediaIds: readonly string[];
      readonly posterKey: string | null;
      readonly lookNotes: readonly string[];
      readonly clipKind: "chroma" | "alpha" | "opaque" | "none";
    }
  | { readonly ok: false; readonly reason: string };

function decisionBrand(ctx: ReelBrandContext): DecisionBrand {
  const p = ctx.profile;
  return {
    name: ctx.businessName,
    identity: p.coreIdentity ?? null,
    tone: p.toneOfVoice ?? null,
    audience: p.targetAudience ?? null,
    styleRules: ctx.designSystem?.styleRules ?? null,
  };
}

const describe = (c: { title: string; tags: readonly string[] }): string =>
  [c.title, c.tags.slice(0, 8).join(", ")].filter((x) => x !== "").join(" — ").slice(0, 300);

function mediaCandidate(c: ReelMediaCandidate, kind: AssetCandidate["kind"]): AssetCandidate {
  return {
    id: c.id,
    kind,
    source: c.source,
    description: describe(c),
    tags: [...c.tags],
    durationSec: c.durationSec,
    ...(c.source === "library" ? { license: c.license } : {}),
  };
}

function trackCandidate(t: ReelTrackCandidate): AssetCandidate {
  return {
    id: t.id,
    kind: "audio",
    source: t.source,
    description: `music track: ${t.title}`,
    durationSec: t.durationSec,
    ...(t.source === "library" ? { license: t.license } : {}),
  };
}

/** El elegido primero y después el resto por puntaje y ranking textual (para varios fondos). */
function rankedIds(decision: AssetDecision): string[] {
  const out: string[] = [];
  if (decision.chosenId !== null) out.push(decision.chosenId);
  const excluded = new Set(decision.excluded.map((e) => e.id));
  const rest = [...decision.scored]
    .filter((s) => !excluded.has(s.id) && s.id !== decision.chosenId)
    .filter((s) => s.harm === null || s.harm < 0.5)
    .sort(
      (a, b) =>
        (b.total ?? -1) - (a.total ?? -1) || a.textRank - b.textRank,
    );
  for (const s of rest) out.push(s.id);
  return out;
}

/**
 * Un ganador de la biblioteca global, ya **copiado** a la marca (T,
 * `library-source.ts`): de ahí en más es media de la marca como cualquier
 * otra. `null` si el id no es de la biblioteca o la copia no se pudo.
 */
async function fromLibrary(
  deps: MaterializeDeps,
  pool: readonly AssetCandidate[],
  id: string,
  mediaType: "image" | "video" | null,
  chroma: ReelMediaCandidate["chroma"],
): Promise<ReelMediaCandidate | null> {
  const candidate = pool.find((c) => c.id === id);
  if (deps.library === null || candidate === undefined) return null;
  const copy = await deps.library.materialize(id);
  if (copy === null) return null;
  return {
    id: copy.id,
    source: "brand",
    mediaType: mediaType ?? copy.mediaType,
    url: copy.url,
    title: copy.title ?? candidate.description,
    tags: [...(candidate.tags ?? [])],
    durationSec: candidate.durationSec ?? null,
    chroma,
    hasSpeech: null,
    license: null,
  };
}

async function decide(
  deps: MaterializeDeps,
  input: AssetDecisionInput,
): Promise<AssetDecision> {
  if (deps.judge !== null) return deps.judge.decide(input);
  return (await runAssetDecision(null, input, deps.logger)).decision;
}

async function writeCopy(
  deps: MaterializeDeps,
  ctx: ReelBrandContext,
  slot: ReelSlotInput,
): Promise<{ value: PlannedReelCopy; source: "model" | "angle" }> {
  const language = ctx.strategy?.language ?? null;
  if (deps.llm !== null) {
    const request = buildReelCopyRequest(
      {
        template: slot.template,
        businessName: ctx.businessName,
        profile: ctx.profile,
        angle: slot.angle,
        designStyle: ctx.designSystem?.copyStyle ?? null,
        language,
      },
      `FG-${randomUUID()}`,
    );
    // Dos intentos: un modelo chico se pasa del tope de vez en cuando.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const out = await deps.llm.completeJson({
          messages: request.messages,
          untrusted: request.untrusted,
          schema: request.schema,
          schemaName: request.schemaName,
          timeoutMs: REEL_COPY_TIMEOUT_MS,
        });
        const parsed = parseReelCopy(out.value, slot.template, language);
        if (parsed.ok) return { value: parsed.value, source: "model" };
        deps.logger.warn(
          { companyId: ctx.companyId, template: slot.template, reason: parsed.reason, attempt },
          "reel: copy del modelo descartada",
        );
      } catch (error: unknown) {
        deps.logger.warn(
          {
            companyId: ctx.companyId,
            reason: error instanceof Error ? error.message.slice(0, 200) : "error",
            attempt,
          },
          "reel: el modelo text no respondió",
        );
        break;
      }
    }
  }
  return {
    value: reelCopyFromAngle(slot.angle, ctx.businessName, slot.template),
    source: "angle",
  };
}

/** Cuántos fondos pide cada plantilla (uno por beat en la lista, hasta 3 distintos). */
function backgroundsFor(template: ReelTemplate, beats: number): number {
  if (template === "before-after") return 2;
  if (template === "list-beats") return Math.min(3, 1 + beats);
  return 1;
}

export async function materializeReel(
  deps: MaterializeDeps,
  ctx: ReelBrandContext,
  slot: ReelSlotInput,
  /** Assets ya usados esta semana: el decisor los excluye (`recent`) si hay otros. */
  recentIds: Set<string>,
): Promise<MaterializedReel> {
  const { value, source } = await writeCopy(deps, ctx, slot);
  const idea = value.idea;
  const brand = decisionBrand(ctx);
  const picks: string[] = [];
  const modes: Record<string, string> = {};

  // La plantilla puede degradarse si la copy o los assets no alcanzan.
  let template = slot.template;
  if (template === "list-beats" && value.copy.beats.length < 2 && ctx.clips.length > 0) {
    template = "hook-reaction-punchline";
  }

  let clip: ReelMediaCandidate | null = null;
  const libClips =
    template === "hook-reaction-punchline" && deps.library !== null
      ? await deps.library.candidates({ format: "green-screen", role: "meme", idea })
      : [];
  if (template === "hook-reaction-punchline" && ctx.clips.length + libClips.length > 0) {
    const d = await decide(deps, {
      idea,
      brand,
      format: "green-screen",
      role: "meme",
      candidates: [...ctx.clips.map((c) => mediaCandidate(c, "meme_clip")), ...libClips],
      recentIds,
    });
    modes["meme"] = d.mode;
    for (const id of rankedIds(d)) {
      clip =
        ctx.clips.find((c) => c.id === id) ??
        (await fromLibrary(deps, libClips, id, "video", "green"));
      if (clip !== null) break;
    }
    if (clip !== null) {
      recentIds.add(clip.id);
      picks.push(`Meme: ${d.reason.replace(/^Picked/u, "picked")}`);
    }
  }
  if (template === "hook-reaction-punchline" && clip === null) template = "list-beats";

  const bgWanted = backgroundsFor(template, value.copy.beats.length);
  const bgs: ReelMediaCandidate[] = [];
  const libBgs =
    deps.library === null
      ? []
      : await deps.library.candidates({ format: "green-screen", role: "background", idea });
  if (ctx.backgrounds.length + libBgs.length > 0) {
    const d = await decide(deps, {
      idea,
      brand,
      format: "green-screen",
      role: "background",
      candidates: [
        ...ctx.backgrounds.map((c) =>
          mediaCandidate(c, c.mediaType === "video" ? "background_video" : "background_image"),
        ),
        ...libBgs,
      ],
      recentIds,
    });
    modes["background"] = d.mode;
    for (const id of rankedIds(d)) {
      const found =
        ctx.backgrounds.find((c) => c.id === id) ??
        (await fromLibrary(deps, libBgs, id, null, "none"));
      if (found !== null && !bgs.some((b) => b.id === found.id)) bgs.push(found);
      if (bgs.length >= bgWanted) break;
    }
    // El ranking puede dejar afuera a los usados esta semana: si falta, se completa con ellos.
    for (const c of ctx.backgrounds) {
      if (bgs.length >= bgWanted) break;
      if (!bgs.includes(c)) bgs.push(c);
    }
    for (const b of bgs) recentIds.add(b.id);
    if (bgs.length > 0) picks.push(`Background: ${d.reason.replace(/^Picked/u, "picked")}`);
  }
  if (template === "before-after" && bgs.length < 2) template = "list-beats";

  let track: ReelTrackCandidate | null = null;
  if (ctx.tracks.length > 0) {
    const d = await decide(deps, {
      idea,
      brand,
      format: "green-screen",
      role: "music",
      candidates: ctx.tracks.map(trackCandidate),
      recentIds,
    });
    modes["music"] = d.mode;
    track = ctx.tracks.find((t) => t.id === rankedIds(d)[0]) ?? ctx.tracks[0] ?? null;
    if (track !== null) picks.push(`Music: ${track.title}`);
  }

  // La marca: logo por luminancia (medida por el render), fuentes y colores.
  let look: ReelBrandLook = REEL_DEFAULT_LOOK;
  const ds = ctx.designSystem;
  if (ds !== null) {
    let lum = new Map<string, number | null>();
    const firstBg = bgs[0];
    const measure = [
      ...ds.logos.map((l) => l.url),
      ...(firstBg !== undefined && firstBg.mediaType === "image" ? [firstBg.url] : []),
    ];
    if (deps.render !== null && measure.length > 0) {
      try {
        lum = new Map(
          await deps.render.imageStats(
            measure,
            await reelMediaAuthorization(deps.storage, {
              companyId: ctx.companyId,
              objectPrefix: "content",
              urls: measure,
              fontUrls: [],
            }),
          ),
        );
      } catch (error: unknown) {
        deps.logger.warn(
          { companyId: ctx.companyId, reason: error instanceof Error ? error.message : "error" },
          "reel: no se pudo medir la luminancia de los logos (va el primero)",
        );
      }
    }
    look = reelLookFromDesignSystem({
      tokens: ds.tokens,
      fontFiles: ds.fontFiles,
      logos: ds.logos.map((l) => ({ url: l.url, luminance: lum.get(l.url) ?? null })),
      motifs: ds.motifs,
      backgroundLuminance:
        firstBg !== undefined && firstBg.mediaType === "image"
          ? (lum.get(firstBg.url) ?? null)
          : null,
      logoEnabled: ds.logoEnabled ?? true,
    });
  }

  const clipAsset: ReelClipAsset | null =
    clip === null
      ? null
      : {
          url: clip.url,
          chroma: clip.chroma,
          durationSec: clip.durationSec,
          // Sin motor de subtítulos, sin capa de subtítulos: el plan lo avisa.
          hasSpeech: deps.captionsAvailable ? clip.hasSpeech : false,
        };
  const visual = (c: ReelMediaCandidate): ReelVisualAsset => ({ url: c.url, kind: c.mediaType });
  let spec: ReelSpec;
  try {
    const planned = reelSpecFromPlan(
      planReel({
        prompt: "",
        template,
        assets: {
          backgrounds: bgs.map(visual),
          clip: clipAsset,
          music: track === null ? null : { url: track.url },
        },
        look,
        copy: value.copy,
        motion: slot.motion,
        language: reelLanguageOf(ctx.strategy?.language ?? null),
      }),
    );
    const checked = reelSpecSchema.safeParse(planned);
    if (!checked.success) {
      return {
        ok: false,
        reason: `spec_invalid: ${checked.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      };
    }
    spec = checked.data;
  } catch (error: unknown) {
    return { ok: false, reason: `spec_failed: ${error instanceof Error ? error.message : "error"}` };
  }

  let posterKey: string | null = null;
  if (deps.render !== null) {
    try {
      const auth = await reelMediaAuthorization(deps.storage, {
        companyId: ctx.companyId,
        objectPrefix: "content",
        urls: reelMediaUrls(spec),
        fontUrls: reelFontUrls(spec),
      });
      const poster = await deps.render.poster(spec, auth);
      const key = `content/${ctx.companyId}/reel-posters/${slot.itemId}.jpg`;
      await deps.storage.put({
        key,
        body: poster.bytes,
        contentType: "image/jpeg",
        cacheControl: "public, max-age=86400",
      });
      posterKey = key;
    } catch (error: unknown) {
      deps.logger.warn(
        { companyId: ctx.companyId, itemId: slot.itemId, reason: error instanceof Error ? error.message : "error" },
        "reel: sin póster (la tarjeta muestra el texto)",
      );
    }
  }

  const clipKind: "chroma" | "alpha" | "opaque" | "none" =
    clip === null ? "none" : clip.chroma === "alpha" ? "alpha" : clip.chroma === "none" ? "opaque" : "chroma";
  return {
    ok: true,
    idea,
    copy: value.copy,
    copySource: source,
    template,
    spec,
    assets: {
      backgrounds: bgs.map((b) => ({ id: b.id, source: b.source, url: b.url, kind: b.mediaType })),
      clip: clip === null ? null : { id: clip.id, source: clip.source, url: clip.url, chroma: clip.chroma },
      music: track === null ? null : { id: track.id, source: track.source, url: track.url },
      logo: look.logo?.url ?? null,
      motif: spec.layers.some((l) => l.id === "motif") ? (look.motif?.url ?? null) : null,
      picks,
      modes,
    },
    mediaIds: [
      ...bgs.filter((b) => b.source === "brand").map((b) => b.id),
      ...(clip !== null && clip.source === "brand" ? [clip.id] : []),
    ],
    posterKey,
    lookNotes: look.notes,
    clipKind,
  };
}
