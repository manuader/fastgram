import { describe, expect, it } from "vitest";
import {
  UPLOAD_KINDS,
  canFinalize,
  validateUploadReservation,
  type Reservation,
} from "./uploads.js";

describe("límites del PRD §9.8 — normativos", () => {
  it("imágenes 10 MB, videos 50 MB", () => {
    expect(UPLOAD_KINDS.image.maxBytes).toBe(10 * 1024 * 1024);
    expect(UPLOAD_KINDS.video.maxBytes).toBe(50 * 1024 * 1024);
    expect(UPLOAD_KINDS.influencerBaseImage.maxBytes).toBe(10 * 1024 * 1024);
  });

  it("los content types son exactamente los del PRD", () => {
    expect([...UPLOAD_KINDS.image.contentTypes]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect([...UPLOAD_KINDS.video.contentTypes]).toEqual([
      "video/mp4",
      "video/quicktime",
    ]);
  });
});

describe("validateUploadReservation", () => {
  const ok = {
    kind: "image" as const,
    filename: "foto.png",
    contentType: "image/png",
    sizeBytes: 1024,
  };

  it("acepta una subida válida", () => {
    expect(validateUploadReservation(ok)).toBeNull();
  });

  it("rechaza un content type no soportado", () => {
    const r = validateUploadReservation({
      ...ok,
      contentType: "image/gif",
      filename: "x.gif",
    });
    expect(r?.code).toBe("unsupported_content_type");
  });

  it("rechaza justo por encima del tope, acepta justo en el tope", () => {
    const max = UPLOAD_KINDS.image.maxBytes;
    expect(validateUploadReservation({ ...ok, sizeBytes: max })).toBeNull();
    expect(validateUploadReservation({ ...ok, sizeBytes: max + 1 })?.code).toBe(
      "file_too_large",
    );
  });

  it("la extensión tiene que coincidir con el content type", () => {
    // El caso que importa: html disfrazado de png. Servido desde el CDN, el
    // navegador lo ejecuta. Es XSS almacenado por la puerta de atrás.
    const r = validateUploadReservation({
      ...ok,
      filename: "payload.html",
      contentType: "image/png",
    });
    expect(r?.code).toBe("extension_mismatch");
  });

  it("jpg y jpeg valen los dos para image/jpeg", () => {
    const base = { kind: "image" as const, contentType: "image/jpeg", sizeBytes: 100 };
    expect(validateUploadReservation({ ...base, filename: "a.jpg" })).toBeNull();
    expect(validateUploadReservation({ ...base, filename: "a.JPEG" })).toBeNull();
  });

  it("un .mov no vale declarado como mp4", () => {
    const r = validateUploadReservation({
      kind: "video",
      filename: "clip.mov",
      contentType: "video/mp4",
      sizeBytes: 100,
    });
    expect(r?.code).toBe("extension_mismatch");
  });
});

describe("canFinalize — los códigos del PRD §9.8", () => {
  const now = 1_000_000;
  const reserva = (over: Partial<Reservation> = {}): Reservation => ({
    uploadId: "up_1",
    companyId: "co_1",
    status: "pending",
    expiresAtMs: now + 60_000,
    ...over,
  });

  it("una reserva vigente y propia procede", () => {
    expect(canFinalize(reserva(), { companyId: "co_1" }, now)).toEqual({
      kind: "proceed",
    });
  });

  it("una reserva inexistente es 404", () => {
    expect(canFinalize(null, { companyId: "co_1" }, now)).toEqual({ kind: "not_found" });
  });

  it("una reserva AJENA Y EXPIRADA devuelve 404, no 410", () => {
    // El caso que delata un chequeo de tenant hecho tarde: si se comprobara
    // la expiración primero, el 410 confirmaría que ese uploadId existe.
    const ajena = reserva({ companyId: "co_2", expiresAtMs: now - 1 });
    expect(canFinalize(ajena, { companyId: "co_1" }, now)).toEqual({ kind: "not_found" });
  });

  it("una reserva expirada propia es 410 gone", () => {
    expect(
      canFinalize(reserva({ expiresAtMs: now - 1 }), { companyId: "co_1" }, now),
    ).toEqual({
      kind: "gone",
    });
  });

  it("finalización en curso o reserva previa fallida es 409", () => {
    expect(
      canFinalize(reserva({ status: "finalizing" }), { companyId: "co_1" }, now).kind,
    ).toBe("conflict");
    expect(
      canFinalize(reserva({ status: "failed" }), { companyId: "co_1" }, now).kind,
    ).toBe("conflict");
    expect(
      canFinalize(reserva({ status: "completed" }), { companyId: "co_1" }, now).kind,
    ).toBe("conflict");
  });
});
