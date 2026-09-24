/**
 * Subida al Media Bank · `PU-MEDIA-001` — la cola entera montada en
 * `MyMediaBankTab`, con los tres pasos de §9.8 fingidos en su frontera:
 *
 * · `apiRequest` / `apiList` / `apiSend` — la API v1 (reserva, finalización,
 *   PATCH de categorías, listado, borrado).
 * · `putSignedUpload` — el PUT al storage, con progreso y abort controlables.
 * · `probeVideoDimensions` — las medidas del video, que en jsdom no existen.
 *
 * Lo que tiene que quedar probado, en el orden de la tarea: selección
 * múltiple, progreso, el error de un archivo sin frenar a los demás, las
 * categorías por defecto según el tipo, y "Apply to all".
 */
import { mediaSchema, type Media } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { MAX_CONCURRENT_UPLOADS } from "@/lib/media/upload/queue";
import { MyMediaBankTab } from "./MyMediaBankTab";

import type * as ApiClient from "@/lib/api/client";
import type * as Transport from "@/lib/media/upload/transport";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

vi.mock("@/lib/media/upload/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof Transport>()),
  putSignedUpload: vi.fn(),
}));

vi.mock("@/lib/media/upload/probe", () => ({
  probeVideoDimensions: vi.fn(),
}));

// Los imports van después de los `vi.mock` sólo para leerse en orden.
import { apiList, apiRequest, apiSend, type CursorPage } from "@/lib/api/client";
import {
  putSignedUpload,
  SignedUploadError,
  type SignedUploadRequest,
} from "@/lib/media/upload/transport";
import { probeVideoDimensions } from "@/lib/media/upload/probe";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);
const putMock = vi.mocked(putSignedUpload);
const probeMock = vi.mocked(probeVideoDimensions);

const UPLOADED_AT = Date.UTC(2026, 8, 24);

function asset(overrides: Readonly<Record<string, unknown>> = {}): Media {
  return mediaSchema.parse({
    mediaId: "media-1",
    mediaType: "image",
    filename: "beach.jpg",
    r2Url: "https://cdn.example.test/beach.jpg",
    status: "ready",
    sizeMb: 0.1,
    categories: [],
    origin: "manual_upload",
    uploadedAt: UPLOADED_AT,
    ...overrides,
  });
}

function page(items: readonly Media[]): CursorPage<Media> {
  return { items, cursor: null, hasMore: false };
}

function image(name: string, type = "image/jpeg"): File {
  return new File(["img-bytes"], name, { type });
}

function video(name: string): File {
  return new File(["video-bytes"], name, { type: "video/mp4" });
}

/** Un PUT que el test resuelve cuando quiere, con acceso a su `onProgress`. */
interface PendingPut {
  readonly request: SignedUploadRequest;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

let puts: PendingPut[] = [];
/** Qué archivos (por nombre de reserva) ya reservaron, en orden. */
let reserved: string[] = [];
/** `filename → uploadId` de la última reserva de cada archivo. */
let uploadIds: Map<string, string>;
/** `uploadId → filename`, para que la finalización sepa qué asset devolver. */
let filenames: Map<string, string>;

function mediaFor(filename: string, id: string): Media {
  const isVideo = /\.(mp4|mov)$/.test(filename);
  return asset({
    mediaId: id,
    filename,
    mediaType: isVideo ? "video" : "image",
    status: isVideo ? "processing" : "ready",
    r2Url: `https://cdn.example.test/${filename}`,
  });
}

/**
 * La API fingida. La reserva y la finalización responden solas; el PUT queda
 * pendiente en `puts` hasta que el test lo resuelva (o se resuelve solo, con
 * `autoPut`).
 */
function installApi({ autoPut = false }: { autoPut?: boolean } = {}): void {
  let counter = 0;
  requestMock.mockImplementation((async (
    path: string,
    options?: ApiClient.ApiRequestOptions<unknown>,
  ) => {
    const method = options?.method ?? "GET";
    const body = options?.body as Record<string, unknown> | undefined;
    if (path === "/media/upload-url" && method === "POST") {
      counter += 1;
      const filename = String(body?.["filename"]);
      const uploadId = `upl-${String(counter)}`;
      reserved.push(filename);
      uploadIds.set(filename, uploadId);
      filenames.set(uploadId, filename);
      return {
        uploadId,
        uploadUrl: `https://storage.example.test/${uploadId}`,
        method: "PUT",
        headers: {
          "Content-Type": String(body?.["contentType"]),
          "Content-Length": String(body?.["sizeBytes"]),
        },
        expiresAt: UPLOADED_AT + 3_600_000,
      };
    }
    if (path === "/media" && method === "POST") {
      const uploadId = String(body?.["uploadId"]);
      const filename = filenames.get(uploadId) ?? "unknown.jpg";
      return mediaFor(filename, `media-${uploadId}`);
    }
    const patch = /^\/media\/(.+)$/.exec(path);
    if (patch !== null && method === "PATCH") {
      const id = decodeURIComponent(patch[1] ?? "");
      const uploadId = id.replace(/^media-/, "");
      return {
        ...mediaFor(filenames.get(uploadId) ?? "unknown.jpg", id),
        categories: body?.["categories"],
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof apiRequest);

  putMock.mockImplementation((request) => {
    if (autoPut) {
      request.onProgress?.(100);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      request.signal?.addEventListener("abort", () => {
        reject(new SignedUploadError({ status: 0, aborted: true, message: "aborted" }));
      });
      puts.push({ request, resolve, reject });
    });
  });
}

function putFor(filename: string): PendingPut {
  const uploadId = uploadIds.get(filename);
  const found = puts.find((put) => put.request.url.endsWith(`/${String(uploadId)}`));
  if (found === undefined) throw new Error(`no PUT in flight for ${filename}`);
  return found;
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<MyMediaBankTab />, { wrapper: Wrapper });
}

/** La fila de la cola de un archivo. */
function row(name: string): HTMLElement {
  const queue = screen.getByRole("region", { name: "Uploads" });
  const label = within(queue).getByText(name);
  const li = label.closest("li");
  if (li === null) throw new Error(`no row for ${name}`);
  return li;
}

function input(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Upload images or videos");
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
  sendMock.mockReset();
  putMock.mockReset();
  probeMock.mockReset();
  probeMock.mockResolvedValue(null);
  listMock.mockResolvedValue(page([]));
  puts = [];
  reserved = [];
  uploadIds = new Map();
  filenames = new Map();
});

describe("selección múltiple", () => {
  it("varios archivos de una: una fila por archivo, y cada uno reserva lo suyo", async () => {
    const user = userEvent.setup();
    installApi({ autoPut: true });
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [
      image("a.jpg"),
      image("b.png", "image/png"),
      video("c.mp4"),
    ]);

    await waitFor(() => {
      expect(
        within(row("c.mp4")).getByText("Uploaded · processing video…"),
      ).toBeInTheDocument();
    });
    expect(within(row("a.jpg")).getByText(/Uploaded$/)).toBeInTheDocument();
    expect(within(row("b.png")).getByText(/Uploaded$/)).toBeInTheDocument();
    expect(reserved.sort()).toEqual(["a.jpg", "b.png", "c.mp4"]);

    // El body de la reserva es el del contrato, con el content type declarado.
    const reservation = requestMock.mock.calls.find(
      ([path, options]) =>
        path === "/media/upload-url" &&
        (options?.body as { filename?: string } | undefined)?.filename === "c.mp4",
    );
    expect(reservation?.[1]?.body).toEqual({
      filename: "c.mp4",
      contentType: "video/mp4",
      sizeBytes: 11,
    });
    expect(screen.getByText("3 of 3 uploaded")).toBeInTheDocument();
  });

  it(`no más de ${String(MAX_CONCURRENT_UPLOADS)} PUTs a la vez: el resto espera`, async () => {
    const user = userEvent.setup();
    installApi();
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [
      image("1.jpg"),
      image("2.jpg"),
      image("3.jpg"),
      image("4.jpg"),
    ]);

    await waitFor(() => {
      expect(puts).toHaveLength(MAX_CONCURRENT_UPLOADS);
    });
    expect(within(row("4.jpg")).getByText(/Waiting…/)).toBeInTheDocument();

    // Termina uno y entra el cuarto.
    putFor("1.jpg").resolve();
    await waitFor(() => {
      expect(puts).toHaveLength(4);
    });
  });

  it("un archivo que no entra se rechaza en el cliente, sin reservar nada", async () => {
    const user = userEvent.setup({ applyAccept: false });
    installApi({ autoPut: true });
    renderTab();
    await screen.findByText("No images uploaded yet");

    const huge = image("huge.jpg");
    Object.defineProperty(huge, "size", { value: 12 * 1024 * 1024 });
    await user.upload(input(), [
      huge,
      new File(["x"], "notes.txt", { type: "text/plain" }),
    ]);

    expect(
      await within(row("huge.jpg")).findByText("12.0 MB — images can be up to 10 MB."),
    ).toBeInTheDocument();
    expect(
      within(row("notes.txt")).getByText("Only JPG, PNG, WebP, MP4 and MOV files."),
    ).toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("progreso", () => {
  it("el porcentaje del PUT llega a la fila y a la barra", async () => {
    const user = userEvent.setup();
    installApi();
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [image("a.jpg")]);
    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });

    putFor("a.jpg").request.onProgress?.(40);

    expect(await within(row("a.jpg")).findByText(/Uploading 40%/)).toBeInTheDocument();
    expect(
      within(row("a.jpg")).getByRole("progressbar", {
        name: "Upload progress for a.jpg",
      }),
    ).toHaveAttribute("aria-valuenow", "40");

    // `content-length` viaja en los headers de la reserva; filtrarlo es trabajo
    // del transporte, que acá recibe el bloque tal cual.
    expect(putFor("a.jpg").request.headers).toMatchObject({
      "Content-Type": "image/jpeg",
    });
  });

  it("cancelar corta el PUT y la fila queda cancelada", async () => {
    const user = userEvent.setup();
    installApi();
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [image("a.jpg")]);
    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });

    await user.click(screen.getByRole("button", { name: "Cancel upload of a.jpg" }));

    expect(await within(row("a.jpg")).findByText("Cancelled")).toBeInTheDocument();
    expect(putFor("a.jpg").request.signal?.aborted).toBe(true);
    // Nunca se finalizó.
    expect(requestMock.mock.calls.some(([path]) => path === "/media")).toBe(false);
  });
});

describe("el fallo de un archivo no frena a los demás", () => {
  it("un PUT caído deja su fila con reintento, y los otros terminan", async () => {
    const user = userEvent.setup();
    installApi();
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [image("a.jpg"), image("b.jpg"), image("c.jpg")]);
    await waitFor(() => {
      expect(puts).toHaveLength(3);
    });

    putFor("b.jpg").reject(new SignedUploadError({ status: 403 }));
    putFor("a.jpg").resolve();
    putFor("c.jpg").resolve();

    expect(
      await within(row("b.jpg")).findByText("The upload was interrupted."),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(within(row("a.jpg")).getByText(/Uploaded$/)).toBeInTheDocument();
    });
    expect(within(row("c.jpg")).getByText(/Uploaded$/)).toBeInTheDocument();
    expect(screen.getByText("2 of 3 uploaded")).toBeInTheDocument();

    // Reintentar un PUT caído vuelve a reservar (gratis) y sube de nuevo.
    await user.click(screen.getByRole("button", { name: "Retry b.jpg" }));
    await waitFor(() => {
      expect(reserved.filter((name) => name === "b.jpg")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(puts).toHaveLength(4);
    });
    putFor("b.jpg").resolve();
    await waitFor(() => {
      expect(within(row("b.jpg")).getByText(/Uploaded$/)).toBeInTheDocument();
    });
  });

  it("una finalización caída se reintenta sin volver a subir", async () => {
    const user = userEvent.setup();
    installApi({ autoPut: true });
    const base = requestMock.getMockImplementation();
    let failFinalize = true;
    requestMock.mockImplementation(((
      path: string,
      options?: ApiClient.ApiRequestOptions<unknown>,
    ) => {
      if (path === "/media" && options?.method === "POST" && failFinalize) {
        failFinalize = false;
        return Promise.reject(
          new ApiRequestError({ code: "service_unavailable", status: 503 }),
        );
      }
      return base?.(path, options);
    }) as typeof apiRequest);

    renderTab();
    await screen.findByText("No images uploaded yet");
    await user.upload(input(), [image("a.jpg")]);

    await within(row("a.jpg")).findByText(/couldn't finish adding it/);
    await user.click(screen.getByRole("button", { name: "Retry a.jpg" }));

    await waitFor(() => {
      expect(within(row("a.jpg")).getByText(/Uploaded$/)).toBeInTheDocument();
    });
    expect(reserved).toEqual(["a.jpg"]);
    expect(putMock).toHaveBeenCalledTimes(1);
    // La misma `Idempotency-Key` en los dos intentos del paso 3.
    const finals = requestMock.mock.calls.filter(([path]) => path === "/media");
    expect(finals).toHaveLength(2);
    expect(finals[0]?.[1]?.idempotencyKey).toBeDefined();
    expect(finals[0]?.[1]?.idempotencyKey).toBe(finals[1]?.[1]?.idempotencyKey);
  });
});

describe("categorías por defecto según el tipo (F-129)", () => {
  function pressed(container: HTMLElement): string[] {
    return within(container)
      .getAllByRole("button", { pressed: true })
      .map((button) => button.textContent);
  }

  it("imagen → las dos de imagen; y no ofrece categorías de video", async () => {
    const user = userEvent.setup();
    installApi({ autoPut: true });
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [image("a.jpg")]);
    const group = await screen.findByRole("group", { name: "Categories for a.jpg" });

    expect(pressed(group)).toEqual(["Slideshow image", "Green screen background"]);
    expect(within(group).queryByText("Hook video")).toBeNull();
  });

  it("video vertical → background; horizontal → hook", async () => {
    const user = userEvent.setup();
    installApi({ autoPut: true });
    probeMock.mockImplementation((file) =>
      Promise.resolve(
        (file as File).name === "tall.mp4"
          ? { width: 1080, height: 1920 }
          : { width: 1920, height: 1080 },
      ),
    );
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [video("tall.mp4"), video("wide.mp4")]);

    const tall = await screen.findByRole("group", { name: "Categories for tall.mp4" });
    const wide = await screen.findByRole("group", { name: "Categories for wide.mp4" });
    expect(pressed(tall)).toEqual(["Background video"]);
    expect(pressed(wide)).toEqual(["Hook video"]);
    expect(within(tall).queryByText("Slideshow image")).toBeNull();
  });

  it("el usuario cambia la sugerencia y `Save` manda exactamente eso", async () => {
    const user = userEvent.setup();
    installApi({ autoPut: true });
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [image("a.jpg")]);
    const group = await screen.findByRole("group", { name: "Categories for a.jpg" });
    await user.click(
      within(group).getByRole("button", { name: /Green screen background/ }),
    );
    await user.click(within(row("a.jpg")).getByRole("button", { name: "Save" }));

    expect(await within(row("a.jpg")).findByText("Categories saved")).toBeInTheDocument();
    const patch = requestMock.mock.calls.find(
      ([, options]) => options?.method === "PATCH",
    );
    expect(patch?.[0]).toBe("/media/media-upl-1");
    expect(patch?.[1]?.body).toEqual({ categories: ["slideshow-image"] });
  });
});

describe("Apply to all", () => {
  it("aplica la selección de una fila a toda la tanda del mismo tipo, y la guarda", async () => {
    const user = userEvent.setup();
    installApi({ autoPut: true });
    renderTab();
    await screen.findByText("No images uploaded yet");

    await user.upload(input(), [
      image("a.jpg"),
      image("b.jpg"),
      image("c.jpg"),
      video("v.mp4"),
    ]);
    await screen.findByRole("group", { name: "Categories for c.jpg" });
    await screen.findByRole("group", { name: "Categories for v.mp4" });

    const group = screen.getByRole("group", { name: "Categories for a.jpg" });
    await user.click(
      within(group).getByRole("button", { name: /Green screen background/ }),
    );
    await user.click(
      within(row("a.jpg")).getByRole("button", { name: "Apply to all 3 images" }),
    );

    await waitFor(() => {
      expect(within(row("c.jpg")).getByText("Categories saved")).toBeInTheDocument();
    });
    expect(within(row("a.jpg")).getByText("Categories saved")).toBeInTheDocument();
    expect(within(row("b.jpg")).getByText("Categories saved")).toBeInTheDocument();

    const patches = requestMock.mock.calls.filter(
      ([, options]) => options?.method === "PATCH",
    );
    expect(patches).toHaveLength(3);
    for (const [, options] of patches) {
      expect(options?.body).toEqual({ categories: ["slideshow-image"] });
    }
    // El video no es de la tanda: sus categorías son de otro tipo.
    expect(
      screen.getByRole("group", { name: "Categories for v.mp4" }),
    ).toBeInTheDocument();
  });
});

describe("acciones de una tarjeta existente", () => {
  it("editar categorías manda el reemplazo total", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(page([asset({ categories: ["slideshow-image"] })]));
    requestMock.mockResolvedValue(asset({ categories: ["green-screen-background"] }));
    renderTab();

    await user.click(
      await screen.findByRole("button", { name: "Edit categories of beach.jpg" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Slideshow image/ }));
    await user.click(
      within(dialog).getByRole("button", { name: /Green screen background/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save categories" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(requestMock).toHaveBeenCalledWith(
      "/media/media-1",
      expect.objectContaining({
        method: "PATCH",
        body: { categories: ["green-screen-background"] },
      }),
    );
  });

  it("borrar un asset en uso (409 media_in_use) lo dice y no cierra", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(page([asset()]));
    sendMock.mockRejectedValue(
      new ApiRequestError({ code: "media_in_use", status: 409 }),
    );
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Delete beach.jpg" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(
      await within(dialog).findByText(
        "The asset is still referenced. Remove the dependency or delete the content before retrying.",
      ),
    ).toBeInTheDocument();
    expect(sendMock).toHaveBeenCalledWith("/media/media-1", { method: "DELETE" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("borrar con éxito cierra y vuelve a pedir el listado", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(page([asset()]));
    listMock.mockResolvedValue(page([]));
    sendMock.mockResolvedValue(undefined);
    renderTab();

    await user.click(await screen.findByRole("button", { name: "Delete beach.jpg" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await screen.findByText("No images uploaded yet");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("estado vacío", () => {
  it("ofrece el CTA grande de subir", async () => {
    listMock.mockResolvedValue(page([]));
    renderTab();

    await screen.findByText("No images uploaded yet");
    expect(screen.getByRole("button", { name: "Upload media" })).toBeInTheDocument();
  });
});
