/**
 * La política de subida de audio del lado del navegador (sprint 7): qué
 * archivo entra y con qué content type se declara. El servidor valida lo
 * mismo con el mismo schema (`brandAudioUploadRequestSchema`).
 */
import { BRAND_AUDIO_MAX_MB, BYTES_PER_MB } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { AUDIO_ACCEPT, audioReservationFor, formatDuration } from "./api";

const file = (name: string, type: string, size = 1024) => ({ name, type, size });

describe("audioReservationFor", () => {
  it.each([
    ["beat.mp3", "audio/mpeg", "audio/mpeg"],
    // Safari y Windows no siempre dicen el tipo de un .m4a: se deduce.
    ["voz.m4a", "", "audio/mp4"],
    ["voz.M4A", "audio/x-m4a", "audio/x-m4a"],
    ["loop.wav", "audio/wav", "audio/wav"],
    ["loop.aac", "", "audio/aac"],
  ])("%s (%s) → %s", (name, type, expected) => {
    const r = audioReservationFor(file(name, type));
    expect(r.ok && r.body.contentType).toBe(expected);
  });

  it("un tipo declarado que no corresponde a la extensión se deduce de la extensión", () => {
    const r = audioReservationFor(file("loop.wav", "audio/mpeg"));
    expect(r.ok && r.body.contentType).toBe("audio/wav");
  });

  it("rechaza lo que el servidor rechazaría", () => {
    expect(audioReservationFor(file("clip.mp4", "video/mp4"))).toEqual({
      ok: false,
      reason: "unsupported_type",
    });
    expect(audioReservationFor(file("a.mp3", "audio/mpeg", 0))).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      audioReservationFor(
        file("a.mp3", "audio/mpeg", BRAND_AUDIO_MAX_MB * BYTES_PER_MB + 1),
      ),
    ).toEqual({ ok: false, reason: "too_large" });
  });

  it("el accept del input lista tipos y extensiones", () => {
    expect(AUDIO_ACCEPT).toContain("audio/mpeg");
    expect(AUDIO_ACCEPT).toContain(".m4a");
  });
});

describe("formatDuration", () => {
  it("m:ss, y nada si no hay duración", () => {
    expect(formatDuration(65.4)).toBe("1:05");
    expect(formatDuration(3)).toBe("0:03");
    expect(formatDuration(undefined)).toBeNull();
  });
});
