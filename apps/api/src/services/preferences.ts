/**
 * Preferencias aprendidas desde Blitz — sprint 9 (agente Q), `PU-S9-011`, `D-22`.
 *
 * El servicio que las rutas de decisión llaman **con una línea**: aceptar y
 * descartar en `blitz.ts`, editar y regenerar en `content.ts`. Arma lo que se
 * sabe de la pieza ({@link PreferenceSubject}), extrae los rasgos con `core`,
 * guarda la señal y recalcula los pesos de la marca y su aporte al dueño.
 *
 * ## Nunca rompe la decisión
 *
 * Corre **dentro** de la transacción de la decisión —así una aceptación que
 * vuelve atrás no deja una señal huérfana— pero en un `SAVEPOINT`
 * (`tx.transaction`): si algo falla, se vuelve al savepoint, se loguea y la
 * decisión sigue. Sin el savepoint, un error de SQL dejaría la transacción de
 * Postgres abortada y la aceptación moriría con él.
 *
 * ## Qué es cada señal
 *
 * - `accept` / `discard`: los rasgos de la sugerencia (su `buildPlan`, la
 *   media elegida, la pista, el ángulo, el influencer y su modelo).
 * - `edit_after_accept`: una edición de la pieza que salió de aceptar. Se
 *   compara la pieza **original** (el `buildPayload`, que nunca se toca) con
 *   la editada (swaps de `studioState` + cajas guardadas), **por aspecto**.
 *   Una fila por aspecto (upsert): editar dos veces el fondo deja la última,
 *   y volver al original borra la señal.
 * - `edit_before_accept`: el vocabulario y el modelo la soportan, pero **hoy
 *   ninguna ruta la produce**: Blitz no tiene edición antes de aceptar (el
 *   botón «Edit» del deck acepta y abre el editor). Ver el reporte.
 *
 * Aceptar desde el piloto automático **no** es una señal: no la decidió el
 * dueño. Sólo cuentan las rutas que llama la persona.
 */
import {
  contentBuildPayloadSchema,
  type ContentBuildPayload,
  type LearnedPreference,
  type PreferencesView,
} from "@fastgram/contracts";
import {
  BLITZ_CAPTION_FONT_SIZE,
  CAPTION_STYLES,
  DEFAULT_PREFERENCE_HALF_LIFE_DAYS,
  PREFERENCE_SIGNAL_HORIZON_HALF_LIVES,
  PREFERENCE_SIGNAL_WEIGHTS,
  PREFERENCE_VOCABULARY_VERSION,
  TEXT_STYLE_PRESETS,
  aggregatePreferenceSignals,
  applyAssetSwaps,
  assetsOf,
  buildPreferences,
  deriveTextBoxesFromBuildPayload,
  describeLearnedPreferences,
  diffPreferenceFeatures,
  effectivePreferenceSettings,
  extractPreferenceFeatures,
  isBlitzContentType,
  mergePreferenceStats,
  parsePreferenceFeature,
  parsePreferenceStats,
  parseSuggestionBuildPlan,
  preferencesFromSnapshot,
  readAssetSwaps,
  type AssetBuildPayload,
  type ContentAssets,
  type PrefMediaSource,
  type PrefMusicSource,
  type PreferenceInsight,
  type PreferenceMediaInput,
  type PreferenceSignal,
  type PreferenceSnapshot,
  type PreferenceStats,
  type PreferenceSubject,
  type PreferenceTextStyleInput,
  type PrefSuggestionOrigin,
  type TextStylePreset,
} from "@fastgram/core";
import {
  contentRepository,
  contentTextBoxRepository,
  ownerPreferencesStore,
  preferenceLookups,
  preferenceSignalStore,
  preferenceSnapshotStore,
  preferenceWeightsStore,
  workspaceDirectory,
  type ContentRow,
  type Executor,
  type OwnerPreferencesRow,
  type OwnerScope,
  type PreferenceMediaFacts,
  type PreferenceSignalRow,
  type SuggestionRow,
  type Transaction,
} from "@fastgram/db";

export interface PreferenceLog {
  warn(obj: object, msg: string): void;
}

const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────────────────────────────────────────────────────────────────────
// De la base a un `PreferenceSubject`
// ───────────────────────────────────────────────────────────────────────────

/** `media.origin` → de dónde es la media, en el vocabulario de `core`. */
const MEDIA_SOURCE: Readonly<Record<string, PrefMediaSource>> = {
  manual_upload: "upload",
  generated: "generated",
  brand_kit: "brand",
  demo: "library",
  internal: "library",
  imported: "imported",
};

const AUDIO_SOURCE: Readonly<Record<string, PrefMusicSource>> = {
  upload: "upload",
  import: "import",
  extracted: "extracted",
};

function mediaInput(m: PreferenceMediaFacts | undefined): PreferenceMediaInput | null {
  if (m === undefined) return null;
  return { mediaType: m.mediaType, source: MEDIA_SOURCE[m.origin] ?? null, tags: m.tags };
}

function originOf(s: SuggestionRow): PrefSuggestionOrigin {
  if (s.sourceTrendingItemId !== null || s.remixSourceUrl !== null) return "remix";
  if (s.promptRequestId !== null) return "prompt";
  return "refill";
}

function presetStyle(presetId: string | null): PreferenceTextStyleInput {
  const known =
    presetId !== null && (TEXT_STYLE_PRESETS as readonly string[]).includes(presetId)
      ? (presetId as TextStylePreset)
      : null;
  return {
    presetId: known,
    fontSize: BLITZ_CAPTION_FONT_SIZE,
    boxed: known === null ? false : CAPTION_STYLES[known].backgroundColor !== undefined,
  };
}

/** Lo que se sabe de una sugerencia: su plan, su media, su pista, su gente. */
export async function suggestionSubject(
  tx: Executor,
  companyId: string,
  s: SuggestionRow,
): Promise<PreferenceSubject> {
  const scope = { companyId };
  const base = {
    format: s.contentType,
    angleId: s.angleId,
    influencerId: s.influencerId,
    origin: originOf(s),
    textStyle: presetStyle(s.textStylePresetId),
  } satisfies PreferenceSubject;

  let modelId: string | null = null;
  if (s.influencerId !== null) {
    const [inf] = await preferenceLookups.influencers(tx, scope, [s.influencerId]);
    modelId = inf?.modelId ?? null;
  }

  const parsed = isBlitzContentType(s.contentType)
    ? parseSuggestionBuildPlan(s.buildPlan, s.contentType)
    : { ok: false as const, reason: "unknown content type" };
  if (!parsed.ok) return { ...base, modelId };

  const plan = parsed.plan;
  const sel = plan.media;
  const bgId =
    sel.format === "slideshow"
      ? sel.slides[0]?.mediaId
      : sel.format === "wall-of-text"
        ? sel.video.mediaId
        : sel.format === "green-screen"
          ? sel.image.mediaId
          : undefined;
  const clipId =
    sel.format === "green-screen"
      ? sel.video.mediaId
      : sel.format === "video-hook"
        ? sel.hookVideo.mediaId
        : undefined;
  const ids = [bgId, clipId].filter((x): x is string => x !== undefined);
  const facts = new Map(
    (await preferenceLookups.mediaByIds(tx, scope, ids)).map((m) => [m.mediaId, m]),
  );
  const bg = bgId === undefined ? undefined : facts.get(bgId);
  const clip = clipId === undefined ? undefined : facts.get(clipId);

  let music: PreferenceSubject["music"] = sel.format === "slideshow" ? undefined : null;
  if (plan.audio !== undefined) {
    const [track] = await preferenceLookups.audioByIds(tx, scope, [plan.audio.audioId]);
    music = {
      trackId: plan.audio.audioId,
      source: track === undefined ? null : (AUDIO_SOURCE[track.origin] ?? null),
    };
  }

  const timed = clip ?? (bg?.mediaType === "video" ? bg : undefined);
  return {
    ...base,
    modelId,
    background: mediaInput(bg),
    clip: mediaInput(clip),
    music,
    texts: plan.texts,
    durationSec: timed?.durationSec ?? null,
  };
}

interface BoxLike {
  readonly text: string;
  readonly font: unknown;
  readonly background: unknown;
}

function boxStyle(box: BoxLike | undefined): PreferenceTextStyleInput | null {
  if (box === undefined) return null;
  const font =
    typeof box.font === "object" && box.font !== null
      ? (box.font as { family?: unknown; size?: unknown })
      : {};
  return {
    fontFamily: typeof font.family === "string" ? font.family : null,
    fontSize: typeof font.size === "number" ? font.size : null,
    boxed: box.background !== null && box.background !== undefined,
  };
}

/** Los slots que son fondo y clip en cada formato (igual que en la sugerencia). */
function mediaUrls(
  format: string,
  assets: ContentAssets,
): { bg?: string; clip?: string } {
  switch (format) {
    case "slideshow":
      return maybe({ bg: assets.slides?.[0]?.url });
    case "wall-of-text":
      return maybe({ bg: assets.video?.url });
    case "green-screen":
      return maybe({ bg: assets.image?.url, clip: assets.video?.url });
    case "video-hook":
      return maybe({ clip: assets.hook_video?.url });
    default:
      return {};
  }
}

function maybe(v: { bg?: string | undefined; clip?: string | undefined }): {
  bg?: string;
  clip?: string;
} {
  return {
    ...(v.bg === undefined ? {} : { bg: v.bg }),
    ...(v.clip === undefined ? {} : { clip: v.clip }),
  };
}

async function contentSide(
  tx: Executor,
  companyId: string,
  format: string,
  assets: ContentAssets,
  boxes: readonly BoxLike[],
): Promise<PreferenceSubject> {
  const scope = { companyId };
  const urls = mediaUrls(format, assets);
  const facts = new Map(
    (
      await preferenceLookups.mediaByUrls(
        tx,
        scope,
        [urls.bg, urls.clip].filter((x): x is string => x !== undefined),
      )
    ).map((m) => [m.url, m]),
  );
  const bg = urls.bg === undefined ? undefined : facts.get(urls.bg);
  const clip = urls.clip === undefined ? undefined : facts.get(urls.clip);

  let music: PreferenceSubject["music"];
  if (assets.slides === undefined) {
    const audio = assets.audio ?? null;
    if (audio === null) {
      music = null;
    } else {
      const [track] = await preferenceLookups.audioByUrls(tx, scope, [audio.url]);
      // Una pista que no es de la biblioteca de la marca (la global de `DATA-012`).
      music =
        track === undefined
          ? { source: "library" }
          : { trackId: track.id, source: AUDIO_SOURCE[track.origin] ?? null };
    }
  }

  return {
    format,
    background:
      bg === undefined ? (urls.bg === undefined ? null : undefined) : mediaInput(bg),
    clip:
      clip === undefined
        ? urls.clip === undefined
          ? null
          : undefined
        : mediaInput(clip),
    music,
    texts: boxes.map((b) => b.text),
    textStyle: boxStyle(boxes[0]),
  };
}

/**
 * La pieza original y la editada. `null` si el payload no se entiende (una
 * pieza `custom`, o un payload viejo): sin original no hay con qué comparar.
 */
export async function contentSubjects(
  tx: Executor,
  companyId: string,
  row: ContentRow,
): Promise<{ before: PreferenceSubject; after: PreferenceSubject } | null> {
  const parsed = contentBuildPayloadSchema.safeParse(row.buildPayload);
  if (!parsed.success) return null;
  const data: ContentBuildPayload = parsed.data;
  // Sólo los cuatro formatos de Blitz (slides o una superficie con texto). Un
  // payload de otra forma (video propio, reel) no salió de una sugerencia.
  if (!("num_images" in data) && !("text" in data)) return null;
  const payload = data as unknown as Parameters<
    typeof deriveTextBoxesFromBuildPayload
  >[0];
  const original = data as unknown as AssetBuildPayload;
  const swaps = readAssetSwaps(row.studioState) ?? {};
  const applied = applyAssetSwaps(original, swaps);
  const edited = applied.ok ? applied.payload : original;

  const derived = deriveTextBoxesFromBuildPayload(payload);
  const saved = await contentTextBoxRepository.list(
    tx,
    { companyId },
    { filter: { contentId: { eq: row.id } }, limit: 100 },
  );
  // Las guardadas vienen por fecha de creación; el orden de las derivadas es
  // el del payload. Para los rasgos alcanza con ordenarlas por id.
  const savedBoxes = [...saved.items].sort((a, b) => a.id.localeCompare(b.id));
  const derivedBoxes = [...derived].sort((a, b) => a.id.localeCompare(b.id));

  return {
    before: await contentSide(tx, companyId, row.type, assetsOf(original), derivedBoxes),
    after: await contentSide(
      tx,
      companyId,
      row.type,
      assetsOf(edited),
      savedBoxes.length > 0 ? savedBoxes : derivedBoxes,
    ),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Recalcular
// ───────────────────────────────────────────────────────────────────────────

function toSignal(r: PreferenceSignalRow): PreferenceSignal {
  return {
    kind: r.kind,
    features: r.features,
    removed: r.removed,
    added: r.added,
    weight: r.weight,
    occurredAtMs: r.occurredAt.getTime(),
  };
}

const ownerLevel = (feature: string): boolean =>
  parsePreferenceFeature(feature)?.ownerLevel === true;

/**
 * Recalcula los pesos de la marca y su aporte al dueño desde las señales. Lee
 * sólo lo que todavía pesa (diez vidas medias) y hasta el tope del repositorio.
 */
export async function recomputePreferences(
  tx: Executor,
  companyId: string,
  nowMs: number,
): Promise<void> {
  const scope = { companyId };
  const ownerOf = await workspaceDirectory.ownerOf(tx, companyId);
  const owner: OwnerScope | null =
    ownerOf === null ? null : { ownerUserId: ownerOf.ownerUserId };
  const ownerRow = owner === null ? null : await ownerPreferencesStore.find(tx, owner);
  const weights = await preferenceWeightsStore.find(tx, scope);

  const ownerHalfLife = ownerRow?.halfLifeDays ?? DEFAULT_PREFERENCE_HALF_LIFE_DAYS;
  const brandHalfLife = weights?.halfLifeDays ?? ownerHalfLife;
  const horizonDays =
    Math.max(brandHalfLife, ownerHalfLife) * PREFERENCE_SIGNAL_HORIZON_HALF_LIVES;
  const rows = await preferenceSignalStore.listRecent(tx, scope, {
    since: new Date(nowMs - horizonDays * DAY_MS),
  });
  const signals = rows.map(toSignal);

  const brandStats = aggregatePreferenceSignals(signals, {
    nowMs,
    halfLifeDays: brandHalfLife,
  });
  await preferenceWeightsStore.putStats(tx, scope, {
    stats: brandStats,
    signalCount: brandStats.signalCount,
    computedAt: new Date(nowMs),
  });

  if (owner !== null) {
    const contribution = aggregatePreferenceSignals(signals, {
      nowMs,
      halfLifeDays: ownerHalfLife,
      sinceMs: ownerRow?.resetAt?.getTime() ?? null,
      keep: ownerLevel,
    });
    await ownerPreferencesStore.putBrandStats(tx, owner, companyId, contribution);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Capturar (las llamadas de una línea)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Corre `fn` en un savepoint de `tx`. Si falla, vuelve al savepoint, loguea y
 * devuelve `false`: la decisión del dueño sigue.
 */
async function bestEffort(
  tx: Transaction,
  log: PreferenceLog | undefined,
  context: object,
  fn: (sp: Transaction) => Promise<void>,
): Promise<boolean> {
  try {
    await tx.transaction(async (sp) => fn(sp));
    return true;
  } catch (error: unknown) {
    log?.warn(
      { ...context, error },
      "no se pudo guardar la señal de preferencias; la decisión sigue",
    );
    return false;
  }
}

export interface AcceptedInput {
  readonly companyId: string;
  readonly suggestion: SuggestionRow;
  readonly contentId: string;
  readonly nowMs: number;
}

/** `POST /blitz`: el dueño aceptó esta sugerencia y salió esta pieza. */
export function capturePreferenceAccept(
  tx: Transaction,
  input: AcceptedInput,
  log?: PreferenceLog,
): Promise<boolean> {
  return bestEffort(
    tx,
    log,
    { signal: "accept", suggestionId: input.suggestion.id },
    async (sp) => {
      const subject = await suggestionSubject(sp, input.companyId, input.suggestion);
      await preferenceSignalStore.upsert(
        sp,
        { companyId: input.companyId },
        {
          suggestionId: input.suggestion.id,
          contentId: input.contentId,
          kind: "accept",
          aspect: "",
          features: extractPreferenceFeatures(subject),
          weight: PREFERENCE_SIGNAL_WEIGHTS.accept,
          vocabularyVersion: PREFERENCE_VOCABULARY_VERSION,
          occurredAt: new Date(input.nowMs),
        },
      );
      await recomputePreferences(sp, input.companyId, input.nowMs);
    },
  );
}

export interface DiscardedInput {
  readonly companyId: string;
  readonly suggestion: SuggestionRow;
  readonly nowMs: number;
}

/** `POST /blitz/queue/:id/discard`: el dueño la descartó. */
export function capturePreferenceDiscard(
  tx: Transaction,
  input: DiscardedInput,
  log?: PreferenceLog,
): Promise<boolean> {
  return bestEffort(
    tx,
    log,
    { signal: "discard", suggestionId: input.suggestion.id },
    async (sp) => {
      const subject = await suggestionSubject(sp, input.companyId, input.suggestion);
      await preferenceSignalStore.upsert(
        sp,
        { companyId: input.companyId },
        {
          suggestionId: input.suggestion.id,
          kind: "discard",
          aspect: "",
          features: extractPreferenceFeatures(subject),
          weight: PREFERENCE_SIGNAL_WEIGHTS.discard,
          vocabularyVersion: PREFERENCE_VOCABULARY_VERSION,
          occurredAt: new Date(input.nowMs),
        },
      );
      await recomputePreferences(sp, input.companyId, input.nowMs);
    },
  );
}

export interface EditedInput {
  readonly companyId: string;
  /** La pieza editada. Se relee dentro de la transacción: ve la edición. */
  readonly contentId: string;
  readonly nowMs: number;
  /** `POST /content/:id/regenerate`: la copy cambia aunque todavía no se vea. */
  readonly regenerated?: boolean | undefined;
}

/**
 * `PATCH /content/:id` y `POST /content/:id/regenerate`. Sólo para piezas que
 * salieron de aceptar en Blitz (tienen señal `accept`); las demás no enseñan
 * nada sobre las sugerencias.
 */
export function capturePreferenceEdit(
  tx: Transaction,
  input: EditedInput,
  log?: PreferenceLog,
): Promise<boolean> {
  return bestEffort(
    tx,
    log,
    { signal: "edit_after_accept", contentId: input.contentId },
    async (sp) => {
      const scope = { companyId: input.companyId };
      const accepted = await preferenceSignalStore.findAcceptByContent(
        sp,
        scope,
        input.contentId,
      );
      if (accepted === null) return;
      const content = await contentRepository.findById(sp, scope, input.contentId);
      if (content === null) return;
      const sides = await contentSubjects(sp, input.companyId, content);
      if (sides === null) return;

      const before = extractPreferenceFeatures(sides.before);
      const after = extractPreferenceFeatures(sides.after);
      const regenerated = input.regenerated === true;
      const changes = diffPreferenceFeatures(
        before,
        after,
        regenerated ? ["text"] : [],
      ).filter(
        // Regenerar sólo dice algo de la copy: no toca lo que otra edición dejó.
        (c) => !regenerated || c.aspect === "text",
      );

      for (const change of changes) {
        await preferenceSignalStore.upsert(sp, scope, {
          suggestionId: accepted.suggestionId,
          contentId: input.contentId,
          kind: "edit_after_accept",
          aspect: change.aspect,
          features: after,
          removed: change.removed,
          added: change.added,
          weight: PREFERENCE_SIGNAL_WEIGHTS.edit_after_accept,
          vocabularyVersion: PREFERENCE_VOCABULARY_VERSION,
          occurredAt: new Date(input.nowMs),
        });
      }
      if (!regenerated) {
        // Un aspecto que volvió a ser el original ya no es una corrección.
        const changed = new Set(changes.map((c) => c.aspect));
        const reverted = (
          ["text", "background", "clip", "music", "style"] as const
        ).filter((a) => !changed.has(a));
        await preferenceSignalStore.deleteEdits(
          sp,
          scope,
          accepted.suggestionId,
          "edit_after_accept",
          reverted,
        );
      }
      await recomputePreferences(sp, input.companyId, input.nowMs);
    },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Lo que se muestra
// ───────────────────────────────────────────────────────────────────────────

const LEARNED_LIMIT = 40;

function toLearned(i: PreferenceInsight, label: string | null): LearnedPreference {
  return {
    feature: i.feature,
    family: i.family,
    value: i.value,
    label,
    aspect: i.aspect,
    direction: i.direction,
    score: Math.max(-1, Math.min(1, i.score)),
    accepts: i.accepts,
    total: i.total,
    evidence: Math.max(0, i.evidence),
    source: i.source,
  };
}

async function labelsFor(
  tx: Executor,
  companyId: string,
  owner: OwnerScope | null,
  insights: readonly PreferenceInsight[],
): Promise<Map<string, string>> {
  // `influencer=none` es un valor, no un id: no se busca.
  const idsOf = (family: string) =>
    insights
      .filter((i) => i.family === family && UUID_RE.test(i.value))
      .map((i) => i.value);
  const scope = { companyId };
  const out = new Map<string, string>();
  for (const a of await preferenceLookups.angles(tx, scope, idsOf("angle"))) {
    out.set(`angle=${a.id}`, a.title);
  }
  for (const inf of await preferenceLookups.influencers(tx, scope, idsOf("influencer"))) {
    out.set(`influencer=${inf.id}`, inf.name);
  }
  for (const t of await preferenceLookups.audioByIds(tx, scope, idsOf("music.track"))) {
    out.set(`music.track=${t.id}`, t.title);
  }
  if (owner !== null) {
    for (const m of await preferenceLookups.modelNames(tx, owner, idsOf("model"))) {
      out.set(`model=${m.id}`, m.name);
    }
  }
  return out;
}

/** `GET /preferences`: la marca activa, con el dueño como prior. */
export async function brandPreferencesView(
  tx: Executor,
  companyId: string,
  nowMs: number,
): Promise<PreferencesView> {
  const snapshot: PreferenceSnapshot = await preferenceSnapshotStore(tx).load(companyId);
  const prefs = preferencesFromSnapshot(companyId, snapshot, nowMs);
  const insights = describeLearnedPreferences(prefs, { limit: LEARNED_LIMIT });
  const ownerOf = await workspaceDirectory.ownerOf(tx, companyId);
  const owner = ownerOf === null ? null : { ownerUserId: ownerOf.ownerUserId };
  const labels = await labelsFor(tx, companyId, owner, insights);
  const summary = await preferenceSignalStore.summary(tx, { companyId });
  const weights = await preferenceWeightsStore.find(tx, { companyId });
  const settings = effectivePreferenceSettings(snapshot);

  return {
    scope: "brand",
    settings: {
      enabled: settings.enabled,
      exploration: settings.exploration,
      halfLifeDays: settings.halfLifeDays,
      explorationSource:
        (snapshot.brand?.exploration ?? null) === null ? "owner" : "brand",
      halfLifeSource: (snapshot.brand?.halfLifeDays ?? null) === null ? "owner" : "brand",
    },
    ownerDefaults: ownerDefaults(snapshot.owner),
    signals: { total: summary.total, lastAt: summary.lastAt?.getTime() ?? null },
    learned: insights.map((i) => toLearned(i, labels.get(i.feature) ?? null)),
    computedAt: weights?.computedAt?.getTime() ?? null,
  };
}

function ownerDefaults(
  owner: { exploration: number; halfLifeDays: number } | null,
): PreferencesView["ownerDefaults"] {
  return {
    exploration: owner?.exploration ?? 0.15,
    halfLifeDays: owner?.halfLifeDays ?? DEFAULT_PREFERENCE_HALF_LIFE_DAYS,
  };
}

/** Todas las marcas del dueño sumadas (sin excluir ninguna). */
export function ownerAggregate(
  row: OwnerPreferencesRow | null,
  nowMs: number,
): PreferenceStats | null {
  if (row === null) return null;
  const raw =
    typeof row.brandStats === "object" && row.brandStats !== null
      ? (row.brandStats as Record<string, unknown>)
      : {};
  const list = Object.values(raw)
    .map(parsePreferenceStats)
    .filter((s): s is PreferenceStats => s !== null);
  return list.length === 0 ? null : mergePreferenceStats(list, nowMs, row.halfLifeDays);
}

/**
 * `GET /preferences/owner`. El agregado se muestra con su propio Beta(1,1)
 * (como si fuera una marca sin prior): es el gusto del dueño, no el de una
 * marca encogido hacia él.
 */
export async function ownerPreferencesView(
  tx: Executor,
  owner: OwnerScope,
  nowMs: number,
): Promise<PreferencesView> {
  const row = await ownerPreferencesStore.find(tx, owner);
  const stats = ownerAggregate(row, nowMs);
  const prefs = buildPreferences({
    brand: stats,
    owner: null,
    nowMs,
    settings: {
      exploration: row?.exploration ?? 0.15,
      halfLifeDays: row?.halfLifeDays ?? DEFAULT_PREFERENCE_HALF_LIFE_DAYS,
    },
  });
  const insights = describeLearnedPreferences(prefs, { limit: LEARNED_LIMIT });
  const labels = new Map<string, string>();
  const modelIds = insights.filter((i) => i.family === "model").map((i) => i.value);
  for (const m of await preferenceLookups.modelNames(tx, owner, modelIds)) {
    labels.set(`model=${m.id}`, m.name);
  }
  const defaults = ownerDefaults(row);
  return {
    scope: "owner",
    settings: {
      enabled: true,
      exploration: defaults.exploration,
      halfLifeDays: defaults.halfLifeDays,
      explorationSource: "owner",
      halfLifeSource: "owner",
    },
    ownerDefaults: defaults,
    signals: {
      total: stats?.signalCount ?? 0,
      lastAt: lastOf(stats),
    },
    learned: insights.map((i) => ({
      ...toLearned(i, labels.get(i.feature) ?? null),
      source: "owner" as const,
    })),
    computedAt: row?.updatedAt.getTime() ?? null,
  };
}

function lastOf(stats: PreferenceStats | null): number | null {
  if (stats === null) return null;
  let last = 0;
  for (const f of Object.values(stats.features)) last = Math.max(last, f.lastMs);
  return last === 0 ? null : last;
}
