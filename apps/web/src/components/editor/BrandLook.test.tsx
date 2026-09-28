/**
 * Sprint 9 (S), `PU-S9-003` — la marca en el editor clásico: las familias del
 * design system en el selector (con su licencia), el `PATCH` con `brand:<id>`,
 * la capa de logo por pieza y «Use for new pieces» por marca.
 *
 * Mismo corte que `ContentEditor.test.tsx`: `apiRequest` falso.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { libraryContentSchema } from "@/lib/library/content";
import { ContentEditor } from "./ContentEditor";
import { brandLookOf, EMPTY_BRAND_LOOK } from "./brandLook";
import { fontOptions } from "./TextInspector";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const ID = "11111111-1111-4111-8111-111111111111";
const DS = "22222222-2222-4222-8222-222222222222";

const content = () =>
  libraryContentSchema.parse({
    _id: ID,
    type: "wall-of-text",
    status: "CREATED",
    files: ["https://cdn.test/out.mp4"],
    revision: 3,
  });

const BOX = {
  id: "slide-0-text-0",
  slideIndex: 0,
  text: "Hola",
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "inter", weight: 600, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
};

const editable = (over: Record<string, unknown> = {}) => ({
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
  logo: null,
  logoAvailable: true,
  ...over,
});

const resolved = {
  kind: "registered",
  family: "inter",
  displayName: "Inter",
  weight: 400,
  mappedFrom: null,
  reason: null,
};

const family = (
  id: string,
  name: string,
  usable: boolean,
  license: "open" | "needs_confirmation",
) => ({
  id,
  name,
  origin: "file",
  category: "sans",
  license,
  licenseConfirmed: usable,
  weights: [300, 700, 800],
  faces: [
    { weight: 300, style: "normal", fileRef: `${id}-300` },
    { weight: 700, style: "normal", fileRef: `${id}-700` },
    { weight: 800, style: "normal", fileRef: `${id}-800` },
  ],
  fallback: "inter",
  fallbackName: "Inter",
  usable,
});

const DESIGN_SYSTEM = {
  id: DS,
  status: "ready",
  source: "zip",
  active: true,
  version: 1,
  name: "FOCUS",
  description: null,
  palette: [],
  semantic: {
    surfaceDark: "#0A0A0B",
    surfaceLight: "#F6F6F4",
    textOnDark: "#FFFFFF",
    textOnLight: "#0A0A0B",
    accents: [],
  },
  families: [
    family("rotis-semi-sans", "Rotis Semi Sans", true, "needs_confirmation"),
    family("rotis-sans-serif", "Rotis Sans Serif", false, "needs_confirmation"),
  ],
  roles: [],
  textDefaults: { title: resolved, body: resolved, color: null, backgroundColor: null },
  spacing: [],
  style: null,
  assets: [
    {
      mediaId: "m1",
      kind: "logo",
      url: "https://cdn.test/logo-light.png",
      filename: "a.png",
    },
  ],
  pendingAssets: [],
  warnings: [],
  failureCode: null,
  failureMessage: null,
  createdAt: 1,
  updatedAt: 1,
};

type Handler = (path: string, options: ApiRequestOptions<unknown>) => unknown;

function serve(opts: { editable?: unknown; onWrite?: Handler } = {}) {
  requestMock.mockImplementation(async (path, options = {}) => {
    const method = options.method ?? "GET";
    let raw: unknown;
    if (method !== "GET")
      raw = await opts.onWrite?.(path, options as ApiRequestOptions<unknown>);
    else if (path.endsWith("/editable")) raw = opts.editable ?? editable();
    else if (path === "/design-system") raw = { active: DESIGN_SYSTEM, latest: null };
    else if (path.includes("/font-files/"))
      raw = {
        fileRef: "x",
        contentType: "font/otf",
        dataUrl: "data:font/otf;base64,AA==",
      };
    else raw = content();
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

const patchBody = () =>
  requestMock.mock.calls.find(([, o]) => o?.method === "PATCH")?.[1]?.body as
    Record<string, unknown> | undefined;

beforeEach(() => {
  requestMock.mockReset();
});

describe("fontOptions", () => {
  const look = brandLookOf(DESIGN_SYSTEM as never);

  it("la marca primero, con su licencia; la que espera licencia, deshabilitada", () => {
    const options = fontOptions("inter", look);
    expect(options.slice(0, 2)).toEqual([
      {
        value: "brand:rotis-semi-sans",
        label: "Rotis Semi Sans · brand font (licensed)",
      },
      {
        value: "brand:rotis-sans-serif",
        label: "Rotis Sans Serif · confirm the license first",
        disabled: true,
      },
    ]);
    expect(options).toHaveLength(2 + 12);
  });

  it("una familia de marca que ya no está se conserva deshabilitada", () => {
    const options = fontOptions("brand:vieja", EMPTY_BRAND_LOOK);
    expect(options[0]).toEqual({
      value: "brand:vieja",
      label: "Brand font (no longer in your design system)",
      disabled: true,
    });
  });
});

describe("ContentEditor · la marca", () => {
  it("elegir la familia de marca manda brand:<id> con la cara más cercana", async () => {
    serve({ onWrite: () => ({ ...content(), status: "BUILDING", revision: 4 }) });
    render(<ContentEditor contentId={ID} />, { wrapper });
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("text-box-slide-0-text-0"));
    const select = await screen.findByLabelText("Font");
    await waitFor(() =>
      expect(
        within(select).getByText("Rotis Semi Sans · brand font (licensed)"),
      ).toBeTruthy(),
    );
    await user.selectOptions(select, "brand:rotis-semi-sans");
    expect(
      await screen.findByText("Your brand's own font. The video uses the same files."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    const boxes = patchBody()?.["textBoxes"] as { font: unknown }[];
    // 600 → la cara que existe más cerca: 700.
    expect(boxes[0]?.font).toEqual({
      family: "brand:rotis-semi-sans",
      weight: 700,
      size: 18,
    });
    expect(patchBody()).not.toHaveProperty("logo");
  });

  it("prender el logo lo dibuja en el lienzo y viaja en el PATCH", async () => {
    serve({ onWrite: () => ({ ...content(), status: "BUILDING", revision: 4 }) });
    render(<ContentEditor contentId={ID} />, { wrapper });
    const user = userEvent.setup();

    await user.click(await screen.findByLabelText("Show the brand logo"));
    const img = await screen.findByTestId("editor-logo");
    expect(img.getAttribute("src")).toBe("https://cdn.test/logo-light.png");
    await user.selectOptions(screen.getByLabelText("Corner"), "bottom-left");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody()?.["logo"]).toEqual({
      corner: "bottom-left",
      size: "small",
      opacity: 0.9,
    });
  });

  it("apagar un logo que la pieza tenía manda logo: null", async () => {
    serve({
      editable: editable({ logo: { corner: "top-right", size: "small", opacity: 0.9 } }),
      onWrite: () => ({ ...content(), status: "BUILDING", revision: 4 }),
    });
    render(<ContentEditor contentId={ID} />, { wrapper });
    const user = userEvent.setup();
    expect(await screen.findByTestId("editor-logo")).toBeTruthy();
    await user.click(screen.getByLabelText("Show the brand logo"));
    expect(screen.queryByTestId("editor-logo")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patchBody()).toBeDefined());
    expect(patchBody()?.["logo"]).toBeNull();
  });

  it("sin logo en el design system: lo dice y no ofrece el toggle", async () => {
    serve({ editable: editable({ logoAvailable: false }) });
    render(<ContentEditor contentId={ID} />, { wrapper });
    expect(
      await screen.findByText(
        "Your design system has no logo yet. Import one in Brand → Design system.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Show the brand logo")).toBeNull();
  });

  it("«Use for new pieces» guarda la preferencia de la marca", async () => {
    serve({
      onWrite: (path, options) =>
        path.endsWith("/logo-layer")
          ? { ...(options.body as object), available: true }
          : content(),
    });
    render(<ContentEditor contentId={ID} />, { wrapper });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Show the brand logo"));
    await user.click(await screen.findByRole("button", { name: "Use for new pieces" }));
    expect(
      await screen.findByText("New pieces of this brand will use this logo setting."),
    ).toBeTruthy();
    const put = requestMock.mock.calls.find(([, o]) => o?.method === "PUT");
    expect(put?.[0]).toBe(`/design-system/${DS}/logo-layer`);
    expect(put?.[1]?.body).toEqual({
      enabled: true,
      corner: "top-right",
      size: "small",
      opacity: 0.9,
    });
  });

  it("400 brand_font_unavailable: el aviso lo dice", async () => {
    const { ApiRequestError } = await import("@/lib/api/errors");
    serve({
      onWrite: () => {
        throw new ApiRequestError({
          code: "bad_request",
          status: 400,
          message: "x",
          details: {
            reason: "brand_font_unavailable",
            families: ["brand:rotis-semi-sans"],
          },
        } as never);
      },
    });
    render(<ContentEditor contentId={ID} />, { wrapper });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Show the brand logo"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(
        "This brand font isn't available: it's not in the active design system or its license isn't confirmed.",
      ),
    ).toBeTruthy();
  });
});
