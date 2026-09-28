/**
 * Biblioteca global de assets (sprint 9, N) contra un cliente de API falso.
 *
 * El corte del mock es `apiList` / `apiRequest` (igual que el Media Bank y los
 * modelos): queda bajo test lo de esta carpeta —hooks, pantallas y funciones
 * puras—, no el parser de `client.ts`.
 *
 * Los fixtures pasan por `libraryAssetSchema.parse`: un literal con un `as`
 * encima haría pasar un test sobre algo que el servidor nunca devolvería.
 */
import {
  libraryAssetSchema,
  librarySourceStatusListSchema,
  type LibraryAsset,
} from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiList: vi.fn(),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));
vi.mock("@/components/brands/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    active: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Acme" },
  }),
}));
// El keyer dibuja en un canvas por `requestAnimationFrame`: jsdom no tiene
// canvas 2D. Lo que se prueba acá es **que** se usa, no el recorte.
vi.mock("@/components/blitz/deck/ChromaKeyVideo", () => ({
  ChromaKeyVideo: ({ url }: { url: string }) => (
    <div data-testid="chroma-key" data-url={url} />
  ),
}));

import {
  apiList,
  apiRequest,
  type ApiRequestOptions,
  type CursorPage,
} from "@/lib/api/client";
import { ApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import {
  EMPTY_LICENSE_FORM,
  detailFormFrom,
  detailPatch,
  libraryListQuery,
  EMPTY_LIBRARY_FILTERS,
  licenseDeclarationFrom,
} from "./api";
import { AssetDetailDialog } from "./AssetDetailDialog";
import { GlobalLibraryPicker } from "./GlobalLibraryPicker";
import { GlobalLibraryScreen } from "./GlobalLibraryScreen";
import { ImportDialog } from "./ImportDialog";

const listMock = vi.mocked(apiList);
const requestMock = vi.mocked(apiRequest);

const ID_A = "0b7f3c1a-2c4e-4f5a-8b6d-9e0f1a2b3c4d";
const ID_B = "1c8a4d2b-3d5f-4a6b-9c7e-0f1a2b3c4d5e";
const NOW = "2026-09-28T12:00:00.000Z";

const CC_BY = {
  type: "cc-by",
  version: "4.0",
  attribution: "Jane Doe / Wikimedia Commons",
  author: "Jane Doe",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Facepalm.webm",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  verifiedAt: NOW,
};

function asset(
  over: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
): LibraryAsset {
  const kind = (over["kind"] as string | undefined) ?? "green_screen_video";
  const license = (over["license"] as Record<string, unknown> | undefined) ?? CC_BY;
  return libraryAssetSchema.parse({
    id: ID_A,
    title: "Facepalm",
    kind,
    mediaType: kind === "audio" ? "audio" : kind.endsWith("image") ? "image" : "video",
    status: "ready",
    url: "https://cdn.example.test/library/facepalm.mp4",
    previewUrl: "https://cdn.example.test/library/facepalm.jpg",
    contentType: "video/mp4",
    sizeMb: 3.2,
    durationSec: 4.2,
    width: 1080,
    height: 1920,
    license,
    metadataSource: "auto",
    provider: "wikimedia",
    externalId: "File:Facepalm.webm",
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
    metadata: {
      schemaVersion: 1,
      kind,
      description: "A man slowly facepalms.",
      memeType: "reaction",
      emotions: ["frustration"],
      useCases: ["when the client asks for changes"],
      characters: ["office worker"],
      tags: ["facepalm"],
      language: null,
      hasSpeech: false,
      durationSec: 4.2,
      aspect: { ratio: "9:16", width: 1080, height: 1920 },
      framing: "half_body",
      chroma: { type: "green", keyQuality: 0.93, keyColor: "#00FF00" },
      nsfw: false,
      energy: "medium",
      needsReview: false,
      license,
      ...meta,
    },
  });
}

function page(items: LibraryAsset[]): CursorPage<LibraryAsset> {
  return { items, cursor: null, hasMore: false };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  listMock.mockReset();
  requestMock.mockReset();
});

/**
 * Los que tipean en varios campos con `userEvent` tardan ~1,5 s solos, pero con
 * la suite entera en paralelo (`pnpm verify`) pasaron los 5 s por defecto.
 */
const TYPING_TIMEOUT_MS = 20_000;
describe("funciones puras", () => {
  it("el query del listado no manda lo vacío y junta listas en CSV", () => {
    expect(libraryListQuery(EMPTY_LIBRARY_FILTERS)).toEqual({});
    expect(
      libraryListQuery({
        ...EMPTY_LIBRARY_FILTERS,
        q: "  facepalm ",
        kinds: ["green_screen_video", "background_video"],
        maxDuration: 10,
        statuses: ["ready"],
      }),
    ).toEqual({
      q: "facepalm",
      kind: "green_screen_video,background_video",
      maxDuration: 10,
      status: "ready",
    });
  });

  it("CC BY sin atribución no es una declaración válida; con todo, sí", () => {
    const base = {
      ...EMPTY_LICENSE_FORM,
      type: "cc-by" as const,
      sourceUrl: "https://commons.wikimedia.org/wiki/File:X.webm",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    };
    const missing = licenseDeclarationFrom(base);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors).toEqual({ attribution: "required" });

    const full = licenseDeclarationFrom({ ...base, attribution: "Jane Doe" });
    expect(full).toEqual({
      ok: true,
      value: {
        type: "cc-by",
        attribution: "Jane Doe",
        sourceUrl: base.sourceUrl,
        licenseUrl: base.licenseUrl,
      },
    });
  });

  it("Pexels exige la página del archivo y la de la licencia; `own` no pide nada", () => {
    const pexels = licenseDeclarationFrom({ ...EMPTY_LICENSE_FORM, type: "pexels" });
    expect(pexels.ok).toBe(false);
    if (!pexels.ok) {
      expect(pexels.errors).toEqual({ sourceUrl: "required", licenseUrl: "required" });
    }
    expect(licenseDeclarationFrom({ ...EMPTY_LICENSE_FORM, type: "own" }).ok).toBe(true);
    expect(licenseDeclarationFrom(EMPTY_LICENSE_FORM)).toEqual({
      ok: false,
      errors: { type: "required" },
    });
  });

  it("el PATCH lleva sólo lo que cambió, y apagar el habla limpia el idioma", () => {
    const a = asset({}, { hasSpeech: true, language: "en" });
    const form = detailFormFrom(a);
    expect(detailPatch(a, form)).toEqual({});
    expect(detailPatch(a, { ...form, tags: ["facepalm", "office"] })).toEqual({
      tags: ["facepalm", "office"],
    });
    expect(detailPatch(a, { ...form, hasSpeech: false })).toEqual({
      hasSpeech: false,
      language: null,
    });
  });
});

describe("GlobalLibraryScreen — estados de la grilla", () => {
  it("loading: skeleton y aria-busy, sin vacío", () => {
    listMock.mockReturnValue(new Promise(() => undefined));
    const { container } = render(<GlobalLibraryScreen />, { wrapper });
    expect(container.querySelector(".fgw-media-skeleton")).not.toBeNull();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(tw("globalLibrary.empty.title"))).toBeNull();
  });

  it("vacío: lo dice y ofrece sumar assets", async () => {
    listMock.mockResolvedValue(page([]));
    render(<GlobalLibraryScreen />, { wrapper });
    expect(await screen.findByText(tw("globalLibrary.empty.title"))).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(
      "/library/assets",
      expect.objectContaining({ query: {}, limit: 40 }),
    );
  });

  it("error: reemplaza la grilla y no se confunde con el vacío", async () => {
    listMock.mockRejectedValue(new ApiRequestError({ code: "network_error", status: 0 }));
    render(<GlobalLibraryScreen />, { wrapper });
    expect(await screen.findByText(tw("error.network.title"))).toBeInTheDocument();
    expect(screen.queryByText(tw("globalLibrary.empty.title"))).toBeNull();
    expect(screen.queryAllByTestId("global-asset-card")).toHaveLength(0);
  });

  it("tarjeta: licencia CC BY con su atribución, croma sobre damero y estados", async () => {
    listMock.mockResolvedValue(
      page([
        asset(),
        asset(
          {
            id: ID_B,
            title: "Office",
            kind: "background_image",
            status: "processing",
            url: null,
            previewUrl: null,
            license: { type: "own", verifiedAt: NOW },
          },
          {
            chroma: { type: "none", keyQuality: null, keyColor: null },
            needsReview: true,
          },
        ),
      ]),
    );
    render(<GlobalLibraryScreen />, { wrapper });
    const cards = await screen.findAllByTestId("global-asset-card");
    expect(cards).toHaveLength(2);
    const [green, processing] = cards;
    if (green === undefined || processing === undefined)
      throw new Error("faltan tarjetas");

    expect(within(green).getByTestId("license-badge")).toHaveTextContent("CC BY 4.0");
    expect(within(green).getByTestId("license-attribution")).toHaveTextContent(
      "Credit: Jane Doe / Wikimedia Commons",
    );
    expect(within(green).getByTestId("chroma-key")).toBeInTheDocument();

    expect(within(processing).queryByTestId("license-attribution")).toBeNull();
    // «Processing» está dos veces: el badge y el nombre del spinner de la preview.
    expect(
      within(processing)
        .getAllByText(tw("globalLibrary.status.processing"))
        .some((el) => el.classList.contains("fg-badge")),
    ).toBe(true);
    expect(
      within(processing).getByText(tw("globalLibrary.needsReview")),
    ).toBeInTheDocument();
    // Sin `ready` no se puede copiar a la marca.
    expect(
      within(processing).getByRole("button", { name: "Use Office in the active brand" }),
    ).toBeDisabled();
  });
});

describe("ImportDialog", () => {
  it(
    "la subida rechaza CC BY sin atribución y no reserva nada",
    async () => {
      const user = userEvent.setup();
      render(<ImportDialog open onClose={() => undefined} />, { wrapper });

      const file = new File([new Uint8Array(1024)], "facepalm.mp4", {
        type: "video/mp4",
      });
      await user.upload(
        screen.getByLabelText(tw("globalLibrary.upload.file.label")),
        file,
      );
      await user.selectOptions(
        screen.getByLabelText(/^License type/),
        tw("globalLibrary.license.cc-by"),
      );
      await user.type(
        screen.getByLabelText(/^Source page/),
        "https://commons.wikimedia.org/wiki/File:Facepalm.webm",
      );
      await user.type(
        screen.getByLabelText(/^License page/),
        "https://creativecommons.org/licenses/by/4.0/",
      );
      await user.click(
        screen.getByRole("button", { name: tw("globalLibrary.upload.submit") }),
      );

      expect(
        await screen.findByText("Attribution is required for this license."),
      ).toBeInTheDocument();
      expect(requestMock).not.toHaveBeenCalled();
    },
    TYPING_TIMEOUT_MS,
  );

  it("una fuente sin key se ve deshabilitada, con el motivo y el campo para pegarla", async () => {
    const user = userEvent.setup();
    requestMock.mockImplementation(
      (path: string, options: ApiRequestOptions<unknown> = {}) => {
        if (path === "/library/sources") {
          const data = [
            {
              id: "wikimedia",
              label: "Wikimedia Commons",
              licenseUrl: "https://commons.wikimedia.org/wiki/Commons:Licensing",
              needsKey: false,
              enabled: true,
              disabledReason: null,
              keyFrom: null,
            },
            {
              id: "pexels",
              label: "Pexels",
              licenseUrl: "https://www.pexels.com/license/",
              needsKey: true,
              enabled: false,
              disabledReason: "missing_key",
              keyFrom: null,
            },
          ];
          return Promise.resolve(
            options.schema === undefined
              ? data
              : librarySourceStatusListSchema.parse(data),
          );
        }
        return Promise.reject(new Error(`sin doble para ${path}`));
      },
    );
    render(<ImportDialog open onClose={() => undefined} />, { wrapper });
    // Las fuentes no se piden hasta abrir su pestaña.
    expect(requestMock).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("tab", { name: tw("globalLibrary.import.tab.sources") }),
    );

    const pexels = await screen.findByTestId("source-pexels");
    expect(
      within(pexels).getByText("Pexels needs an API key before you can search it."),
    ).toBeInTheDocument();
    expect(within(pexels).getByRole("button", { name: "Pexels" })).toBeDisabled();
    const keyInput = within(pexels).getByLabelText("Pexels API key");
    expect(keyInput).toHaveAttribute("type", "password");
    expect(
      within(screen.getByTestId("source-wikimedia")).getByRole("button", {
        name: "Wikimedia Commons",
      }),
    ).toBeEnabled();
  });
});

describe("AssetDetailDialog", () => {
  it(
    "el formulario manda un PATCH con sólo lo editado",
    async () => {
      const user = userEvent.setup();
      const calls: { path: string; options: ApiRequestOptions<unknown> }[] = [];
      requestMock.mockImplementation(
        (path: string, options: ApiRequestOptions<unknown> = {}) => {
          calls.push({ path, options });
          if (path === `/library/assets/${ID_A}` && options.method === "PATCH") {
            const body = options.body as { description: string };
            return Promise.resolve(
              asset({ metadataSource: "edited" }, { description: body.description }),
            );
          }
          if (path === `/library/assets/${ID_A}`) return Promise.resolve(asset());
          return Promise.reject(new Error(`sin doble para ${path}`));
        },
      );
      render(<AssetDetailDialog assetId={ID_A} onClose={() => undefined} />, { wrapper });

      const description = await screen.findByLabelText(
        tw("globalLibrary.detail.description"),
      );
      // Lo medido y la licencia están, en sólo lectura.
      expect(screen.getByTestId("measured-block")).toHaveTextContent("93%");
      expect(screen.getByTestId("measured-block")).toHaveTextContent("#00FF00");
      expect(screen.getByTestId("license-block")).toHaveTextContent(
        "Jane Doe / Wikimedia Commons",
      );

      const save = screen.getByRole("button", { name: tw("globalLibrary.detail.save") });
      expect(save).toBeDisabled();
      await user.clear(description);
      await user.type(description, "A man facepalms in slow motion.");
      await user.click(save);

      await waitFor(() => {
        expect(calls.some((c) => c.options.method === "PATCH")).toBe(true);
      });
      const patch = calls.find((c) => c.options.method === "PATCH");
      expect(patch?.path).toBe(`/library/assets/${ID_A}`);
      expect(patch?.options.body).toEqual({
        description: "A man facepalms in slow motion.",
      });
      expect(
        await screen.findByText(tw("globalLibrary.detail.saved")),
      ).toBeInTheDocument();
    },
    TYPING_TIMEOUT_MS,
  );
});

describe("GlobalLibraryPicker", () => {
  it("pide sólo lo listo de los tipos pedidos, filtra lo que sobre y entrega lo elegido", async () => {
    const user = userEvent.setup();
    const green = asset();
    const background = asset(
      { id: ID_B, title: "Beach", kind: "background_video" },
      { chroma: { type: "none", keyQuality: null, keyColor: null } },
    );
    // El servidor devuelve de más: el picker igual entrega sólo lo pedido.
    listMock.mockResolvedValue(page([green, background]));
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <GlobalLibraryPicker
        open
        onOpenChange={onOpenChange}
        kinds={["green_screen_video"]}
        onPick={onPick}
      />,
      { wrapper },
    );

    const items = await screen.findAllByTestId("picker-item");
    expect(items).toHaveLength(1);
    expect(screen.queryByText("Beach")).toBeNull();
    expect(listMock).toHaveBeenCalledWith(
      "/library/assets",
      expect.objectContaining({
        query: { kind: "green_screen_video", status: "ready" },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Use Facepalm" }));
    expect(onPick).toHaveBeenCalledWith(green);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("cerrado no pide nada", () => {
    render(
      <GlobalLibraryPicker
        open={false}
        onOpenChange={() => undefined}
        onPick={() => undefined}
      />,
      { wrapper },
    );
    expect(listMock).not.toHaveBeenCalled();
  });
});
