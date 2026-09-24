/**
 * Fila de base → recurso público.
 *
 * Tres traducciones que aplican a todo el archivo:
 *
 * 1. **`timestamptz` → ms epoch.** El contrato tipa las fechas como milisegundos
 *    (`msEpochSchema`); la base guarda `timestamptz` porque el cursor y los índices
 *    `(companyId, createdAt)` lo necesitan. La conversión vive acá, en un solo lugar.
 *
 * 2. **`null` → campo ausente.** El contrato usa `.optional()`, no `.nullable()`, en
 *    casi todo. Con `exactOptionalPropertyTypes` mandar `{x: undefined}` no es lo mismo
 *    que omitir `x`, así que los opcionales se construyen por spread condicional.
 *
 * 3. **Lo interno no sale.** `storageKey`, `companyId`, `buildPayload`, `studioState`,
 *    `soulId` y compañía no aparecen en ningún tipo de retorno de este archivo
 *    (NFR-007: *"storage keys e ids internos nunca se devuelven"*). Que el tipo de
 *    retorno sea explícito es lo que convierte ese requisito en un error de compilación
 *    en vez de una revisión de código.
 *
 * ## Dos desajustes contrato ↔ schema, anotados y no tapados
 *
 * - `contentSchema.thumbnailUrl` es **obligatorio** y `contents.thumbnail_url` es
 *   nullable. Un contenido en `BUILDING` todavía no tiene thumbnail, así que el caso
 *   nulo es normal, no excepcional. Se omite el campo cuando no está, y el tipo de
 *   retorno lo dice (`ContentResource`). Inventar una URL sería peor.
 * - `contentAngleSchema.description` / `.targetAudience` exigen `min(1)` y las columnas
 *   son nullable. Las filas que crea esta API siempre los traen (el request se valida
 *   contra el contrato); una fila con null sólo puede venir de otra vía. Se emite `""`
 *   para no romper la forma, y queda reportado.
 */
import type {
  AudioTrack,
  BlitzPreferences,
  BrandSource,
  CompanyProfile,
  Connection,
  Content,
  ContentAngle,
  FieldMeta,
  Influencer,
  Media,
  Post,
} from "@fastgram/contracts";
import type {
  audioTracks,
  blitzPreferences,
  brandSources,
  companyProfiles,
  connections,
  contentAngles,
  contents,
  influencers,
  media,
  posts,
} from "@fastgram/db";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

/** Milisegundos desde epoch. Ver traducción (1). */
const ms = (d: Date): number => d.getTime();

/** `{k: v}` si `v` no es nulo, `{}` si lo es. Ver traducción (2). */
function opt<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

// ─────────────────────────────── Media ───────────────────────────────

export function toMedia(row: Row<typeof media>): Media {
  return {
    mediaId: row.mediaId as Media["mediaId"],
    mediaType: row.mediaType,
    filename: row.filename,
    r2Url: row.r2Url,
    status: row.status,
    sizeMb: row.sizeMb,
    ...opt("videoDurationSec", row.videoDurationSec),
    categories: row.categories as Media["categories"],
    origin: row.origin,
    uploadedAt: ms(row.uploadedAt),
    ...opt("deletedAt", row.deletedAt === null ? null : ms(row.deletedAt)),
    // `0029` (sprint 7, F): etiquetas y qué hizo la normalización.
    ...(row.tags.length === 0 ? {} : { tags: [...row.tags] }),
    ...opt("normalization", row.normalization),
  } as Media;
}

// ─────────────────────────────── Content ───────────────────────────────

/** `Content` del contrato, con `thumbnailUrl` opcional. Ver la nota de la cabecera. */
export type ContentResource = Omit<Content, "thumbnailUrl"> & {
  thumbnailUrl?: string;
};

export function toContent(row: Row<typeof contents>): ContentResource {
  return {
    _id: row.id as Content["_id"],
    type: row.type,
    status: row.status,
    files: row.files,
    ...opt("thumbnailUrl", row.thumbnailUrl),
    ...opt("generatedText", row.generatedText),
    ...opt("remixSourceUrl", row.remixSourceUrl),
    revision: row.revision,
    ...opt("lastEdit", row.lastEdit as Record<string, unknown> | null),
    ...opt("deletedAt", row.deletedAt === null ? null : ms(row.deletedAt)),
  } as ContentResource;
}

// ─────────────────────────────── Angles ───────────────────────────────

export function toContentAngle(row: Row<typeof contentAngles>): ContentAngle {
  return {
    _id: row.id as ContentAngle["_id"],
    title: row.title,
    // Ver la nota de la cabecera: columna nullable contra contrato `min(1)`.
    description: row.description ?? "",
    targetAudience: row.targetAudience ?? "",
    isActive: row.isActive,
    influencerIds: row.influencerIds as ContentAngle["influencerIds"],
    createdAt: ms(row.createdAt),
    updatedAt: ms(row.updatedAt),
  } as ContentAngle;
}

// ──────────────────────────── Blitz preferences ────────────────────────────

/**
 * FR-055 (PRD:1288) — `settingsApplication` es **sólo de respuesta** y constante:
 * los cambios aplican a generaciones futuras, sobre una cola objetivo de 5 ítems.
 * No se guarda en la base porque no es estado: es la descripción del comportamiento.
 */
export function toBlitzPreferences(row: Row<typeof blitzPreferences>): BlitzPreferences {
  return {
    slideshowWeight: row.slideshowWeight,
    wallOfTextWeight: row.wallOfTextWeight,
    greenScreenWeight: row.greenScreenWeight,
    videoHookWeight: row.videoHookWeight,
    remixPercentage: row.remixPercentage,
    ownMediaPercentage: row.ownMediaPercentage,
    mentionBusinessPercentage: row.mentionBusinessPercentage,
    influencerChance: row.influencerChance,
    smartTextPositioning: row.smartTextPositioning,
    genderFilter: row.genderFilter,
    angleWeights: (row.angleWeights ?? {}) as BlitzPreferences["angleWeights"],
    textStyleWeights: (row.textStyleWeights ??
      {}) as BlitzPreferences["textStyleWeights"],
    settingsApplication: { mode: "future_generations", targetQueuedItems: 5 },
  };
}

// ─────────────────────────────── Influencers ───────────────────────────────

/**
 * `influencerSchema.baseImageUrl` es obligatorio y la columna es nullable: mientras
 * el pipeline genera la imagen base (15-20 min, DATA-013) todavía no hay URL. Mismo
 * criterio que `thumbnailUrl`: se omite en vez de inventar.
 */
export type InfluencerResource = Omit<Influencer, "baseImageUrl"> & {
  baseImageUrl?: string;
};

export function toInfluencer(row: Row<typeof influencers>): InfluencerResource {
  return {
    _id: row.id as Influencer["_id"],
    name: row.name,
    gender: row.gender,
    age: row.age,
    ethnicity: row.ethnicity,
    ...opt("baseImageUrl", row.baseImageUrl),
    status: row.status,
    progress: row.progress,
    isActive: row.isActive,
    createdAt: ms(row.createdAt),
    updatedAt: ms(row.updatedAt),
  } as InfluencerResource;
}

// ─────────────────────────────── Connections ───────────────────────────────

export function toConnection(row: Row<typeof connections>): Connection {
  return {
    _id: row.id as Connection["_id"],
    platform: row.platform,
    platformUserId: row.platformUserId,
    platformUsername: row.platformUsername,
    scopes: row.scopes,
    publishable: row.publishable,
    tokenExpiry: row.tokenExpiry === null ? 0 : ms(row.tokenExpiry),
    status: row.status,
    createdAt: ms(row.createdAt),
    updatedAt: ms(row.updatedAt),
  } as Connection;
}

// ─────────────────────────────── Audio ───────────────────────────────

export function toAudioTrack(row: Row<typeof audioTracks>): AudioTrack {
  return {
    audioId: row.audioId as AudioTrack["audioId"],
    url: row.url,
    description: row.description,
    sizeMb: row.sizeMb,
    ...opt("durationSec", row.durationSec),
    library: row.library,
  } as AudioTrack;
}

// ─────────────────────────────── Posts ───────────────────────────────

/**
 * `Post` tiene 18 campos opcionales. Encadenarlos con spreads condicionales como en
 * el resto del archivo hace que TypeScript intente representar 2^18 formas del objeto
 * y falle con "union type that is too complex to represent" (TS2590).
 *
 * Por eso acá se construye un registro mutable y se copian los opcionales presentes en
 * un bucle. El resultado en runtime es idéntico —las claves nulas no aparecen— y el
 * cast final es el único punto donde se afirma la forma, que es lo que el contrato ya
 * valida.
 */
export function toPost(row: Row<typeof posts>): Post {
  const out: Record<string, unknown> = {
    _id: row.id,
    contentId: row.contentId,
    platform: row.platform,
    accountType: row.accountType,
    scheduledAtUtc: ms(row.scheduledAtUtc),
    caption: row.caption ?? "",
    description: row.description ?? "",
    status: row.status,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
  };

  const optional: ReadonlyArray<readonly [string, unknown]> = [
    ["connectionId", row.connectionId],
    ["warmedAccountId", row.warmedAccountId],
    ["connectionUsername", row.connectionUsername],
    ["publishedCaption", row.publishedCaption],
    ["captionAdjustmentReason", row.captionAdjustmentReason],
    ["discloseAsAds", row.discloseAsAds],
    ["aiContentDisclaimer", row.aiContentDisclaimer],
    ["instagramSlideshowFormat", row.instagramSlideshowFormat],
    ["tiktokSoundMode", row.tiktokSoundMode],
    ["tiktokSoundId", row.tiktokSoundId],
    ["postingMode", row.postingMode],
    ["privacyLevel", row.privacyLevel],
    ["cancellationPending", row.cancellationPending],
    ["tiktokProcessingDelayed", row.tiktokProcessingDelayed],
    ["errorCode", row.errorCode],
    ["errorMessage", row.errorMessage],
    ["postUrl", row.postUrl],
    ["postedAt", row.postedAt === null ? null : ms(row.postedAt)],
  ];

  for (const [key, value] of optional) {
    if (value !== null && value !== undefined) out[key] = value;
  }

  return out as unknown as Post;
}

// ──────────────────────────── Brand sources ────────────────────────────

/**
 * `BrandSource` del contrato — DATA-031.
 *
 * Dos campos de la fila **no salen**, y el tipo de retorno lo convierte en un
 * error de compilación si alguien los agrega:
 *
 *  - `companyId`, como en todo el archivo.
 *  - `connectionId`, que es el id interno de la `Connection` OAuth que el tier A
 *    usó para leer. `FR-011.4` pide que *"la UI nunca exponga en qué nivel se
 *    resolvió"* salvo la degradación a D, y devolver el id de la conexión es
 *    contar el tier por la puerta de atrás.
 *
 * `acquisitionTier` **sí** sale, porque `brandSourceSchema` lo declara
 * obligatorio; queda anotado en el reporte como una contradicción del contrato
 * con `FR-011.4` que no es de esta capa resolver.
 */
export function toBrandSource(row: Row<typeof brandSources>): BrandSource {
  return {
    _id: row.id as BrandSource["_id"],
    sourceType: row.sourceType,
    handle: row.handle,
    canonicalUrl: row.canonicalUrl,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    isPrimary: row.isPrimary,
    acquisitionTier: row.acquisitionTier,
    status: row.status,
    failureReason: row.failureReason,
    lastAnalysedAt: row.lastAnalysedAt === null ? null : ms(row.lastAnalysedAt),
    analysisCount: row.analysisCount,
    createdAt: ms(row.createdAt),
    updatedAt: ms(row.updatedAt),
  };
}

// ──────────────────────────── Company profile ────────────────────────────

/**
 * `CompanyProfile` del contrato — DATA-004.
 *
 * Los cinco campos de `AI-001` son obligatorios en el contrato y **nullables en
 * la columna**: un workspace que todavía no analizó nada los tiene en `null`.
 * Se emiten como `""` —el mismo criterio que `toContentAngle`— y no se omiten,
 * porque un campo ausente y un campo vacío significan lo mismo acá y el
 * contrato ya eligió cuál es: vacío. Es además lo que `AI-016` exige leer como
 * "hueco": *"un campo sin señal suficiente queda vacío"*.
 */
export function toCompanyProfile(row: Row<typeof companyProfiles>): CompanyProfile {
  return {
    coreIdentity: row.coreIdentity ?? "",
    productOffering: row.productOffering ?? "",
    uniqueBenefits: row.uniqueBenefits ?? "",
    problemSolution: row.problemSolution ?? "",
    marketAndCompetition: row.marketAndCompetition ?? "",
    ...opt("toneOfVoice", row.toneOfVoice),
    ...opt("targetAudience", row.targetAudience),
    ...opt("businessModel", row.businessModel),
    businessCategories: row.businessCategories,
    ...opt("monthlyRevenueBand", row.monthlyRevenueBand),
    ...opt("teamSize", row.teamSize),
    ...opt("ownerRole", row.ownerRole),
    expectations: row.expectations,
    brandRevision: row.brandRevision,
    status: row.status,
    fieldMeta: row.fieldMeta as Record<string, FieldMeta>,
  } as CompanyProfile;
}

/**
 * El perfil de un workspace que todavía no tiene fila.
 *
 * `GET /brand/profile` **no devuelve 404** cuando falta: el perfil es una
 * propiedad del workspace, no un recurso con vida propia, y un 404 obligaría a
 * cada cliente a tratar "workspace nuevo" como un error. Los cinco campos salen
 * vacíos, que es exactamente lo que `AI-016` quiere que se lea como hueco.
 */
export function emptyCompanyProfile(): CompanyProfile {
  return {
    coreIdentity: "",
    productOffering: "",
    uniqueBenefits: "",
    problemSolution: "",
    marketAndCompetition: "",
    businessCategories: [],
    expectations: [],
    brandRevision: 0,
    status: "pending",
    fieldMeta: {},
  };
}
