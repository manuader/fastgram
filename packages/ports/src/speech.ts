/**
 * Puerto `SpeechGen` (texto → voz) — sprint 8 (agente L), `P4-FORMAT-002`,
 * `P4-INFL-011`, `docs/PLAN-USO-PERSONAL.md` §4, D-14.
 *
 * Mismo ciclo que `ImageGen`/`VideoGen` (`image-gen.ts`): enviar → seguir por
 * `poll` → copiar el resultado a nuestro storage. Comparte con ellos el
 * pedido aceptado (`GenJobHandle`), el rechazo por contenido
 * (`GenRejectedSubmission`), el costo (`GenCostEstimate`) y los errores
 * (`PortError`, ver la cabecera de `image-gen.ts`).
 *
 * ## Por qué un puerto propio y no un «kind» más de `GenModelSpec`
 *
 * La ficha de un modelo de voz no tiene relaciones de aspecto ni duraciones:
 * tiene un tope de caracteres y una lista de voces. Meterlo en `GenModelSpec`
 * obligaba a cada consumidor de imagen/video a filtrar un tercer caso que no
 * le sirve.
 *
 * ## Las entradas de archivo
 *
 * Los tres puertos de voz (`SpeechGen`, `TalkingAvatar`, `CharacterSwap`)
 * reciben las entradas como **URL pública o data URI** (`data:…;base64,…`):
 * nuestro storage local no es público, y fal documenta que acepta data URIs
 * como archivo de entrada.
 */
import type {
  GenCostEstimate,
  GenCredentialCheck,
  GenJobHandle,
  GenJobStatus,
  GenListPrice,
  GenSubmission,
} from "./image-gen.js";

/** Lo que la UI y la validación necesitan saber de un modelo de voz. */
export interface SpeechModelSpec {
  /** El endpoint id del proveedor, tal cual. */
  readonly id: string;
  /** Nombre para la UI. Es una marca: no se traduce. */
  readonly label: string;
  /** Tope de caracteres del texto, de su esquema. */
  readonly maxChars: number;
  /** Voces documentadas (nombres que acepta el campo de voz). */
  readonly voices: readonly string[];
  /** La voz que usa el modelo si no se manda ninguna. */
  readonly defaultVoice: string;
  /** Acepta un código de idioma ISO 639-1 para forzar el idioma. */
  readonly languageCode: boolean;
  readonly docsUrl: string;
  readonly listPrice: GenListPrice | null;
}

export interface SpeechRequest {
  /** Endpoint id del catálogo. */
  readonly model: string;
  readonly text: string;
  /** Una voz del modelo. Ausente = la default del modelo. */
  readonly voice?: string;
  /** ISO 639-1 (`en`, `es`). Ignorado si el modelo no lo acepta. */
  readonly languageCode?: string;
}

/**
 * El estado de un pedido de voz o video de los puertos de voz. A diferencia
 * de `GenJobState` trae **una** salida y, si el proveedor la informa, la
 * duración que cobró (OmniHuman: `duration`, «as used for billing»).
 */
export interface VoiceJobState {
  readonly status: GenJobStatus;
  /** Sólo con `completed`. URL temporal del proveedor: hay que copiarla. */
  readonly output?: { readonly url: string; readonly contentType?: string };
  /** Segundos que el proveedor dice haber cobrado, si los dice. */
  readonly billedSeconds?: number;
  /** Duración del resultado, si el proveedor la informa (MiniMax: `duration_ms`). */
  readonly mediaSeconds?: number;
  /** Ya saneado. Sólo con `failed`/`nsfw`. */
  readonly message?: string;
}

/** Lo común a los tres puertos de voz: seguir un pedido y probar la key. */
export interface VoiceProviderClient {
  /** `fal`. */
  readonly provider: string;
  /** Idempotente (es un `GET`): la cola puede repetirlo. */
  pollVoice(handle: GenJobHandle): Promise<VoiceJobState>;
  /** Autenticación contra algo documentado que **no genera** ni cobra. */
  checkVoiceCredentials(model: string): Promise<GenCredentialCheck>;
}

export interface SpeechGen extends VoiceProviderClient {
  speechModels(): readonly SpeechModelSpec[];
  estimateSpeech(request: SpeechRequest): Promise<GenCostEstimate>;
  /** No idempotente: ver `ImageGen.generateImage`. */
  generateSpeech(request: SpeechRequest): Promise<GenSubmission>;
}
