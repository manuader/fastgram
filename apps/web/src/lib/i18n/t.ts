/**
 * Traductor de la shell: une el catálogo canónico de `@fastgram/ui` con el
 * catálogo local de `apps/web`.
 *
 * Una sola función para las dos fuentes, y no dos imports en cada componente,
 * porque el sitio del que sale una clave es un detalle de dónde se puede
 * escribir hoy — no algo que el JSX deba saber. El día que `packages/ui`
 * absorba estas claves, desaparece este archivo y no se toca ninguna pantalla.
 */
import { en, interpolate, type MessageKey, type MessageVars } from "@fastgram/ui";
import { webEn, type WebMessageKey } from "./messages";

export type CopyKey = MessageKey | WebMessageKey;
export type { MessageVars };

const uiKeys: ReadonlySet<string> = new Set(Object.keys(en));

/** Traduce una clave de cualquiera de los dos catálogos. */
export function tw(key: CopyKey, vars?: MessageVars): string {
  const template = uiKeys.has(key) ? en[key as MessageKey] : webEn[key as WebMessageKey];
  return interpolate(template, vars);
}
