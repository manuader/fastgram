/**
 * Cliente HTTP del API v1 · `P1-UI-007`. PRD §9.3.
 *
 * Todo lo que la shell sabe del backend pasa por aquí. Tres responsabilidades y
 * ninguna más:
 *
 *   1. **Abrir el sobre.** Éxito `{"data": …}`, error `{"error": {…}}`
 *      (PRD:2256-2257). Ninguna pantalla ve un `.data` ni un `.error`.
 *   2. **Validar con el contrato.** El schema Zod lo pone quien llama, y sale de
 *      `@fastgram/contracts`. Un backend que devuelve algo que el contrato no
 *      describe falla aquí, con `invalid_response`, y no tres componentes más
 *      abajo con un `undefined is not a function`.
 *   3. **Traducir el fallo.** Siempre un `ApiRequestError` con `code` estable.
 *
 * `apps/web` **no** habla con la base (regla `web-no-db` de dependency-cruiser):
 * este módulo es literalmente el único camino de salida.
 */
import { errorEnvelopeSchema } from "@fastgram/contracts";
import type { z } from "zod";
import { ApiRequestError } from "./errors";

/**
 * Un schema que **produce** `T`, sin atarse a su tipo de entrada.
 *
 * Hace falta porque los schemas del contrato usan ids con marca
 * (`z.string().brand<"PostId">()`) y `.refine(...)`: el tipo de salida lleva la
 * marca y el de entrada no, así que `z.ZodType<Post>` —que asume entrada igual
 * a salida— no los acepta. Y el cliente no tiene por qué conocer la entrada:
 * lo que le llega es JSON sin tipar.
 */
export type OutputSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/**
 * Base del API.
 *
 * `NEXT_PUBLIC_API_URL` **no existe todavía en `.env.example`** (esta tarea no
 * puede editarlo). El default apunta a `API_PORT=3001`, que es lo que declara
 * `.env.example` para `apps/api`.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Readonly<Record<string, QueryValue>>;

/**
 * Lo que necesita `send`. Está separado de `ApiRequestOptions<T>` para que el
 * genérico del schema no contamine la firma interna: si `send` recibiera
 * `ApiRequestOptions<unknown>`, pasarle un `ApiRequestOptions<Post>` sería un
 * error de varianza por el `ZodType<T>`.
 */
export interface SendOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
  /** PRD:2288 — obligatorio en `POST /content`, `POST /influencers`, etc. */
  idempotencyKey?: string;
  headers?: Readonly<Record<string, string>>;
}

export interface ApiRequestOptions<TOutput> extends SendOptions {
  /** Schema del **contenido** de `data`, no del sobre. */
  schema?: OutputSchema<TOutput>;
}

function buildUrl(path: string, query?: QueryParams): string {
  const url = new URL(
    path.startsWith("/") ? path.slice(1) : path,
    API_BASE_URL.endsWith("/") ? API_BASE_URL : `${API_BASE_URL}/`,
  );
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Un cuerpo de error ilegible no puede convertirse en "todo bien": si el status
 * dice que falló, falla — con `invalid_response` si además no se entiende.
 */
function failureFromBody(body: unknown, status: number): ApiRequestError {
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) return ApiRequestError.fromEnvelope(parsed.data.error, status);
  return new ApiRequestError({
    code: "invalid_response",
    status,
    serverMessage: `Unrecognised error envelope (HTTP ${String(status)})`,
  });
}

interface RawResponse {
  status: number;
  body: unknown;
}

async function send(path: string, options: SendOptions): Promise<RawResponse> {
  const { method = "GET", query, body, signal, idempotencyKey, headers } = options;

  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    ...headers,
  };
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json; charset=utf-8";
  }
  if (idempotencyKey !== undefined) {
    requestHeaders["Idempotency-Key"] = idempotencyKey;
  }

  const init: RequestInit = {
    method,
    headers: requestHeaders,
    // La sesión va en cookie: sin esto, cada petición sale anónima.
    credentials: "include",
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (signal !== undefined) init.signal = signal;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    // Un abort es una cancelación nuestra: se propaga para que TanStack Query
    // no lo cuente como fallo ni lo reintente.
    if (aborted) throw cause;
    throw new ApiRequestError({
      code: "network_error",
      status: 0,
      serverMessage: cause instanceof Error ? cause.message : undefined,
    });
  }

  // 204 y cualquier respuesta sin cuerpo: `body` queda `undefined`.
  const text = await response.text();
  let parsed: unknown;
  if (text === "") {
    parsed = undefined;
  } else {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiRequestError({
        code: "invalid_response",
        status: response.status,
        serverMessage: "Response body was not JSON",
      });
    }
  }

  if (!response.ok) throw failureFromBody(parsed, response.status);
  return { status: response.status, body: parsed };
}

function unwrapData(body: unknown, status: number): unknown {
  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new ApiRequestError({
      code: "invalid_response",
      status,
      serverMessage: "Success response had no `data` envelope",
    });
  }
  return (body as { data: unknown }).data;
}

function validate<T>(
  value: unknown,
  schema: OutputSchema<T> | undefined,
  status: number,
): T {
  if (schema === undefined) return value as T;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiRequestError({
    code: "invalid_response",
    status,
    serverMessage: parsed.error.message,
    details: { issues: parsed.error.issues },
  });
}

/** Una petición que devuelve un recurso. Lanza `ApiRequestError` si falla. */
export async function apiRequest<TOutput = unknown>(
  path: string,
  options: ApiRequestOptions<TOutput> = {},
): Promise<TOutput> {
  const { status, body } = await send(path, options);
  return validate(unwrapData(body, status), options.schema, status);
}

// ---------------------------------------------------------------------------
// Paginación por cursor · PRD:2256, PRD:2345
// ---------------------------------------------------------------------------

/** Una página tal y como la devuelve el API: los items y cómo pedir la siguiente. */
export interface CursorPage<TItem> {
  readonly items: readonly TItem[];
  /** Cursor **opaco**: no se interpreta, se reenvía (PRD:2345). */
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export interface ApiListOptions<TItem> extends SendOptions {
  /** Schema de **un item**, no del array. */
  itemSchema?: OutputSchema<TItem>;
  cursor?: string | null;
  /** 1–100, default 20 en el servidor (PRD:2345). */
  limit?: number;
}

/**
 * Una página de un listado paginado.
 *
 * `cursor` sale del sobre y se devuelve tal cual. Que `hasMore` y `cursor`
 * viajen juntos importa: el API puede devolver un cursor con `hasMore: false`,
 * y quien pagine tiene que mirar `hasMore`, no la nulidad del cursor.
 */
export async function apiList<TItem = unknown>(
  path: string,
  options: ApiListOptions<TItem> = {},
): Promise<CursorPage<TItem>> {
  const { itemSchema, cursor, limit, query, ...rest } = options;

  const mergedQuery: Record<string, QueryValue> = { ...query };
  if (cursor !== undefined && cursor !== null) mergedQuery["cursor"] = cursor;
  if (limit !== undefined) mergedQuery["limit"] = limit;

  const { status, body } = await send(path, { ...rest, query: mergedQuery });

  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new ApiRequestError({
      code: "invalid_response",
      status,
      serverMessage: "Paginated response had no `data` envelope",
    });
  }

  const envelope = body as { data: unknown; pagination?: unknown };
  if (!Array.isArray(envelope.data)) {
    throw new ApiRequestError({
      code: "invalid_response",
      status,
      serverMessage: "Paginated `data` was not an array",
    });
  }

  const items =
    itemSchema === undefined
      ? (envelope.data as TItem[])
      : envelope.data.map((item) => validate(item, itemSchema, status));

  const pagination = envelope.pagination;
  const hasPagination =
    typeof pagination === "object" && pagination !== null && "hasMore" in pagination;

  if (!hasPagination) {
    // Un listado sin bloque `pagination` es un listado completo: se trata como
    // una única página, no como un error. `GET /warmed-accounts` es así
    // explícitamente (PRD:1695, "sin cursor de paginación").
    return { items, cursor: null, hasMore: false };
  }

  const { cursor: nextCursor, hasMore } = pagination as {
    cursor?: unknown;
    hasMore: unknown;
  };
  return {
    items,
    cursor: typeof nextCursor === "string" ? nextCursor : null,
    hasMore: hasMore === true,
  };
}
