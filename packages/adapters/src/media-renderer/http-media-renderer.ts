/**
 * `MediaRenderer` sobre `services/render` — `P2-RENDER-002`, IMPL ADR-007 e
 * IMPL §5, PRD `FR-070`, `NFR-001`, `NFR-025`, PRD §10.
 *
 * Es el adaptador que hace que el build sea de verdad. `MemoryMediaRenderer`
 * deja correr el pipeline completo con bytes sintéticos derivados del
 * fingerprint; eso alcanza para probar el pipeline y no alcanza para nada más.
 * Acá hay un motor: `services/render` con FFmpeg y sharp del otro lado de un
 * HTTP interno.
 *
 * ## El contrato con el servicio
 *
 *  - `POST /render` con `{"payload": <payload de build>}` → **200** con
 *    `{type, keys, cache, warnings, artifacts:[{kind, index, bytes, href}]}`.
 *  - `GET <href>` → **200** con los bytes, `content-type` y `content-length`.
 *    `href` es **opaco**: se concatena al base URL y se pide tal cual. No se
 *    parsea, no se reconstruye, no se supone nada de su forma más allá de que
 *    empieza con `/` (ver {@link assertOpaqueHref}).
 *  - Errores: `{"error":{"code",...,"message","details"}}` con su status.
 *  - `GET /capabilities` y `GET /health` para diagnóstico.
 *
 * ## Tres cosas que no son obvias y cuestan tiempo
 *
 * **1. El fingerprint del adaptador y las claves de cache del servicio son
 * cosas distintas, y no hay que intentar alinearlas.** El puerto exige que
 * `fingerprint` sea **puro** —«no toca red ni disco»—, así que no puede
 * consultar `/capabilities`: la versión del motor entra por configuración,
 * igual que en `MemoryMediaRenderer`. El servicio, en cambio, calcula tres
 * claves (`mediaKey`, `overlayKey`, `buildKey`) sobre el payload **ya
 * normalizado por zod**, con los defaults aplicados y con
 * `FONT_REGISTRY_VERSION` adentro, y las parte por costo para que una edición
 * de copy no re-encodee el fondo. Son dos preguntas diferentes: la de acá es
 * «¿tengo que volver a pedir este render?» y la de allá es «¿tengo este
 * artefacto en disco?». Alinearlas obligaría a este adaptador a replicar los
 * defaults de zod del servicio y su versión de registro tipográfico, y a
 * romperse callado cada vez que allá cambie un default. `keys` viaja en
 * {@link HttpRenderBuild} sólo para diagnóstico.
 *
 * **2. El fingerprint incluye la versión del mapeo.** Este adaptador convierte
 * píxeles de canvas a unidades de editor (ver `render-wire.ts`), así que **el
 * mapeo también decide el resultado**. Si cambia la conversión, los artefactos
 * viejos ya no corresponden al mismo hash: por eso {@link MAPPING_VERSION}
 * entra al hash y hay que subirla con cualquier cambio de `render-wire.ts` que
 * mueva un píxel. Es la misma regla que `ENGINE_VERSION` del servicio.
 *
 * **3. `body` es un `AsyncIterable` que no acumula.** El puerto lo pide así a
 * propósito: un render de 50 MB (`NFR-013`) no se materializa en memoria sólo
 * para cruzar la frontera hacia `Storage`. Se lee del `ReadableStream` de
 * `fetch` con un `getReader()` y se va cediendo chunk por chunk. **Nada se
 * junta en un buffer en ningún momento**, y el total se cuenta mientras pasa
 * para poder detectar un artefacto truncado (ver {@link streamBody}).
 *
 * ## Timeouts
 *
 * `NFR-001` acota un build a 30 s–2 min. Un `fetch` sin timeout deja un job
 * colgado ocupando un slot del worker para siempre, así que hay dos relojes y
 * los dos vencen en `timeout`, no en un error genérico:
 *
 *  - `timeoutMs` (default 2 min, el techo de `NFR-001`) para el `POST /render`
 *    y para el `GET` del artefacto **hasta que llegan las cabeceras**.
 *  - `idleTimeoutMs` (default 30 s) **entre chunks** del cuerpo. No se puede
 *    usar el primero para el cuerpo entero: quien consume el stream lo hace al
 *    ritmo de la subida a `Storage`, y matar una subida legítima de 50 MB por
 *    pasarse del presupuesto de render sería peor que el problema. Lo que hay
 *    que matar es una conexión que **no avanza**, y eso es inactividad.
 *
 * ## Lo que este adaptador NO hace
 *
 *  - **No autoriza.** El puerto es explícito: validar que la media pertenezca
 *    al workspace es de `core`, con scope de `companyId`. Acá ni se mira.
 *    Ojo con la consecuencia operativa: `services/render` tiene
 *    `RENDER_REQUIRE_GRANT=true` por defecto y el puerto no tiene por dónde
 *    pasar un grant firmado. Ver el reporte de `P2-RENDER-002`.
 *  - **No sube el resultado.** IMPL §2.3 separa render y subida para poder
 *    cachear entre los dos pasos.
 *  - **No implementa `normalize`, `probe` ni `thumbnail`**: el servicio no
 *    expone endpoints para eso. Fallan claro en vez de fingir, con el código
 *    razonado en `missingEndpoint`.
 */

import { createHash } from "node:crypto";
import {
  PortError,
  type BrandBackgroundGenerator,
  type BrandBackgroundRequest,
  type Clock,
  type MediaAuthorization,
  type MediaProbe,
  type MediaRenderer,
  type NormalizeRequest,
  type PortErrorCode,
  type RenderedMedia,
  type RenderJob,
  type RenderResult,
  type ThumbnailRequest,
} from "@fastgram/ports";
import { systemClock } from "../clock/index.js";
import { signMediaGrant, type SignedMediaGrant } from "./media-grant.js";
import { assertJobIsValid, canonicalize, canvasOf } from "./job-rules.js";
import {
  DEFAULT_MAPPING,
  toWirePayload,
  type RenderMappingConfig,
  type WirePayload,
} from "./render-wire.js";

const SOURCE = "MediaRenderer/http";

/**
 * Versión del mapeo puerto → payload del servicio. **Subirla con cualquier
 * cambio de `render-wire.ts` que altere el resultado visual**: es lo que hace
 * que el cache no sirva un artefacto viejo renderizado con otra conversión.
 */
export const MAPPING_VERSION = "1";

/** Techo de `NFR-001` para un build. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Inactividad tolerada entre chunks del cuerpo del artefacto. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Vida del grant firmado.
 *
 * Tiene que cubrir el build más lento —`DEFAULT_TIMEOUT_MS` son 2 min— más la
 * bajada de los N artefactos, porque el mismo grant se usa para el `POST` y
 * para cada `GET /artifact`. Un grant que vence entre el render y la bajada del
 * slide 14 produce un build a medias que ya se pagó en CPU.
 */
const DEFAULT_GRANT_TTL_MS = 600_000;

/**
 * Lo que el servicio escribe hoy, según `render/engine.ts`: los videos van a
 * `.mp4` y los slides a `.jpg`. Sólo se usa como respaldo cuando la respuesta
 * no declara un `content-type` utilizable.
 */
const CONTENT_TYPE_BY_KIND: Readonly<Record<ArtifactKind, string>> = {
  video: "video/mp4",
  image: "image/jpeg",
};

/** El `fetch` global alcanza; entra por config para poder testear sin red. */
export type RenderFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface HttpMediaRendererConfig {
  /** Base del servicio, p. ej. `http://render:3002`. Sin ruta. */
  readonly baseUrl: string;
  /**
   * Versión del motor, que entra al fingerprint.
   *
   * **Es obligatoria y a propósito no tiene default.** IMPL §5 y
   * `P2-RENDER-011`: un upgrade de FFmpeg que mueva la tipografía **debe**
   * invalidar el cache en vez de servir frames viejos. Un default silencioso
   * haría que ese upgrade pase desapercibido, que es exactamente el modo de
   * falla que los golden-file tests buscan detectar. Quien monta el adaptador
   * la resuelve al arrancar con {@link fetchRenderEngineVersion} —que sí puede
   * tocar la red— y la inyecta acá.
   */
  readonly engineVersion: string;
  /** Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Default {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  readonly idleTimeoutMs?: number;
  readonly fetch?: RenderFetch;
  readonly clock?: Clock;
  /** Lo que el PRD no define. Ver {@link DEFAULT_MAPPING}. */
  readonly mapping?: Partial<RenderMappingConfig>;
  /**
   * El servicio devuelve `warnings` para cosas que salieron bien pero hay que
   * saber: «se renderizó con una fuente no verificada» (trampa 6), «HDR sin
   * tone mapping». `RenderResult` no tiene dónde ponerlas, así que sin este
   * gancho se perderían — y una pieza publicada con la tipografía equivocada y
   * sin rastro en ningún log es justo lo que la trampa 6 describe.
   *
   * **Cuidado con lo que este gancho puede prometer: no es una auditoría.**
   * Medido del lado del servicio: en un **cache hit** los `warnings` vuelven
   * vacíos, porque el overlay no se recompone. El mismo payload devolvió
   * `["el overlay se renderizó con una fuente no verificada"]` la primera vez y
   * `[]` la segunda. O sea: el aviso aparece una sola vez por payload, y una
   * pieza servida desde la cache hereda el artefacto de aquel primer render
   * **sin heredar su warning**. No es un bug del servicio. Sirve para
   * diagnosticar un despliegue, no para responder «¿esta pieza salió con la
   * fuente correcta?».
   */
  readonly onWarnings?: (warnings: readonly string[], context: WarningContext) => void;
  /**
   * Secreto HMAC con el que se firma el grant de media (`NFR-006`).
   *
   * **Sin esto, el aislamiento por workspace no existe.** El servicio puede
   * seguir aplicando `RENDER_ALLOWED_MEDIA_PREFIXES`, que es global: acepta o
   * rechaza igual para el workspace 42 y para el 43. El grant es lo único que
   * dice *de quién* es la media.
   *
   * Es opcional en el tipo y no en el despliegue: un servicio configurado sólo
   * con prefijos globales es una topología válida (un entorno de desarrollo con
   * un bucket), y obligarlo acá haría inventar un secreto para arrancarlo. Lo
   * que no puede pasar es llegar a producción sin él, y eso lo comprueba
   * `assertRendererIsolation` del lado del worker.
   *
   * Viene del entorno. Nunca del repo.
   */
  readonly grantSecret?: string;
  /** Vida del grant firmado. Default {@link DEFAULT_GRANT_TTL_MS}. */
  readonly grantTtlMs?: number;
}

export interface WarningContext {
  readonly format: RenderJob["format"];
  readonly fingerprint: string;
}

export type ArtifactKind = "video" | "image";

export interface HttpRenderArtifactRef {
  readonly kind: ArtifactKind;
  readonly index: number;
  /** Lo que el servicio dice que pesa el archivo. */
  readonly sizeBytes: number;
  /**
   * Path opaco elegido por el servidor. Hoy tiene forma de
   * `/artifact/<hash>[-<índice>].<mp4|jpg>`, y el esquema de claves **no es
   * contrato**: `services/render` puede cambiarlo sin avisar. No se parsea.
   */
  readonly href: string;
  /**
   * Baja el artefacto. **Una sola vez por referencia**: devuelve un stream, no
   * un buffer. Hasta que se llama no cruza ni un byte.
   *
   * **Se llama en el mismo flujo que el `POST /render`, y el `href` no se
   * guarda para después.** La cache de `services/render` es local al proceso:
   * con varias réplicas y sin volumen compartido, el `POST` se resuelve en una
   * y el `GET` puede caer en otra que no tiene el archivo. Cuanto más tiempo
   * pasa entre los dos, más probable es un `not_found` que ya no se arregla
   * reintentando (ver {@link SERVICE_CODE_TO_PORT}). Un `href` persistido en
   * la base o en un job de cola es un bug con demora.
   */
  readonly open: () => Promise<RenderedMedia>;
}

/**
 * La respuesta completa de `POST /render`.
 *
 * Existe porque el puerto no la puede expresar: `RenderResult` transporta **un**
 * artefacto y un slideshow de N slides produce N imágenes. Ver
 * {@link HttpMediaRenderer.render}.
 */
export interface HttpRenderBuild {
  readonly type: string;
  /** Claves de cache **del servicio**. Diagnóstico: no son el fingerprint. */
  readonly keys: Readonly<Record<string, string>>;
  readonly cache: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
  readonly artifacts: readonly HttpRenderArtifactRef[];
  readonly fingerprint: string;
  readonly renderMs: number;
}

export class HttpMediaRenderer implements MediaRenderer, BrandBackgroundGenerator {
  readonly #baseUrl: string;
  readonly #engineVersion: string;
  readonly #timeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #fetch: RenderFetch;
  readonly #clock: Clock;
  readonly #mapping: RenderMappingConfig;
  readonly #onWarnings: ((w: readonly string[], c: WarningContext) => void) | undefined;
  readonly #grantSecret: string | undefined;
  readonly #grantTtlMs: number;

  constructor(config: HttpMediaRendererConfig) {
    if (config.baseUrl.length === 0) {
      throw new PortError("bad_request", "render service base URL is not configured", {
        source: SOURCE,
      });
    }
    if (config.engineVersion.length === 0) {
      // Sin versión de motor el cache de IMPL §5 serviría frames viejos después
      // de un upgrade, y nada lo diría.
      throw new PortError("bad_request", "render engine version is not configured", {
        source: SOURCE,
      });
    }
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#engineVersion = config.engineVersion;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = config.clock ?? systemClock;
    this.#mapping = { ...DEFAULT_MAPPING, ...config.mapping };
    this.#onWarnings = config.onWarnings;
    this.#grantSecret = config.grantSecret;
    this.#grantTtlMs = config.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  }

  /**
   * Acuña el grant que acompaña a cada pedido, o `undefined` si no hay secreto.
   *
   * Se acuña **por pedido** y no por instancia: el `expiresAt` tiene que
   * medirse desde el pedido, no desde el arranque del worker. Un worker que
   * vive días con un grant acuñado al iniciar mandaría grants vencidos para
   * siempre, y el síntoma sería `media_grant_invalid` en todos los builds
   * después de la primera hora.
   */
  #grant(auth: MediaAuthorization): SignedMediaGrant | undefined {
    if (this.#grantSecret === undefined) return undefined;
    return signMediaGrant(auth, {
      secret: this.#grantSecret,
      nowMs: this.#clock.nowMs(),
      ttlMs: this.#grantTtlMs,
    });
  }

  /**
   * Hash estable del job más la versión del motor y la del mapeo.
   *
   * **Puro**: no toca red ni disco. Eso es lo que obliga a que la versión del
   * motor sea configuración inyectada y no una consulta a `/capabilities`.
   * La serialización es canónica (claves ordenadas, ver `job-rules.ts`) porque
   * `core` arma los payloads con spreads y dos spreads en distinto orden dan el
   * mismo objeto con distinto `JSON.stringify`.
   */
  fingerprint(job: RenderJob): string {
    const canonical = canonicalize({
      engine: this.#engineVersion,
      mapping: MAPPING_VERSION,
      job,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Un build, con **un** artefacto.
   *
   * Si el servicio devuelve más de uno —un slideshow de N slides son N
   * imágenes— esto falla con `provider_contract_violation` en vez de devolver
   * el primero. Devolver el primero produciría una pieza de una sola imagen,
   * publicada, sin ningún error en ningún log: es exactamente el modo de falla
   * que `FR-070` intenta evitar con la validación de `num_images` («produce un
   * slideshow corto sin avisar»). El puerto no puede expresar N artefactos;
   * mientras siga así, un slideshow multi-slide se construye con
   * {@link renderAll}, que sí los devuelve todos. Está reportado.
   */
  async render(job: RenderJob, auth: MediaAuthorization): Promise<RenderResult> {
    const startedAt = this.#clock.nowMs();
    const build = await this.renderAll(job, auth);
    const [artifact, ...rest] = build.artifacts;

    if (artifact === undefined) {
      throw new PortError(
        "provider_contract_violation",
        "the render service returned no artifact",
        { source: SOURCE },
      );
    }
    if (rest.length > 0) {
      throw new PortError(
        "provider_contract_violation",
        `the render service returned ${String(build.artifacts.length)} artifacts and ` +
          "MediaRenderer.render carries one; use renderAll for multi-artifact builds",
        { source: SOURCE },
      );
    }

    const media = await artifact.open();
    return {
      ...media,
      fingerprint: build.fingerprint,
      // Reloj de pared del adaptador: incluye el round trip HTTP y las
      // cabeceras del artefacto, y puede ser milisegundos si el servicio
      // acertó su cache. **No es tiempo de encode**: el servicio no lo
      // reporta. Reportado como pedido a `services/render`.
      renderMs: this.#clock.nowMs() - startedAt,
    };
  }

  /**
   * `POST /render` completo: todos los artefactos, más `warnings`, `cache` y
   * las claves de cache del servicio.
   *
   * No es parte del puerto. Existe para lo que el puerto no expresa (N
   * artefactos) y para lo que tiraría a la basura (los `warnings`).
   */
  async renderAll(job: RenderJob, auth: MediaAuthorization): Promise<HttpRenderBuild> {
    const startedAt = this.#clock.nowMs();
    // Las reglas de `FR-070` que no dependen del motor se verifican acá para
    // que los dos adaptadores den el mismo `bad_request` con o sin servicio
    // arriba. El servicio las vuelve a verificar: es defensa en profundidad,
    // no una segunda definición (ver `job-rules.ts`).
    assertJobIsValid(job, SOURCE);

    const payload: WirePayload = toWirePayload(job, this.#mapping, SOURCE);
    const grant = this.#grant(auth);
    const response = await this.#request("POST", "/render", {
      payload,
      ...(grant === undefined ? {} : { grant }),
    });

    if (!response.ok) throw await translateHttp(response, "render");

    const raw = await readJson(response);
    const fingerprint = this.fingerprint(job);
    const build = parseRenderResponse(
      raw,
      job,
      fingerprint,
      this.#clock.nowMs() - startedAt,
      {
        open: (href, kind, index, declaredBytes) =>
          this.#openArtifact(job, href, kind, index, declaredBytes),
      },
    );

    if (build.warnings.length > 0 && this.#onWarnings !== undefined) {
      this.#onWarnings(build.warnings, { format: job.format, fingerprint });
    }
    return build;
  }

  /**
   * `NFR-014` / `P2-RENDER-013`. **Sin endpoint del lado del servicio.**
   *
   * `services/render` tiene `ffmpeg/normalize.ts` y lo usa internamente antes
   * de encodear, pero no lo expone por HTTP: su superficie es `/health`,
   * `/capabilities` y `/render`. Falta `POST /normalize`.
   */
  async normalize(
    request: NormalizeRequest,
    auth: MediaAuthorization,
  ): Promise<RenderedMedia> {
    const grant = this.#grant(auth);
    const response = await this.#request("POST", "/normalize", {
      url: request.url,
      targetContentType: request.targetContentType,
      ...(grant === undefined ? {} : { grant }),
    });
    if (!response.ok) throw await translateHttp(response, "normalize");
    return await this.#openDescribedMedia(await readJson(response), "normalize");
  }

  /**
   * `ERR-P11`. **Sin endpoint del lado del servicio.** Existe
   * `ffmpeg/probe.ts` (ffprobe) y no hay ruta HTTP. Falta `POST /probe`.
   */
  async probe(url: string, auth: MediaAuthorization): Promise<MediaProbe> {
    const grant = this.#grant(auth);
    const response = await this.#request("POST", "/probe", {
      url,
      ...(grant === undefined ? {} : { grant }),
    });
    if (!response.ok) throw await translateHttp(response, "probe");
    return parseProbeResponse(await readJson(response));
  }

  /**
   * IMPL §5: «Nunca servir el master para un preview». **Sin endpoint del lado
   * del servicio.** Falta `POST /thumbnail`.
   */
  async thumbnail(
    request: ThumbnailRequest,
    auth: MediaAuthorization,
  ): Promise<RenderedMedia> {
    const grant = this.#grant(auth);
    const response = await this.#request("POST", "/thumbnail", {
      url: request.url,
      maxWidth: request.maxWidth,
      ...(request.atSeconds === undefined ? {} : { atSeconds: request.atSeconds }),
      ...(grant === undefined ? {} : { grant }),
    });
    if (!response.ok) throw await translateHttp(response, "thumbnail");
    return await this.#openDescribedMedia(await readJson(response), "thumbnail");
  }

  /**
   * `PU-MEDIA-002` — `POST /brand-backgrounds`. Un fondo de marca generado por
   * el servicio, sin proveedor: misma forma que `/thumbnail` (metadatos en la
   * respuesta, bytes por el `href`), así que se abre con el mismo camino.
   *
   * El grant no autoriza URLs —no hay media que leer— sino **al que pide**: con
   * `RENDER_REQUIRE_GRANT=true` el servicio no genera nada sin uno válido.
   */
  async generateBrandBackground(
    request: BrandBackgroundRequest,
    auth: MediaAuthorization,
  ): Promise<RenderedMedia> {
    const grant = this.#grant(auth);
    const response = await this.#request("POST", "/brand-backgrounds", {
      palette: request.palette,
      seed: request.seed,
      kind: request.kind,
      ...(request.kind === "image"
        ? { aspectRatio: request.aspectRatio }
        : { aspectRatio: "9:16", durationSeconds: request.durationSeconds }),
      ...(grant === undefined ? {} : { grant }),
    });
    if (!response.ok) throw await translateHttp(response, "brand-backgrounds");
    const media = await this.#openDescribedMedia(
      await readJson(response),
      "brand-backgrounds",
    );
    const expected = request.kind === "image" ? "image/jpeg" : "video/mp4";
    if (media.contentType !== expected) {
      throw contractViolation(
        `brand-backgrounds returned ${media.contentType} for a ${request.kind}`,
      );
    }
    return media;
  }

  /**
   * Abre los bytes de un artefacto que el servicio **describió** en su
   * respuesta (`/normalize`, `/thumbnail`).
   *
   * Es distinto de {@link HttpMediaRenderer.#openArtifact}, que sirve a
   * `/render`: allá las dimensiones salen del canvas pedido porque el servicio
   * no las reporta. Acá sí las reporta —el archivo es el resultado de medirlo,
   * no de dibujarlo— y usarlas es lo único correcto: un thumbnail con
   * `maxWidth: 320` sobre un video 9:16 no mide 320 de ancho, mide lo que el
   * escalado le dio, y el contrato del puerto exige que `width` sea real para
   * poder comprobar que no se está sirviendo el master.
   */
  async #openDescribedMedia(raw: unknown, method: string): Promise<RenderedMedia> {
    const described = parseDescribedMedia(raw, method);
    const response = await this.#request("GET", described.href);
    if (!response.ok) throw await translateHttp(response, "artifact");

    const body = response.body;
    if (body === null) {
      throw new PortError(
        "provider_contract_violation",
        "the artifact response had no body",
        { source: SOURCE },
      );
    }
    assertDeclaredLength(response, described.sizeBytes);

    return {
      body: streamBody(body, described.sizeBytes, this.#idleTimeoutMs),
      contentType: described.contentType,
      sizeBytes: described.sizeBytes,
      width: described.width,
      height: described.height,
      ...(described.durationSeconds === undefined
        ? {}
        : { durationSeconds: described.durationSeconds }),
    };
  }

  /** `GET /capabilities`: qué trae el FFmpeg de esa máquina y qué fuentes faltan. */
  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.#request("GET", "/capabilities");
    if (!response.ok) throw await translateHttp(response, "capabilities");
    const json = await readJson(response);
    if (typeof json !== "object" || json === null) {
      throw new PortError(
        "provider_contract_violation",
        "/capabilities did not return an object",
        { source: SOURCE },
      );
    }
    return json as Readonly<Record<string, unknown>>;
  }

  /** `GET /health`. `true` sólo si contesta 200. */
  async healthy(): Promise<boolean> {
    try {
      const response = await this.#request("GET", "/health");
      // El cuerpo no interesa, pero hay que consumirlo o la conexión queda
      // abierta hasta que el GC la cierre.
      await response.text().catch(() => "");
      return response.ok;
    } catch {
      return false;
    }
  }

  async #openArtifact(
    job: RenderJob,
    href: string,
    kind: ArtifactKind,
    index: number,
    declaredBytes: number,
  ): Promise<RenderedMedia> {
    assertOpaqueHref(href);
    const response = await this.#request("GET", href);
    if (!response.ok) throw await translateHttp(response, "artifact");

    const body = response.body;
    if (body === null) {
      throw new PortError(
        "provider_contract_violation",
        "the artifact response had no body",
        { source: SOURCE },
      );
    }

    assertDeclaredLength(response, declaredBytes);
    const canvas = canvasOf(job, SOURCE, index);

    return {
      body: streamBody(body, declaredBytes, this.#idleTimeoutMs),
      contentType: resolveContentType(response.headers.get("content-type"), kind),
      sizeBytes: declaredBytes,
      // **Las dimensiones son las del canvas pedido, no las medidas sobre el
      // archivo.** El servicio no las devuelve y el puerto las exige.
      //
      // Medido contra `services/render` real (2026-09-22), porque la sospecha
      // obvia era que `toEvenDimension` —que redondea a par para h264— dejara
      // el archivo 1 px más chico que lo declarado:
      //
      //   canvas 1080×1920 → ffprobe dice 1080×1920 ✔
      //   canvas 1082×1922 → ffprobe dice 1082×1922 ✔
      //   canvas 1081×1921 → **el build falla** con `render_failed`
      //                      (ffmpeg exit 187); no hay artefacto que medir.
      //
      // O sea: con canvas par esto es exacto, y con impar no hay mentira
      // posible porque no hay pieza. El sesgo silencioso que se temía no
      // existe. Lo que sí queda abierto es el canvas impar del lado del
      // servicio; está en el reporte.
      width: canvas.width,
      height: canvas.height,
      // `durationSeconds` se omite: el servicio no lo reporta y adivinarlo
      // sería inventar. Quien lo necesite tiene que probar el archivo.
    };
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers:
          body === undefined
            ? { Accept: "application/json" }
            : { "Content-Type": "application/json", Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw translateTransport(cause, controller.signal.aborted);
    } finally {
      // Se limpia en cuanto llegan las cabeceras: el cuerpo lo cuida
      // `idleTimeoutMs`. Si este timer siguiera armado, abortaría la descarga
      // de un artefacto grande que se está consumiendo bien.
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Versión del motor — la parte que sí puede tocar la red
 * ------------------------------------------------------------------------ */

export interface EngineVersionQuery {
  readonly baseUrl: string;
  readonly fetch?: RenderFetch;
  readonly timeoutMs?: number;
}

/**
 * Lee `GET /capabilities` y arma la etiqueta de versión de motor que
 * {@link HttpMediaRendererConfig.engineVersion} pide.
 *
 * Vive afuera de la clase porque `fingerprint` tiene que ser puro: esto se
 * llama **una vez al arrancar el proceso** y su resultado se inyecta.
 *
 * Lo que entra en la etiqueta es lo que `/capabilities` expone hoy: la versión
 * de FFmpeg y la estrategia de texto. **Falta lo más importante**: el
 * `ENGINE_VERSION` del servicio (`domain/hash.ts`, hoy `"1"`), que es lo que
 * sube cuando cambia el filtergraph, y `FONT_REGISTRY_VERSION`, que sube
 * cuando cambia una fuente. Sin ellos, un cambio en cómo el servicio arma el
 * overlay **no** invalida el fingerprint de este lado. Está reportado como
 * pedido a `services/render`; hasta que exista, quien monte el adaptador puede
 * concatenar su propio sufijo a mano en cada deploy.
 */
export async function fetchRenderEngineVersion(
  query: EngineVersionQuery,
): Promise<string> {
  const base = query.baseUrl.replace(/\/+$/, "");
  const doFetch = query.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, query.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(`${base}/capabilities`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (cause) {
    throw translateTransport(cause, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw await translateHttp(response, "capabilities");
  const json = await readJson(response);
  const caps = asRecord(json)?.["ffmpeg"];
  const ffmpeg = asRecord(caps);
  const available = ffmpeg?.["available"];
  const version = ffmpeg?.["version"];

  if (available !== true || typeof version !== "string" || version.length === 0) {
    // Un servicio sin FFmpeg no puede renderizar nada: mejor no levantar el
    // worker que levantarlo con una versión de motor inventada.
    throw new PortError(
      "provider_unavailable",
      "the render service reports no usable ffmpeg",
      { source: SOURCE },
    );
  }

  const strategy = asRecord(json)?.["textStrategy"];
  return typeof strategy === "string" && strategy.length > 0
    ? `ffmpeg-${version}+text-${strategy}`
    : `ffmpeg-${version}`;
}

/* ------------------------------------------------------------------------ *
 * Respuesta de `POST /render`
 * ------------------------------------------------------------------------ */

interface ArtifactOpener {
  readonly open: (
    href: string,
    kind: ArtifactKind,
    index: number,
    declaredBytes: number,
  ) => Promise<RenderedMedia>;
}

/**
 * Valida la respuesta y la convierte en {@link HttpRenderBuild}.
 *
 * El criterio de rigor no es uniforme, y es deliberado: **estricto con lo que
 * el build necesita, tolerante con lo que es diagnóstico**. `artifacts` y
 * `type` se validan campo por campo porque de ellos depende la pieza; `keys`,
 * `cache` y `warnings` se toman como vengan, porque fallar un render que salió
 * bien por la forma de un campo informativo sería cobrarle al usuario un bug
 * de observabilidad.
 */
function parseRenderResponse(
  raw: unknown,
  job: RenderJob,
  fingerprint: string,
  renderMs: number,
  opener: ArtifactOpener,
): HttpRenderBuild {
  const body = asRecord(raw);
  if (body === null) {
    throw new PortError(
      "provider_contract_violation",
      "POST /render did not return a JSON object",
      { source: SOURCE },
    );
  }

  const type = body["type"];
  if (typeof type !== "string") {
    throw new PortError("provider_contract_violation", "the build has no type", {
      source: SOURCE,
    });
  }
  if (type !== job.format) {
    // Si el servicio dice haber construido otra cosa, el mapeo del payload
    // divergió: es la trampa 19 (dos procesos, dos nombres) y se detecta acá
    // antes de subir una pieza que no es la que se pidió.
    throw new PortError(
      "provider_contract_violation",
      `asked for a ${job.format} build and the service answered ${type}`,
      { source: SOURCE },
    );
  }

  const rawArtifacts = body["artifacts"];
  if (!Array.isArray(rawArtifacts)) {
    throw new PortError("provider_contract_violation", "the build has no artifacts", {
      source: SOURCE,
    });
  }

  const expected = expectedArtifactCount(job);
  if (rawArtifacts.length !== expected) {
    // Un slideshow con menos artefactos que slides es el «slideshow corto sin
    // avisar» de `FR-070`, del otro lado del cable.
    throw new PortError(
      "provider_contract_violation",
      `a ${job.format} build should produce ${String(expected)} artifact(s) and the ` +
        `service returned ${String(rawArtifacts.length)}`,
      { source: SOURCE },
    );
  }

  const artifacts = rawArtifacts.map((entry, position) =>
    parseArtifact(entry, position, opener),
  );

  return {
    type,
    keys: stringRecord(body["keys"]),
    cache: stringRecord(body["cache"]),
    warnings: Array.isArray(body["warnings"])
      ? body["warnings"].filter((w): w is string => typeof w === "string")
      : [],
    artifacts,
    fingerprint,
    renderMs,
  };
}

function parseArtifact(
  entry: unknown,
  position: number,
  opener: ArtifactOpener,
): HttpRenderArtifactRef {
  const artifact = asRecord(entry);
  const kind = artifact?.["kind"];
  const href = artifact?.["href"];
  const bytes = artifact?.["bytes"];
  const index = artifact?.["index"];

  if (kind !== "video" && kind !== "image") {
    throw new PortError(
      "provider_contract_violation",
      `artifact ${String(position)} has no usable kind`,
      { source: SOURCE },
    );
  }
  if (typeof href !== "string" || href.length === 0) {
    // Sin `href` no hay bytes que bajar. Es el caso del servicio que todavía
    // no implementó el paso 2 del contrato: devuelve `{kind,index,bytes}` y
    // nada más. Falla claro en vez de subir un artefacto vacío.
    throw new PortError(
      "provider_contract_violation",
      `artifact ${String(position)} has no href: this deployment of services/render ` +
        "does not serve artifact bytes yet",
      { source: SOURCE },
    );
  }
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    // 0 bytes con status 200 es la trampa de `render_empty_output` del lado del
    // servicio; acá se la ve igual y no se deja pasar.
    throw new PortError(
      "provider_contract_violation",
      `artifact ${String(position)} declares no bytes`,
      { source: SOURCE },
    );
  }

  const resolvedIndex =
    typeof index === "number" && Number.isFinite(index) ? index : position;
  return {
    kind,
    index: resolvedIndex,
    sizeBytes: bytes,
    href,
    open: () => opener.open(href, kind, resolvedIndex, bytes),
  };
}

/**
 * `POST /probe` → {@link MediaProbe}.
 *
 * Las tres banderas se exigen presentes y booleanas en vez de caer a `false`.
 * Un default acá sería el peor error posible de este archivo: `isHdr: false`
 * por omisión hace que `NFR-014` no tone-mapee un PQ real y la pieza salga
 * lavada, sin un solo error en ningún log. Si el servicio no las manda, esto
 * es un incumplimiento de contrato y se dice.
 */
function parseProbeResponse(raw: unknown): MediaProbe {
  const body = asRecord(raw);
  const contentType = body?.["contentType"];
  const width = body?.["width"];
  const height = body?.["height"];
  const hasAudio = body?.["hasAudio"];
  const isHdr = body?.["isHdr"];
  const isFastStart = body?.["isFastStart"];
  const duration = body?.["durationSeconds"];

  if (typeof contentType !== "string" || contentType.length === 0) {
    throw contractViolation("probe response has no contentType");
  }
  if (!isPositive(width) || !isPositive(height)) {
    throw contractViolation("probe response has no usable dimensions");
  }
  if (
    typeof hasAudio !== "boolean" ||
    typeof isHdr !== "boolean" ||
    typeof isFastStart !== "boolean"
  ) {
    throw contractViolation(
      "probe response is missing the flags that govern normalization",
    );
  }

  return {
    contentType,
    width,
    height,
    hasAudio,
    isHdr,
    isFastStart,
    ...(isPositive(duration) ? { durationSeconds: duration } : {}),
  };
}

interface DescribedMedia {
  readonly href: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number | undefined;
}

/**
 * Lo que `/normalize` y `/thumbnail` devuelven: los metadatos del artefacto
 * más el `href` por donde bajarlo.
 *
 * El campo del tamaño es `sizeBytes`, **no** `bytes` como en los artefactos de
 * `/render`. Son dos formas distintas del mismo servicio.
 */
function parseDescribedMedia(raw: unknown, method: string): DescribedMedia {
  const body = asRecord(raw);
  const href = body?.["href"];
  const contentType = body?.["contentType"];
  const sizeBytes = body?.["sizeBytes"];
  const width = body?.["width"];
  const height = body?.["height"];
  const duration = body?.["durationSeconds"];

  if (typeof href !== "string" || href.length === 0) {
    throw contractViolation(`${method} response has no href`);
  }
  assertOpaqueHref(href);
  if (typeof contentType !== "string" || contentType.length === 0) {
    throw contractViolation(`${method} response has no contentType`);
  }
  if (!isPositive(sizeBytes)) {
    // 0 bytes con 200 es la misma trampa que `render_empty_output`.
    throw contractViolation(`${method} response declares no bytes`);
  }
  if (!isPositive(width) || !isPositive(height)) {
    throw contractViolation(`${method} response has no usable dimensions`);
  }

  return {
    href,
    contentType,
    sizeBytes,
    width,
    height,
    durationSeconds: isPositive(duration) ? duration : undefined,
  };
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function contractViolation(message: string): PortError {
  return new PortError("provider_contract_violation", message, { source: SOURCE });
}

function expectedArtifactCount(job: RenderJob): number {
  return job.format === "slideshow" ? job.images.length : 1;
}

/* ------------------------------------------------------------------------ *
 * El cuerpo del artefacto
 * ------------------------------------------------------------------------ */

/**
 * `href` se usa **tal cual**, concatenado al base URL. Esto no lo parsea: sólo
 * verifica que sea un path absoluto.
 *
 * La comprobación no es cosmética. Un `href` absoluto (`https://otro/…`)
 * concatenado daría una URL sin sentido y el fallo aparecería como un error de
 * red raro; peor, aceptar un host elegido por la respuesta sería dejar que el
 * servicio redirija la descarga a donde quiera. Se rechaza temprano y con un
 * mensaje que dice qué se esperaba.
 */
function assertOpaqueHref(href: string): void {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("://")) {
    throw new PortError(
      "provider_contract_violation",
      "the artifact href must be a path starting with a single /",
      { source: SOURCE },
    );
  }
}

/**
 * Cruza `content-length` con lo que el JSON declaró.
 *
 * Sólo cuando no hay `content-encoding`: con compresión de por medio
 * `content-length` es el tamaño comprimido y `fetch` descomprime solo, así que
 * la comparación daría un falso positivo.
 */
function assertDeclaredLength(response: Response, declaredBytes: number): void {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding !== "" && encoding !== "identity") return;

  const header = response.headers.get("content-length");
  if (header === null) return;
  const length = Number(header);
  if (!Number.isFinite(length)) return;
  if (length !== declaredBytes) {
    throw new PortError(
      "provider_contract_violation",
      `the build declared ${String(declaredBytes)} bytes and the artifact response ` +
        `announces ${String(length)}`,
      { source: SOURCE },
    );
  }
}

/**
 * Qué `content-type` se le declara a `Storage`.
 *
 *  - `video/*` o `image/*` coherente con el `kind` → se usa el del servidor.
 *  - ausente o genérico (`application/octet-stream`) → se usa el respaldo por
 *    `kind`. El servicio escribe `.mp4` y `.jpg`, así que el respaldo es un
 *    hecho verificable, no una suposición.
 *  - `text/*` o `application/json` → **se rechaza**. Un 200 con un cuerpo de
 *    texto es una página de error de algún proxy en el medio, y subirla al
 *    bucket como si fuera el video es una pieza roto sin ningún error.
 *  - `video/*` cuando se esperaba una imagen (o al revés) → se rechaza: el
 *    puerto llama a eso `provider_contract_violation`.
 */
function resolveContentType(header: string | null, kind: ArtifactKind): string {
  const fallback = CONTENT_TYPE_BY_KIND[kind];
  if (header === null) return fallback;

  const value = header.split(";")[0]?.trim().toLowerCase() ?? "";
  if (value === "" || value === "application/octet-stream") return fallback;

  if (value.startsWith("text/") || value === "application/json") {
    throw new PortError(
      "provider_contract_violation",
      `the artifact came back as ${value}, which is not media`,
      { source: SOURCE },
    );
  }
  if (value.startsWith("video/") || value.startsWith("image/")) {
    if (!value.startsWith(`${kind}/`)) {
      throw new PortError(
        "provider_contract_violation",
        `the build declared a ${kind} artifact and the response is ${value}`,
        { source: SOURCE },
      );
    }
    return header;
  }
  return fallback;
}

/**
 * `ReadableStream` → `AsyncIterable<Uint8Array>` **sin acumular**.
 *
 * Tres cosas que hace y conviene no perder:
 *
 *  1. Cede cada chunk tal como llega. No hay buffer intermedio, así que un
 *     artefacto de 50 MB nunca está entero en memoria del worker.
 *  2. Reloj de inactividad **entre chunks**. Un socket que quedó abierto y no
 *     manda nada es lo que cuelga un slot del worker para siempre; sin esto,
 *     ningún timeout cubre el cuerpo.
 *  3. Cuenta el total y falla si no coincide con lo declarado. Un artefacto
 *     truncado subido como completo es una pieza roto sin error, y esto es el
 *     único lugar donde se puede detectar sin juntar los bytes. El error llega
 *     al consumidor a mitad de la subida, que es lo correcto: aborta la subida
 *     en vez de cerrarla como buena.
 *
 * Lo que **no** hace, porque el servicio no lo permite: reanudar. El endpoint
 * de artefacto no soporta `Range` ni `HEAD`, así que una descarga cortada a los
 * 40 MB de 50 no se retoma — se rehace el build entero, y con la cache local
 * del servicio eso puede terminar en `not_found`. Reportado.
 */
function streamBody(
  stream: ReadableStream<Uint8Array>,
  declaredBytes: number,
  idleTimeoutMs: number,
): AsyncIterable<Uint8Array> {
  return (async function* () {
    const reader = stream.getReader();
    let total = 0;
    let drained = false;
    try {
      for (;;) {
        const chunk = await readChunk(reader, idleTimeoutMs);
        if (chunk === null) break;
        total += chunk.byteLength;
        yield chunk;
      }
      drained = true;
    } finally {
      if (!drained) {
        // Consumidor que cortó antes de terminar, o timeout: hay que cerrar el
        // socket o queda colgado hasta que el GC lo note.
        await reader.cancel().catch(() => undefined);
      }
    }

    if (total !== declaredBytes) {
      throw new PortError(
        "provider_contract_violation",
        `the artifact declared ${String(declaredBytes)} bytes and delivered ${String(total)}`,
        { source: SOURCE },
      );
    }
  })();
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<Uint8Array | null> {
  const read = reader.read();
  // Si la carrera la gana el reloj, esta promesa puede rechazar después y sin
  // nadie escuchando: el `catch` vacío evita un unhandled rejection que
  // tumbaría el proceso del worker.
  void read.catch(() => undefined);

  if (idleTimeoutMs <= 0) {
    const result = await read;
    return result.done ? null : (result.value ?? null);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new PortError(
          "timeout",
          `the artifact stream stalled for ${String(idleTimeoutMs)} ms`,
          { source: SOURCE },
        ),
      );
    }, idleTimeoutMs);
  });

  try {
    const result = await Promise.race([read, idle]);
    return result.done ? null : (result.value ?? null);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------ *
 * Traducción de errores — PRD §10, `NFR-022`, regla 6 de CLAUDE.md
 * ------------------------------------------------------------------------ */

/**
 * `RenderErrorCode` del servicio → código estable del puerto.
 *
 * La clasificación **reintentable vs permanente** no es de estilo: el handler
 * de `apps/worker` reintenta exactamente `provider_unavailable`, `timeout` y
 * `rate_limited`, y con el resto cierra la pieza en `FAILED` y **devuelve el
 * content save**. Clasificar mal un permanente como reintentable retrasa un
 * reembolso; clasificar mal un transitorio como permanente mata una pieza que
 * se podía construir. Cada fila de acá está decidida con esa pregunta:
 * *¿el mismo payload, minutos después, puede salir distinto?*
 *
 *  - `bad_request`, `media_url_not_allowed`, `media_grant_invalid`,
 *    `content_unavailable_for_type`, `unsupported_media_format` →
 *    **`bad_request`**, permanente. Son propiedades del payload. El puerto
 *    nombra explícitamente el caso de `video-hook` sin demo
 *    (`422 content_unavailable_for_type`) como `bad_request`.
 *    `media_url_not_allowed` podría parecer `forbidden`, pero el puerto no
 *    autoriza: desde acá, una URL que la política rechaza es un payload que no
 *    se puede construir.
 *  - `media_probe_failed` (502) → **`not_found`**, permanente. El status
 *    sugiere upstream, pero el disparador real es una URL que no resuelve —una
 *    firma vencida, un objeto borrado—, y la URL viaja **en el payload**: el
 *    reintento la vuelve a usar y vuelve a fallar. Es el caso que el propio
 *    `build-handler` describe como «el que más tienta a reintentar y el que
 *    menos conviene».
 *  - `font_unavailable` (500) → **`bad_request`**, permanente. Suena a
 *    problema del servidor y no lo es: la familia va en el payload, y
 *    `tiktok`/`snapchat` están en `FONT_REGISTRY` con `licence: "unresolved"`
 *    y sin archivo distribuible. Con `RENDER_FONT_STRICT=true` esa pieza no se
 *    puede construir en **ningún** pod, hoy ni en diez minutos. Reintentarla
 *    sólo retrasa el reembolso.
 *  - `ffmpeg_unavailable`, `render_capability_missing`, `render_failed` (500) →
 *    **`provider_unavailable`**, reintentable. Son defectos del despliegue o
 *    caídas del encoder, no del payload; la pieza se puede construir sin que
 *    el usuario cambie nada. `render_capability_missing` es el más discutible
 *    —un build de FFmpeg sin `chromakey` no va a crecer uno en el reintento—
 *    pero el costo de equivocarse es unos pocos intentos perdidos, y el de la
 *    otra opción es una tanda de piezas reembolsadas que un deploy habría
 *    salvado.
 *  - `render_empty_output` (500) → **`provider_contract_violation`**,
 *    permanente. Exit 0 sin bytes es determinista para el mismo payload: es la
 *    trampa que `services/render` documenta en su propio `errors.ts`.
 *  - `render_timeout` (504) → **`timeout`**, reintentable.
 *  - `artifact_not_found` (404, de `GET <href>`) → **`not_found`**,
 *    **permanente**. Éste tiene historia y conviene que quede escrita, porque
 *    el razonamiento obvio lleva a la respuesta equivocada.
 *
 *    La primera versión de esta tabla lo clasificaba como
 *    `provider_unavailable` reintentable, con el argumento de que el artefacto
 *    existió —el POST lo devolvió— y volver a renderizar lo vuelve a crear.
 *    Suena bien y está mal, por dos cosas que sólo se ven mirando el
 *    despliegue:
 *
 *      · **La cache del servicio es local al proceso.** Con varias réplicas
 *        detrás de un balanceador y sin volumen compartido, el `POST` se
 *        resuelve en una réplica y el `GET` del `href` puede caer en otra que
 *        no tiene el archivo. Ahí el 404 es *correcto*, y el reintento es una
 *        moneda al aire: puede volver a caer en la réplica equivocada. No es
 *        una falla transitoria, es un despliegue que hay que arreglar (volumen
 *        compartido, o afinidad, o una réplica).
 *      · **Reintentar un render no es gratis.** Es un encode completo, y el
 *        CPU de render es el driver de costo #2 de IMPL §5. Gastar tres
 *        encodes en una moneda al aire es peor que cerrar la pieza y devolver
 *        el save: el usuario recupera su crédito en vez de esperar.
 *
 *    De ahí también la regla de uso de {@link HttpRenderBuild}: el `href` se
 *    consume **en el mismo flujo**, nunca se guarda para después.
 *
 * Un código que no esté en esta tabla —porque el servicio agregó uno— cae en
 * la traducción por status HTTP, que es lo que hace que agregar un código allá
 * no rompa acá.
 */
const SERVICE_CODE_TO_PORT: Readonly<Record<string, PortErrorCode>> = {
  bad_request: "bad_request",
  media_url_not_allowed: "bad_request",
  media_grant_invalid: "bad_request",
  content_unavailable_for_type: "bad_request",
  unsupported_media_format: "bad_request",
  media_probe_failed: "not_found",
  font_unavailable: "bad_request",
  ffmpeg_unavailable: "provider_unavailable",
  render_capability_missing: "provider_unavailable",
  render_failed: "provider_unavailable",
  render_empty_output: "provider_contract_violation",
  render_timeout: "timeout",
  artifact_not_found: "not_found",
};

type Operation =
  | "render"
  | "artifact"
  | "capabilities"
  | "probe"
  | "normalize"
  | "thumbnail"
  | "brand-backgrounds";

/**
 * Los mensajes de acá pueden cruzar hacia el cliente (`PortError.toPublic`),
 * así que son neutrales: nunca el stderr de FFmpeg, nunca una ruta local. El
 * cuerpo original viaja en `cause`, que sólo llega al log — que es la regla del
 * repo y también la del propio servicio, que ya descarta `cause` al serializar.
 */
async function translateHttp(
  response: Response,
  operation: Operation,
): Promise<PortError> {
  const status = response.status;
  // El cuerpo se lee sólo para el `cause` y para el código. Que falle no
  // cambia la clasificación.
  const text = await response.text().catch(() => "");
  const serviceCode = errorCodeOf(text);

  if (serviceCode !== null) {
    const mapped = SERVICE_CODE_TO_PORT[serviceCode];
    if (mapped !== undefined) {
      return new PortError(mapped, messageFor(mapped, operation), {
        source: SOURCE,
        cause: text,
      });
    }
  }

  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    return new PortError(
      "rate_limited",
      "the render service is rate limiting requests",
      retryAfter === null
        ? { source: SOURCE, cause: text }
        : { source: SOURCE, cause: text, retryAfterSeconds: retryAfter },
    );
  }
  if (status === 408 || status === 504) {
    return new PortError("timeout", "the render service timed out", {
      source: SOURCE,
      cause: text,
    });
  }
  if (status === 404) {
    // Acá el status solo no alcanza y la operación decide, porque los dos 404
    // posibles no se parecen en nada:
    //
    //  · en `GET <href>` es el artefacto que no está en la cache de la réplica
    //    que atendió la descarga. Permanente, por las dos razones de la tabla
    //    de arriba (cache local + reintentar es un encode completo). Llega acá
    //    sólo si el cuerpo no trae `artifact_not_found`; con el código, lo
    //    resuelve la tabla y termina en el mismo `not_found`.
    //  · en `POST /render` un 404 es la ruta que no existe —base URL apuntando
    //    a otro servicio, o un despliegue viejo—. Permanente, y el mensaje
    //    tiene que decir eso o se pierde una tarde.
    if (operation === "artifact") {
      return new PortError("not_found", "the rendered artifact is not available", {
        source: SOURCE,
        cause: text,
      });
    }
    return new PortError(
      "provider_contract_violation",
      "the render service does not expose this route",
      { source: SOURCE, cause: text },
    );
  }
  if (status === 401) {
    return new PortError("unauthorized", "the render service rejected the request", {
      source: SOURCE,
      cause: text,
    });
  }
  if (status === 403) {
    return new PortError("forbidden", "the render service refused the request", {
      source: SOURCE,
      cause: text,
    });
  }
  if (status >= 500) {
    return new PortError("provider_unavailable", "the render service is unavailable", {
      source: SOURCE,
      cause: text,
    });
  }
  if (status >= 400) {
    return new PortError("bad_request", "the render service rejected the build", {
      source: SOURCE,
      cause: text,
    });
  }
  // Un 2xx o 3xx que llegó a un `!response.ok`, o un status inventado: el
  // servicio contestó algo que el contrato no prevé.
  return new PortError(
    "provider_contract_violation",
    `the render service answered with an unexpected status ${String(status)}`,
    { source: SOURCE, cause: text },
  );
}

function messageFor(code: PortErrorCode, operation: Operation): string {
  switch (code) {
    case "bad_request":
      // Un `bad_request` de las tres operaciones de media no es un payload de
      // build mal armado: es la URL, el grant o un parámetro fuera de rango.
      // Decir «build payload» ahí mandaría a mirar el lugar equivocado.
      return operation === "render"
        ? "the render service rejected the build payload"
        : `the render service rejected the ${operation} request`;
    case "not_found":
      // Los dos `not_found` del servicio no son lo mismo y el mensaje es lo
      // único que los distingue en el log: uno es una URL del payload que no
      // se pudo leer, el otro el artefacto que ya no está.
      return operation === "artifact"
        ? "the rendered artifact is not available"
        : "a media URL in the build payload could not be read";
    case "timeout":
      return "the render exceeded its time budget";
    case "provider_contract_violation":
      return "the render engine produced no usable output";
    default:
      return `the render service could not complete the ${operation} request`;
  }
}

function translateTransport(cause: unknown, aborted: boolean): PortError {
  if (aborted) {
    return new PortError("timeout", "the render service timed out", {
      source: SOURCE,
      cause,
    });
  }
  return new PortError("provider_unavailable", "the render service is unreachable", {
    source: SOURCE,
    cause,
  });
}

/* ------------------------------------------------------------------------ *
 * Utilidades
 * ------------------------------------------------------------------------ */

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value);
  if (record === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** El `code` del envoltorio `{"error":{"code",...}}`, si se puede leer. */
function errorCodeOf(text: string): string | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const error = asRecord(asRecord(parsed)?.["error"]);
  const code = error?.["code"];
  return typeof code === "string" && code.length > 0 ? code : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new PortError(
      "provider_contract_violation",
      "the render service returned a malformed response",
      { source: SOURCE, cause },
    );
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}
