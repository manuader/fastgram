/**
 * Firma del grant de media que `services/render` exige — `NFR-006`,
 * `P2-RENDER-009`, `P2-RENDER-015`.
 *
 * ## Qué problema resuelve
 *
 * El servicio de render es **sin estado**: no tiene base y no puede preguntar
 * si el asset `abc` pertenece al workspace 42. Si intentara resolverlo yendo a
 * buscar la URL, estaría confiando en la URL misma, que es exactamente lo que
 * no hay que confiar. Así que la autoridad viaja en el pedido: quien sí tiene
 * base firma con HMAC-SHA256 los prefijos del workspace concreto, y el render
 * verifica firma y vencimiento.
 *
 * Sin grant, el servicio sólo puede aplicar `RENDER_ALLOWED_MEDIA_PREFIXES`,
 * que es global: **no distingue el workspace 42 del 43**. Por eso el grant es
 * lo que sostiene el aislamiento de `NFR-006`, y no un extra de seguridad.
 *
 * ## La duplicación, que es deliberada y peligrosa
 *
 * `canonicalGrantBody` de acá tiene que producir **exactamente la misma cadena**
 * que `canonicalGrantBody` de `services/render/src/media/urlPolicy.ts`. Un
 * espacio, una clave en otro orden o un array sin ordenar dan otro HMAC, y el
 * servicio responde `media_grant_invalid` — un 400 que parece un bug de
 * permisos y es un bug de serialización.
 *
 * No se importa la del servicio porque `packages/adapters` no puede depender de
 * `services/**`: son despliegues distintos y la dependencia iría al revés de la
 * flecha. La alternativa honesta a la duplicación es **medirla**: el test de
 * integración firma acá y lo manda al servicio real, que es el único lugar
 * donde las dos implementaciones se comparan de verdad. Un test unitario que
 * compare esta función contra una cadena escrita a mano sólo comprueba que la
 * copia no cambió, no que las dos coincidan.
 */
import { createHmac } from "node:crypto";
import type { MediaAuthorization } from "@fastgram/ports";

/** El cuerpo tal como lo valida `mediaGrantBodySchema` del servicio. */
export interface MediaGrantBody {
  readonly companyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly mediaPrefixes: readonly string[];
  readonly sharedPrefixes: readonly string[];
  readonly urls?: readonly string[];
}

export interface SignedMediaGrant {
  readonly body: MediaGrantBody;
  /** HMAC-SHA256 hex sobre {@link canonicalGrantBody}. */
  readonly signature: string;
}

/**
 * Serialización canónica: claves en orden fijo y arrays ordenados, para que la
 * firma no dependa del orden en que el emisor armó el objeto.
 *
 * El orden de las claves es alfabético y **no** es casual ni cosmético: es el
 * contrato. Ver el encabezado.
 */
export function canonicalGrantBody(body: MediaGrantBody): string {
  const sorted = (xs: readonly string[]): string[] => [...xs].sort();
  const parts: [string, unknown][] = [
    ["companyId", body.companyId],
    ["expiresAt", body.expiresAt],
    ["issuedAt", body.issuedAt],
    ["mediaPrefixes", sorted(body.mediaPrefixes)],
    ["sharedPrefixes", sorted(body.sharedPrefixes)],
  ];
  if (body.urls !== undefined) parts.push(["urls", sorted(body.urls)]);
  return JSON.stringify(Object.fromEntries(parts));
}

export interface GrantMintOptions {
  readonly secret: string;
  readonly nowMs: number;
  readonly ttlMs: number;
}

/**
 * Convierte la **intención** del puerto ({@link MediaAuthorization}: de quién
 * es la media y qué prefijos abarca) en el **mecanismo** que este servicio
 * pide (un cuerpo con vencimiento, más su HMAC).
 *
 * El vencimiento se acuña acá y no en el puerto a propósito: un `expiresAt` en
 * el puerto entraría al `fingerprint` del job y el cache de IMPL §5 dejaría de
 * acertar nunca. Ver el comentario de `MediaAuthorization`.
 */
export function signMediaGrant(
  auth: MediaAuthorization,
  options: GrantMintOptions,
): SignedMediaGrant {
  const body: MediaGrantBody = {
    companyId: auth.companyId,
    issuedAt: options.nowMs,
    expiresAt: options.nowMs + options.ttlMs,
    mediaPrefixes: auth.mediaPrefixes,
    sharedPrefixes: auth.sharedPrefixes,
    ...(auth.urls === undefined ? {} : { urls: auth.urls }),
  };
  const signature = createHmac("sha256", options.secret)
    .update(canonicalGrantBody(body))
    .digest("hex");
  return { body, signature };
}
