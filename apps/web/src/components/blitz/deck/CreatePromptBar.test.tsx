/**
 * «Create from prompt» arriba del deck · `PU-BLITZ-003`, `EXT-009`.
 *
 * Mismo corte que `BlitzDeck.test.tsx`: se mockea el cliente tipado
 * (`apiRequest`) y se renderiza **el deck entero**, porque lo que importa es el
 * circuito — pedir, esperar, y ver las tarjetas nuevas arriba con su chip — y
 * no la barra sola.
 *
 * El polling se mueve con timers falsos que igual avanzan solos
 * (`shouldAdvanceTime`), para que `userEvent` y React Query sigan andando.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@fastgram/ui";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionGlobalConfig } from "motion/react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { deckSuggestionSchema, type DeckSuggestion } from "@/lib/blitz/deck/suggestion";
import { PROMPT_POLL_MS } from "@/lib/blitz/deck/prompt";
import { BlitzDeck } from "./BlitzDeck";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiSend: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

import { apiRequest, apiSend, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const sendMock = vi.mocked(apiSend);

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const card = (over: Readonly<Record<string, unknown>>): DeckSuggestion =>
  deckSuggestionSchema.parse({
    id: "s1",
    contentType: "wall-of-text",
    generatedText: "Regular card",
    ...over,
  });

const REGULAR = card({ id: "r1" });
const FROM_PROMPT = card({
  id: "p1",
  contentType: "green-screen",
  generatedText: "Mondays, but with coffee",
  promptRequestId: REQUEST_ID,
});

interface Backend {
  queue: () => unknown;
  generate: (options: ApiRequestOptions<unknown>) => Promise<unknown>;
  status: () => unknown;
}

function installBackend(backend: Partial<Backend>): void {
  const full: Backend = {
    queue: () => [REGULAR],
    generate: () => Promise.resolve({ requestId: REQUEST_ID }),
    status: () => ({
      requestId: REQUEST_ID,
      status: "running",
      suggestionIds: [],
      count: 1,
    }),
    ...backend,
  };
  requestMock.mockImplementation(((
    path: string,
    options: ApiRequestOptions<unknown> = {},
  ) => {
    if (path === "/blitz/queue") return Promise.resolve(full.queue());
    if (path === "/blitz/generate" && options.method === "POST")
      return full.generate(options);
    if (path === `/blitz/generate/${REQUEST_ID}`) return Promise.resolve(full.status());
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
  return {
    user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) }),
    ...render(<BlitzDeck />, { wrapper }),
  };
}

const callsTo = (path: string) => requestMock.mock.calls.filter(([p]) => p === path);

function topCardLabel(): string | null {
  const cards = screen.queryAllByTestId("deck-top-card");
  return cards[cards.length - 1]?.getAttribute("aria-label") ?? null;
}

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  requestMock.mockReset();
  sendMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function type(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(
    screen.getByRole("textbox", { name: "What should it be about?" }),
    text,
  );
}

describe("Create from prompt · la barra", () => {
  it("se dibuja arriba del deck con tema, formato, cantidad y botón", async () => {
    installBackend({});
    renderDeck();
    const bar = await screen.findByTestId("create-prompt-bar");
    expect(
      within(bar).getByRole("heading", { name: "Create from prompt" }),
    ).toBeInTheDocument();
    expect(
      within(bar).getByRole("textbox", { name: "What should it be about?" }),
    ).toBeInTheDocument();
    const format = within(bar).getByRole("combobox", { name: "Format" });
    expect(
      within(format)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Any format (your mix)",
      "Slideshow",
      "Wall of Text",
      "Green Screen",
      "Video Hook",
      // Sprint 9 (P): el reel entra al selector, fuera de Blitz.
      "Reel (HyperFrames)",
    ]);
    const count = within(bar).getByRole("combobox", { name: "How many" });
    expect(within(count).getAllByRole("option")).toHaveLength(5);
    expect(within(bar).getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("un tema de menos de 3 caracteres no se manda: se explica al lado", async () => {
    installBackend({});
    const { user } = renderDeck();
    await screen.findByTestId("create-prompt-bar");
    await type(user, " ab ");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText("Write at least 3 characters.")).toBeInTheDocument();
    expect(callsTo("/blitz/generate")).toHaveLength(0);
  });

  it("escribir en el tema no dispara las flechas del deck", async () => {
    installBackend({});
    const { user } = renderDeck();
    await screen.findByText("Regular card");
    await type(user, "lunes{ArrowLeft}{ArrowRight}");
    expect(sendMock).not.toHaveBeenCalled();
    expect(topCardLabel()).toBe("Wall of Text suggestion");
  });
});

describe("Create from prompt · pedir, esperar y ver las nuevas arriba", () => {
  it("manda tema, formato y cantidad con Idempotency-Key, hace polling y al terminar refresca la cola", async () => {
    let status: "running" | "done" = "running";
    let queue: DeckSuggestion[] = [REGULAR];
    installBackend({
      queue: () => queue,
      status: () => ({
        requestId: REQUEST_ID,
        status,
        suggestionIds: status === "done" ? ["p1"] : [],
        count: 1,
      }),
    });
    const { user } = renderDeck();
    await screen.findByText("Regular card");

    await type(user, "  a meme about Mondays for my coffee shop  ");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Format" }),
      "green-screen",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    const post = callsTo("/blitz/generate")[0];
    expect(post?.[1]).toMatchObject({
      method: "POST",
      body: {
        prompt: "a meme about Mondays for my coffee shop",
        contentType: "green-screen",
        count: 1,
      },
    });
    expect(typeof post?.[1]?.idempotencyKey).toBe("string");

    // Mientras corre: progreso, y el botón no deja pedir dos veces.
    expect(await screen.findByTestId("prompt-progress")).toHaveTextContent(
      "Creating a piece from your prompt…",
    );
    const statusCallsBefore = callsTo(`/blitz/generate/${REQUEST_ID}`).length;
    expect(statusCallsBefore).toBeGreaterThanOrEqual(1);

    // El worker termina: la próxima pregunta ve `done` y la cola trae la nueva arriba.
    status = "done";
    queue = [FROM_PROMPT, REGULAR];
    const queueCallsBefore = callsTo("/blitz/queue").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROMPT_POLL_MS);
    });

    expect(
      await screen.findByText("Your new piece is at the top of your deck."),
    ).toBeInTheDocument();
    expect(callsTo(`/blitz/generate/${REQUEST_ID}`).length).toBeGreaterThan(
      statusCallsBefore,
    );
    expect(callsTo("/blitz/queue").length).toBeGreaterThan(queueCallsBefore);

    // Arriba, con el chip.
    expect(await screen.findByText("From your prompt")).toBeInTheDocument();
    expect(topCardLabel()).toBe("Green Screen suggestion");

    // Cerrado: no se pregunta más.
    const settled = callsTo(`/blitz/generate/${REQUEST_ID}`).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROMPT_POLL_MS * 3);
    });
    expect(callsTo(`/blitz/generate/${REQUEST_ID}`)).toHaveLength(settled);
  });

  it("formato sin media → el motivo y un link a la Library", async () => {
    installBackend({
      status: () => ({
        requestId: REQUEST_ID,
        status: "failed",
        suggestionIds: [],
        failureReason: "no_media_for_format",
        count: 2,
      }),
    });
    const { user } = renderDeck();
    await screen.findByText("Regular card");
    await type(user, "a meme about Mondays");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const alert = await screen.findByTestId("prompt-danger");
    expect(alert).toHaveTextContent("Your Library has no media for that format yet.");
    expect(within(alert).getByRole("link", { name: "Go to Library" })).toHaveAttribute(
      "href",
      "/library",
    );
  });

  it("sin LLM → el motivo y un link a Settings → Models", async () => {
    installBackend({
      status: () => ({
        requestId: REQUEST_ID,
        status: "failed",
        suggestionIds: [],
        failureReason: "llm_not_configured",
        count: 1,
      }),
    });
    const { user } = renderDeck();
    await screen.findByText("Regular card");
    await type(user, "a meme about Mondays");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const alert = await screen.findByTestId("prompt-danger");
    expect(alert).toHaveTextContent("There's no AI model set up for text");
    expect(within(alert).getByRole("link", { name: "Set up AI models" })).toHaveAttribute(
      "href",
      "/settings/models",
    );
    // Se puede cerrar y vuelve a quedar la barra sola.
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("prompt-danger")).not.toBeInTheDocument();
  });

  it("si el POST falla, se dice y no se queda cargando", async () => {
    installBackend({ generate: () => Promise.reject(new Error("boom")) });
    const { user } = renderDeck();
    await screen.findByText("Regular card");
    await type(user, "a meme about Mondays");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByTestId("prompt-danger")).toHaveTextContent(
      "Couldn't start that. Try again.",
    );
    expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled();
  });
});

describe("el chip «From your prompt»", () => {
  it("sólo en las tarjetas que salieron de un pedido", async () => {
    installBackend({ queue: () => [REGULAR, FROM_PROMPT] });
    renderDeck();
    await screen.findByText("Regular card");
    const chips = screen.getByRole("list", { name: "Content tags" });
    expect(within(chips).queryByText("From your prompt")).not.toBeInTheDocument();
  });

  it("aparece en la de arriba cuando es de un pedido", async () => {
    installBackend({ queue: () => [FROM_PROMPT, REGULAR] });
    renderDeck();
    const chips = await screen.findByRole("list", { name: "Content tags" });
    expect(await within(chips).findByText("From your prompt")).toBeInTheDocument();
  });
});

describe("sprint 7: buscar el meme si no hay", () => {
  it("con phase searching_meme, el progreso dice que está buscando un meme", async () => {
    installBackend({
      status: () => ({
        requestId: REQUEST_ID,
        status: "running",
        phase: "searching_meme",
        suggestionIds: [],
        count: 1,
      }),
    });
    const { user } = renderDeck();
    await screen.findByText("Regular card");
    await type(user, "a meme about Mondays");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByTestId("prompt-progress")).toHaveTextContent(
      "Searching for a meme…",
    );
  });

  it("meme_not_found manda a importar un clip por link desde la Library", async () => {
    installBackend({
      status: () => ({
        requestId: REQUEST_ID,
        status: "failed",
        failureReason: "meme_not_found",
        suggestionIds: [],
        count: 1,
      }),
    });
    const { user } = renderDeck();
    await screen.findByText("Regular card");
    await type(user, "a meme about Mondays");
    await user.click(screen.getByRole("button", { name: "Create" }));
    const alert = await screen.findByTestId("prompt-danger");
    expect(alert).toHaveTextContent("Couldn't find a green-screen meme for that topic");
    expect(
      within(alert).getByRole("link", { name: "Import a clip from a link" }),
    ).toHaveAttribute("href", "/library");
  });

  it("el chip «Auto-found meme» enlaza al origen, y sólo aparece si vino anotado", async () => {
    const autoFound = card({
      id: "a1",
      contentType: "green-screen",
      generatedText: "Mondays, found",
      promptRequestId: REQUEST_ID,
      autoFoundMeme: { sourceUrl: "https://www.youtube.com/watch?v=J3bvkPStwB8" },
    });
    installBackend({ queue: () => [autoFound, REGULAR] });
    renderDeck();
    const chips = await screen.findByRole("list", { name: "Content tags" });
    const chip = await within(chips).findByText("Auto-found meme");
    expect(chip.closest("a")).toHaveAttribute(
      "href",
      "https://www.youtube.com/watch?v=J3bvkPStwB8",
    );
  });

  it("una tarjeta sin anotación no muestra el chip", async () => {
    installBackend({ queue: () => [FROM_PROMPT, REGULAR] });
    renderDeck();
    const chips = await screen.findByRole("list", { name: "Content tags" });
    await within(chips).findByText("From your prompt");
    expect(within(chips).queryByText("Auto-found meme")).not.toBeInTheDocument();
  });
});
