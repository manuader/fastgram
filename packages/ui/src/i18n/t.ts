import { en, type MessageKey, type Messages } from "./messages.js";

/** Valores para los huecos `{nombre}` de un mensaje. */
export type MessageVars = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Sustituye los huecos `{nombre}` de una plantilla.
 *
 * Un hueco sin valor **se deja tal cual**, a propósito: un `{handle}` visible en
 * pantalla se detecta en la primera pasada de QA; un string vacío no se ve hasta
 * que un usuario lo reporta.
 */
export function interpolate(template: string, vars?: MessageVars): string {
  if (vars === undefined) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Crea un traductor sobre un catálogo concreto. Es lo que usará el provider de
 * i18n de la app cuando haya más de un idioma; hasta entonces, `t` alcanza.
 */
export function createTranslator(messages: Messages) {
  return function translate(key: MessageKey, vars?: MessageVars): string {
    return interpolate(messages[key], vars);
  };
}

/** Traductor por defecto (catálogo `en`). */
export const t = createTranslator(en);
