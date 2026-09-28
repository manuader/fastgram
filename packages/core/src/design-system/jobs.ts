/**
 * La cola `design-system` y las claves de storage — `PU-S9-001`, `PU-S9-004`.
 *
 * Una sola cola con dos clases de trabajo, despachadas por `kind` (trampa 63:
 * dos consumidores en la misma cola se despachan por payload; acá hay un solo
 * consumidor y el payload dice qué hacer):
 *
 *  - `import`: abrir el zip subido, subir assets y fuentes, resumir el estilo;
 *  - `generate`: generar fondos/patrones nuevos con la paleta (pendientes de
 *    aprobación).
 *
 * ## Claves
 *
 * Todo lo que el render tiene que poder leer va bajo `media/{companyId}/`
 * (lo autoriza el grant del build); las fuentes van bajo
 * `fonts/{companyId}/` (brief: el grant del build tiene que sumar ese prefijo,
 * pedido al coordinador). Las claves son **deterministas** por design system
 * y contenido: una reentrega del job sube los mismos bytes a la misma clave y
 * encuentra las filas ya creadas.
 */
import type { DesignSystemTokens, DsFontFamily } from "./types.js";

export interface DesignSystemImportJob {
  readonly kind: "import";
  readonly companyId: string;
  readonly designSystemId: string;
  /** La clave del zip subido (reserva de §9.8 con el prefijo de abajo). */
  readonly zipKey: string;
}

export interface DesignSystemGenerateJob {
  readonly kind: "generate";
  readonly companyId: string;
  readonly designSystemId: string;
  /** Id del pedido: agrupa los pendientes y hace idempotente la reentrega. */
  readonly requestId: string;
  /** Fondos generados localmente por el render (sin proveedor). */
  readonly localImages: number;
  /** Imágenes pedidas al modelo `image` del registro, si hay uno configurado. */
  readonly modelImages: number;
}

export type DesignSystemJob = DesignSystemImportJob | DesignSystemGenerateJob;

/** Topes de un pedido de generación: CPU del render y costo del modelo. */
export const MAX_GENERATE_LOCAL = 8;
export const MAX_GENERATE_MODEL = 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type ParsedDesignSystemJob =
  | { readonly ok: true; readonly job: DesignSystemJob }
  | { readonly ok: false; readonly reason: string };

const isCount = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** Valida lo que vuelve de la cola. No lanza: un payload roto no mejora reintentando. */
export function parseDesignSystemJob(raw: unknown): ParsedDesignSystemJob {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "payload is not an object" };
  }
  const o = raw as Record<string, unknown>;
  const { kind, companyId, designSystemId } = o;
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) {
    return { ok: false, reason: "companyId is missing or not a UUID" };
  }
  if (typeof designSystemId !== "string" || !UUID_RE.test(designSystemId)) {
    return { ok: false, reason: "designSystemId is missing or not a UUID" };
  }
  if (kind === "import") {
    const zipKey = o["zipKey"];
    if (
      typeof zipKey !== "string" ||
      !zipKey.startsWith(`${designSystemUploadPrefix(companyId)}/`) ||
      zipKey.includes("..")
    ) {
      return { ok: false, reason: "zipKey is missing or outside the brand prefix" };
    }
    return { ok: true, job: { kind, companyId, designSystemId, zipKey } };
  }
  if (kind === "generate") {
    const { requestId, localImages, modelImages } = o;
    if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
      return { ok: false, reason: "requestId is missing or not a UUID" };
    }
    if (
      !isCount(localImages, MAX_GENERATE_LOCAL) ||
      !isCount(modelImages, MAX_GENERATE_MODEL)
    ) {
      return { ok: false, reason: "localImages/modelImages out of range" };
    }
    if (localImages + modelImages === 0)
      return { ok: false, reason: "nothing to generate" };
    return {
      ok: true,
      job: { kind, companyId, designSystemId, requestId, localImages, modelImages },
    };
  }
  return { ok: false, reason: `unknown kind ${String(kind)}` };
}

/** La `singletonKey`: una vez por import o por pedido (trampa 39, a propósito). */
export function designSystemSingletonKey(job: DesignSystemJob): string {
  return job.kind === "import"
    ? `design-system:import:${job.designSystemId}`
    : `design-system:generate:${job.requestId}`;
}

/* ------------------------------------------------------------------------ *
 * Claves de storage
 * ------------------------------------------------------------------------ */

/** Donde se reserva la subida del zip. No es `media/`: el render no lo lee. */
export function designSystemUploadPrefix(companyId: string): string {
  return `design-systems/${companyId}/uploads`;
}

const EXT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeForExtension(ext: string): string | null {
  return EXT_CONTENT_TYPES[ext.toLowerCase()] ?? null;
}

/**
 * La clave de un asset importado al Media Bank. `sha` = los primeros 16 hex
 * del sha256 del contenido: dos archivos iguales caen en la misma clave.
 */
export function designSystemAssetKey(
  companyId: string,
  designSystemId: string,
  kind: string,
  sha256: string,
  ext: string,
): string {
  return `media/${companyId}/design-system/${designSystemId}/${kind}/${sha256.slice(0, 16)}${ext}`;
}

/** La clave de un archivo de fuente: `fonts/{companyId}/{ds}/{familia}-{peso}[i].{ext}`. */
export function designSystemFontKey(
  companyId: string,
  designSystemId: string,
  familyId: string,
  weight: number,
  style: "normal" | "italic",
  ext: string,
): string {
  return `fonts/${companyId}/${designSystemId}/${familyId}-${String(weight)}${
    style === "italic" ? "i" : ""
  }${ext}`;
}

export function designSystemFontPrefix(companyId: string): string {
  return `fonts/${companyId}/`;
}

/** La clave de un generado pendiente de aprobación. */
export function designSystemGeneratedKey(
  companyId: string,
  designSystemId: string,
  requestId: string,
  index: number,
  ext: string,
): string {
  return `media/${companyId}/design-system/${designSystemId}/generated/${requestId}/${String(
    index + 1,
  )}${ext}`;
}

/* ------------------------------------------------------------------------ *
 * Ediciones
 * ------------------------------------------------------------------------ */

/**
 * Aplica las licencias tildadas por el dueño. Sólo cambia familias con
 * archivos que la necesitan: tildar una libre o una sin archivos no hace nada.
 */
export function withFontLicenses(
  tokens: DesignSystemTokens,
  confirmed: Readonly<Record<string, boolean>>,
): DesignSystemTokens {
  return {
    ...tokens,
    families: tokens.families.map((f): DsFontFamily => {
      const v = confirmed[f.id];
      if (v === undefined || f.license !== "needs_confirmation") return f;
      return { ...f, licenseConfirmed: v };
    }),
  };
}

/** Cambia el plan B de una familia por otra registrada. */
export function withFontFallbacks(
  tokens: DesignSystemTokens,
  fallbacks: Readonly<Record<string, string>>,
  registered: readonly string[],
): DesignSystemTokens {
  return {
    ...tokens,
    families: tokens.families.map((f): DsFontFamily => {
      const v = fallbacks[f.id];
      return v !== undefined && registered.includes(v) ? { ...f, fallback: v } : f;
    }),
  };
}
