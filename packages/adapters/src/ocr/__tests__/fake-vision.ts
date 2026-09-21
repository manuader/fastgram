/**
 * `services/vision` falso: implementa el contrato de `app/models.py` sobre un
 * servidor HTTP de verdad.
 *
 * **Por qué un servidor y no un `fetch` mockeado.** Lo que más se puede
 * romper del adaptador no es el parseo: es el rodeo que tiene que dar para
 * pasarle bytes a un servicio que recibe URLs. Con un fake que **descarga la
 * URL de verdad** queda verificado que `loopbackPublisher` publica algo
 * alcanzable, que el `Content-Type` viaja y que el servidor se cierra después.
 * Con un mock, todo eso sería fe.
 *
 * **Qué sigue sin verificar:** PaddleOCR. Este fake lee texto de los bytes
 * porque le pasamos texto. Que el motor real lea un overlay de TikTok es
 * `P1-VISION-002` y necesita el servicio levantado con el extra `ocr`.
 *
 * Replica dos comportamientos del servicio real que el adaptador asume:
 * la deduplicación de `service._dedupe` (primera aparición, con su
 * `at_second`) y la degradación de `AI-016` (`partial` en vez de excepción).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeVisionOptions {
  /** Fuerza un estado HTTP en vez de responder. */
  readonly status?: number;
  /** Fuerza el `status` del cuerpo (`ok` | `partial` | `failed`). */
  readonly ocrStatus?: "ok" | "partial" | "failed";
  /** Idioma detectado. `null` para no reportar ninguno. */
  readonly detectedLanguage?: string | null;
  /** Devuelve un cuerpo que no es JSON. */
  readonly malformed?: boolean;
  /** Tarda esto antes de responder. */
  readonly delayMs?: number;
}

export interface FakeVisionRequest {
  readonly url: string;
  readonly max_frames?: number;
  readonly sample_every_seconds?: number;
}

export class FakeVision {
  readonly requests: FakeVisionRequest[] = [];
  /** Content-Types con los que el fake descargó cada media publicada. */
  readonly downloadedTypes: string[] = [];
  #server: Server | null = null;
  #options: FakeVisionOptions;

  constructor(options: FakeVisionOptions = {}) {
    this.#options = options;
  }

  set(options: FakeVisionOptions): void {
    this.#options = options;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      void this.#handle(req.url ?? "", req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.#server = server;
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }

  async #handle(
    path: string,
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (path !== "/ocr" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as FakeVisionRequest;
    this.requests.push(request);

    const { delayMs } = this.#options;
    if (delayMs !== undefined && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const { status, malformed } = this.#options;
    if (status !== undefined && status >= 400) {
      res.writeHead(status).end("{}");
      return;
    }
    if (malformed === true) {
      res.writeHead(200, { "Content-Type": "application/json" }).end("no soy json");
      return;
    }

    // La parte que importa: descargar de verdad la URL que publicó el
    // adaptador. Si `loopbackPublisher` no funcionara, esto falla acá.
    let text = "";
    try {
      const media = await fetch(request.url);
      this.downloadedTypes.push(media.headers.get("content-type") ?? "");
      text = await media.text();
    } catch {
      // `main.py` degrada en vez de abortar cuando no puede descargar.
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          status: "partial",
          blocks: [],
          reason: "no se pudo descargar el objeto",
          frames_analysed: 0,
        }),
      );
      return;
    }

    const ocrStatus = this.#options.ocrStatus ?? "ok";
    if (ocrStatus === "failed") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "failed", blocks: [], reason: "el motor murió" }));
      return;
    }

    const isVideo = /\.(mp4|mov|webm)$/.test(new URL(request.url).pathname);
    const blocks = dedupe(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => ({
          text: line,
          confidence: 0.9,
          box: [0, index * 40, 300, 36],
          // Un overlay que dura varios frames: el real lo deduplica y conserva
          // el `at_second` de la primera aparición.
          at_second: isVideo ? index * 2 : null,
        })),
    );

    const language = this.#options.detectedLanguage;
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        status: ocrStatus,
        blocks,
        detected_language: language === undefined ? "es" : language,
        frames_analysed: isVideo ? (request.max_frames ?? 12) : 1,
        ...(ocrStatus === "partial" ? { reason: "1 de 8 frames no se pudo leer" } : {}),
      }),
    );
  }
}

/** Igual que `service._dedupe`: primera aparición, comparando normalizado. */
function dedupe<T extends { text: string }>(blocks: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const block of blocks) {
    const key = block.text.toLowerCase().split(/\s+/).join(" ");
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}
