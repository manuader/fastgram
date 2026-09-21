/**
 * Contrato del puerto `Asr` — PRD `INT-015`, `AI-016`.
 *
 * El caso que justifica la suite es el guardarraíl de `AI-016`: **«Sin
 * traducción de la voz. El tono se analiza y registra en el idioma
 * original.»** Varios proveedores ofrecen «translate to English» y es fácil
 * dejarlo prendido sin querer; si pasa, `toneOfVoice` queda en inglés para una
 * marca que habla español y todo el contenido generado hereda una voz que no
 * es la suya. Es un fallo silencioso: la transcripción se ve perfecta.
 */

import type { Asr } from "../asr.js";
import {
  check,
  checkEqual,
  checkInRange,
  checkNonEmpty,
  checkRejectsWithCode,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface AsrFixture {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** BCP-47 esperado. Ej. `es`. */
  readonly expectedLanguage: string;
  /** Fragmento que tiene que aparecer, **en el idioma original**. */
  readonly expectedText: string;
}

export interface AsrContractSetup {
  readonly makeAdapter: AdapterFactory<Asr>;
  /** Audio o video con habla. §25.4 pide cobertura en español: usá español. */
  readonly speech: AsrFixture;
}

export function describeAsrContract(
  harness: ContractHarness,
  name: string,
  setup: AsrContractSetup,
): void {
  const { describe, it } = harness;

  describe(`Asr contract · ${name}`, () => {
    it("transcribe con segmentos ordenados y sin solaparse", async () => {
      const asr = await setup.makeAdapter();
      const transcript = await asr.transcribe({
        bytes: setup.speech.bytes,
        contentType: setup.speech.contentType,
      });

      checkNonEmpty(transcript.text, "texto transcrito");
      check(transcript.segments.length > 0, "sin segmentos");
      check(transcript.durationSeconds > 0, "durationSeconds en cero");

      let previousEnd = 0;
      for (const segment of transcript.segments) {
        check(
          segment.startSeconds >= previousEnd - 1e-6,
          "los segmentos vienen desordenados o solapados",
        );
        check(
          segment.endSeconds >= segment.startSeconds,
          "segmento con fin antes del inicio",
        );
        check(
          transcript.text.includes(segment.text.trim()) ||
            segment.text.trim().length === 0,
          `el segmento "${segment.text}" no aparece en el texto completo`,
        );
        previousEnd = segment.endSeconds;
      }
    });

    it("devuelve el idioma detectado: INT-015 lo exige para toneOfVoice", async () => {
      const asr = await setup.makeAdapter();
      const transcript = await asr.transcribe({
        bytes: setup.speech.bytes,
        contentType: setup.speech.contentType,
      });

      checkNonEmpty(transcript.language, "language");
      checkEqual(
        transcript.language.slice(0, 2).toLowerCase(),
        setup.speech.expectedLanguage.slice(0, 2).toLowerCase(),
        "idioma detectado",
      );
      checkInRange(transcript.languageConfidence, 0, 1, "languageConfidence");
    });

    it("NO traduce: el texto vuelve en el idioma original (AI-016)", async () => {
      const asr = await setup.makeAdapter();
      const transcript = await asr.transcribe({
        bytes: setup.speech.bytes,
        contentType: setup.speech.contentType,
      });

      check(
        transcript.text.toLowerCase().includes(setup.speech.expectedText.toLowerCase()),
        `no aparece "${setup.speech.expectedText}": el adaptador puede estar traduciendo, y AI-016 lo prohíbe`,
      );
    });

    it("rechaza media sin pista de audio con bad_request", async () => {
      const asr = await setup.makeAdapter();
      await checkRejectsWithCode(
        () =>
          asr.transcribe({
            bytes: new TextEncoder().encode("no soy audio"),
            contentType: "text/plain",
          }),
        ["bad_request"],
        "media sin audio",
      );
    });
  });
}
