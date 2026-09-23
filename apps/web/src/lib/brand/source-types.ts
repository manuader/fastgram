/**
 * Los tipos de Brand Source tal como los ve la pantalla · `FR-011.1`,
 * `FR-011.2`, `DATA-031`.
 *
 * Módulo sin hooks ni red a propósito: lo leen `error-presentation.ts` (para el
 * `{platform}` de `ERR-B04`/`ERR-B07`) y los componentes del onboarding, y un
 * import de hooks acá metería a React Query en la presentación de errores.
 */
import type { BrandSourceStatus, BrandSourceType } from "@fastgram/contracts";
import type { CopyKey } from "../i18n/t";

/**
 * Tipo → nombre en pantalla. `Record` exhaustivo: un tipo nuevo en el contrato
 * rompe la compilación en vez de salir como identificador crudo.
 */
export const SOURCE_TYPE_COPY: Readonly<Record<BrandSourceType, CopyKey>> = {
  website: "brand.sourceType.website",
  instagram: "brand.sourceType.instagram",
  tiktok: "brand.sourceType.tiktok",
  x: "brand.sourceType.x",
  youtube: "brand.sourceType.youtube",
  linkedin: "brand.sourceType.linkedin",
  other_url: "brand.sourceType.otherUrl",
  manual: "brand.sourceType.manual",
};

export const SOURCE_STATUS_COPY: Readonly<Record<BrandSourceStatus, CopyKey>> = {
  pending: "brand.status.pending",
  analyzing: "brand.status.analyzing",
  ready: "brand.status.ready",
  partial: "brand.status.partial",
  failed: "brand.status.failed",
  stale: "brand.status.stale",
};

/** Las cinco de `D-02`: las que se muestran como `@handle`. */
const SOCIAL: ReadonlySet<BrandSourceType> = new Set([
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
]);

export function isSocialSourceType(type: BrandSourceType): boolean {
  return SOCIAL.has(type);
}

/**
 * Cómo se nombra una fuente en una línea: `@mimarca` para las sociales,
 * el dominio para la web (FR-011.2, *"badge de origen"*: `from @mimarca on
 * Instagram`, `from miproducto.com`).
 *
 * LinkedIn y los canales de YouTube guardan el handle con prefijo
 * (`company/acme`, `channel/UC…`, ver `canonicalSocialUrl` de `core`), y un
 * `@company/acme` no es algo que nadie escriba: esos van sin arroba.
 */
export function sourceLabel(type: BrandSourceType, handle: string | null): string {
  if (handle === null || handle === "") return "";
  if (isSocialSourceType(type) && !handle.includes("/")) return `@${handle}`;
  return handle;
}
