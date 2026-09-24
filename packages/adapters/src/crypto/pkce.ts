/**
 * PKCE (RFC 7636 §4.1–4.2): `code_verifier` de 43 caracteres base64url (32
 * bytes aleatorios) y `code_challenge = BASE64URL(SHA256(verifier))`, método
 * `S256`. X lo acepta (`plain` o `S256`) —
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

export function s256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  return { codeVerifier, codeChallenge: s256Challenge(codeVerifier) };
}
