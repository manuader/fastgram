/**
 * El archivo de preferencias y canales de notificación —
 * `${FASTGRAM_HOME:-~/.fastgram}/notifications.json`, `0600`.
 *
 * Mismas garantías que `spend.json` (`genai/json-files.ts`): escritura atómica
 * y leer-modificar-escribir bajo lock entre procesos (escribe la API, lee el
 * worker). No conoce la forma del documento: la valida
 * `core/notifications/settings.ts`, así `adapters` no depende de `core`.
 */
import { join } from "node:path";

import { JsonFileDocument } from "../genai/json-files.js";
import { resolveFastgramHome } from "../model-registry/file-model-registry.js";

export const NOTIFICATION_SETTINGS_FILE_NAME = "notifications.json";

export function notificationSettingsPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return join(resolveFastgramHome(env), NOTIFICATION_SETTINGS_FILE_NAME);
}

export function notificationSettingsFile(
  env: Readonly<Record<string, string | undefined>>,
): JsonFileDocument {
  return new JsonFileDocument(notificationSettingsPath(env));
}
