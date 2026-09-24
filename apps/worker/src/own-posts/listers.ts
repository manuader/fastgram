/**
 * Listar los posts propios de una cuenta — `FR-011.5.1`, `P1-ONB-008`.
 *
 * Tres fuentes, todas de lectura y ninguna con la sesión del usuario (D-11,
 * D-13):
 *
 * - **Instagram** (conexión, Instagram Login): `GET graph.instagram.com/<ver>/me/media`
 *   con `fields=id,media_type,media_url,permalink,children{id,media_type,media_url}`.
 *   Es el endpoint documentado de «Instagram API with Instagram Login» para la
 *   media del usuario conectado; el host y la versión son los mismos que usan
 *   las métricas (`packages/adapters/src/metrics/instagram.ts`). Un carrusel
 *   aporta cada hijo. `media_url` es una URL firmada del CDN: se baja directo.
 * - **YouTube** (conexión): `channels?part=contentDetails&mine=true` → la
 *   playlist `uploads` → `playlistItems`. La Data API no entrega el archivo:
 *   cada video se baja con `yt-dlp` desde su página (un video privado falla y
 *   cuenta como `failed`).
 * - **Perfil público** (`yt-dlp --flat-playlist`, sin login): YouTube lista
 *   bien (verificado 2026-09-24: entradas `_type: "url"`, `ie_key: "Youtube"`);
 *   TikTok hoy falla en `yt-dlp` («Unable to extract secondary user ID») y
 *   cierra `listing_failed`.
 *
 * Todo lo que viene de afuera es dato: se valida la forma y lo que no encaja
 * se descarta.
 */
import { lookup } from "node:dns/promises";

import {
  classifyAddress,
  minimalChildEnv,
  runProcess,
  type ProcessRunner,
} from "@fastgram/adapters";

/** Un post (o un hijo de carrusel) a importar. */
export interface OwnPostItem {
  /** Identidad estable para el dedupe: `<plataforma>:<id>`. */
  readonly ref: string;
  readonly kind: "image" | "video";
  /** Archivo directo (Instagram). */
  readonly directUrl?: string;
  /** Página del post, para `yt-dlp` (YouTube, perfiles). */
  readonly pageUrl?: string;
  readonly title?: string;
}

export type ListOutcome =
  | { readonly ok: true; readonly items: readonly OwnPostItem[] }
  | { readonly ok: false; readonly code: "listing_failed" | "connection_unavailable" };

export type Fetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const LIST_TIMEOUT_MS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

async function getJson(
  fetch: Fetch,
  url: string,
  token: string,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, body: (await response.json()) as unknown };
}

export interface InstagramListConfig {
  readonly host?: string;
  readonly apiVersion?: string;
}

export async function listInstagramMedia(
  fetch: Fetch,
  token: string,
  limit: number,
  config: InstagramListConfig = {},
): Promise<ListOutcome> {
  const base = `${(config.host ?? "https://graph.instagram.com").replace(/\/$/, "")}/${config.apiVersion ?? "v26.0"}`;
  const fields = "id,media_type,media_url,permalink,children{id,media_type,media_url}";
  const url = `${base}/me/media?fields=${encodeURIComponent(fields)}&limit=${String(Math.min(limit, 50))}`;
  const r = await getJson(fetch, url, token);
  if (!r.ok) {
    return {
      ok: false,
      code:
        r.status === 401 || r.status === 403
          ? "connection_unavailable"
          : "listing_failed",
    };
  }
  const data = isRecord(r.body) && Array.isArray(r.body["data"]) ? r.body["data"] : [];
  const items: OwnPostItem[] = [];
  const push = (node: unknown): void => {
    if (!isRecord(node)) return;
    const id = str(node["id"]);
    const type = str(node["media_type"]);
    const mediaUrl = str(node["media_url"]);
    if (id === undefined || mediaUrl === undefined || !mediaUrl.startsWith("https://"))
      return;
    if (type !== "IMAGE" && type !== "VIDEO") return;
    items.push({
      ref: `instagram:${id}`,
      kind: type === "IMAGE" ? "image" : "video",
      directUrl: mediaUrl,
    });
  };
  for (const post of data) {
    if (!isRecord(post)) continue;
    if (post["media_type"] === "CAROUSEL_ALBUM") {
      const children = isRecord(post["children"]) ? post["children"]["data"] : undefined;
      if (Array.isArray(children)) for (const child of children) push(child);
    } else {
      push(post);
    }
    if (items.length >= limit) break;
  }
  return { ok: true, items: items.slice(0, limit) };
}

export async function listYouTubeUploads(
  fetch: Fetch,
  token: string,
  limit: number,
  host = "https://www.googleapis.com",
): Promise<ListOutcome> {
  const api = `${host.replace(/\/$/, "")}/youtube/v3`;
  const channel = await getJson(
    fetch,
    `${api}/channels?part=contentDetails&mine=true`,
    token,
  );
  if (!channel.ok) {
    return {
      ok: false,
      code:
        channel.status === 401 || channel.status === 403
          ? "connection_unavailable"
          : "listing_failed",
    };
  }
  const first =
    isRecord(channel.body) && Array.isArray(channel.body["items"])
      ? channel.body["items"][0]
      : undefined;
  const details = isRecord(first) ? first["contentDetails"] : undefined;
  const related = isRecord(details) ? details["relatedPlaylists"] : undefined;
  const uploads = isRecord(related) ? str(related["uploads"]) : undefined;
  if (uploads === undefined) return { ok: true, items: [] };

  const list = await getJson(
    fetch,
    `${api}/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=${String(Math.min(limit, 50))}`,
    token,
  );
  if (!list.ok) return { ok: false, code: "listing_failed" };
  const rows =
    isRecord(list.body) && Array.isArray(list.body["items"]) ? list.body["items"] : [];
  const items: OwnPostItem[] = [];
  for (const row of rows) {
    const cd = isRecord(row) ? row["contentDetails"] : undefined;
    const videoId = isRecord(cd) ? str(cd["videoId"]) : undefined;
    if (videoId === undefined || !/^[\w-]{6,20}$/.test(videoId)) continue;
    items.push({
      ref: `youtube:${videoId}`,
      kind: "video",
      pageUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return { ok: true, items: items.slice(0, limit) };
}

/* ------------------------------------------------------------------------ *
 * Perfil público con `yt-dlp --flat-playlist`
 * ------------------------------------------------------------------------ */

export interface ProfileLister {
  list(url: string, platform: string, limit: number): Promise<ListOutcome>;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

/** El JSON plano de un perfil es chico; mismo orden de magnitud que el reader. */
const MAX_LIST_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Un canal de YouTube sin pestaña (`/@marca`) devuelve las **pestañas** como
 * entradas, no los videos. Se pide `/shorts`: es lo que publica una marca en
 * formato vertical. Quien quiera los largos pega el link con `/videos`.
 */
export function profileListUrl(url: string, platform: string): string {
  if (platform !== "youtube") return url;
  try {
    const u = new URL(url);
    const tab = /\/(videos|shorts|streams|playlists)\/?$/.test(u.pathname);
    const isChannel = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.test(
      u.pathname,
    );
    if (isChannel && !tab) {
      u.pathname = `${u.pathname.replace(/\/$/, "")}/shorts`;
      return u.toString();
    }
  } catch {
    return url;
  }
  return url;
}

/** Las entradas del JSON de `--flat-playlist`, como `OwnPostItem`. */
export function itemsFromFlatPlaylist(
  info: unknown,
  platform: string,
  limit: number,
): OwnPostItem[] {
  const entries = isRecord(info) && Array.isArray(info["entries"]) ? info["entries"] : [];
  const items: OwnPostItem[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = str(entry["id"]);
    const url = str(entry["url"]) ?? str(entry["webpage_url"]);
    if (id === undefined || url === undefined) continue;
    // Una pestaña o una playlist anidada no es un post.
    if (entry["_type"] === "playlist") continue;
    const ie = str(entry["ie_key"]) ?? "";
    if (ie.endsWith("Tab") || ie.endsWith("Playlist") || ie.endsWith("User")) continue;
    if (!url.startsWith("https://") && !url.startsWith("http://")) continue;
    const title = str(entry["title"]);
    items.push({
      ref: `${platform}:${id}`,
      kind: "video",
      pageUrl: url,
      ...(title === undefined ? {} : { title }),
    });
    if (items.length >= limit) break;
  }
  return items;
}

export interface YtDlpProfileListerConfig {
  readonly binary?: string;
  /** Sólo tests. */
  readonly runner?: ProcessRunner;
  readonly resolver?: HostResolver;
  readonly timeoutMs?: number;
}

/**
 * Mismas garantías que `YtDlpDownloader` y el reader de Inspiration: proceso
 * hijo sin shell con la URL detrás de `--`, `--no-config`, entorno mínimo,
 * timeout duro, stdout acotado y el host resuelto antes de lanzar (nada de
 * red local). El stderr no sale.
 */
export class YtDlpProfileLister implements ProfileLister {
  readonly #binary: string;
  readonly #run: ProcessRunner;
  readonly #resolve: HostResolver;
  readonly #timeoutMs: number;

  constructor(config: YtDlpProfileListerConfig = {}) {
    this.#binary = config.binary ?? "yt-dlp";
    this.#run = config.runner ?? runProcess;
    this.#resolve = config.resolver ?? systemResolver;
    this.#timeoutMs = config.timeoutMs ?? 120_000;
  }

  async list(url: string, platform: string, limit: number): Promise<ListOutcome> {
    const target = profileListUrl(url, platform);
    let host: string;
    try {
      host = new URL(target).hostname;
    } catch {
      return { ok: false, code: "listing_failed" };
    }
    try {
      const addresses = await this.#resolve(host);
      if (addresses.length === 0 || addresses.some((a) => classifyAddress(a) !== null)) {
        return { ok: false, code: "listing_failed" };
      }
    } catch {
      return { ok: false, code: "listing_failed" };
    }
    const result = await this.#run(
      this.#binary,
      [
        "--no-config",
        "--no-warnings",
        "--no-progress",
        "--socket-timeout",
        "30",
        "--flat-playlist",
        "--playlist-end",
        String(limit),
        "--dump-single-json",
        "--",
        target,
      ],
      {
        timeoutMs: this.#timeoutMs,
        maxStdoutBytes: MAX_LIST_JSON_BYTES,
        env: minimalChildEnv(),
      },
    );
    if (result.exitCode !== 0) return { ok: false, code: "listing_failed" };
    let info: unknown;
    try {
      info = JSON.parse(result.stdout) as unknown;
    } catch {
      return { ok: false, code: "listing_failed" };
    }
    return { ok: true, items: itemsFromFlatPlaylist(info, platform, limit) };
  }
}
