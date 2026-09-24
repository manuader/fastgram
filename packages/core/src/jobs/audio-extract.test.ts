import { describe, expect, it } from "vitest";

import {
  audioExtractionStatusKey,
  extractedAudioTitle,
  parseAudioExtractJob,
  parseAudioExtractionStatus,
} from "./audio-extract.js";

const C = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";

describe("audio-extract — lo que viaja y lo que se guarda", () => {
  it("el payload exige uuids; el título es opcional y se recorta", () => {
    expect(parseAudioExtractJob({ companyId: C, extractionId: E, mediaId: M })).toEqual({
      ok: true,
      job: { companyId: C, extractionId: E, mediaId: M },
    });
    const titled = parseAudioExtractJob({
      companyId: C,
      extractionId: E,
      mediaId: M,
      title: `  ${"x".repeat(250)}  `,
    });
    expect(titled.ok && titled.job.title?.length).toBe(200);
    expect(
      parseAudioExtractJob({ companyId: C, extractionId: "../x", mediaId: M }).ok,
    ).toBe(false);
    expect(parseAudioExtractJob(null).ok).toBe(false);
  });

  it("el estado vive bajo el prefijo de la marca", () => {
    expect(audioExtractionStatusKey(C, E)).toBe(`audio-extractions/${C}/${E}.json`);
  });

  it("un estado con forma rara o un código inventado es `null`", () => {
    const ok = { id: E, mediaId: M, state: "failed", error: "no_audio", updatedAt: 1 };
    expect(parseAudioExtractionStatus(ok)).toEqual(ok);
    expect(parseAudioExtractionStatus({ ...ok, error: "stderr: boom" })).toBeNull();
    expect(parseAudioExtractionStatus({ ...ok, state: "weird" })).toBeNull();
    expect(parseAudioExtractionStatus({ ...ok, trackId: "no-uuid" })).toBeNull();
    expect(parseAudioExtractionStatus("x")).toBeNull();
  });

  it("el título por defecto sale del nombre del video", () => {
    expect(extractedAudioTitle("carpeta/Mi demo.mp4")).toBe("Mi demo (audio)");
    expect(extractedAudioTitle(".mp4")).toBe(".mp4 (audio)");
    expect(extractedAudioTitle("   ")).toBe("Extracted audio");
  });
});
