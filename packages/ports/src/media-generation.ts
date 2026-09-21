/**
 * Puerto MediaGeneration — PRD `FR-080`, `FR-081`, `FR-082`, `FR-090`, ADR-010.
 *
 * **Por qué existe, y por qué es el puerto que más importa de todos.**
 *
 * `P1-INFRA-001` midió el costo real (`docs/COST-MODEL.md`) y la conclusión
 * cambió el orden del plan: la generación en GPU es el driver dominante **por
 * dos órdenes de magnitud**. Un usuario Pro que gaste sus 2.000 créditos en
 * video consume $23,33 sobre un plan de $149 — el 15,7 %. Egress, render,
 * LLM, storage y OCR **sumados** no llegan a $0,50 por usuario y mes.
 *
 * Eso convierte "cambiar de proveedor de generación" en la palanca de costo
 * principal del producto, no en una comodidad de arquitectura. Y los precios
 * de GPU se mueven en semanas. Un puerto acá es lo que hace que esa palanca se
 * pueda accionar en un archivo.
 *
 * El hueco lo detectó la revisión de puertos: ADR-010 fija FLUX.1 [schnell]
 * (Apache-2.0, uso comercial permitido; **[dev] es no-comercial**, ver el ADR)
 * y ADR-013 fija GPU serverless por segundo, pero no había dónde apoyar
 * `AI Studio` ni el pipeline de influencers.
 *
 * **Lo que este puerto no hace:** no lleva la cuenta de créditos ni el cap de
 * 10 generaciones en vuelo. Eso es negocio y vive en `core` (§16.2). Acá no
 * hay planes ni saldos.
 *
 * Errores (`PortError`):
 *  - `bad_request` — prompt o parámetros fuera de lo que el modelo acepta.
 *  - `provider_unavailable`, `timeout`, `rate_limited` — reintentables.
 *  - `not_found` — un job o una referencia que el proveedor no reconoce.
 *  - `provider_contract_violation` — devolvió algo que no encaja.
 *
 * El **filtro de contenido no es un `PortError`**: es un resultado legítimo
 * con causa propia. `FR-090` exige mensajes distintos según sea el prompt o la
 * imagen de referencia lo bloqueado, y un error genérico borraría esa
 * distinción justo donde el usuario necesita saber qué cambiar.
 */

/** Relación de aspecto. Los literales salen del PRD; no se inventan. */
export type GenerationAspectRatio = "1:1" | "4:5" | "3:4" | "9:16" | "16:9";

/** Por qué terminó una generación. */
export type GenerationOutcome =
  | "succeeded"
  | "failed"
  /** Rechazada por política de contenido. Ver {@link ContentFilterCause}. */
  | "content_filtered";

/**
 * Causa del bloqueo, con los casos que `FR-090` distingue por copy literal:
 * *"Your prompt contains terms we don't allow"* vs *"Your prompt or image was
 * blocked by the content filter"*.
 */
export type ContentFilterCause = "prompt" | "reference_image" | "output";

export interface GeneratedAsset {
  /** URL temporal del proveedor. Hay que copiarla a Storage antes de que expire. */
  readonly url: string;
  readonly contentType: string;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Sólo video. */
  readonly durationSeconds?: number;
}

export interface GenerationJob {
  readonly jobId: string;
  readonly status: "queued" | "running" | "done";
  /** Entero 0–100. `FR-080` lo expone en la UI del pipeline de influencer. */
  readonly progress: number;
  readonly outcome?: GenerationOutcome;
  readonly assets: readonly GeneratedAsset[];
  readonly filterCause?: ContentFilterCause;
  /**
   * Segundos de GPU consumidos, si el proveedor los reporta.
   *
   * No es telemetría decorativa: es el driver de costo #1 y el único modo de
   * saber si el tarifario de créditos sigue al costo. `OQ-21` está abierta
   * justamente porque un video de 10 s cuesta los mismos 60 créditos que uno
   * de 5 s pagando el doble. Sin este número, esa pregunta no se puede cerrar
   * con datos.
   */
  readonly billedGpuSeconds?: number;
}

export interface ImageGenerationRequest {
  readonly prompt: string;
  readonly aspectRatio: GenerationAspectRatio;
  /** `FR-090` tiene un control `Image count`. */
  readonly count: number;
  /** Slots de referencia de `FR-090`: composición, producto, persona. */
  readonly references?: {
    readonly composition?: string;
    readonly product?: string;
    readonly person?: string;
  };
  /**
   * LoRA de un influencer entrenado. Es lo que hace que el personaje sea el
   * mismo entre piezas — la promesa literal del producto: *"Persistent AI
   * characters — train once, generate endlessly."*
   */
  readonly characterModelId?: string;
  /** Para reproducir una generación. Sin esto, un bug no se puede reproducir. */
  readonly seed?: number;
}

export interface VideoGenerationRequest {
  readonly prompt: string;
  readonly aspectRatio: GenerationAspectRatio;
  readonly durationSeconds: number;
  /** Imagen de partida, para animar un frame concreto. */
  readonly initImageUrl?: string;
  readonly characterModelId?: string;
  readonly seed?: number;
}

/**
 * Entrenamiento de un personaje — el "influencer" del PRD.
 *
 * `FR-080` lo describe como *"Our agents will go and create <Name> for you
 * now. Takes about 15–20 minutes"* y cuesta 250 créditos. Detrás de esa
 * descripción hay un **fine-tune LoRA**: generar variaciones del personaje
 * desde una imagen base y entrenar un adaptador que lo reproduzca. Nombrarlo
 * en el puerto evita que quede como caja negra en el código.
 */
export interface CharacterTrainingRequest {
  readonly baseImageUrl: string;
  readonly name: string;
  /** `FR-080`: el slider va de 18 a 60. El rango lo valida `core`. */
  readonly age: number;
  readonly gender: string;
  readonly ethnicity: string;
  readonly additionalDetails?: string;
}

export interface MediaGeneration {
  /** Arranca una generación de imagen. Asíncrona: devuelve el job. */
  generateImages(request: ImageGenerationRequest): Promise<GenerationJob>;

  generateVideo(request: VideoGenerationRequest): Promise<GenerationJob>;

  /**
   * Arranca el entrenamiento del personaje. 15–20 minutos según `FR-080`.
   * El `progress` del job alimenta los estados `generating_variations` →
   * `training` → `ready`.
   */
  trainCharacter(request: CharacterTrainingRequest): Promise<GenerationJob>;

  /**
   * Estado de un job. **El contrato público es polling** (ADR-014); si el
   * proveedor ofrece webhooks, el adaptador los usa internamente pero sigue
   * respondiendo acá.
   */
  getJob(jobId: string): Promise<GenerationJob>;

  /**
   * Cancela un job en vuelo.
   *
   * Idempotente: cancelar uno ya terminado no es error. Importa porque libera
   * un slot del cap de 10 en vuelo de `FR-090`, y porque en GPU por segundo
   * cancelar **deja de gastar**, a diferencia de un job de CPU donde da casi
   * igual.
   */
  cancelJob(jobId: string): Promise<void>;

  /**
   * Qué puede este adaptador. Los proveedores difieren mucho: duración máxima
   * de video, si soporta LoRA propio, qué relaciones de aspecto acepta.
   * Exponerlo evita que `core` asuma el denominador común de uno de ellos.
   */
  readonly capabilities: {
    readonly maxVideoSeconds: number;
    readonly supportsCharacterTraining: boolean;
    readonly supportedAspectRatios: readonly GenerationAspectRatio[];
    readonly maxImagesPerRequest: number;
  };
}
