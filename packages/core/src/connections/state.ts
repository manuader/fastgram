/**
 * El `state` del OAuth: firmado, con vencimiento, atado a una marca y de un
 * solo uso — `PU-PUB-002`.
 *
 * ## Por qué firmado **y** guardado
 *
 * - La **firma** (HMAC con la clave local, vía `StateSigner`) hace que el
 *   callback no pueda traer una marca o una plataforma que no fue la que
 *   pidió la autorización: el `state` es lo único que viaja por el navegador
 *   del usuario y por la plataforma.
 * - El **registro** (`OAuthStateLedger`) lo hace de un solo uso y guarda el
 *   `code_verifier` de PKCE, que no puede viajar en el `state` (es justamente
 *   lo que no tiene que ver nadie más que el servidor).
 *
 * El callback de la web es un `GET` que llega desde otro sitio, sin la guarda
 * CSRF del proxy. Lo que lo protege es esto: sin un `state` emitido por este
 * servidor, para esta marca, hace menos de {@link OAUTH_STATE_TTL_MS} y
 * nunca usado, no se crea ninguna conexión.
 */
import type {
  OAuthPendingAuthorization,
  OAuthPlatform,
  OAuthStateLedger,
  StateSigner,
} from "@fastgram/ports";
import { isOAuthPlatform } from "@fastgram/ports";

/** Diez minutos: alcanza para loguearse en la plataforma; no es un dato del PRD. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const VERSION = "v1";

interface StatePayload {
  /** companyId */
  readonly c: string;
  /** platform */
  readonly p: OAuthPlatform;
  /** nonce */
  readonly n: string;
  /** expiración, ms epoch */
  readonly e: number;
}

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

/** Comparación en tiempo constante (para el largo dado) sin depender de `node:crypto`. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface IssueStateInput {
  readonly companyId: string;
  readonly platform: OAuthPlatform;
  /** Aleatorio, del adaptador (`randomNonce`). */
  readonly nonce: string;
  readonly now: Date;
  readonly codeVerifier?: string;
  readonly ttlMs?: number;
}

/** Firma el `state` y lo anota en el registro. Devuelve el `state` para la URL. */
export async function issueOAuthState(
  deps: { readonly signer: StateSigner; readonly ledger: OAuthStateLedger },
  input: IssueStateInput,
): Promise<string> {
  const expiresAt = new Date(input.now.getTime() + (input.ttlMs ?? OAUTH_STATE_TTL_MS));
  const payload: StatePayload = {
    c: input.companyId,
    p: input.platform,
    n: input.nonce,
    e: expiresAt.getTime(),
  };
  const body = `${VERSION}.${b64url(JSON.stringify(payload))}`;
  const mac = await deps.signer.sign(body);
  const entry: OAuthPendingAuthorization = {
    companyId: input.companyId,
    platform: input.platform,
    expiresAt,
    ...(input.codeVerifier === undefined ? {} : { codeVerifier: input.codeVerifier }),
  };
  await deps.ledger.put(input.nonce, entry);
  return `${body}.${mac}`;
}

export type StateRejection =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "wrong_brand"
  | "wrong_platform"
  | "already_used";

export type ConsumeStateResult =
  | { readonly ok: true; readonly codeVerifier?: string }
  | { readonly ok: false; readonly reason: StateRejection };

export interface ConsumeStateInput {
  readonly state: string;
  /** La marca de la request del callback (`X-Fastgram-Workspace`). */
  readonly companyId: string;
  readonly platform: OAuthPlatform;
  readonly now: Date;
}

function parse(
  state: string,
): { body: string; mac: string; payload: StatePayload } | null {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [version, encoded, mac] = parts as [string, string, string];
  let json: unknown;
  try {
    json = JSON.parse(unb64url(encoded));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (
    typeof o["c"] !== "string" ||
    typeof o["p"] !== "string" ||
    !isOAuthPlatform(o["p"]) ||
    typeof o["n"] !== "string" ||
    o["n"].length === 0 ||
    typeof o["e"] !== "number"
  ) {
    return null;
  }
  return {
    body: `${version}.${encoded}`,
    mac,
    payload: { c: o["c"], p: o["p"], n: o["n"], e: o["e"] },
  };
}

/**
 * Verifica y **consume** el `state`. El orden importa:
 *
 * 1. Forma y firma primero: un `state` que no firmamos no toca el registro
 *    (no se puede usar para quemar el nonce de otro).
 * 2. Vencimiento, marca y plataforma contra lo firmado.
 * 3. `take` del registro al final: si todo lo anterior pasó, el nonce se
 *    gasta aunque el intercambio del `code` falle después — un `code` de
 *    OAuth también es de un solo uso, así que reintentar exige volver a
 *    autorizar de todos modos.
 *
 * Una marca equivocada **no** consume el nonce: el callback que corresponde
 * (el de la marca correcta) todavía puede llegar.
 */
export async function consumeOAuthState(
  deps: { readonly signer: StateSigner; readonly ledger: OAuthStateLedger },
  input: ConsumeStateInput,
): Promise<ConsumeStateResult> {
  const parsed = parse(input.state);
  if (parsed === null) return { ok: false, reason: "malformed" };
  const expected = await deps.signer.sign(parsed.body);
  if (!constantTimeEqual(expected, parsed.mac))
    return { ok: false, reason: "bad_signature" };
  const { payload } = parsed;
  if (payload.e <= input.now.getTime()) return { ok: false, reason: "expired" };
  if (payload.p !== input.platform) return { ok: false, reason: "wrong_platform" };
  if (payload.c !== input.companyId) return { ok: false, reason: "wrong_brand" };

  const entry = await deps.ledger.take(payload.n, input.now);
  if (entry === null) return { ok: false, reason: "already_used" };
  // Defensa en profundidad: lo guardado tiene que decir lo mismo que lo firmado.
  if (entry.companyId !== payload.c || entry.platform !== payload.p) {
    return { ok: false, reason: "bad_signature" };
  }
  if (entry.expiresAt.getTime() <= input.now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return entry.codeVerifier === undefined
    ? { ok: true }
    : { ok: true, codeVerifier: entry.codeVerifier };
}
