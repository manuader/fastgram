/**
 * `/onboarding` · pasos 1 y 4 · FR-011.2, FR-010, §19.5.1 (`P1-ONB-002`,
 * `P1-ONB-005`).
 *
 * ## Qué se mockea, y por qué ahí
 *
 * El corte está en **`apiRequest`**, como en `BlitzSettingsForm.test.tsx`, y el
 * doble **enruta por path** en vez de devolver una respuesta fija: la pantalla
 * habla con tres endpoints (`GET /onboarding`, `POST /brand/sources/resolve`,
 * `POST /brand/sources`) y un mock plano mediría el orden de las llamadas, no
 * la pantalla. El alta **escribe** en el estado del doble, así que el refetch
 * que la sigue ve la fuente nueva igual que lo haría contra el servidor.
 *
 * Las respuestas se validan con el schema del contrato **dentro** del doble
 * (`apiRequest` real lo hace con `options.schema`): un fixture inválido rompe
 * acá, no pasa verde.
 *
 * ## Reloj falso (las trampas ya pagadas)
 *
 * Todo el archivo corre con fake timers: el debounce de `/resolve` y el
 * polling son tiempo. `waitFor` no sabe avanzarlos en vitest (detecta `jest`),
 * así que se avanza a mano con `tick`, siempre con 1 ms de más por el
 * `setTimeout(0)` con que TanStack notifica al observador.
 */
import {
  brandSourceSchema,
  onboardingStateSchema,
  type BrandSource,
  type OnboardingState,
} from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { RESOLVE_DEBOUNCE_MS } from "@/lib/onboarding/brand-source";
import {
  ANALYSIS_EXPECTED_MS,
  BRAND_ANALYSIS_POLL_INTERVAL_MS,
} from "@/lib/onboarding/processing";
import { OnboardingFlow } from "./OnboardingFlow";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const T0 = Date.UTC(2026, 8, 23, 12);
const ID = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;

function source(overrides: Readonly<Record<string, unknown>> = {}): BrandSource {
  return brandSourceSchema.parse({
    _id: ID[0],
    sourceType: "instagram",
    handle: "mimarca",
    canonicalUrl: "https://instagram.com/mimarca",
    displayName: null,
    avatarUrl: null,
    isPrimary: true,
    acquisitionTier: "B_public_api",
    status: "pending",
    lastAnalysedAt: null,
    analysisCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// El doble del servidor
// ---------------------------------------------------------------------------

type Resolver = (input: string, hint: string | undefined) => unknown;

interface Server {
  state: OnboardingState;
  resolve: Resolver;
  /** `null` = crea la fuente; un error = lo lanza. */
  createFails: ApiRequestError | null;
  calls: { path: string; options: ApiRequestOptions<unknown> }[];
}

let server: Server;

function onboarding(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return onboardingStateSchema.parse({
    step: "brand_source",
    sources: [],
    manualBranch: false,
    details: null,
    profiling: null,
    oauthConsents: 0,
    ...overrides,
  });
}

function installServer(initial: Partial<Server> = {}): void {
  server = {
    state: onboarding(),
    resolve: () => {
      throw new Error("resolve no configurado");
    },
    createFails: null,
    calls: [],
    ...initial,
  };
  requestMock.mockImplementation(async (path, options = {}) => {
    server.calls.push({ path, options: options as ApiRequestOptions<unknown> });
    const parse = (value: unknown) =>
      options.schema === undefined ? value : options.schema.parse(value);

    if (path === "/onboarding") return parse(server.state);
    if (path === "/brand/sources/resolve") {
      const body = options.body as { input: string; hint?: string };
      return parse(server.resolve(body.input, body.hint));
    }
    if (path === "/brand/sources" && options.method === "POST") {
      if (server.createFails !== null) throw server.createFails;
      const created = source({ _id: ID[server.state.sources.length] ?? ID[1] });
      server.state = onboarding({
        step: "company_details",
        sources: [...server.state.sources, created],
      });
      return parse(created);
    }
    throw new Error(`ruta no esperada: ${path}`);
  });
}

function calls(path: string) {
  return server.calls.filter((c) => c.path === path);
}

const igResolved = () => ({
  sourceType: "instagram",
  handle: "mimarca",
  canonicalUrl: "https://instagram.com/mimarca",
  displayName: null,
  avatarUrl: null,
  available: true,
});

// ---------------------------------------------------------------------------
// Montaje
// ---------------------------------------------------------------------------

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(1);
  });
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const rendered = render(<OnboardingFlow />, { wrapper: Wrapper });
  await tick(0);
  return rendered;
}

function field(): HTMLInputElement {
  const found = screen.getByPlaceholderText(
    "yoursite.com, instagram.com/yourbrand, or @yourbrand",
  );
  if (!(found instanceof HTMLInputElement)) throw new Error("no es un input");
  return found;
}

/**
 * Escribir y dejar que pase el debounce y responda `/resolve`.
 *
 * **Dos** ticks, no uno: el `setState` del debounce se dispara dentro del
 * `act` del primero, y `act` difiere el render hasta cerrarse. La query
 * habilitada por el valor nuevo recién arranca **después**, así que hace falta
 * otra vuelta para que su respuesta llegue a pantalla. Con uno solo, la
 * pantalla sigue en `Checking…` y parece que `/resolve` no contestó.
 */
async function typeAndSettle(value: string): Promise<void> {
  fireEvent.change(field(), { target: { value } });
  await tick(RESOLVE_DEBOUNCE_MS);
  await tick(0);
}

/** El contenedor que lleva `aria-busy`: la señal neutral de trampa 38. */
function busy(container: HTMLElement): string | null {
  return container.querySelector("[aria-busy]")?.getAttribute("aria-busy") ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Los estados de §19
// ---------------------------------------------------------------------------

describe("GET /onboarding · loading, error, datos", () => {
  it("mientras carga anuncia `aria-busy` y no pinta el paso", async () => {
    installServer();
    requestMock.mockImplementation(() => new Promise(() => undefined));
    const { container } = await mount();
    expect(busy(container)).toBe("true");
    expect(screen.queryByText("Where can we learn about your brand?")).toBeNull();
  });

  it("un fallo de red es un error con `Try again`, no un paso 1 vacío", async () => {
    installServer();
    requestMock.mockRejectedValue(
      new ApiRequestError({ code: "network_error", status: 0 }),
    );
    const { container } = await mount();
    // Negativa primero, tras una espera neutral (el `aria-busy` se apagó).
    expect(busy(container)).toBe("false");
    expect(screen.queryByText("Where can we learn about your brand?")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't reach the server. Check your connection.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("sin fuentes: el paso 1 con su copy literal (FR-011.2) y los seis chips", async () => {
    installServer();
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Where can we learn about your brand?",
    );
    expect(
      screen.getByText(
        "Paste your website, your Instagram, TikTok, X, YouTube or LinkedIn — whatever describes you best.",
      ),
    ).toBeInTheDocument();
    const chips = within(screen.getByRole("group", { name: "Platform" }))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(chips).toEqual(["Website", "Instagram", "TikTok", "X", "YouTube", "LinkedIn"]);
  });
});

// ---------------------------------------------------------------------------
// Paso 1 · detección y alta
// ---------------------------------------------------------------------------

describe("paso 1 · input único, detección y alta", () => {
  it("no pregunta a cada tecla: una sola llamada a /resolve tras el debounce", async () => {
    installServer({ resolve: igResolved });
    await mount();
    fireEvent.change(field(), { target: { value: "instagram.com/m" } });
    await tick(100);
    fireEvent.change(field(), { target: { value: "instagram.com/mimarca" } });
    await tick(RESOLVE_DEBOUNCE_MS - 50);
    expect(calls("/brand/sources/resolve")).toHaveLength(0);
    expect(screen.getByText("Checking…")).toBeInTheDocument();

    await tick(50);
    expect(calls("/brand/sources/resolve")).toHaveLength(1);
    expect(calls("/brand/sources/resolve")[0]?.options.body).toEqual({
      input: "instagram.com/mimarca",
    });
  });

  it("detectado: tarjeta de confirmación con plataforma, handle y `Analyse`", async () => {
    installServer({ resolve: igResolved });
    await mount();
    await typeAndSettle("https://www.instagram.com/mimarca?igshid=abc");
    expect(screen.getByText("@mimarca")).toBeInTheDocument();
    expect(screen.getByText("Instagram", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyse" })).toBeInTheDocument();
  });

  it("`Analyse` crea con Idempotency-Key y la fuente aparece en `pending`", async () => {
    installServer({ resolve: igResolved });
    const { container } = await mount();
    await typeAndSettle("instagram.com/mimarca");

    fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
    // Dos vueltas: el `onSuccess` del hook **espera** el refetch de
    // `GET /onboarding` antes de que corra el del `mutate` (que pliega el
    // input), y cada una termina en su propio `act`.
    await tick(0);
    await tick(0);

    const created = calls("/brand/sources");
    expect(created).toHaveLength(1);
    expect(created[0]?.options.method).toBe("POST");
    expect(created[0]?.options.body).toEqual({
      sourceType: "instagram",
      canonicalUrl: "https://instagram.com/mimarca",
    });
    expect(created[0]?.options.idempotencyKey).toEqual(expect.any(String));

    // La lista viene del refetch de GET /onboarding, no de un estado local.
    const list = container.querySelector(".fgw-onb-sources");
    expect(list).not.toBeNull();
    expect(within(list as HTMLElement).getByText("Queued")).toBeInTheDocument();
    // La primera fuente mueve el paso derivado a `company_details`, y la
    // pantalla NO se va sola: todavía hay que poder añadir otra.
    expect(
      screen.getByRole("button", { name: "Add another source" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await tick(0);
    expect(screen.queryByText("Where can we learn about your brand?")).toBeNull();
  });

  it("reintentar un alta fallida reusa la misma Idempotency-Key", async () => {
    installServer({
      resolve: igResolved,
      createFails: new ApiRequestError({ code: "timeout", status: 0 }),
    });
    await mount();
    await typeAndSettle("instagram.com/mimarca");

    fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
    await tick(0);
    expect(screen.getByText("That took too long. Try again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await tick(0);
    const keys = calls("/brand/sources").map((c) => c.options.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("`@handle` suelto abre el desambiguador (ERR-B03) con la conectada preseleccionada", async () => {
    installServer({
      resolve: (input) => {
        if (input === "@mimarca") {
          throw new ApiRequestError({
            code: "bad_request",
            status: 400,
            details: {
              code: "ERR-B03",
              handle: "mimarca",
              candidates: ["instagram", "tiktok", "x", "youtube", "linkedin"],
              preselected: "tiktok",
            },
          });
        }
        return {
          sourceType: "tiktok",
          handle: "mimarca",
          canonicalUrl: "https://tiktok.com/@mimarca",
          displayName: null,
          avatarUrl: null,
          available: true,
        };
      },
    });
    await mount();
    await typeAndSettle("@mimarca");

    const picker = screen.getByRole("group", { name: "Which platform is @mimarca on?" });
    expect(within(picker).getByRole("button", { name: "TikTok" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // No es un error: no hay alerta.
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(within(picker).getByRole("button", { name: "TikTok" }));
    await tick(RESOLVE_DEBOUNCE_MS);
    await tick(0);
    expect(field().value).toBe("tiktok.com/@mimarca");
    expect(screen.getByRole("button", { name: "Analyse" })).toBeInTheDocument();
  });

  it("entrada irreconocible: ERR-B02 literal, sin tarjeta", async () => {
    installServer({
      resolve: () => {
        throw new ApiRequestError({
          code: "bad_request",
          status: 400,
          details: { code: "ERR-B02" },
        });
      },
    });
    await mount();
    await typeAndSettle("no sé");
    expect(screen.queryByRole("button", { name: "Analyse" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't tell what this is. Paste a website URL or a social profile link.",
    );
  });

  it("SSRF: el literal de FR-010, no «That request wasn't valid»", async () => {
    installServer({
      resolve: () => {
        throw new ApiRequestError({
          code: "bad_request",
          status: 400,
          serverMessage: "Localhost URLs are not allowed",
        });
      },
    });
    await mount();
    await typeAndSettle("http://localhost:3000");
    expect(screen.getByRole("alert")).toHaveTextContent("Localhost URLs are not allowed");
  });

  it("enlace a un post: ERR-B12 como aviso, sin bloquear `Analyse`", async () => {
    installServer({
      resolve: () => ({
        sourceType: "tiktok",
        handle: "mimarca",
        canonicalUrl: "https://tiktok.com/@mimarca",
        displayName: null,
        avatarUrl: null,
        available: true,
        resolvedFromPost: true,
      }),
    });
    await mount();
    await typeAndSettle("tiktok.com/@mimarca/video/123");
    expect(
      screen.getByText("We'll analyse the whole @mimarca profile, not just that post."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyse" })).toBeEnabled();
  });

  it("el cap de 5 al crear (ERR-B10) se dice con su copy, sin «Try again»", async () => {
    installServer({
      resolve: igResolved,
      createFails: new ApiRequestError({
        code: "bad_request",
        status: 400,
        details: { code: "ERR-B10", cap: 5 },
      }),
    });
    await mount();
    await typeAndSettle("instagram.com/mimarca");
    fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
    await tick(0);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You can analyse up to 5 sources per workspace.",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  /**
   * El doble decide como `detectBrandSource` de `core`: un host desconocido es
   * `other_url`, y sólo `hint: "website"` lo vuelve `website`. Si el cliente no
   * manda la pista, la tarjeta dice `Link` y el alta sale `other_url`.
   */
  const unknownHost: Resolver = (input, hint) => ({
    sourceType: hint === "website" ? "website" : "other_url",
    handle: input,
    canonicalUrl: `https://${input}`,
    displayName: null,
    avatarUrl: null,
    available: true,
  });

  it("chip Website + dominio desconocido: manda `hint: website` y el alta sale `website`", async () => {
    installServer({ resolve: unknownHost });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Website" }));
    await typeAndSettle("miproducto.com");
    expect(calls("/brand/sources/resolve").at(-1)?.options.body).toEqual({
      input: "miproducto.com",
      hint: "website",
    });
    expect(screen.getByText("Website", { selector: "p" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
    await tick(0);
    expect(calls("/brand/sources")[0]?.options.body).toEqual({
      sourceType: "website",
      canonicalUrl: "https://miproducto.com",
    });
  });

  it("pulsar Website sobre un dominio ya resuelto vuelve a preguntar: no sirve el `other_url` de la caché", async () => {
    installServer({ resolve: unknownHost });
    await mount();
    await typeAndSettle("miproducto.com");
    // Sin chip no hay pista: lo que dice el host.
    expect(calls("/brand/sources/resolve")[0]?.options.body).toEqual({
      input: "miproducto.com",
    });
    expect(screen.getByText("Link", { selector: "p" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Website" }));
    await tick(RESOLVE_DEBOUNCE_MS);
    await tick(0);
    // Negativa primero, tras una espera neutral (trampa 38): el botón existe
    // en los dos mundos.
    expect(screen.getByRole("button", { name: "Analyse" })).toBeInTheDocument();
    expect(screen.queryByText("Link", { selector: "p" })).toBeNull();
    expect(screen.getByText("Website", { selector: "p" })).toBeInTheDocument();
    expect(calls("/brand/sources/resolve")).toHaveLength(2);
  });

  it("reanudar con una fuente ya creada no vuelve al paso 1, y el análisis sigue a la vista", async () => {
    installServer({
      state: onboarding({ step: "company_details", sources: [source()] }),
    });
    await mount();
    // Reanudar (FR-010 crit. 3): la API dice `company_details`, así que no se
    // vuelve al paso 1.
    expect(screen.queryByText("Where can we learn about your brand?")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Company details is not built yet",
    );
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("`Continue` sin ninguna fuente: ERR-B01, y no sale del paso", async () => {
    installServer();
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await tick(0);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add a website or a social profile to continue",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Where can we learn about your brand?",
    );
  });
});

// ---------------------------------------------------------------------------
// Polling y la honestidad sobre `pending`
// ---------------------------------------------------------------------------

describe("estado del análisis · polling y `pending` que no avanza", () => {
  it("con una fuente en curso vuelve a pedir a los 10 s, y deja de pedir al terminar", async () => {
    installServer({ state: onboarding({ step: "processing", sources: [source()] }) });
    await mount();
    expect(calls("/onboarding")).toHaveLength(1);

    await tick(BRAND_ANALYSIS_POLL_INTERVAL_MS - 1_000);
    expect(calls("/onboarding")).toHaveLength(1);

    server.state = onboarding({
      step: "processing",
      sources: [source({ status: "ready", updatedAt: T0 + 5_000 })],
    });
    await tick(1_000);
    expect(calls("/onboarding")).toHaveLength(2);
    // Primero lo que se ve —la pantalla se enteró sola—, después el contador.
    expect(screen.queryByText("Analyzing company profile...")).toBeNull();
    expect(screen.getByText("Brand analysis finished")).toBeInTheDocument();

    await tick(BRAND_ANALYSIS_POLL_INTERVAL_MS * 3);
    expect(calls("/onboarding")).toHaveLength(2);
  });

  it("`pending` más de 3 min dice que NO empezó — y no promete que alguien trabaja", async () => {
    installServer({ state: onboarding({ step: "processing", sources: [source()] }) });
    const { container } = await mount();
    expect(screen.queryByText(/hasn't started yet/)).toBeNull();

    // El dato no cambia en todo este rato: sólo el reloj. Es exactamente lo que
    // pasa cuando el worker no montó `brand-source-analysis`.
    await tick(ANALYSIS_EXPECTED_MS);

    // Negativa primero, tras una espera neutral (trampa 38): el `aria-busy`
    // apagado es cierto con y sin el aviso.
    expect(busy(container)).toBe("false");
    expect(
      screen.queryByText(
        "Taking longer than expected. We'll keep working in the background.",
      ),
    ).toBeNull();
    expect(screen.queryByText("Workspace ready!")).toBeNull();
    expect(
      screen.getByText(
        "The analysis hasn't started yet. It's still queued — you can keep going with setup meanwhile.",
      ),
    ).toBeInTheDocument();
  });

  it("paso 4 · Instagram lista sus sub-pasos del PRD, sin tildar ninguno", async () => {
    installServer({
      state: onboarding({
        step: "processing",
        sources: [source({ status: "analyzing" })],
      }),
    });
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Analyzing company profile...",
    );
    const steps = screen.getByRole("list", { name: "What the analysis does" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Reading profile",
      "Reading recent posts",
      "Reading on-screen text",
      "Building your brand profile",
    ]);
    expect(
      screen.getByText("We can't show which of these is running yet."),
    ).toBeInTheDocument();
  });

  it("paso 4 · una fuente fallida dice por qué (ERR-B05) y, si fallaron todas, el copy de FR-010", async () => {
    installServer({
      state: onboarding({
        step: "processing",
        sources: [source({ status: "failed", failureReason: "private" })],
      }),
    });
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your company profile needs support before setup can finish.",
    );
    expect(
      screen.getByText(
        "@mimarca is private, so we can't read it. Connect the account or paste your bio instead.",
      ),
    ).toBeInTheDocument();
  });

  /**
   * `FR-011.4` pide, al degradar a D, pedir «la ayuda concreta» (pegar la bio,
   * subir capturas, describir la marca). Ningún endpoint la recibe hoy, así que
   * la pantalla **no** la pide: dice qué pasó y ofrece lo único que funciona.
   * Tampoco «Add a different one»: toda red social termina en este motivo.
   */
  it("paso 4 · `unsupported_platform` lo dice con la plataforma, sin pedir bio ni otra red", async () => {
    installServer({
      state: onboarding({
        step: "processing",
        sources: [
          source({
            sourceType: "tiktok",
            canonicalUrl: "https://tiktok.com/@mimarca",
            status: "failed",
            failureReason: "unsupported_platform",
            acquisitionTier: "D_assisted",
          }),
        ],
      }),
    });
    const { container } = await mount();
    // Negativas primero, tras la espera neutral (trampa 38).
    expect(busy(container)).toBe("false");
    const list = container.querySelector(".fgw-onb-sources");
    expect(list).not.toBeNull();
    const shown = list?.textContent ?? "";
    expect(shown).not.toMatch(/bio|screenshot|describe|different one/i);
    expect(
      screen.getByText(
        "We can't read TikTok profiles yet, so this source won't shape your brand profile. If you have a website, add it instead.",
      ),
    ).toBeInTheDocument();
  });
});
