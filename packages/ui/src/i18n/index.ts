export { en, type MessageKey, type Messages } from "./messages.js";
export { t, createTranslator, interpolate, type MessageVars } from "./t.js";
export { emptyStatePresets, errorStatePresets, resolveStatePreset } from "./presets.js";
export type {
  EmptyStatePresetId,
  ErrorStatePresetId,
  ResolvedState,
  StatePreset,
} from "./presets.js";
