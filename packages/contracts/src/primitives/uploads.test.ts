import { describe, expect, it } from "vitest";
import {
  filenameMatchesContentType,
  imageUploadReservationRequestSchema,
  mbToBytes,
  mediaUploadReservationRequestSchema,
  uploadReservationSchema,
  UPLOAD_IMAGE_MAX_MB,
  UPLOAD_INFLUENCER_BASE_IMAGE_MAX_MB,
  UPLOAD_VIDEO_MAX_MB,
  videoUploadReservationRequestSchema,
} from "./uploads";

describe("límites de subida · NFR-013 · PRD:2963", () => {
  it("imágenes 10 MB, videos 50 MB, base image de influencer 10 MB", () => {
    expect(UPLOAD_IMAGE_MAX_MB).toBe(10);
    expect(UPLOAD_VIDEO_MAX_MB).toBe(50);
    expect(UPLOAD_INFLUENCER_BASE_IMAGE_MAX_MB).toBe(10);
  });

  it("una imagen de exactamente 10 MB pasa; 10 MB + 1 byte no", () => {
    const base = { filename: "a.png", contentType: "image/png" as const };
    expect(
      imageUploadReservationRequestSchema.parse({ ...base, sizeBytes: mbToBytes(10) })
        .sizeBytes,
    ).toBe(mbToBytes(10));
    expect(() =>
      imageUploadReservationRequestSchema.parse({
        ...base,
        sizeBytes: mbToBytes(10) + 1,
      }),
    ).toThrow();
  });

  it("un video de exactamente 50 MB pasa; 50 MB + 1 byte no", () => {
    const base = { filename: "a.mp4", contentType: "video/mp4" as const };
    expect(
      videoUploadReservationRequestSchema.parse({ ...base, sizeBytes: mbToBytes(50) })
        .sizeBytes,
    ).toBe(mbToBytes(50));
    expect(() =>
      videoUploadReservationRequestSchema.parse({
        ...base,
        sizeBytes: mbToBytes(50) + 1,
      }),
    ).toThrow();
  });

  it("el Media Bank aplica el techo que corresponde a cada tipo · FR-100 · PRD:1631", () => {
    expect(() =>
      mediaUploadReservationRequestSchema.parse({
        filename: "a.png",
        contentType: "image/png",
        sizeBytes: mbToBytes(20),
      }),
    ).toThrow();
    expect(
      mediaUploadReservationRequestSchema.parse({
        filename: "a.mp4",
        contentType: "video/mp4",
        sizeBytes: mbToBytes(20),
      }).sizeBytes,
    ).toBe(mbToBytes(20));
  });
});

describe("la extensión debe coincidir con el content type · §9.8 · PRD:2339", () => {
  it.each([
    ["photo.jpg", "image/jpeg", true],
    ["photo.jpeg", "image/jpeg", true],
    ["photo.png", "image/jpeg", false],
    ["photo.webp", "image/webp", true],
    ["clip.mp4", "video/mp4", true],
    ["clip.mov", "video/quicktime", true],
    ["clip.mov", "video/mp4", false],
    ["clip.MP4", "video/mp4", true],
    ["noextension", "image/png", false],
  ])("%s + %s → %s", (filename, contentType, expected) => {
    expect(filenameMatchesContentType(filename, contentType)).toBe(expected);
  });

  it("la reserva rechaza una extensión incoherente", () => {
    expect(() =>
      imageUploadReservationRequestSchema.parse({
        filename: "a.mp4",
        contentType: "image/png",
        sizeBytes: 1000,
      }),
    ).toThrow();
  });
});

describe("respuesta de reserva · §9.8 · PRD:2338", () => {
  it("es {uploadId, uploadUrl, method:'PUT', headers, expiresAt}", () => {
    const parsed = uploadReservationSchema.parse({
      uploadId: "up_1",
      uploadUrl: "https://storage.example.com/o/abc?sig=x",
      method: "PUT",
      headers: { "content-type": "image/png" },
      expiresAt: 1_700_000_000_000,
    });
    expect(parsed.method).toBe("PUT");
  });

  it("el método no puede ser otro que PUT", () => {
    expect(() =>
      uploadReservationSchema.parse({
        uploadId: "up_1",
        uploadUrl: "https://storage.example.com/o/abc",
        method: "POST",
        headers: {},
        expiresAt: 1,
      }),
    ).toThrow();
  });
});
