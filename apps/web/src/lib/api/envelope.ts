/**
 * §9.3 — el mismo sobre de error que emite `apps/api`, para los route handlers
 * de esta app. El cliente (`client.ts`, `lib/auth/auth-client.ts`) no tiene que
 * notar si el error lo dijo la API o el BFF.
 */
export function errorEnvelope(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const error = details === undefined ? { code, message } : { code, message, details };
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
