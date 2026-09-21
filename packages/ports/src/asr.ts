/**
 * Puerto Asr — IMPL ADR-012, PRD `INT-015`, `FR-011.3`, `D-03`.
 *
 * Qué lo obliga: `INT-015` difiere el ASR a **Fase 2** por decisión `D-03` y
 * exige que «el sistema debe funcionar completo sin él». Eso sólo se puede
 * sostener si el ASR está detrás de algo que se pueda no montar: un puerto con
 * cero implementaciones activas en Fase 1. ADR-012 agrega la segunda razón:
 * cuando entre, será self-host, «el costo por minuto de audio a escala de
 * catálogo hace que las APIs de transcripción sean el segundo driver de costo
 * después del render» — es decir, se espera cambiar de implementación por
 * costo, no por capricho.
 *
 * Dos requisitos de `INT-015` que son del contrato y no del proveedor:
 *  - «soporte multiidioma con **detección automática**, y devolución del
 *    idioma detectado para alimentar `toneOfVoice`». De ahí
 *    {@link Transcript.language}, que es obligatorio.
 *  - `AI-016`, guardarraíl «Sin traducción de la voz»: **el tono se analiza y
 *    registra en el idioma original**. Este puerto transcribe; no traduce.
 *    Un adaptador que devuelva inglés a partir de audio en español está
 *    incumpliendo el contrato, no mejorándolo.
 *
 * Errores (`PortError`):
 *  - `provider_unavailable`, `timeout`, `rate_limited`, `quota_exceeded`.
 *  - `bad_request` — media sin pista de audio, formato no soportado, duración
 *    por encima del límite del adaptador.
 *  - `provider_contract_violation`.
 *
 * Igual que `Ocr`: bytes en memoria, nunca una clave de storage. `DATA-032`
 * prohíbe persistir binarios de terceros.
 */

export interface TranscriptSegment {
  /** Segundos desde el inicio. */
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
  /** [0, 1] cuando el motor la reporta. */
  readonly confidence?: number;
}

export interface Transcript {
  /** Segmentos concatenados. Es el `transcript` que consume §25.3 `JV-1`. */
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
  /**
   * BCP-47 detectado. Obligatorio: `INT-015` lo exige para `toneOfVoice`, y
   * `AI-016` necesita saber en qué idioma quedó registrada la voz.
   */
  readonly language: string;
  readonly languageConfidence: number;
  readonly durationSeconds: number;
  readonly latencyMs: number;
}

export interface TranscribeRequest {
  readonly bytes: Uint8Array;
  /** Audio o video con pista de audio. */
  readonly contentType: string;
  /**
   * Pista, no imposición. La detección es automática (`INT-015`); esto sólo
   * desempata cuando el perfil ya dijo en qué idioma habla.
   */
  readonly languageHint?: string;
  /** Segundos a transcribir desde el inicio. Acota el coste por ítem. */
  readonly maxDurationSeconds?: number;
}

export interface Asr {
  /**
   * Transcribe **en el idioma original**. Ver el guardarraíl de `AI-016`: no
   * hay parámetro de idioma destino y no lo habrá.
   */
  transcribe(request: TranscribeRequest): Promise<Transcript>;
}
