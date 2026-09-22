/**
 * Subir un video propio · `P2-STUDIO-009`, `F-083` (PRD:525), §9.8 (PRD:2347).
 *
 * ## Dónde se corta el mock, y por qué justo ahí
 *
 * En los **dos** bordes de la red, y en ninguno más: `apiRequest` (los pasos 1
 * y 3, que hablan con la API v1) y `putSignedUpload` (el paso 2, que habla con
 * el storage). Lo que queda bajo test es la máquina de los tres pasos y la
 * pantalla — que es donde están las decisiones de esta tarea.
 *
 * ## Lo que estos casos protegen
 *
 * 1. **Que un archivo que no entra no salga a la red.** El límite es el del
 *    contrato, así que no puede discrepar con el del servidor; lo que se mide
 *    acá es que se aplique *antes* de pedir nada.
 * 2. **Que un fallo del último paso no vuelva a subir el archivo.** Es la
 *    diferencia entre reenviar 50 MB y reenviar 40 bytes, y —con la misma
 *    `Idempotency-Key`— entre cobrar un content save una vez o dos.
 * 3. **Que el usuario vea cuánto falta.** Un indeterminado durante minuto y
 *    medio se lee como una pantalla colgada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { queryKeys } from "@/lib/api/keys";
import { CustomVideoUpload } from "./CustomVideoUpload";

import type * as ApiClient from "@/lib/api/client";
import type * as Transport from "@/lib/studio/upload-transport";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

vi.mock("@/lib/studio/upload-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof Transport>()),
  putSignedUpload: vi.fn(),
}));

// Los imports van después de los `vi.mock` sólo para leerse en orden.
import { apiRequest } from "@/lib/api/client";
import { putSignedUpload, SignedUploadError } from "@/lib/studio/upload-transport";

const requestMock = vi.mocked(apiRequest);
const putMock = vi.mocked(putSignedUpload);

const MB = 1024 * 1024;

const RESERVE_PATH = "/content/custom/video/upload-url";
const FINALIZE_PATH = "/content/custom/video";

const RESERVATION = {
  uploadId: "8c5a9e0a-6a5e-4f2f-9e0e-2c1d3b4a5f60",
  uploadUrl: "https://minio.test/bucket/content/custom-video/co_1/up_1.mp4?X-Amz-Sig=a",
  method: "PUT" as const,
  headers: { "Content-Type": "video/mp4", "Content-Length": String(3 * MB) },
  expiresAt: 1_800_000_000_000,
};

const CONTENT = {
  _id: "content-1",
  type: "custom",
  status: "BUILDING",
  files: [],
  revision: 0,
};

/**
 * Un `File` con el peso que haga falta, sin reservar los bytes: `size` es un
 * getter del `Blob` y se puede fijar en la instancia. Alocar 62 MB para probar
 * una comparación sería pagar por nada.
 */
function videoFile(
  options: { name?: string; type?: string; sizeBytes?: number } = {},
): File {
  const { name = "demo.mp4", type = "video/mp4", sizeBytes = 3 * MB } = options;
  const file = new File([new Uint8Array([1, 2, 3])], name, { type });
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** El camino feliz de la API: reserva primero, pieza después. */
function apiHappyPath(): void {
  requestMock.mockImplementation(async (path: string) => {
    if (path === RESERVE_PATH) return RESERVATION as never;
    return CONTENT as never;
  });
}

function finalizeCalls(): { body: unknown; idempotencyKey?: string | undefined }[] {
  return requestMock.mock.calls
    .filter(([path]) => path === FINALIZE_PATH)
    .map(([, options]) => ({
      body: options?.body,
      idempotencyKey: options?.idempotencyKey,
    }));
}

let client: QueryClient;

function renderUpload() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<CustomVideoUpload />, { wrapper: Wrapper });
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText("Video file");
}

beforeEach(() => {
  requestMock.mockReset();
  putMock.mockReset();
  putMock.mockResolvedValue(undefined);
});

describe("lo que se ve antes de elegir nada", () => {
  it("el tope y los formatos, con el número del contrato", () => {
    renderUpload();
    // Decirlo antes es lo que evita el único error caro: elegir 300 MB y
    // enterarse cuando ya se esperó.
    expect(screen.getByText("MP4 or MOV, up to 50 MB.")).toBeInTheDocument();
    expect(fileInput().accept).toContain("video/quicktime");
  });

  it("dice que la imagen no entra, en vez de dejar que alguien lo descubra", () => {
    // La tarjeta del formato dice "video or image" (PRD:536) y la API sólo
    // tiene endpoint de video.
    renderUpload();
    expect(screen.getByText(/Images aren't accepted here yet/)).toBeInTheDocument();
  });
});

describe("un archivo que no entra no sale a la red", () => {
  it("62.4 MB: ni reserva, ni PUT, y el motivo con su número", async () => {
    const user = userEvent.setup();
    renderUpload();

    await user.upload(fileInput(), videoFile({ sizeBytes: Math.round(62.4 * MB) }));

    // La negativa primero: es lo que mide este caso.
    expect(requestMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "demo.mp4 is 62.4 MB and the limit is 50 MB, so it wasn't uploaded.",
    );
  });

  it("50 MB exactos sí salen: el borde del contrato, desde la pantalla", async () => {
    const user = userEvent.setup();
    apiHappyPath();
    renderUpload();

    await user.upload(fileInput(), videoFile({ sizeBytes: 50 * MB }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalled();
    });
    expect(requestMock.mock.calls[0]?.[1]?.body).toMatchObject({ sizeBytes: 50 * MB });
  });

  it("tras un rechazo el selector queda vacío: el MISMO archivo se puede volver a elegir", async () => {
    const user = userEvent.setup();
    renderUpload();

    await user.upload(fileInput(), videoFile({ sizeBytes: 62 * MB }));

    // Un `<input type="file">` no dispara `change` si el valor no cambia. Sin
    // vaciarlo, quien corrija el archivo y vuelva a elegir **el mismo nombre**
    // —o simplemente reintente con el mismo— no dispara nada y el control
    // parece muerto. jsdom no reproduce ese silencio del navegador; lo que sí
    // se puede comprobar es la condición que lo causa.
    expect(fileInput().files).toHaveLength(0);
    expect(fileInput().value).toBe("");
  });

  it("50 MB + 1 byte, no", async () => {
    const user = userEvent.setup();
    renderUpload();

    await user.upload(fileInput(), videoFile({ sizeBytes: 50 * MB + 1 }));

    expect(requestMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("el circuito de §9.8, de punta a punta", () => {
  it("reserva → PUT con los headers firmados → finalización", async () => {
    const user = userEvent.setup();
    apiHappyPath();
    renderUpload();

    await user.upload(fileInput(), videoFile({ name: "hook.mp4", sizeBytes: 3 * MB }));
    await screen.findByText("Video uploaded");

    // 1 · la reserva lleva lo que el schema del servidor espera.
    expect(requestMock.mock.calls[0]).toMatchObject([
      RESERVE_PATH,
      {
        method: "POST",
        body: { filename: "hook.mp4", contentType: "video/mp4", sizeBytes: 3 * MB },
      },
    ]);

    // 2 · el PUT va a la URL firmada, con el método y los headers de la reserva
    // y **sin tocarlos**: con SigV4, una cabecera de más o de menos invalida la
    // firma.
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0]?.[0]).toMatchObject({
      url: RESERVATION.uploadUrl,
      method: "PUT",
      headers: RESERVATION.headers,
    });

    // 3 · la finalización sólo lleva el `uploadId`, y una `Idempotency-Key`:
    // la ruta cuesta un content save (PRD:2286).
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0]?.body).toEqual({ uploadId: RESERVATION.uploadId });
    expect(finalizeCalls()[0]?.idempotencyKey).toBeTruthy();
  });

  it("al terminar dice que la pieza se está construyendo, no que está lista", async () => {
    const user = userEvent.setup();
    apiHappyPath();
    renderUpload();

    await user.upload(fileInput(), videoFile());

    // FR-070: MOV→MP4 y el thumbnail los hace el servidor. Decir "listo" y
    // mandar a la Library sería mandar a ver algo que todavía no está.
    expect(await screen.findByText(/It's building now/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("la pieza nueva invalida el listado de contenido", async () => {
    const user = userEvent.setup();
    apiHappyPath();
    renderUpload();
    // El listado tiene `staleTime` de 30 s: sin invalidar, ir a la Library
    // dentro de ese medio minuto la enseña sin la pieza recién creada.
    client.setQueryData(queryKeys.content(), { pages: [], pageParams: [] });

    await user.upload(fileInput(), videoFile());
    await screen.findByText("Video uploaded");

    await waitFor(() => {
      expect(client.getQueryState(queryKeys.content())?.isInvalidated).toBe(true);
    });
  });
});

describe("mientras sube, se ve cuánto falta", () => {
  it("el porcentaje llega a la pantalla y a la barra", async () => {
    const user = userEvent.setup();
    const transfer = deferred<undefined>();
    requestMock.mockResolvedValue(RESERVATION as never);
    putMock.mockImplementation(async (request) => {
      request.onProgress?.(42);
      return transfer.promise;
    });
    renderUpload();

    await user.upload(fileInput(), videoFile({ name: "hook.mp4" }));

    expect(await screen.findByText("Uploading hook.mp4 — 42%")).toBeInTheDocument();
    // La barra, para quien no lee el texto.
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "42");
    transfer.resolve(undefined);
  });

  it("sin total conocido la barra es indeterminada, no un 0 % clavado", async () => {
    const user = userEvent.setup();
    const transfer = deferred<undefined>();
    requestMock.mockResolvedValue(RESERVATION as never);
    putMock.mockImplementation(async (request) => {
      request.onProgress?.(null);
      return transfer.promise;
    });
    renderUpload();

    await user.upload(fileInput(), videoFile({ name: "hook.mp4" }));

    expect(await screen.findByText("Uploading hook.mp4…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
    transfer.resolve(undefined);
  });

  it("`Cancel` corta la subida y no finaliza nada", async () => {
    const user = userEvent.setup();
    requestMock.mockResolvedValue(RESERVATION as never);
    putMock.mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new SignedUploadError({ status: 0, aborted: true }));
          });
        }),
    );
    renderUpload();

    await user.upload(fileInput(), videoFile());
    await user.click(await screen.findByRole("button", { name: "Cancel upload" }));

    // Lo que importa es que NO se finalice: una finalización tras un abort
    // cobraría un content save por un objeto que no está entero.
    await waitFor(() => {
      expect(screen.queryByRole("progressbar")).toBeNull();
    });
    expect(finalizeCalls()).toHaveLength(0);
    // Y se vuelve al principio, con el selector otra vez utilizable.
    expect(fileInput()).not.toBeDisabled();
  });
});

describe("cuando falla a mitad de camino", () => {
  it("si falla la finalización, reintentar NO vuelve a subir el archivo", async () => {
    const user = userEvent.setup();
    let finalizes = 0;
    requestMock.mockImplementation(async (path: string) => {
      if (path === RESERVE_PATH) return RESERVATION as never;
      finalizes += 1;
      if (finalizes === 1) {
        throw new ApiRequestError({ code: "network_error", status: 0 });
      }
      return CONTENT as never;
    });
    renderUpload();

    await user.upload(fileInput(), videoFile({ sizeBytes: 40 * MB }));

    // El botón lo dice: no es "Try again", es "terminar" lo que quedó.
    await user.click(await screen.findByRole("button", { name: "Finish upload" }));
    await screen.findByText("Video uploaded");

    // Esto es el test entero: un PUT, una reserva, dos finalizaciones.
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls.filter(([path]) => path === RESERVE_PATH)).toHaveLength(
      1,
    );
    expect(finalizeCalls()).toHaveLength(2);
  });

  it("y las dos finalizaciones van con la MISMA `Idempotency-Key`", async () => {
    const user = userEvent.setup();
    let finalizes = 0;
    requestMock.mockImplementation(async (path: string) => {
      if (path === RESERVE_PATH) return RESERVATION as never;
      finalizes += 1;
      if (finalizes === 1) {
        throw new ApiRequestError({ code: "service_unavailable", status: 503 });
      }
      return CONTENT as never;
    });
    renderUpload();

    await user.upload(fileInput(), videoFile());
    await user.click(await screen.findByRole("button", { name: "Finish upload" }));
    await screen.findByText("Video uploaded");

    // Sin esto, una finalización que el servidor sí procesó —y cuya respuesta
    // se perdió— se cobraría dos veces y crearía dos piezas.
    const keys = finalizeCalls().map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("si falla el PUT se empieza otra vez: la reserva es gratis", async () => {
    const user = userEvent.setup();
    apiHappyPath();
    putMock.mockRejectedValueOnce(new SignedUploadError({ status: 500 }));
    renderUpload();

    await user.upload(fileInput(), videoFile());

    expect(await screen.findByText("The video didn't reach storage")).toBeInTheDocument();
    // La negativa: nada se creó, así que no se finalizó nada.
    expect(finalizeCalls()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Video uploaded");

    expect(requestMock.mock.calls.filter(([path]) => path === RESERVE_PATH)).toHaveLength(
      2,
    );
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it("una reserva caducada (`410`) se rehace entera, con una key nueva", async () => {
    const user = userEvent.setup();
    let finalizes = 0;
    requestMock.mockImplementation(async (path: string) => {
      if (path === RESERVE_PATH) return RESERVATION as never;
      finalizes += 1;
      if (finalizes === 1) throw new ApiRequestError({ code: "gone", status: 410 });
      return CONTENT as never;
    });
    renderUpload();

    await user.upload(fileInput(), videoFile());
    expect(await screen.findByText("The upload window expired")).toBeInTheDocument();
    // Repetir sólo el paso 3 con una reserva vencida daría otro 410 para
    // siempre, así que aquí NO se ofrece terminar.
    expect(screen.queryByRole("button", { name: "Finish upload" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Video uploaded");

    expect(putMock).toHaveBeenCalledTimes(2);
    const keys = finalizeCalls().map((call) => call.idempotencyKey);
    // Dos subidas distintas son dos piezas: compartir la key haría que la
    // segunda devolviera la primera.
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("la cuota agotada no ofrece reintentar: ofrece la salida de §19", async () => {
    const user = userEvent.setup();
    requestMock.mockImplementation(async (path: string) => {
      if (path === RESERVE_PATH) return RESERVATION as never;
      throw new ApiRequestError({ code: "content_quota_exceeded", status: 402 });
    });
    renderUpload();

    await user.upload(fileInput(), videoFile());
    await screen.findByRole("alert");

    // ERR-R03: reintentar da otro 402. Un botón que no puede funcionar enseña
    // que los botones de esta app no sirven.
    expect(screen.queryByRole("button", { name: "Finish upload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("link", { name: "Upgrade to unlock" })).toBeInTheDocument();
  });
});
