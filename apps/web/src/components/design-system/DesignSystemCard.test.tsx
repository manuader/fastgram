/**
 * La tarjeta del design system (sprint 9, M) contra un `apiRequest` falso:
 * cargando, error, vacío (derivar), importando, import fallido, y listo
 * (paleta, licencia de la fuente, pendientes).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
  apiSend: vi.fn(),
}));

import { ApiRequestError } from "@/lib/api/errors";
import { apiRequest, apiSend, type ApiRequestOptions } from "@/lib/api/client";
import { DesignSystemCard } from "./DesignSystemCard";
import { zipRejection } from "./api";

const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);

const ID = "11111111-1111-4111-8111-111111111111";

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function answer(options: ApiRequestOptions<unknown> | undefined, value: unknown) {
  return Promise.resolve(
    options?.schema === undefined ? value : options.schema.parse(value),
  );
}

const resolved = (
  family: string,
  displayName: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "registered",
  family,
  displayName,
  weight: 400,
  mappedFrom: null,
  reason: null,
  ...extra,
});

function ds(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: "ready",
    source: "zip",
    active: true,
    version: 1,
    name: "FOCUS — Design System",
    description: null,
    palette: [
      { name: "--focus-ink", hex: "#0A0A0B", aliasOf: null },
      { name: "--focus-magenta", hex: "#FF00FF", aliasOf: null },
      { name: "--surface-dark", hex: "#0A0A0B", aliasOf: "--focus-ink" },
    ],
    semantic: {
      surfaceDark: "#0A0A0B",
      surfaceLight: null,
      textOnDark: "#FFFFFF",
      textOnLight: null,
      accents: ["#FF00FF"],
    },
    families: [
      {
        id: "rotis-semi-sans",
        name: "Rotis Semi Sans",
        origin: "file",
        category: "sans",
        license: "needs_confirmation",
        licenseConfirmed: false,
        weights: [300, 700],
        faces: [{ weight: 700, style: "normal", fileRef: "rotis-semi-sans-700" }],
        fallback: "inter",
        fallbackName: "Inter",
        usable: false,
      },
    ],
    roles: [
      {
        role: "body",
        stack: ["Rotis Semi Sans", "sans-serif"],
        familyId: "rotis-semi-sans",
      },
    ],
    textDefaults: {
      title: resolved("playfair", "Playfair Display"),
      body: resolved("inter", "Inter", {
        mappedFrom: "Rotis Semi Sans",
        reason: "license_not_confirmed",
      }),
      color: "#FFFFFF",
      backgroundColor: "#0A0A0B",
    },
    spacing: [],
    style: {
      voice: "Short, declarative lines.",
      values: ["Libertad"],
      tagline: "El punto donde todo cambia.",
      compositionRules: ["One sharp point, off-center."],
      dos: [],
      donts: ["No emoji."],
      language: "es-AR",
      origin: "model",
    },
    assets: [
      {
        mediaId: "m1",
        kind: "logo",
        url: "http://storage.test/logo.png",
        filename: "logo.png",
      },
    ],
    pendingAssets: [
      {
        id: "abcd-1",
        url: "http://storage.test/g1.jpg",
        generator: "local",
        createdAt: 1,
      },
    ],
    warnings: [],
    failureCode: null,
    failureMessage: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DesignSystemCard", () => {
  it("vacío: invita a subir el zip o derivar, y derivar llama a la API", async () => {
    requestMock.mockImplementation((path, options) => {
      if (path === "/design-system")
        return answer(options, { active: null, latest: null });
      if (path === "/design-system/derive")
        return answer(options, ds({ source: "derived" }));
      throw new Error(`inesperado ${path}`);
    });
    wrap(<DesignSystemCard />);
    expect(screen.getByTestId("ds-loading")).toBeTruthy();
    await screen.findByTestId("ds-empty");
    expect(screen.getByTestId("ds-dropzone")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Derive from brand analysis" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/design-system/derive",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("error de la API: estado de error con reintento", async () => {
    requestMock.mockRejectedValue(
      new ApiRequestError({
        status: 503,
        code: "service_unavailable",
        serverMessage: "down",
      }),
    );
    wrap(<DesignSystemCard />);
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeTruthy();
  });

  it("importando: avisa que está procesando", async () => {
    requestMock.mockImplementation((_path, options) =>
      answer(options, {
        active: null,
        latest: ds({ status: "importing", active: false }),
      }),
    );
    wrap(<DesignSystemCard />);
    expect(await screen.findByText(/Importing: reading tokens/)).toBeTruthy();
  });

  it("import fallido: el motivo por su código estable", async () => {
    requestMock.mockImplementation((_path, options) =>
      answer(options, {
        active: null,
        latest: ds({ status: "failed", active: false, failureCode: "zip_bomb" }),
      }),
    );
    wrap(<DesignSystemCard />);
    expect(await screen.findByText(/unpacks to far more than its size/)).toBeTruthy();
  });

  it("listo: paleta, reemplazo sin licencia, tildar la licencia y aprobar un pendiente", async () => {
    requestMock.mockImplementation((path, options) => {
      if (path === "/design-system")
        return answer(options, { active: ds(), latest: null });
      if (path === `/design-system/${ID}` && options?.method === "PATCH")
        return answer(options, ds());
      if (path === `/design-system/${ID}/font-files/rotis-semi-sans-700`) {
        return answer(options, {
          fileRef: "rotis-semi-sans-700",
          contentType: "font/otf",
          dataUrl: "data:font/otf;base64,T1RUTw==",
        });
      }
      if (path === `/design-system/${ID}/pending/abcd-1/approve`)
        return answer(options, { mediaId: "m9" });
      throw new Error(`inesperado ${path}`);
    });
    wrap(<DesignSystemCard />);
    await screen.findByTestId("ds-active");
    // Los alias no se repiten como swatch.
    expect(screen.getAllByText("#0A0A0B").length).toBeGreaterThan(0);
    expect(screen.getByText("focus-magenta")).toBeTruthy();
    expect(
      screen.getByText(/titles and hooks in Playfair Display, the rest in Inter/),
    ).toBeTruthy();
    expect(screen.getByText(/Renders as Inter/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("I have a license to use this font"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        `/design-system/${ID}`,
        expect.objectContaining({
          method: "PATCH",
          body: { fontLicenses: { "rotis-semi-sans": true } },
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        `/design-system/${ID}/pending/abcd-1/approve`,
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("un archivo que no es .zip no se sube", async () => {
    requestMock.mockImplementation((_path, options) =>
      answer(options, { active: null, latest: null }),
    );
    wrap(<DesignSystemCard />);
    await screen.findByTestId("ds-empty");
    const input = screen.getByLabelText("Choose a .zip");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "focus.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByText("That file is not a .zip.")).toBeTruthy();
    expect(requestMock).not.toHaveBeenCalledWith(
      "/design-system/upload-url",
      expect.anything(),
    );
    expect(zipRejection({ name: "a.zip", size: 101 * 1024 * 1024 })).toBe("too_large");
    expect(zipRejection({ name: "a.zip", size: 0 })).toBe("empty");
  });
});
