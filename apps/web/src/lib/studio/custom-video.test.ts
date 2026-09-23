/**
 * La política de la subida de video custom · `F-083`, §9.8 (PRD:2347),
 * `NFR-013` (PRD:2963).
 *
 * Dos cosas se prueban acá y no en la pantalla, porque son decisiones y no
 * pintura:
 *
 * 1. **Qué archivo entra**, y con qué motivo se rechaza el que no. El motivo
 *    importa tanto como el rechazo: "el tope son 50 MB" sobre un archivo vacío
 *    es un consejo falso, y el general ya cobró una vez por un pre-chequeo que
 *    daba justo eso.
 * 2. **Desde dónde se reintenta cada fallo.** Es la diferencia entre volver a
 *    subir 50 MB y mandar una petición de 40 bytes, y entre cobrar un content
 *    save una vez o dos.
 */
import {
  UPLOAD_VIDEO_MAX_MB,
  videoUploadReservationRequestSchema,
} from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api/errors";
import {
  contentTypeFor,
  CUSTOM_VIDEO_ACCEPT,
  CUSTOM_VIDEO_MAX_BYTES,
  CUSTOM_VIDEO_MAX_MB,
  describeUpload,
  resumeFor,
  sizeInMb,
  type UploadCandidate,
} from "./custom-video";

const MB = 1024 * 1024;

function candidate(overrides: Partial<UploadCandidate> = {}): UploadCandidate {
  return { name: "clip.mp4", type: "video/mp4", size: 3 * MB, ...overrides };
}

function apiError(code: ApiRequestError["code"], status: number): ApiRequestError {
  return new ApiRequestError({ code, status });
}

describe("el límite es el del contrato, y el borde está fijado · NFR-013", () => {
  it("son 50 MB, en mebibytes", () => {
    // Escritos, no derivados: es lo que la pantalla le promete al usuario
    // ("MP4 or MOV, up to 50 MB") y lo que el PRD nombra en NFR-013. Si el
    // contrato cambiara el número, esto se pone rojo y alguien decide —en vez
    // de que la promesa se mueva sola.
    expect(CUSTOM_VIDEO_MAX_MB).toBe(50);
    expect(CUSTOM_VIDEO_MAX_BYTES).toBe(52_428_800);
    // Y que sea el mismo objeto que valida el servidor, no una copia.
    expect(CUSTOM_VIDEO_MAX_MB).toBe(UPLOAD_VIDEO_MAX_MB);
  });

  it("50 MB exactos entran; 50 MB + 1 byte, no", () => {
    expect(describeUpload(candidate({ size: 50 * MB })).ok).toBe(true);

    const over = describeUpload(candidate({ size: 50 * MB + 1 }));
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.reason).toBe("too_large");
  });

  it("lo que pasa el chequeo es exactamente el body que acepta el servidor", () => {
    const check = describeUpload(candidate({ name: "demo.mp4", size: 7 * MB }));
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.body).toEqual({
      filename: "demo.mp4",
      contentType: "video/mp4",
      sizeBytes: 7 * MB,
    });
    // El mismo schema que monta `POST /content/custom/video/upload-url`.
    expect(videoUploadReservationRequestSchema.safeParse(check.body).success).toBe(true);
  });
});

describe("por qué se rechaza cada archivo", () => {
  it("un archivo vacío es vacío, no 'demasiado grande'", () => {
    // El schema los junta —los dos fallan por `sizeBytes`— y el consejo sería
    // el contrario del útil: nadie arregla un archivo de 0 bytes achicándolo.
    const check = describeUpload(candidate({ size: 0 }));
    expect(check.ok === false && check.reason).toBe("empty");
  });

  it("un tipo que no es video se rechaza por el tipo", () => {
    const check = describeUpload(candidate({ name: "notes.txt", type: "text/plain" }));
    expect(check.ok === false && check.reason).toBe("unsupported_type");
  });

  it("un `.txt` de 80 MB se rechaza por el TIPO, no por el tamaño", () => {
    // Falla por las dos cosas a la vez. Decirle "pesa mucho" a quien eligió un
    // `.txt` lo manda a comprimirlo, que no lo va a arreglar nunca.
    const check = describeUpload(
      candidate({ name: "notes.txt", type: "text/plain", size: 80 * MB }),
    );
    expect(check.ok === false && check.reason).toBe("unsupported_type");
  });

  it("extensión y content type incoherentes · §9.8 (PRD:2339)", () => {
    const check = describeUpload(candidate({ name: "clip.mov", type: "video/mp4" }));
    expect(check.ok === false && check.reason).toBe("extension_mismatch");
  });

  it("`62.4 MB` y no `62.4178 MB`: el número que se le enseña al usuario", () => {
    expect(sizeInMb(Math.round(62.4 * MB))).toBe("62.4");
    expect(sizeInMb(400 * 1024)).toBe("0.4");
  });
});

describe("el tipo que declara el cliente cuando el sistema no lo dice", () => {
  it("un `.mov` sin `type` se declara `video/quicktime` y entra", () => {
    // Windows y algunos Safari mandan `type: ""` para un `.mov`. Rechazarlo
    // sería rechazar en el cliente un archivo que el servidor acepta: el
    // servidor tampoco abre el archivo, comprueba estas mismas dos cosas.
    expect(contentTypeFor(candidate({ name: "hook.mov", type: "" }))).toBe(
      "video/quicktime",
    );
    expect(describeUpload(candidate({ name: "hook.mov", type: "" })).ok).toBe(true);
  });

  it("un `.mp4` sin `type` se declara `video/mp4`", () => {
    expect(contentTypeFor(candidate({ name: "HOOK.MP4", type: "" }))).toBe("video/mp4");
  });

  it("sin tipo y sin extensión conocida no se inventa nada", () => {
    expect(contentTypeFor(candidate({ name: "archivo", type: "" }))).toBe("");
    expect(describeUpload(candidate({ name: "archivo", type: "" })).ok).toBe(false);
  });

  it("el `accept` ofrece los dos tipos y las dos extensiones", () => {
    // Sólo MIME escondería los `.mov` sin tipo; sólo extensión escondería un
    // archivo bien tipado con otro nombre.
    for (const token of ["video/mp4", "video/quicktime", ".mp4", ".mov"]) {
      expect(CUSTOM_VIDEO_ACCEPT).toContain(token);
    }
  });
});

describe("desde dónde se retoma cada fallo · el coste manda", () => {
  it("si falla el PUT se empieza de nuevo: la reserva es gratis (PRD:2285)", () => {
    expect(resumeFor("transfer", null)).toBe("restart");
  });

  it("si falla la finalización por red, se repite SÓLO el paso 3", () => {
    // Es la decisión que evita volver a subir 50 MB por una petición de 40
    // bytes que se cortó.
    expect(resumeFor("finalize", apiError("network_error", 0))).toBe("finalize");
    expect(resumeFor("finalize", apiError("timeout", 0))).toBe("finalize");
    expect(resumeFor("finalize", apiError("service_unavailable", 503))).toBe("finalize");
    expect(resumeFor("finalize", apiError("rate_limited", 429))).toBe("finalize");
  });

  it("`409 conflict` es 'el objeto todavía no se ve': se repite el paso 3", () => {
    expect(resumeFor("finalize", apiError("conflict", 409))).toBe("finalize");
  });

  it("`410 gone` es la reserva caducada: se empieza de cero", () => {
    // Repetir el paso 3 con una reserva vencida da otro 410, siempre.
    expect(resumeFor("finalize", apiError("gone", 410))).toBe("restart");
  });

  it("la cuota agotada no se reintenta: no hay botón que la arregle", () => {
    // §19.8 / ERR-R03. El archivo está subido, pero repetir el paso 3 da otro
    // 429 y encima parece que la culpa es del usuario por no insistir. Es el
    // mismo status que `rate_limited`, que arriba SÍ se repite: la diferencia
    // la hace el `code`.
    expect(resumeFor("finalize", apiError("content_quota_exceeded", 429))).toBe("none");
    expect(resumeFor("reserve", apiError("content_quota_exceeded", 429))).toBe("none");
    // El 402 de créditos de AI Studio (FR-080) tampoco.
    expect(resumeFor("finalize", apiError("payment_required", 402))).toBe("none");
    expect(resumeFor("finalize", apiError("bad_request", 400))).toBe("none");
  });

  it("un fallo de la reserva se reintenta sólo si §19 dice que sirve", () => {
    expect(resumeFor("reserve", apiError("network_error", 0))).toBe("restart");
    expect(resumeFor("reserve", apiError("unauthorized", 401))).toBe("none");
  });
});
