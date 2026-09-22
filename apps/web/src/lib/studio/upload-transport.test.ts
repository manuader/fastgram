/**
 * El PUT firmado del paso 2 de §9.8, con un `XMLHttpRequest` de mentira.
 *
 * ## Qué se mide, y por qué no alcanza con "sube"
 *
 * Lo que rompe una subida firmada no es el cuerpo: es **la cabecera**. La firma
 * SigV4 que emite la API cubre `content-type` (trampa 11 del general, con test
 * de punta a punta en `apps/api/test/media-upload.int.test.ts`), así que un PUT
 * sin él —o con otro— es un `403` y no un `200`. Y a la vez `Content-Length`,
 * que viene en la misma respuesta de reserva, **no se puede mandar** desde un
 * navegador: es un forbidden header name. Reenviar el bloque entero, que es lo
 * natural, rompe; filtrar de más, también.
 *
 * El doble de `setRequestHeader` lanza con `Content-Length` a propósito, igual
 * que hace jsdom: si alguien quita el filtro, este archivo se pone rojo con el
 * motivo escrito en vez de fallar mucho más tarde contra un bucket real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSignedUploadError,
  putSignedUpload,
  SignedUploadError,
} from "./upload-transport";

type Listener = (event: unknown) => void;

class FakeEmitter {
  readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeXhr extends FakeEmitter {
  static instances: FakeXhr[] = [];

  readonly upload = new FakeEmitter();
  readonly headers: Record<string, string> = {};
  method = "";
  url = "";
  status = 0;
  body: unknown = null;
  aborts = 0;

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    // Lo mismo que hace jsdom (y lo que el navegador ignora en silencio).
    if (name.toLowerCase() === "content-length") {
      throw new Error('Refused to set unsafe header "Content-Length"');
    }
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.body = body;
  }

  abort(): void {
    this.aborts += 1;
    this.emit("abort");
  }

  /** Respuesta del storage. */
  respond(status: number): void {
    this.status = status;
    this.emit("load");
  }
}

function install(): void {
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

function last(): FakeXhr {
  const instance = FakeXhr.instances.at(-1);
  if (instance === undefined) throw new Error("no se abrió ninguna petición");
  return instance;
}

const RESERVATION = {
  url: "https://minio.test/bucket/content/custom-video/co_1/up_1.mp4?X-Amz-Signature=abc",
  method: "PUT" as const,
  headers: { "Content-Type": "video/mp4", "Content-Length": "1234" },
};

function body(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("la petición que sale", () => {
  it("usa la URL y el método de la reserva, tal cual", async () => {
    install();
    const promise = putSignedUpload({ ...RESERVATION, body: body() });
    last().respond(200);
    await expect(promise).resolves.toBeUndefined();

    expect(last().method).toBe("PUT");
    expect(last().url).toBe(RESERVATION.url);
  });

  it("manda `Content-Type` y NO intenta mandar `Content-Length`", async () => {
    install();
    const promise = putSignedUpload({ ...RESERVATION, body: body() });
    last().respond(200);
    await promise;

    // Sin él, el storage responde 403: la firma lo cubre.
    expect(last().headers["Content-Type"]).toBe("video/mp4");
    // Con él, el navegador lanza. El doble lanza igual que jsdom, así que si
    // esta clave apareciera el test de arriba ya habría fallado.
    expect(Object.keys(last().headers)).not.toContain("Content-Length");
  });
});

describe("cómo termina", () => {
  it("un `2xx` resuelve", async () => {
    install();
    const promise = putSignedUpload({ ...RESERVATION, body: body() });
    last().respond(204);
    await expect(promise).resolves.toBeUndefined();
  });

  it("un `403` —firma vencida o tipo cambiado— rechaza con su status", async () => {
    install();
    const promise = putSignedUpload({ ...RESERVATION, body: body() });
    last().respond(403);

    await expect(promise).rejects.toBeInstanceOf(SignedUploadError);
    await promise.catch((error: unknown) => {
      expect(isSignedUploadError(error) && error.status).toBe(403);
      // No es un abort: el usuario no canceló nada.
      expect(isSignedUploadError(error) && error.aborted).toBe(false);
    });
  });

  it("un fallo de red rechaza con status 0", async () => {
    install();
    const promise = putSignedUpload({ ...RESERVATION, body: body() });
    last().emit("error");

    await promise.catch((error: unknown) => {
      expect(isSignedUploadError(error) && error.status).toBe(0);
      expect(isSignedUploadError(error) && error.aborted).toBe(false);
    });
    await expect(promise).rejects.toBeInstanceOf(SignedUploadError);
  });
});

describe("el progreso, que es la razón de usar XHR", () => {
  it("traduce bytes a porcentaje y afirma el 100 % al terminar", async () => {
    install();
    const seen: (number | null)[] = [];
    const promise = putSignedUpload({
      ...RESERVATION,
      body: body(),
      onProgress: (percent) => seen.push(percent),
    });

    last().upload.emit("progress", { loaded: 0, total: 200, lengthComputable: true });
    last().upload.emit("progress", { loaded: 100, total: 200, lengthComputable: true });
    last().respond(200);
    await promise;

    // El último `progress` puede quedarse corto por buffering; lo que el
    // usuario tiene que ver al final es 100, no 97.
    expect(seen).toEqual([0, 50, 100]);
  });

  it("sin total se informa `null`, no `0`", async () => {
    install();
    const seen: (number | null)[] = [];
    const promise = putSignedUpload({
      ...RESERVATION,
      body: body(),
      onProgress: (percent) => seen.push(percent),
    });

    // Una barra clavada en 0 % durante un minuto se lee como "roto"; una barra
    // indeterminada dice la verdad, que es "no sé cuánto falta".
    last().upload.emit("progress", { loaded: 10, total: 0, lengthComputable: false });
    last().respond(200);
    await promise;

    expect(seen).toEqual([null, 100]);
  });
});

describe("cancelar corta la transferencia de verdad", () => {
  it("el `AbortSignal` llama a `xhr.abort()` y el fallo se marca como abort", async () => {
    install();
    const controller = new AbortController();
    const promise = putSignedUpload({
      ...RESERVATION,
      body: body(),
      signal: controller.signal,
    });

    expect(last().aborts).toBe(0);
    controller.abort();
    expect(last().aborts).toBe(1);

    await promise.catch((error: unknown) => {
      expect(isSignedUploadError(error) && error.aborted).toBe(true);
    });
    await expect(promise).rejects.toBeInstanceOf(SignedUploadError);
  });

  it("con la señal ya abortada no se abre ninguna petición", async () => {
    install();
    const controller = new AbortController();
    controller.abort();

    const promise = putSignedUpload({
      ...RESERVATION,
      body: body(),
      signal: controller.signal,
    });

    // La negativa primero: es lo que mide este caso. Abrir la petición y
    // abortarla después igual habría mandado bytes.
    expect(FakeXhr.instances).toHaveLength(0);
    await expect(promise).rejects.toBeInstanceOf(SignedUploadError);
  });
});
