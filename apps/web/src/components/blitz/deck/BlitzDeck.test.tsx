/**
 * `/blitz` · el deck, sus tres formas de decidir y sus estados (FR-050,
 * `PU-BLITZ-001/002`).
 *
 * ## Qué se mockea
 *
 * El corte está en el cliente tipado (`apiRequest`/`apiSend`), igual que en
 * `MyContentTab.test.tsx`: lo que queda bajo test es el deck —qué dibuja, qué
 * pide y con qué cuerpo— y no el parser de sobres, que tiene sus tests.
 *
 * Las animaciones van apagadas (`MotionGlobalConfig.skipAnimations`): jsdom no
 * pinta, y una salida con resorte deja la tarjeta vieja en el DOM unos cientos
 * de ms, que es tiempo de test tirado sin nada que afirmar.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@fastgram/ui";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionGlobalConfig } from "motion/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { contentSchema, type Content } from "@fastgram/contracts";
import { ApiRequestError } from "@/lib/api/errors";
import { deckSuggestionSchema, type DeckSuggestion } from "@/lib/blitz/deck/suggestion";
import { BlitzDeck, SETTINGS_MODELS_HREF } from "./BlitzDeck";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

import { apiRequest, apiSend, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);

const CONTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * El chip de tipo de la tarjeta, no la opción homónima del selector de formato
 * de «Create from prompt» (`PU-BLITZ-003`), que está en la pantalla desde el
 * primer render: sin esto, esperar «Wall of Text» resolvía antes de que
 * cargara la cola.
 */
const CHIP_ONLY = { ignore: "option, script, style" } as const;

function suggestion(overrides: Readonly<Record<string, unknown>> = {}): DeckSuggestion {
  return deckSuggestionSchema.parse({
    id: "s1",
    contentType: "wall-of-text",
    generatedText: "Stop scrolling: this changes everything",
    aiExplanation:
      "- Curiosity hook drives watch time\n- Informal tone builds shareability",
    influencer: { id: "i1", name: "Ella" },
    angle: { id: "a1", title: "One Idea, Everywhere" },
    ...overrides,
  });
}

const S1 = suggestion();
const S2 = suggestion({
  id: "s2",
  contentType: "slideshow",
  influencer: null,
  angle: null,
  generatedText: "Second card",
  preview: {
    slides: [{ text: "Slide one" }, { text: "Slide two" }],
    audioUrl: "https://cdn.example.test/track.mp3",
  },
  remixSource: { url: "https://tiktok.example.test/v/1", likes: 106800, views: 1300000 },
});

function built(status: Content["status"]): Content {
  return contentSchema.parse({
    _id: CONTENT_ID,
    type: "wall-of-text",
    status,
    files: status === "CREATED" ? ["https://cdn.example.test/out.mp4"] : [],
    revision: 1,
  });
}

function apiError(status: number, code: string): ApiRequestError {
  return new ApiRequestError({ code: code as ApiRequestError["code"], status });
}

interface Backend {
  queue: () => Promise<unknown>;
  accept: (options: ApiRequestOptions<unknown>) => Promise<unknown>;
  contentItem: () => Promise<unknown>;
}

function installBackend(backend: Partial<Backend>): void {
  const full: Backend = {
    queue: () => Promise.resolve([S1, S2]),
    accept: () => Promise.resolve(built("BUILDING")),
    contentItem: () => Promise.resolve(built("BUILDING")),
    ...backend,
  };
  requestMock.mockImplementation(((
    path: string,
    options: ApiRequestOptions<unknown> = {},
  ) => {
    if (path === "/blitz/queue") return full.queue();
    if (path === "/blitz" && options.method === "POST") return full.accept(options);
    if (path.startsWith("/content/")) return full.contentItem();
    return Promise.reject(new Error(`ruta no esperada en el test: ${path}`));
  }) as typeof apiRequest);
  sendMock.mockResolvedValue(undefined);
}

function renderDeck() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return { user: userEvent.setup(), ...render(<BlitzDeck />, { wrapper }) };
}

/** El nombre accesible de la tarjeta de arriba, o `null` si no hay. */
function topCardLabel(): string | null {
  const cards = screen.queryAllByTestId("deck-top-card");
  const last = cards[cards.length - 1];
  return last?.getAttribute("aria-label") ?? null;
}

function acceptCalls() {
  return requestMock.mock.calls.filter(
    ([path, options]) => path === "/blitz" && options?.method === "POST",
  );
}

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
  // jsdom no implementa la reproducción de media.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  requestMock.mockReset();
  sendMock.mockReset();
  push.mockReset();
});

describe("BlitzDeck · carga y tarjeta", () => {
  it("muestra el skeleton mientras carga y después la primera sugerencia con sus chips", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    installBackend({ queue: () => new Promise((r) => (resolve = r)) });
    renderDeck();

    expect(screen.getByTestId("deck-loading")).toBeInTheDocument();

    await act(async () => {
      resolve([S1, S2]);
      await Promise.resolve();
    });

    expect(await screen.findByText("Wall of Text", CHIP_ONLY)).toBeInTheDocument();
    expect(screen.queryByTestId("deck-loading")).not.toBeInTheDocument();
    expect(topCardLabel()).toBe("Wall of Text suggestion");
    expect(screen.getByText("👤 Ella")).toBeInTheDocument();
    expect(screen.getByText("One Idea, Everywhere")).toBeInTheDocument();
    expect(screen.getByText(/2 in queue/)).toBeInTheDocument();
  });

  it("Why This Content? muestra el racional almacenado en bullets", async () => {
    installBackend({});
    const { user } = renderDeck();

    const toggle = await screen.findByRole("button", { name: "Why This Content?" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    const panel = screen.getByRole("region", { name: "Why This Content" });
    expect(
      within(panel).getByText("Curiosity hook drives watch time"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("Informal tone builds shareability"),
    ).toBeInTheDocument();
  });

  it("Remixed From y mute sólo aparecen cuando la sugerencia los trae", async () => {
    installBackend({ queue: () => Promise.resolve([S2, S1]) });
    const { user } = renderDeck();

    const remix = await screen.findByRole("region", { name: "Remixed From" });
    expect(within(remix).getByText("106.8K")).toBeInTheDocument();
    expect(within(remix).getByText("1.3M")).toBeInTheDocument();

    const unmute = screen.getByRole("button", { name: "Unmute" });
    expect(unmute).toHaveAttribute("aria-pressed", "false");
    await user.click(unmute);
    expect(screen.getByRole("button", { name: "Mute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Slideshow: flechas y posición.
    expect(screen.getByRole("status", { name: "Slide 1 of 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    expect(screen.getByRole("status", { name: "Slide 2 of 2" })).toBeInTheDocument();
    expect(screen.getByText("Slide two")).toBeInTheDocument();
  });

  it("sin remix ni audio, no hay panel ni botón de mute", async () => {
    installBackend({});
    renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);
    expect(
      screen.queryByRole("region", { name: "Remixed From" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unmute" })).not.toBeInTheDocument();
  });
});

describe("BlitzDeck · teclado (F-052)", () => {
  it("← descarta la de arriba y pasa a la siguiente", async () => {
    installBackend({});
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.keyboard("{ArrowLeft}");

    expect(sendMock).toHaveBeenCalledWith("/blitz/queue/s1/discard", { method: "POST" });
    await waitFor(() => {
      expect(topCardLabel()).toBe("Slideshow suggestion");
    });
    expect(acceptCalls()).toHaveLength(0);
  });

  it("→ abre `What would you like to do?` y no cobra nada hasta elegir", async () => {
    installBackend({});
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.keyboard("{ArrowRight}");

    const dialog = await screen.findByRole("dialog", {
      name: "What would you like to do?",
    });
    expect(within(dialog).getByText("Step 1 of 3")).toBeInTheDocument();
    expect(acceptCalls()).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(acceptCalls()).toHaveLength(0);
    expect(topCardLabel()).toBe("Wall of Text suggestion");
  });

  it("con modificadores o escribiendo en un campo, las flechas no deciden", async () => {
    installBackend({});
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    await user.keyboard("{Meta>}{ArrowRight}{/Meta}");

    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("BlitzDeck · botones", () => {
  it("✕ descarta igual que ←", async () => {
    installBackend({});
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(sendMock).toHaveBeenCalledWith("/blitz/queue/s1/discard", { method: "POST" });
    await waitFor(() => {
      expect(topCardLabel()).toBe("Slideshow suggestion");
    });
  });

  it("si descartar falla, la tarjeta vuelve y se avisa", async () => {
    installBackend({});
    sendMock.mockRejectedValue(apiError(500, "service_unavailable"));
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(await screen.findByText(/Couldn't skip that suggestion/)).toBeInTheDocument();
    expect(topCardLabel()).toBe("Wall of Text suggestion");
  });

  it("Edit y Schedule Post se ven pero están deshabilitados (sprint 2)", async () => {
    installBackend({});
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    expect(screen.getByRole("button", { name: "Edit" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Accept" }));
    const dialog = await screen.findByRole("dialog");
    const schedule = within(dialog).getByRole("button", { name: /Schedule Post/ });
    expect(schedule).toHaveAttribute("aria-disabled", "true");
    await user.click(schedule);
    expect(acceptCalls()).toHaveLength(0);
  });
});

describe("BlitzDeck · aceptar → pieza construida (PU-BLITZ-002)", () => {
  it("Save to Library hace POST /blitz con la tarjeta vista, avisa y sigue el build hasta CREATED", async () => {
    let buildStatus: Content["status"] = "BUILDING";
    installBackend({ contentItem: () => Promise.resolve(built(buildStatus)) });
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.click(screen.getByRole("button", { name: "Accept" }));
    const dialog = await screen.findByRole("dialog");
    buildStatus = "CREATED";
    await user.click(within(dialog).getByRole("button", { name: /Save to Library/ }));

    const calls = acceptCalls();
    expect(calls).toHaveLength(1);
    const options = calls[0]?.[1];
    expect(options?.body).toEqual({ suggestionId: "s1" });
    expect(typeof options?.idempotencyKey).toBe("string");
    expect(options?.idempotencyKey).not.toBe("");

    expect(await screen.findByText("Content saved!")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(topCardLabel()).toBe("Slideshow suggestion");
    });

    // El tracker ve la pieza y, al volver a preguntar, que ya está construida.
    const tray = screen.getByRole("region", { name: "Recent builds" });
    await waitFor(() => {
      expect(within(tray).getByTestId("build-row")).toHaveAttribute(
        "data-status",
        "CREATED",
      );
    });
    expect(within(tray).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/library/${CONTENT_ID}`,
    );

    // El toast lleva a la Library.
    await user.click(screen.getByRole("button", { name: "View in Library" }));
    expect(push).toHaveBeenCalledWith("/library");
  });

  it("un fallo que no es de cola queda en el diálogo y el reintento reusa la Idempotency-Key", async () => {
    let attempts = 0;
    installBackend({
      accept: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(apiError(503, "service_unavailable"))
          : Promise.resolve(built("BUILDING"));
      },
    });
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.keyboard("{ArrowRight}");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Save to Library/ }));

    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Save to Library/ }));
    expect(await screen.findByText("Content saved!")).toBeInTheDocument();

    const keys = acceptCalls().map(([, options]) => options?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("422 content_unavailable_for_type saca la tarjeta sin cobrar y avisa", async () => {
    installBackend({
      accept: () => Promise.reject(apiError(422, "content_unavailable_for_type")),
    });
    const { user } = renderDeck();
    await screen.findByText("Wall of Text", CHIP_ONLY);

    await user.keyboard("{ArrowRight}");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /Save to Library/,
      }),
    );

    expect(await screen.findByText(/can't be built anymore/)).toBeInTheDocument();
    await waitFor(() => {
      expect(topCardLabel()).toBe("Slideshow suggestion");
    });
    expect(
      screen.queryByRole("region", { name: "Recent builds" }),
    ).not.toBeInTheDocument();
  });
});

describe("BlitzDeck · estados (P2-BLITZ-013)", () => {
  it("cola vacía: estado de espera con el aviso del LLM, sin cuota", async () => {
    installBackend({ queue: () => Promise.resolve([]) });
    renderDeck();

    expect(await screen.findByText("Your queue is being generated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Check AI models" })).toHaveAttribute(
      "href",
      SETTINGS_MODELS_HREF,
    );
    expect(screen.queryByText(/quota/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("deck-top-card")).not.toBeInTheDocument();
  });

  it("un fallo de red es un error, no una cola vacía", async () => {
    installBackend({ queue: () => Promise.reject(apiError(0, "network_error")) });
    renderDeck();

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Your queue is being generated")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deck-top-card")).not.toBeInTheDocument();
  });

  it("perfil de marca no listo: lleva a Brand", async () => {
    installBackend({
      queue: () => Promise.reject(apiError(409, "company_profile_not_ready")),
    });
    renderDeck();

    expect(
      await screen.findByText("Your brand profile isn't ready yet"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Brand" })).toHaveAttribute(
      "href",
      "/brand",
    );
  });
});

describe("BlitzDeck · modo blind (sin GET /blitz/queue)", () => {
  const missingRoute = () => Promise.reject(apiError(404, "not_found"));

  it("muestra la siguiente de la cola, no ofrece descartar y acepta con POST /blitz sin cuerpo", async () => {
    installBackend({ queue: missingRoute });
    const { user } = renderDeck();

    expect(
      await screen.findByText("Next suggestion", { selector: "p" }),
    ).toBeInTheDocument();
    const skip = screen.getByRole("button", { name: "Skip" });
    expect(skip).toHaveAttribute("aria-disabled", "true");

    await user.click(skip);
    await user.keyboard("{ArrowLeft}");
    expect(sendMock).not.toHaveBeenCalled();

    await user.keyboard("{ArrowRight}");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /Save to Library/,
      }),
    );

    const calls = acceptCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.body).toEqual({});
    expect(await screen.findByText("Content saved!")).toBeInTheDocument();
    // Sigue habiendo una tarjeta: la próxima de la cola.
    await waitFor(() => {
      expect(topCardLabel()).toBe("Next suggestion");
    });
  });

  it("POST /blitz con cola vacía → estado de espera con reintento manual (nunca automático)", async () => {
    installBackend({
      queue: missingRoute,
      accept: () => Promise.reject(apiError(404, "not_found")),
    });
    const { user } = renderDeck();

    await screen.findByText("Next suggestion", { selector: "p" });
    await user.keyboard("{ArrowRight}");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /Save to Library/,
      }),
    );

    expect(await screen.findByText("Your queue is being generated")).toBeInTheDocument();
    expect(acceptCalls()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Next suggestion", { selector: "p" }),
    ).toBeInTheDocument();
    // Reintentar vuelve a mostrar la tarjeta; aceptar sigue siendo decisión del usuario.
    expect(acceptCalls()).toHaveLength(1);
  });
});
