import { describe, expect, it } from "vitest";
import { describeAsrContract } from "@fastgram/ports";
import { encodeMemorySpeech, MemoryAsr } from "./memory-asr.js";

/**
 * Primera ejecución de las cuatro aserciones de contrato de `Asr`.
 *
 * El fixture va **en español** porque §25.4 pide cobertura en español y porque
 * el caso que la suite protege —`AI-016`, «sin traducción de la voz»— sólo se
 * ve con un idioma que no sea inglés: un adaptador que traduzca a inglés pasa
 * desapercibido si el fixture ya estaba en inglés.
 */
const SPEECH = encodeMemorySpeech({
  language: "es-AR",
  languageConfidence: 0.98,
  durationSeconds: 6,
  segments: [
    { startSeconds: 0, endSeconds: 2.5, text: "hola, somos una marca chica" },
    { startSeconds: 2.5, endSeconds: 6, text: "y hablamos de tú a tú" },
  ],
});

describeAsrContract({ describe, it }, "memory", {
  makeAdapter: () => new MemoryAsr(),
  speech: {
    bytes: SPEECH,
    contentType: "audio/wav",
    expectedLanguage: "es",
    expectedText: "hablamos de tú a tú",
  },
});

describe("MemoryAsr — comportamiento propio del adaptador", () => {
  it("languageHint no pisa el idioma del audio: AI-016 lo prohíbe", async () => {
    const asr = new MemoryAsr();

    const transcript = await asr.transcribe({
      bytes: SPEECH,
      contentType: "audio/wav",
      languageHint: "en",
    });

    // La pista desempata, no impone. Si un día esto devuelve "en", el
    // adaptador dejó de transcribir y empezó a obedecer a quien llama — que
    // es el primer escalón hacia traducir.
    expect(transcript.language).toBe("es-AR");
  });

  it("languageHint sí resuelve cuando el audio no declara idioma", async () => {
    const asr = new MemoryAsr();
    const sinIdioma = encodeMemorySpeech({
      segments: [{ startSeconds: 0, endSeconds: 1, text: "ahá" }],
    });

    const transcript = await asr.transcribe({
      bytes: sinIdioma,
      contentType: "audio/wav",
      languageHint: "es",
    });

    expect(transcript.language).toBe("es");
  });

  it("sin idioma ni pista falla en vez de adivinar uno", async () => {
    const asr = new MemoryAsr();
    const sinIdioma = encodeMemorySpeech({
      segments: [{ startSeconds: 0, endSeconds: 1, text: "ahá" }],
    });

    await expect(
      asr.transcribe({ bytes: sinIdioma, contentType: "audio/wav" }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("ordena los segmentos que llegan desordenados y compone el texto", async () => {
    const asr = new MemoryAsr();
    const desordenado = encodeMemorySpeech({
      language: "es",
      segments: [
        { startSeconds: 4, endSeconds: 6, text: "segundo" },
        { startSeconds: 0, endSeconds: 2, text: "primero" },
      ],
    });

    const transcript = await asr.transcribe({
      bytes: desordenado,
      contentType: "audio/wav",
    });

    expect(transcript.segments.map((s) => s.text)).toEqual(["primero", "segundo"]);
    expect(transcript.text).toBe("primero segundo");
  });

  it("maxDurationSeconds recorta y la duración reportada es la transcrita", async () => {
    const asr = new MemoryAsr();

    const transcript = await asr.transcribe({
      bytes: SPEECH,
      contentType: "audio/wav",
      maxDurationSeconds: 3,
    });

    expect(transcript.segments).toHaveLength(1);
    expect(transcript.durationSeconds).toBe(2.5);
    expect(transcript.text).toBe("hola, somos una marca chica");
  });

  it("un audio sin habla da una transcripción vacía, no un error", async () => {
    const asr = new MemoryAsr();
    const silencio = encodeMemorySpeech({ language: "es", segments: [] });

    const transcript = await asr.transcribe({
      bytes: silencio,
      contentType: "audio/mpeg",
    });

    // Silencio no es fallo: `AI-016` degrada el análisis, no lo aborta.
    expect(transcript.text).toBe("");
    expect(transcript.segments).toHaveLength(0);
  });

  it("un segmento con fin antes del inicio es bad_request", async () => {
    const asr = new MemoryAsr();
    const roto = encodeMemorySpeech({
      language: "es",
      segments: [{ startSeconds: 5, endSeconds: 1, text: "imposible" }],
    });

    await expect(
      asr.transcribe({ bytes: roto, contentType: "audio/wav" }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("acceptsContentType permite acotar los formatos sin tocar el adaptador", async () => {
    const asr = new MemoryAsr({
      acceptsContentType: (contentType) => contentType === "audio/wav",
    });

    await expect(
      asr.transcribe({ bytes: SPEECH, contentType: "video/mp4" }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });
});
