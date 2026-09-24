/**
 * La marca activa · `PU-BRAND-001` / PRD §2.7 `D-07`.
 *
 * Una marca es un workspace (una company). La activa viaja en una cookie y no
 * en el estado de React por una sola razón: **quien la necesita es el proxy**
 * (`app/api/fastgram/v1/[...path]/route.ts`), que corre en el servidor y la
 * convierte en el header `X-Fastgram-Workspace` hacia `apps/api`. El navegador
 * no puede poner ese header él mismo sin que cada llamada de cada pantalla lo
 * sepa; la cookie viaja sola en cada `fetch` same-origin.
 *
 * No es un secreto ni una credencial: es un uuid que la API **valida** contra
 * el dueño de la key (una marca ajena o borrada es `404`). Por eso la cookie no
 * es `HttpOnly` —la escribe el cliente al elegir marca— y el proxy igual la
 * filtra por forma antes de reenviarla (`isWorkspaceId`).
 *
 * Sin cookie, la API opera sobre la company de la key: esa es "la default".
 */

export const WORKSPACE_COOKIE = "fg_workspace";

/** El nombre exacto que lee `apps/api` (contrato de marcas del sprint 1). */
export const WORKSPACE_HEADER = "X-Fastgram-Workspace";

/** Un año: la marca elegida es una preferencia, no una sesión. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ¿Tiene forma de id de marca?
 *
 * Filtrar acá no es validar (eso lo hace la API): es no reenviar basura. Un
 * valor de cookie lo puede escribir cualquiera en las devtools, y lo que sale
 * del proxy lleva la key del servidor puesta.
 */
export function isWorkspaceId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Lee la cookie de un `document.cookie`. `null` si no está o no tiene forma. */
export function parseWorkspaceCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== WORKSPACE_COOKIE) continue;
    let value = part.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return isWorkspaceId(value) ? value.toLowerCase() : null;
  }
  return null;
}

/** El string de `document.cookie` que fija la marca. */
export function serializeWorkspaceCookie(id: string, secure: boolean): string {
  const attributes = [
    `${WORKSPACE_COOKIE}=${encodeURIComponent(id)}`,
    "Path=/",
    `Max-Age=${String(MAX_AGE_SECONDS)}`,
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** El string de `document.cookie` que la borra. */
export function serializeClearedWorkspaceCookie(): string {
  return `${WORKSPACE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function readWorkspaceCookie(): string | null {
  if (typeof document === "undefined") return null;
  return parseWorkspaceCookie(document.cookie);
}

export function writeWorkspaceCookie(id: string): void {
  if (typeof document === "undefined") return;
  document.cookie = serializeWorkspaceCookie(id, window.location.protocol === "https:");
}

export function clearWorkspaceCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = serializeClearedWorkspaceCookie();
}
