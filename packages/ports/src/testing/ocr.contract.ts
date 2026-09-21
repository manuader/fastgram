/**
 * Contrato del puerto `Ocr` — PRD `INT-016`, `FR-011.3`, `P1-VISION-002`…`005`.
 *
 * `JV-1` depende de que el texto en pantalla llegue convertido a texto: «un
 * adaptador basado en un modelo text-only no puede ver el video». Si el OCR
 * devuelve vacío en silencio, `JV-1` clasifica con menos señal y nadie se
 * entera — no falla nada, sólo empeora. De ahí que la suite exija que el caso
 * feliz encuentre texto de verdad y no sólo que no lance.
 */

import type { Ocr } from "../ocr.js";
import {
  check,
  checkInRange,
  checkNonEmpty,
  checkRejectsWithCode,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface OcrFixture {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Fragmento que el motor **debe** encontrar, en minúsculas. */
  readonly expectedText: string;
}

export interface OcrContractSetup {
  readonly makeAdapter: AdapterFactory<Ocr>;
  /** Imagen con texto legible. Ej. un overlay de TikTok. */
  readonly imageWithText: OcrFixture;
  /** Video con un overlay. Omitirlo saltea esa parte de la suite. */
  readonly videoWithOverlay?: OcrFixture;
}

export function describeOcrContract(
  harness: ContractHarness,
  name: string,
  setup: OcrContractSetup,
): void {
  const { describe, it } = harness;

  describe(`Ocr contract · ${name}`, () => {
    it("lee el texto de una imagen y lo devuelve en blocks y en text", async () => {
      const ocr = await setup.makeAdapter();
      const fixture = setup.imageWithText;
      const result = await ocr.recognizeImage({
        bytes: fixture.bytes,
        contentType: fixture.contentType,
      });

      checkNonEmpty(result.text, "texto extraído");
      check(
        result.text.toLowerCase().includes(fixture.expectedText.toLowerCase()),
        `no encontró "${fixture.expectedText}" en "${result.text}"`,
      );
      check(result.blocks.length > 0, "blocks vacío con text no vacío");
      for (const block of result.blocks) {
        checkInRange(block.confidence, 0, 1, "confidence del bloque");
        check(
          result.text.includes(block.text),
          `el bloque "${block.text}" no aparece en el texto concatenado`,
        );
      }
      check(result.latencyMs >= 0, "latencyMs negativo");
    });

    it("reporta el idioma detectado con su confianza (P1-VISION-004)", async () => {
      const ocr = await setup.makeAdapter();
      const fixture = setup.imageWithText;
      const result = await ocr.recognizeImage({
        bytes: fixture.bytes,
        contentType: fixture.contentType,
      });

      for (const language of result.languages) {
        checkNonEmpty(language.code, "código de idioma");
        checkInRange(language.confidence, 0, 1, "confianza del idioma");
      }
      // Ordenadas por confianza descendente: FR-011.3 usa la primera.
      for (let i = 1; i < result.languages.length; i += 1) {
        const previous = result.languages[i - 1];
        const current = result.languages[i];
        if (previous === undefined || current === undefined) continue;
        check(
          previous.confidence >= current.confidence,
          "languages no viene ordenado por confianza descendente",
        );
      }
    });

    it("rechaza un content type no soportado con bad_request", async () => {
      const ocr = await setup.makeAdapter();
      await checkRejectsWithCode(
        () =>
          ocr.recognizeImage({
            bytes: new TextEncoder().encode("no soy una imagen"),
            contentType: "application/zip",
          }),
        ["bad_request"],
        "content type no soportado",
      );
    });

    it("deduplica el texto entre frames de video", async () => {
      const ocr = await setup.makeAdapter();
      const fixture = setup.videoWithOverlay;
      if (fixture === undefined) return;

      const result = await ocr.recognizeVideoFrames({
        bytes: fixture.bytes,
        contentType: fixture.contentType,
        maxFrames: 8,
      });

      check(result.frames.length > 0, "ningún frame muestreado");
      check(
        result.text.toLowerCase().includes(fixture.expectedText.toLowerCase()),
        `no encontró "${fixture.expectedText}" en el texto agregado`,
      );
      for (const frame of result.frames) {
        check(frame.atSeconds >= 0, "atSeconds negativo");
      }
      // Un overlay que dura varios frames no puede contar varias veces: la
      // señal de AI-016 se pondera y repetir texto la distorsiona.
      const occurrences = result.text
        .toLowerCase()
        .split(fixture.expectedText.toLowerCase());
      check(
        occurrences.length === 2,
        `el texto agregado repite "${fixture.expectedText}" ${String(occurrences.length - 1)} veces`,
      );
    });
  });
}
