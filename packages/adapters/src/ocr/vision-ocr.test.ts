import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeOcrContract, isPortError } from "@fastgram/ports";
import { VisionOcr, loopbackPublisher } from "./vision-ocr.js";
import { FakeVision } from "./__tests__/fake-vision.js";

/**
 * Suite de contrato de `Ocr` contra un `services/vision` falso pero **real
 * como servidor**: escucha HTTP y descarga de verdad la URL que el adaptador
 * publica.
 *
 * **Lo que esto verifica.** El rodeo entero que el adaptador tiene que dar
 * porque el puerto pasa bytes y el servicio recibe URLs: que
 * `loopbackPublisher` publique algo alcanzable, que el `Content-Type` viaje,
 * que el servidor efímero se cierre después, que el cuerpo del `POST /ocr`
 * tenga la forma de `app/models.py` y que la respuesta se traduzca bien.
 *
 * **Lo que NO verifica, y es la mitad de `P1-VISION-002`.** Que PaddleOCR lea
 * un overlay de TikTok. Eso necesita el servicio levantado con el extra `ocr`
 * —`docker compose --profile vision up`, que no corre por defecto porque la
 * imagen pesa— y una imagen de verdad. Sigue sin correrse.
 */
const OVERLAY = ["GUIA RAPIDA", "sudeste asiatico en 3 semanas", "con 800 dolares"].join(
  "\n",
);

const vision = new FakeVision();
let baseUrl = "";

beforeAll(async () => {
  baseUrl = await vision.start();
});

afterAll(async () => {
  await vision.stop();
});

function makeOcr(): VisionOcr {
  return new VisionOcr({ baseUrl, publisher: loopbackPublisher(), timeoutMs: 5_000 });
}

describeOcrContract({ describe, it }, "vision (servicio falso)", {
  makeAdapter: makeOcr,
  imageWithText: {
    bytes: new TextEncoder().encode(OVERLAY),
    contentType: "image/png",
    expectedText: "guia rapida",
  },
  videoWithOverlay: {
    // El mismo overlay repetido: es el caso que el puerto quiere que no cuente
    // tres veces. El servicio deduplica y el adaptador no lo vuelve a sumar.
    bytes: new TextEncoder().encode([OVERLAY, OVERLAY, OVERLAY].join("\n")),
    contentType: "video/mp4",
    expectedText: "guia rapida",
  },
});

describe("VisionOcr — el rodeo de los bytes (DATA-032)", () => {
  it("publica los bytes en una URL efímera y la cierra al terminar", async () => {
    const ocr = makeOcr();
    await ocr.recognizeImage({
      bytes: new TextEncoder().encode("hola"),
      contentType: "image/png",
    });

    const published = vision.requests[vision.requests.length - 1]?.url;
    expect(published).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\.png$/);

    // Y después de la llamada ya no responde: los bytes no sobreviven.
    const after = await fetch(published ?? "").then(
      (r) => r.status,
      () => "cerrado",
    );
    expect(after).toBe("cerrado");
  });

  it("el Content-Type declarado llega al servicio", async () => {
    const ocr = makeOcr();
    await ocr.recognizeImage({
      bytes: new TextEncoder().encode("hola"),
      contentType: "image/webp",
    });
    expect(vision.downloadedTypes[vision.downloadedTypes.length - 1]).toBe("image/webp");
  });

  it("la URL efímera se libera aunque el servicio falle", async () => {
    vision.set({ status: 500 });
    const ocr = makeOcr();
    await ocr
      .recognizeImage({ bytes: new TextEncoder().encode("x"), contentType: "image/png" })
      .catch(() => undefined);
    vision.set({});

    const published = vision.requests[vision.requests.length - 1]?.url;
    const after = await fetch(published ?? "").then(
      (r) => r.status,
      () => "cerrado",
    );
    expect(after).toBe("cerrado");
  });

  it("maxFrames viaja como max_frames (el costo crece linealmente con esto)", async () => {
    const ocr = makeOcr();
    await ocr.recognizeVideoFrames({
      bytes: new TextEncoder().encode("linea uno\nlinea dos"),
      contentType: "video/mp4",
      maxFrames: 4,
    });
    expect(vision.requests[vision.requests.length - 1]?.max_frames).toBe(4);
  });
});

describe("VisionOcr — AI-016: degrada, no aborta", () => {
  it("un `partial` devuelve lo que se pudo leer, no lanza", async () => {
    // Es la regla que `tests/test_degradacion.py` protege del lado del
    // servicio. Acá se protege del lado del cliente: si el adaptador lanzara
    // con `partial`, el alta se caería entera por una miniatura ilegible.
    vision.set({ ocrStatus: "partial" });
    const ocr = makeOcr();
    const result = await ocr.recognizeImage({
      bytes: new TextEncoder().encode("algo se leyó"),
      contentType: "image/png",
    });
    vision.set({});

    expect(result.text).toContain("algo se leyó");
  });

  it("un `failed` sí lanza: vacío no se puede distinguir de «no había texto»", async () => {
    // §25.3 `JV-1` depende del OCR como señal. Devolver texto vacío haría que
    // el clasificador trabajara con menos señal sin que nadie se entere.
    vision.set({ ocrStatus: "failed" });
    const ocr = makeOcr();
    const error = await ocr
      .recognizeImage({ bytes: new TextEncoder().encode("x"), contentType: "image/png" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    vision.set({});

    expect(isPortError(error) && error.code).toBe("provider_unavailable");
  });

  it("sin idioma detectado devuelve la lista vacía, no un idioma inventado", async () => {
    vision.set({ detectedLanguage: null });
    const ocr = makeOcr();
    const result = await ocr.recognizeImage({
      bytes: new TextEncoder().encode("hola"),
      contentType: "image/png",
    });
    vision.set({});

    expect(result.languages).toEqual([]);
  });
});

describe("VisionOcr — traducción de errores (PRD §10)", () => {
  const cases = [
    { status: 503, code: "provider_unavailable", why: "el motor todavía no cargó" },
    { status: 500, code: "provider_unavailable", why: "el servicio explotó" },
    { status: 504, code: "timeout", why: "gateway timeout" },
    { status: 429, code: "rate_limited", why: "saturado" },
    { status: 422, code: "bad_request", why: "validación de FastAPI" },
    { status: 413, code: "bad_request", why: "media por encima de NFR-013" },
  ] as const;

  for (const testCase of cases) {
    it(`${String(testCase.status)} → ${testCase.code} (${testCase.why})`, async () => {
      vision.set({ status: testCase.status });
      const ocr = makeOcr();
      const error = await ocr
        .recognizeImage({
          bytes: new TextEncoder().encode("x"),
          contentType: "image/png",
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      vision.set({});

      expect(isPortError(error)).toBe(true);
      if (isPortError(error)) expect(error.code).toBe(testCase.code);
    });
  }

  it("un content type de video no soportado es bad_request sin tocar la red", async () => {
    const before = vision.requests.length;
    const ocr = makeOcr();
    const error = await ocr
      .recognizeVideoFrames({ bytes: new Uint8Array([1]), contentType: "video/avi" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(error) && error.code).toBe("bad_request");
    expect(vision.requests.length).toBe(before);
  });

  it("el servicio caído es provider_unavailable y no nombra el host", async () => {
    const ocr = new VisionOcr({
      baseUrl: "http://127.0.0.1:9",
      publisher: loopbackPublisher(),
      timeoutMs: 2_000,
    });
    const error = await ocr
      .recognizeImage({ bytes: new TextEncoder().encode("x"), contentType: "image/png" })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(isPortError(error)).toBe(true);
    if (!isPortError(error)) return;
    expect(error.code).toBe("provider_unavailable");
    expect(JSON.stringify(error.toPublic())).not.toContain("127.0.0.1");
  });

  it("un cuerpo que no es JSON es provider_contract_violation", async () => {
    vision.set({ malformed: true });
    const ocr = makeOcr();
    const error = await ocr
      .recognizeImage({ bytes: new TextEncoder().encode("x"), contentType: "image/png" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    vision.set({});
    expect(isPortError(error) && error.code).toBe("provider_contract_violation");
  });

  it("un timeout del adaptador sale como `timeout`", async () => {
    vision.set({ delayMs: 500 });
    const ocr = new VisionOcr({
      baseUrl,
      publisher: loopbackPublisher(),
      timeoutMs: 50,
    });
    const error = await ocr
      .recognizeImage({ bytes: new TextEncoder().encode("x"), contentType: "image/png" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    vision.set({});
    expect(isPortError(error) && error.code).toBe("timeout");
  });
});
