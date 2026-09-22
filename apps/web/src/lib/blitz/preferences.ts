"use client";

/**
 * Los datos de `/blitz/settings` · FR-055 (PRD:1255-1300), `P2-PREFS-007`.
 *
 * `GET /blitz/preferences` sintetiza defaults sin escribir fila (DATA-006), así
 * que esta pantalla **no tiene estado vacío**: siempre hay algo que enseñar.
 * `PATCH /blitz/preferences` tiene un límite dedicado de **3/min** (§9.6), que
 * es lo que condiciona todo lo demás — ver `autosave.ts`.
 *
 * Lo que vive acá es lo que la pantalla no puede resolver dentro del JSX:
 *
 * 1. **El diff.** El PATCH no se arma con "lo último que tocó el usuario" sino
 *    comparando el borrador local contra la última respuesta confirmada del
 *    servidor. Eso hace tres cosas gratis: los cuatro pesos viajan juntos
 *    siempre que alguno cambie (lo que el contrato exige), revertir un cambio
 *    lo saca del patch en vez de mandar el valor de vuelta, y reintentar
 *    después de un fallo no necesita recordar qué se había intentado.
 * 2. **La guarda de conjunto.** Un mapa que no suma 100 **no se manda**. Con
 *    `setWeight` no debería poder pasar; la guarda es lo que convierte un bug
 *    futuro en "no se guardó y se ve" en vez de en un `400` por arrastre.
 * 3. **`angleWeights` no se toca.** Ver la nota de `PreferencesDraft`.
 */
import {
  blitzPreferencesSchema,
  TEXT_STYLE_PRESET_IDS,
  type BlitzPreferences,
  type UpdateBlitzPreferencesRequest,
} from "@fastgram/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type { CopyKey } from "../i18n/t";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { queryKeys } from "../api/keys";
import { clampWeight, isSendableWeights, type WeightMap } from "./weights";

export const PREFERENCES_PATH = "/blitz/preferences";

/**
 * Los cuatro pesos del content mix. El orden es el de la tabla de FR-055
 * (PRD:1269), que es también el del resumen de la sección
 * (`Slideshow 45% · Wall of text 45% · Green screen 10% · Hook demo videos 0%`).
 */
export const MIX_KEYS = [
  "slideshowWeight",
  "wallOfTextWeight",
  "greenScreenWeight",
  "videoHookWeight",
] as const;
export type MixKey = (typeof MIX_KEYS)[number];

export const MIX_COPY: Readonly<Record<MixKey, CopyKey>> = {
  slideshowWeight: "prefs.mix.slideshow",
  wallOfTextWeight: "prefs.mix.wallOfText",
  greenScreenWeight: "prefs.mix.greenScreen",
  videoHookWeight: "prefs.mix.videoHook",
};

/** Los porcentajes sueltos de FR-055 que no forman conjunto con nadie. */
export const RATIO_KEYS = [
  "remixPercentage",
  "ownMediaPercentage",
  "mentionBusinessPercentage",
  "influencerChance",
] as const;
export type RatioKey = (typeof RATIO_KEYS)[number];

export const RATIO_COPY: Readonly<Record<RatioKey, CopyKey>> = {
  remixPercentage: "prefs.ratio.remix",
  ownMediaPercentage: "prefs.ratio.ownMedia",
  mentionBusinessPercentage: "prefs.ratio.mentionBusiness",
  influencerChance: "prefs.ratio.influencerChance",
};

/** Los siete presets de FR-055 (PRD:1279), con el nombre que se lee en pantalla. */
export const TEXT_STYLE_COPY: Readonly<Record<string, CopyKey>> = {
  "tiktok-classic": "prefs.style.tiktokClassic",
  "bold-impact": "prefs.style.boldImpact",
  snapchat: "prefs.style.snapchat",
  "white-box": "prefs.style.whiteBox",
  "yellow-pop": "prefs.style.yellowPop",
  "clean-karaoke": "prefs.style.cleanKaraoke",
  "script-playful": "prefs.style.scriptPlayful",
};

export const GENDER_OPTIONS = ["", "man", "woman"] as const;

/**
 * El estado editable de la pantalla.
 *
 * `settingsApplication` se va: FR-055 regla 7 lo declara **sólo de respuesta**
 * y mandarlo en un PATCH es `400`. `angleWeights` se queda en el borrador pero
 * la pantalla no lo edita ni lo manda: su regla es que cubra **todos los
 * ángulos activos del workspace**, y esta pantalla no tiene de dónde sacar esa
 * lista (haría falta `GET /blitz/angles`, que es otra tarea). Inventar un
 * editor sin la lista produciría PATCHes que el servidor rechaza siempre.
 */
export type PreferencesDraft = Omit<BlitzPreferences, "settingsApplication">;

export function toDraft(prefs: BlitzPreferences): PreferencesDraft {
  const { settingsApplication: _ignored, ...draft } = prefs;
  return draft;
}

/** Los cuatro pesos del borrador, como mapa, que es lo que `setWeight` mueve. */
export function mixOf(draft: PreferencesDraft): Record<string, number> {
  return {
    slideshowWeight: draft.slideshowWeight,
    wallOfTextWeight: draft.wallOfTextWeight,
    greenScreenWeight: draft.greenScreenWeight,
    videoHookWeight: draft.videoHookWeight,
  };
}

/**
 * El mapa de vuelta a los cuatro campos del borrador.
 *
 * El `?? 0` no es defensivo por gusto: `noUncheckedIndexedAccess` obliga a
 * decidir qué pasa con una clave ausente, y un peso ausente es 0 — que además
 * es lo que el servidor entendería si se mandara el conjunto incompleto.
 */
export function applyMix(
  draft: PreferencesDraft,
  mix: Readonly<Record<string, number>>,
): PreferencesDraft {
  return {
    ...draft,
    slideshowWeight: mix["slideshowWeight"] ?? 0,
    wallOfTextWeight: mix["wallOfTextWeight"] ?? 0,
    greenScreenWeight: mix["greenScreenWeight"] ?? 0,
    videoHookWeight: mix["videoHookWeight"] ?? 0,
  };
}

function sameWeights(a: WeightMap, b: WeightMap): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/** Qué conjunto está sucio pero todavía no se puede mandar. */
export type BlockedGroup = "contentMix" | "textStyleWeights";

export interface PreferencesPatchResult {
  /** `null` = no hay nada que guardar. */
  readonly patch: UpdateBlitzPreferencesRequest | null;
  readonly blocked: readonly BlockedGroup[];
}

/**
 * El PATCH que lleva `baseline` hasta `draft`.
 *
 * Los cuatro pesos van **juntos en cuanto uno cambie**, porque el contrato los
 * valida como unidad (`updateBlitzPreferencesRequestSchema`, y antes que él
 * `assertValidPreferencesPatch`): un set parcial es `400` aunque los valores
 * sean correctos.
 */
export function buildPreferencesPatch(
  baseline: PreferencesDraft,
  draft: PreferencesDraft,
): PreferencesPatchResult {
  const blocked: BlockedGroup[] = [];

  // Los cuatro juntos en cuanto uno cambie, y sólo si el conjunto suma 100.
  const mixChanged = MIX_KEYS.some((key) => baseline[key] !== draft[key]);
  const mixSendable = mixChanged && isSendableWeights(mixOf(draft));
  if (mixChanged && !mixSendable) blocked.push("contentMix");

  const styleChanged = !sameWeights(baseline.textStyleWeights, draft.textStyleWeights);
  const styleSendable = styleChanged && isSendableWeights(draft.textStyleWeights);
  if (styleChanged && !styleSendable) blocked.push("textStyleWeights");

  // Se escribe campo a campo y no con un bucle sobre las claves porque el
  // objeto resultante **es** el cuerpo del contrato: con un bucle haría falta
  // un `as` y un error de tipeo en una clave viajaría hasta el `400` del
  // servidor. Es el mismo criterio que el merge de la ruta.
  const patch: UpdateBlitzPreferencesRequest = {
    ...(mixSendable
      ? {
          slideshowWeight: draft.slideshowWeight,
          wallOfTextWeight: draft.wallOfTextWeight,
          greenScreenWeight: draft.greenScreenWeight,
          videoHookWeight: draft.videoHookWeight,
        }
      : {}),
    ...(baseline.remixPercentage !== draft.remixPercentage
      ? { remixPercentage: draft.remixPercentage }
      : {}),
    ...(baseline.ownMediaPercentage !== draft.ownMediaPercentage
      ? { ownMediaPercentage: draft.ownMediaPercentage }
      : {}),
    ...(baseline.mentionBusinessPercentage !== draft.mentionBusinessPercentage
      ? { mentionBusinessPercentage: draft.mentionBusinessPercentage }
      : {}),
    ...(baseline.influencerChance !== draft.influencerChance
      ? { influencerChance: draft.influencerChance }
      : {}),
    ...(baseline.smartTextPositioning !== draft.smartTextPositioning
      ? { smartTextPositioning: draft.smartTextPositioning }
      : {}),
    // `null` es un valor legítimo ("sin filtro"), no una ausencia: la
    // comparación es por desigualdad y no por nullish. Con `??` el usuario no
    // podría quitar nunca el filtro una vez puesto.
    ...(baseline.genderFilter !== draft.genderFilter
      ? { genderFilter: draft.genderFilter }
      : {}),
    ...(styleSendable ? { textStyleWeights: draft.textStyleWeights } : {}),
  };

  if (Object.keys(patch).length === 0) return { patch: null, blocked };
  return { patch, blocked };
}

/** `GET /blitz/preferences`. Sin polling: nadie cambia esto por detrás. */
export function useBlitzPreferences(): UseQueryResult<BlitzPreferences, ApiRequestError> {
  return useQuery<BlitzPreferences, ApiRequestError>({
    queryKey: queryKeys.blitzPreferences(),
    queryFn: ({ signal }) =>
      apiRequest<BlitzPreferences>(PREFERENCES_PATH, {
        signal,
        schema: blitzPreferencesSchema,
      }),
  });
}

/**
 * `PATCH /blitz/preferences`.
 *
 * Sin reintento automático, que ya es el default del `QueryClient` para
 * mutaciones: con un límite de 3/min, un reintento silencioso gasta el
 * presupuesto del usuario en una petición que él no pidió.
 */
export function useSaveBlitzPreferences(): UseMutationResult<
  BlitzPreferences,
  ApiRequestError,
  UpdateBlitzPreferencesRequest
> {
  return useMutation<BlitzPreferences, ApiRequestError, UpdateBlitzPreferencesRequest>({
    mutationFn: (patch) =>
      apiRequest<BlitzPreferences>(PREFERENCES_PATH, {
        method: "PATCH",
        body: patch,
        schema: blitzPreferencesSchema,
      }),
  });
}

/** El mix de estilos apagado es `{}` (FR-055, PRD:1277), no un mapa en ceros. */
export function isStyleMixOn(weights: WeightMap): boolean {
  return Object.keys(weights).length > 0;
}

export const TEXT_STYLE_PRESETS: readonly string[] = TEXT_STYLE_PRESET_IDS;

/** Lo que enseña un slider: el valor del borrador, ya saneado. */
export function displayWeight(value: number | undefined): number {
  return clampWeight(value ?? 0);
}
