/**
 * La IP del cliente, para los límites de `/auth/*` — `P1-AUTH-002`, NFR-009.
 *
 * ## Por qué no `request.ip`
 *
 * `app.ts` monta Fastify con `trustProxy: true`, así que `request.ip` sale del
 * `X-Forwarded-For` **de cualquiera**: un cliente que manda
 * `X-Forwarded-For: 1.2.3.4` elige su IP, y un límite por IP pasa a ser un
 * límite por "lo que el atacante escriba". Para loguear da igual; para decidir
 * cuántos intentos de contraseña tiene alguien, no.
 *
 * ## La regla
 *
 * Se confía en `X-Forwarded-For` **sólo** si el socket viene de un proxy de
 * `AUTH_TRUSTED_PROXIES`. En ese caso se recorre la lista de derecha a
 * izquierda —cada proxy agrega al final lo que vio— salteando los proxies
 * propios, y el primero que no es de confianza es el cliente. Lo que está más a
 * la izquierda lo escribió el cliente y no se mira.
 *
 * Sin proxies configurados, la IP que se devuelve es la del socket y
 * `trusted: false`: detrás del BFF esa es la IP del servidor web, igual para
 * todos, y quien llama no debe usarla para limitar (ver `rate-limits.ts`).
 */
import { isIP } from "node:net";

export interface ClientIp {
  readonly ip: string;
  /**
   * `true` si la IP identifica al cliente real: vino por un proxy de confianza
   * o hay proxies configurados y el socket no es uno de ellos (conexión directa).
   */
  readonly trusted: boolean;
}

/** `::ffff:10.0.0.1` y `10.0.0.1` son la misma dirección. */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.toLowerCase().startsWith("::ffff:") && isIP(trimmed.slice(7)) === 4
    ? trimmed.slice(7)
    : trimmed;
}

export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: ReadonlySet<string>,
): ClientIp {
  const remote = normalizeIp(remoteAddress ?? "");
  if (trustedProxies.size === 0) return { ip: remote, trusted: false };
  if (!trustedProxies.has(remote)) return { ip: remote, trusted: true };

  const hops = (
    Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? "")
  )
    .split(",")
    .map((hop) => normalizeIp(hop))
    .filter((hop) => hop.length > 0);

  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] ?? "";
    if (trustedProxies.has(hop)) continue;
    // Un salto que no es una IP lo escribió un proxy roto o alguien que no es
    // un proxy. No se lo cree: se limita al proxy, que es lo conservador.
    if (isIP(hop) === 0) return { ip: remote, trusted: false };
    return { ip: hop, trusted: true };
  }
  // El proxy de confianza no dijo quién era el cliente.
  return { ip: remote, trusted: false };
}
