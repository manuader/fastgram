/**
 * Puerto `ImageGen` y las piezas que comparte con `VideoGen` —
 * `PU-MODEL-003`, `PU-MODEL-005`, `docs/PLAN-USO-PERSONAL.md` §4, D-14.
 *
 * ## Por qué no es `MediaGeneration`
 *
 * `MediaGeneration` (`media-generation.ts`) es el puerto del PRD pensado para
 * GPU propia: créditos, LoRA de influencer, progreso 0–100. Los proveedores
 * del plan de uso personal (Higgsfield, fal) son otra cosa: **colas
 * asíncronas de terceros** con un id de pedido, una URL de estado, resultados
 * que expiran (Higgsfield: «at least seven days», fal: según la política del
 * CDN) y un precio por pedido que se puede **estimar antes** de mandarlo. Este
 * puerto modela exactamente eso y nada más.
 *
 * ## Qué es un modelo acá
 *
 * El id es el que publica el proveedor (endpoint id de Higgsfield, endpoint id
 * de fal). **Ningún id va fijo en `core`**: los elige el usuario en Settings →
 * Models (ADR-009). Cada adaptador expone su catálogo **verificado** en
 * {@link ImageGen.models} —con la página de documentación de la que salió cada
 * id— porque cada modelo tiene su propio esquema de parámetros: un id que el
 * adaptador no conoce no se puede mandar sin inventar el cuerpo.
 *
 * ## Errores
 *
 * - Transporte (`PortError`): `unauthorized`, `quota_exceeded` (sin saldo en el
 *   proveedor), `rate_limited` (tope de concurrencia), `bad_request`,
 *   `not_found`, `provider_unavailable`, `timeout`,
 *   `provider_contract_violation`.
 * - **El filtro de contenido no es un error**: es un resultado legítimo
 *   (`status: "nsfw"`), igual que en `MediaGeneration`. La UI tiene que decir
 *   «el proveedor rechazó el contenido», no «algo falló».
 */

/**
 * Relaciones de aspecto que la app sabe pedir. Cada modelo acepta un
 * subconjunto ({@link GenModelSpec.aspectRatios}); el adaptador rechaza el
 * resto con `bad_request` en vez de mandar algo que el proveedor no documenta.
 */
export const GEN_ASPECT_RATIOS = ["1:1", "4:5", "3:4", "4:3", "9:16", "16:9"] as const;
export type GenAspectRatio = (typeof GEN_ASPECT_RATIOS)[number];

export type GenMediaKind = "image" | "video";

/** Con qué hablarle al proveedor. Sale del registro de modelos. */
export interface GenEndpoint {
  /** Base de la API, sin barra final obligatoria. */
  readonly baseUrl: string;
  /**
   * La credencial en claro. Higgsfield: `KEY_ID:KEY_SECRET` (una sola cadena,
   * así la manda en `Authorization: Key …`). fal: la key.
   */
  readonly apiKey: string;
}

/** Precio de lista de un modelo, **citado** de su página. */
export interface GenListPrice {
  /** Una frase en inglés para la UI: «$0.04 per video second at 480p». */
  readonly summary: string;
  /** La página de la que se copió. */
  readonly sourceUrl: string;
}

/** Lo que la UI y la validación necesitan saber de un modelo del catálogo. */
export interface GenModelSpec {
  /** El endpoint id del proveedor, tal cual. */
  readonly id: string;
  /** Nombre para la UI. Es una marca: no se traduce. */
  readonly label: string;
  readonly kind: GenMediaKind;
  /**
   * Relaciones que acepta. Vacío con {@link aspectFromImage} = la toma de la
   * imagen de entrada.
   */
  readonly aspectRatios: readonly GenAspectRatio[];
  /** La salida sigue a la imagen de entrada y no se puede pedir otra. */
  readonly aspectFromImage: boolean;
  /** Cantidades de salida que se pueden pedir en **un** pedido. */
  readonly counts: readonly number[];
  /** Sólo video: duraciones en segundos que el modelo acepta. */
  readonly durationsSeconds: readonly number[];
  /** Seedance image-to-video, por ejemplo, anima la imagen sin texto. */
  readonly promptRequired: boolean;
  /** Imagen de entrada (video: primer cuadro). */
  readonly imageInput: "none" | "optional" | "required";
  /** Cuántas imágenes de referencia acepta. 0 = ninguna. */
  readonly maxReferenceImages: number;
  /** Página de la documentación de la que salió el id y su esquema. */
  readonly docsUrl: string;
  /** `null` = el proveedor estima el precio por API (Higgsfield). */
  readonly listPrice: GenListPrice | null;
}

/** Un pedido aceptado por el proveedor. Lo que hay que guardar para seguirlo. */
export interface GenJobHandle {
  readonly requestId: string;
  /** La URL de estado **que devolvió el proveedor** (no se arma a mano). */
  readonly statusUrl: string;
  /** fal: dónde se lee el resultado. Higgsfield lo trae en el estado. */
  readonly responseUrl?: string;
}

export type GenJobStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  /** Rechazado por la moderación del proveedor (entrada o salida). */
  | "nsfw"
  | "canceled";

export const TERMINAL_GEN_STATUSES: readonly GenJobStatus[] = [
  "completed",
  "failed",
  "nsfw",
  "canceled",
];

export interface GenOutput {
  /** URL temporal del proveedor: hay que copiarla a nuestro storage. */
  readonly url: string;
  readonly contentType?: string;
}

export interface GenJobState {
  readonly status: GenJobStatus;
  /** Sólo con `completed`. Puede venir vacío si el proveedor filtró todo. */
  readonly outputs: readonly GenOutput[];
  /**
   * Lo que el proveedor dijo al fallar, **ya saneado** (sin cuerpo crudo).
   * Sólo con `failed`/`nsfw`.
   */
  readonly message?: string;
}

/** Un pedido que el proveedor rechazó por contenido al enviarlo (fal: 422). */
export interface GenRejectedSubmission {
  readonly kind: "rejected";
  readonly status: "nsfw";
  readonly message: string;
}

export interface GenAcceptedSubmission {
  readonly kind: "accepted";
  readonly handle: GenJobHandle;
}

export type GenSubmission = GenAcceptedSubmission | GenRejectedSubmission;

/**
 * Costo estimado de un pedido, en USD.
 *
 * - `provider`: lo calculó el proveedor para esta cuenta (Higgsfield
 *   `POST /estimate/…`).
 * - `price_list`: precio de lista de la página del modelo × unidades. Es una
 *   **estimación**: el proveedor puede aplicar descuentos o redondeos.
 */
export interface GenCostEstimate {
  readonly usd: number;
  readonly source: "provider" | "price_list";
  /** Cómo se llegó al número, en inglés para la UI: «5.06 video s × $0.04». */
  readonly basis: string;
  readonly sourceUrl?: string;
  /** Higgsfield devuelve también créditos. */
  readonly credits?: number;
}

export interface ImageGenRequest {
  readonly prompt: string;
  readonly aspectRatio: GenAspectRatio;
  /** Default 1. */
  readonly n?: number;
  /** URLs **públicas**: el proveedor las descarga. */
  readonly referenceImageUrls?: readonly string[];
  /** Endpoint id del catálogo. */
  readonly model: string;
}

/** Una llamada autenticada y barata, para «Test connection». */
export interface GenCredentialCheck {
  readonly latencyMs: number;
  /** Qué se llamó, en inglés para la UI («estimate endpoint»). */
  readonly probe: string;
}

/**
 * Lo común a `ImageGen` y `VideoGen`: seguir un pedido, probar credenciales y
 * el catálogo.
 */
export interface GenProviderClient {
  /** `higgsfield`, `fal`. */
  readonly provider: string;
  /** El catálogo verificado de este adaptador, de las dos clases. */
  models(): readonly GenModelSpec[];
  /**
   * Estado de un pedido. Con `completed` trae las salidas.
   *
   * Idempotente y seguro de reintentar (es un `GET`): la política de la
   * cola puede repetirlo ante un `provider_unavailable`.
   */
  poll(handle: GenJobHandle): Promise<GenJobState>;
  /** Autenticación contra algo documentado que **no genera** ni cobra. */
  checkCredentials(model: string): Promise<GenCredentialCheck>;
}

export interface ImageGen extends GenProviderClient {
  estimateImage(request: ImageGenRequest): Promise<GenCostEstimate>;
  /**
   * Envía el pedido. **No es idempotente**: ni Higgsfield ni fal aceptan una
   * clave de idempotencia, así que quien llama no puede repetirlo a ciegas
   * después de un timeout ambiguo (Higgsfield lo dice explícitamente).
   */
  generateImage(request: ImageGenRequest): Promise<GenSubmission>;
}
