/**
 * `PU-EDIT-003` — guardar manda el body correcto, y el `409` de revisión se
 * ve como lo que es: "alguien la cambió, recargá".
 *
 * El corte está en `apiRequest` (el cliente tipado), como en el resto de las
 * pantallas: lo que queda bajo test es el editor, no el parser del sobre.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { libraryContentSchema } from "@/lib/library/content";
import { ContentEditor } from "./ContentEditor";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const ID = "11111111-1111-4111-8111-111111111111";

const content = (over: Record<string, unknown> = {}) =>
  libraryContentSchema.parse({
    _id: ID,
    type: "wall-of-text",
    status: "CREATED",
    files: ["https://cdn.test/out.mp4"],
    revision: 3,
    ...over,
  });

const BOX = {
  id: "slide-0-text-0",
  slideIndex: 0,
  text: "Hola",
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "inter", weight: 700, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
};

const EDITABLE = {
  canvas: { width: 1080, height: 1920 },
  textBoxes: [BOX],
  assets: {
    video: {
      url: "https://cdn.test/v.mp4",
      drawX: 0,
      drawY: 0,
      drawW: 1080,
      drawH: 1920,
    },
    audio: null,
  },
};

type Handler = (path: string, options: ApiRequestOptions<unknown>) => unknown;

function serve(onPatch: Handler) {
  requestMock.mockImplementation(async (path, options = {}) => {
    const method = options.method ?? "GET";
    let raw: unknown;
    if (method === "PATCH")
      raw = await onPatch(path, options as ApiRequestOptions<unknown>);
    else if (path.endsWith("/editable")) raw = EDITABLE;
    else raw = content();
    // Como el cliente real: el schema del que llama valida la respuesta.
    const schema = options.schema;
    return (schema === undefined ? raw : schema.parse(raw)) as never;
  });
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  requestMock.mockReset();
  push.mockReset();
});

async function editTextTo(value: string) {
  const user = userEvent.setup();
  const textarea = await screen.findByLabelText("Content");
  await user.clear(textarea);
  await user.type(textarea, value);
  return user;
}

describe("ContentEditor · guardar", () => {
  it("manda PATCH con la revisión vista, todas las cajas y una Idempotency-Key", async () => {
    serve(() => content({ status: "BUILDING", revision: 4 }));
    render(<ContentEditor contentId={ID} />, { wrapper });

    const user = await editTextTo("Chau");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        `/content/${ID}`,
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const call = requestMock.mock.calls.find(([, o]) => o?.method === "PATCH");
    const options = call?.[1];
    expect(options?.body).toEqual({ revision: 3, textBoxes: [{ ...BOX, text: "Chau" }] });
    expect(typeof options?.idempotencyKey).toBe("string");
    expect(options?.idempotencyKey).not.toBe("");

    // Queda reconstruyendo, sin cambios pendientes.
    expect(
      await screen.findByText("Rebuilding the piece with your changes…"),
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("409 stale_revision: aviso claro y Reload, sin perder el texto todavía", async () => {
    serve(() => {
      throw new ApiRequestError({
        code: "stale_revision",
        status: 409,
        serverMessage: "Someone else changed this piece.",
      });
    });
    render(<ContentEditor contentId={ID} />, { wrapper });

    const user = await editTextTo("Mío");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Someone else changed this piece. Reload to get the latest version.",
    );
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect((screen.getByLabelText("Content") as HTMLTextAreaElement).value).toBe("Hola");
  });

  it("URL fuera del Media Bank: mensaje propio", async () => {
    serve(() => {
      throw new ApiRequestError({
        code: "bad_request",
        status: 400,
        details: { invalidAssets: ["video"] },
      });
    });
    render(<ContentEditor contentId={ID} />, { wrapper });
    const user = await editTextTo("x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pick media from your Media Bank.",
    );
  });

  it("sin cambios, Save está deshabilitado y Done vuelve a la pieza", async () => {
    serve(() => content());
    render(<ContentEditor contentId={ID} />, { wrapper });
    const user = userEvent.setup();
    const save = await screen.findByRole("button", { name: "Save changes" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /Done Editing/ }));
    expect(push).toHaveBeenCalledWith(`/library/${ID}`);
  });
});

describe("ContentEditor · estados", () => {
  it("404: la pieza no existe o no es de esta marca", async () => {
    requestMock.mockRejectedValue(
      new ApiRequestError({ code: "not_found", status: 404 }),
    );
    render(<ContentEditor contentId={ID} />, { wrapper });
    expect(
      await screen.findByText("This piece doesn't exist or isn't in this brand."),
    ).toBeTruthy();
  });

  it("content_not_editable: lo dice en vez de mostrar un lienzo vacío", async () => {
    requestMock.mockImplementation(async (path, options = {}) => {
      if (path.endsWith("/editable")) {
        throw new ApiRequestError({ code: "content_not_editable", status: 422 });
      }
      return (options.schema?.parse(content()) ?? content()) as never;
    });
    render(<ContentEditor contentId={ID} />, { wrapper });
    expect(await screen.findByText("This piece can't be edited here.")).toBeTruthy();
  });
});
