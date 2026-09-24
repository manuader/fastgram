/**
 * Lógica pura de la pantalla de influencers — `PU-LATER-004`, `FR-080`,
 * `FR-081`, `F-094`. Sin React: lo prueba `form.test.ts`.
 */
import {
  INFLUENCER_AGE_MAX,
  INFLUENCER_AGE_MIN,
  INFLUENCER_REFERENCES_MAX,
  INFLUENCER_REFERENCES_MIN,
  type CreateInfluencerRequest,
  type Influencer,
  type InfluencerFailureCode,
  type InfluencerGeneration,
  type InfluencerImageRequest,
} from "@fastgram/contracts";
import type { CopyKey } from "../i18n/t";

/** El influencer tal como lo lee la web: la portada puede faltar (camino viejo). */
export type InfluencerView = Omit<Influencer, "baseImageUrl"> & {
  readonly baseImageUrl?: string | undefined;
};

export interface WizardForm {
  readonly name: string;
  readonly gender: "" | "female" | "male" | "other";
  /** `null` = sin edad (los rasgos son opcionales). */
  readonly age: number | null;
  readonly ethnicity: string;
  readonly details: string;
  readonly referenceMediaIds: readonly string[];
}

export const INITIAL_WIZARD: WizardForm = {
  name: "",
  gender: "",
  age: null,
  ethnicity: "",
  details: "",
  referenceMediaIds: [],
};

export type WizardStep = 1 | 2 | 3;

export function canLeaveStep(form: WizardForm, step: WizardStep): boolean {
  if (step === 1) return form.name.trim().length > 0 && form.name.trim().length <= 100;
  if (step === 2) {
    const n = form.referenceMediaIds.length;
    return n >= INFLUENCER_REFERENCES_MIN && n <= INFLUENCER_REFERENCES_MAX;
  }
  return true;
}

/** Marca o desmarca una foto; no deja pasar del máximo. */
export function toggleReference(form: WizardForm, mediaId: string): WizardForm {
  const has = form.referenceMediaIds.includes(mediaId);
  if (has) {
    return {
      ...form,
      referenceMediaIds: form.referenceMediaIds.filter((id) => id !== mediaId),
    };
  }
  if (form.referenceMediaIds.length >= INFLUENCER_REFERENCES_MAX) return form;
  return { ...form, referenceMediaIds: [...form.referenceMediaIds, mediaId] };
}

export function clampAge(age: number): number {
  return Math.min(INFLUENCER_AGE_MAX, Math.max(INFLUENCER_AGE_MIN, Math.round(age)));
}

/** El cuerpo de `POST /influencers`. Los rasgos vacíos no viajan. */
export function toCreateRequest(form: WizardForm): CreateInfluencerRequest {
  const ethnicity = form.ethnicity.trim();
  const details = form.details.trim();
  return {
    name: form.name.trim(),
    referenceMediaIds: [...form.referenceMediaIds],
    ...(form.gender === "" ? {} : { gender: form.gender }),
    ...(form.age === null ? {} : { age: clampAge(form.age) }),
    ...(ethnicity === "" ? {} : { ethnicity }),
    ...(details === "" ? {} : { additionalDetails: details }),
  };
}

/** `male · 25 · White` (FR-080), con lo que haya. */
export function traitsLine(inf: InfluencerView): string {
  return [inf.gender, inf.age === undefined ? undefined : String(inf.age), inf.ethnicity]
    .filter((x): x is string => x !== undefined && x !== "")
    .join(" · ");
}

export function isInFlight(inf: Pick<InfluencerView, "status">): boolean {
  return inf.status === "generating_variations" || inf.status === "training";
}

/** Cada cuánto se vuelve a pedir la lista o el detalle mientras algo entrena. */
export const TRAINING_POLL_MS = 5_000;

export function influencersRefetchInterval(
  items: readonly Pick<InfluencerView, "status">[] | undefined,
): number | false {
  return items?.some(isInFlight) === true ? TRAINING_POLL_MS : false;
}

export const GENERATIONS_POLL_MS = 4_000;

export function generationsRefetchInterval(
  items: readonly Pick<InfluencerGeneration, "status">[] | undefined,
): number | false {
  return items?.some((g) => g.status === "queued" || g.status === "generating") === true
    ? GENERATIONS_POLL_MS
    : false;
}

export const STATUS_COPY: Readonly<Record<InfluencerView["status"], CopyKey>> = {
  generating_variations: "influencers.status.generating_variations",
  training: "influencers.status.training",
  ready: "influencers.status.ready",
  failed: "influencers.status.failed",
  inactive: "influencers.status.inactive",
};

export const FAILURE_COPY: Readonly<Record<InfluencerFailureCode, CopyKey>> = {
  not_configured: "influencers.failure.not_configured",
  references_missing: "influencers.failure.references_missing",
  upload_failed: "influencers.failure.upload_failed",
  training_failed: "influencers.failure.training_failed",
  quota_exceeded: "influencers.failure.quota_exceeded",
  unauthorized: "influencers.failure.unauthorized",
  rate_limited: "influencers.failure.rate_limited",
  provider_unavailable: "influencers.failure.provider_unavailable",
  bad_request: "influencers.failure.bad_request",
  timeout: "influencers.failure.timeout",
  provider_contract_violation: "influencers.failure.provider_contract_violation",
};

export interface ImageForm {
  readonly prompt: string;
  readonly aspectRatio: "9:16" | "3:4" | "1:1" | "4:3" | "16:9";
  readonly count: 1 | 4;
}

export const INITIAL_IMAGE_FORM: ImageForm = {
  prompt: "",
  aspectRatio: "9:16",
  count: 1,
};

export const IMAGE_ASPECTS: readonly ImageForm["aspectRatio"][] = [
  "9:16",
  "3:4",
  "1:1",
  "4:3",
  "16:9",
];

/** `null` mientras no haya un pedido válido (sin prompt, no se estima). */
export function toImageRequest(form: ImageForm): InfluencerImageRequest | null {
  const prompt = form.prompt.trim();
  if (prompt.length === 0 || prompt.length > 2000) return null;
  return { prompt, aspectRatio: form.aspectRatio, count: form.count };
}
