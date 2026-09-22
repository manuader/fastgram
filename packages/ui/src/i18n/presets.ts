import type { MessageKey } from "./messages";
import { t, type MessageVars } from "./t";

/**
 * Un estado vacío o de error listo para renderizar: qué claves de copy usa.
 * Deliberadamente son **claves**, no strings: el componente no incrusta copy.
 */
export interface StatePreset {
  readonly titleKey: MessageKey;
  readonly descriptionKey?: MessageKey;
  readonly actionKey?: MessageKey;
}

/**
 * Los estados vacíos del PRD §19.1, indexados por su ID del PRD.
 *
 * Que la clave sea el ID (`ERR-E04`) y no un nombre inventado es lo que permite
 * auditar la cobertura contra el PRD de un vistazo — y que el día que el PRD
 * añada un ERR-E14 se vea el hueco.
 */
export const emptyStatePresets = {
  "ERR-E01": { titleKey: "empty.aiStudio.title" },
  "ERR-E02": {
    titleKey: "empty.inspiration.title",
    descriptionKey: "empty.inspiration.description",
  },
  "ERR-E03": {
    titleKey: "empty.inspirationSetup.title",
    descriptionKey: "empty.inspirationSetup.description",
  },
  "ERR-E04": { titleKey: "empty.mediaBank.title" },
  "ERR-E05": { titleKey: "empty.posts.title" },
  "ERR-E06": { titleKey: "empty.imagePicker.title" },
  "ERR-E07": { titleKey: "empty.audio.title" },
  "ERR-E08": {
    titleKey: "empty.posts.title",
    descriptionKey: "empty.leads.description",
  },
  "ERR-E09": {
    titleKey: "empty.warmedAccounts.title",
    descriptionKey: "empty.warmedAccounts.description",
  },
  "ERR-E10": { titleKey: "empty.workspaces.title" },
  "ERR-E11": {
    titleKey: "empty.posts.title",
    descriptionKey: "empty.blitzQueue.description",
  },
  "ERR-E12": {
    titleKey: "empty.brandSources.title",
    actionKey: "empty.brandSources.action",
  },
  "ERR-E13": { titleKey: "empty.socialSource.title" },
} as const satisfies Record<string, StatePreset>;

export type EmptyStatePresetId = keyof typeof emptyStatePresets;

/**
 * Los estados de error del PRD §19.3 / §19.4 / §19.8 que tienen pantalla propia.
 * Los de §19.5 (integraciones) suelen vivir en un banner dentro de Settings, no
 * en una pantalla completa: quedan en el catálogo pero no como preset.
 */
export const errorStatePresets = {
  generic: {
    titleKey: "common.somethingWentWrong",
    actionKey: "common.tryAgain",
  },
  contentPreparation: {
    titleKey: "common.somethingWentWrong",
    descriptionKey: "common.somethingWentWrongContent",
    actionKey: "common.tryAgain",
  },
  run: {
    titleKey: "common.somethingWentWrong",
    descriptionKey: "common.somethingWentWrongRun",
    actionKey: "common.tryAgain",
  },
  "ERR-U01": {
    titleKey: "error.accessDenied.title",
    descriptionKey: "error.accessDenied.description",
  },
  "ERR-U02": {
    titleKey: "error.leadNotFound.title",
    descriptionKey: "error.leadNotFound.description",
  },
  "ERR-U03": {
    titleKey: "error.workspaceUnavailable.title",
    descriptionKey: "error.workspaceUnavailable.description",
  },
  "ERR-U04": { titleKey: "error.noCompanySelected.title" },
  "ERR-U05": { titleKey: "error.influencerNotFound.title" },
  "ERR-R02": { titleKey: "error.blitzQuota.title" },
  "ERR-R03": { titleKey: "error.contentQuota.title" },
  "ERR-R04": { titleKey: "error.trialQuota.title" },
  "ERR-R07": { titleKey: "error.generationsInFlight.title" },
  "ERR-R08": { titleKey: "error.notEnoughCredits.title" },
} as const satisfies Record<string, StatePreset>;

export type ErrorStatePresetId = keyof typeof errorStatePresets;

/** Un preset ya resuelto a strings del idioma activo. */
export interface ResolvedState {
  title: string;
  description?: string;
  actionLabel?: string;
}

/**
 * Convierte un preset en los strings que van a pantalla.
 *
 * Existe para que el copy del PRD §19 llegue al componente sin que el
 * componente sepa de dónde salió: `EmptyState` sigue siendo presentación pura.
 */
export function resolveStatePreset(
  preset: StatePreset,
  vars?: MessageVars,
): ResolvedState {
  const resolved: ResolvedState = { title: t(preset.titleKey, vars) };
  if (preset.descriptionKey !== undefined) {
    resolved.description = t(preset.descriptionKey, vars);
  }
  if (preset.actionKey !== undefined) {
    resolved.actionLabel = t(preset.actionKey, vars);
  }
  return resolved;
}
