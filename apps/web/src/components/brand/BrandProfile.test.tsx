/**
 * `/brand` · FR-020, F-022, F-024, F-025, §19.5.1 (`P1-BRANDPG-001`…`-005`).
 *
 * ## Qué se mockea, y por qué ahí
 *
 * El corte está en el cliente (`apiRequest`, `apiList`, `apiSend`), como en
 * `OnboardingFlow.test.tsx`, y el doble **es un servidor chico**: guarda el
 * perfil y las fuentes, aplica los `PATCH` y sube `brandRevision` como la API.
 * Marca `editedByUser` en **cada clave del cuerpo** —igual que
 * `markEditedByUser`—, que es exactamente por qué la pantalla no puede mandar
 * campos sin cambios. Las respuestas pasan por el schema del contrato dentro
 * del doble: un fixture inválido rompe acá.
 *
 * ## Reloj falso (trampas ya pagadas)
 *
 * El debounce de `/resolve` y el polling son tiempo. `waitFor` no avanza los
 * fake timers de vitest, así que se avanza a mano con `tick` y 1 ms de más
 * por el `setTimeout(0)` con que TanStack notifica. Las aserciones de "no
 * pasó" van **antes** que las positivas y detrás de un `await` neutral
 * (trampas 35 y 38).
 */
import {
  brandSourceSchema,
  companyProfileSchema,
  type BrandSource,
  type CompanyProfile,
  type FieldMeta,
} from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { RESOLVE_DEBOUNCE_MS } from "@/lib/onboarding/brand-source";
import { BRAND_ANALYSIS_POLL_INTERVAL_MS } from "@/lib/onboarding/processing";
import { BrandProfile } from "./BrandProfile";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
  apiSend: vi.fn(),
}));

import { apiList, apiRequest, apiSend } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const listMock = vi.mocked(apiList);
const sendMock = vi.mocked(apiSend);

const T0 = Date.UTC(2026, 8, 23, 12);
const IG = "11111111-1111-4111-8111-111111111111";
const WEB = "22222222-2222-4222-8222-222222222222";
const NEW = "44444444-4444-4444-8444-444444444444";

function source(overrides: Readonly<Record<string, unknown>> = {}): BrandSource {
  return brandSourceSchema.parse({
    _id: IG,
    sourceType: "instagram",
    handle: "mimarca",
    canonicalUrl: "https://instagram.com/mimarca",
    displayName: null,
    avatarUrl: null,
    isPrimary: true,
    acquisitionTier: "B_public_api",
    status: "ready",
    lastAnalysedAt: T0,
    analysisCount: 1,
    createdAt: T0 - 1000,
    updatedAt: T0,
    ...overrides,
  });
}

const webSource = (overrides: Readonly<Record<string, unknown>> = {}) =>
  source({
    _id: WEB,
    sourceType: "website",
    handle: "miproducto.com",
    canonicalUrl: "https://miproducto.com",
    isPrimary: false,
    createdAt: T0,
    ...overrides,
  });

const meta = (m: Partial<FieldMeta> = {}): FieldMeta => ({
  confidence: "high",
  sourceId: IG as FieldMeta["sourceId"],
  excerptRef: "snap#x",
  editedByUser: false,
  ...m,
});

function profile(overrides: Readonly<Record<string, unknown>> = {}): CompanyProfile {
  return companyProfileSchema.parse({
    coreIdentity: "We make shoes",
    productOffering: "Running shoes",
    uniqueBenefits: "Light",
    problemSolution: "Sore feet",
    marketAndCompetition: "Crowded",
    businessCategories: ["Retail"],
    toneOfVoice: "Friendly",
    targetAudience: "Runners",
    brandRevision: 3,
    status: "ready",
    fieldMeta: {
      coreIdentity: meta(),
      productOffering: meta({ sourceId: WEB as FieldMeta["sourceId"] }),
      uniqueBenefits: meta({ confidence: "low" }),
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// El doble del servidor
// ---------------------------------------------------------------------------

interface Server {
  profile: CompanyProfile;
  sources: BrandSource[];
  profileFails: ApiRequestError | null;
  patchFails: ApiRequestError | null;
  reanalyseFails: ApiRequestError | null;
  primaryFails: ApiRequestError | null;
  removeFails: ApiRequestError | null;
}

let server: Server;

function installServer(initial: Partial<Server> = {}): void {
  server = {
    profile: profile(),
    sources: [source(), webSource()],
    profileFails: null,
    patchFails: null,
    reanalyseFails: null,
    primaryFails: null,
    removeFails: null,
    ...initial,
  };

  listMock.mockImplementation(async (path, options = {}) => {
    if (path !== "/brand/sources") throw new Error(`lista no esperada: ${path}`);
    const items = server.sources.map((s) =>
      options.itemSchema === undefined ? s : options.itemSchema.parse(s),
    );
    return Promise.resolve({ items, cursor: null, hasMore: false });
  });

  sendMock.mockImplementation(async (path, options = {}) => {
    const match = /^\/brand\/sources\/([^/]+)$/.exec(path);
    if (match === null || options.method !== "DELETE") {
      throw new Error(`send no esperado: ${path}`);
    }
    if (server.removeFails !== null) throw server.removeFails;
    server.sources = server.sources.filter((s) => s._id !== match[1]);
    return Promise.resolve();
  });

  requestMock.mockImplementation(async (path, options = {}) => {
    const parse = (value: unknown) =>
      options.schema === undefined ? value : options.schema.parse(value);
    const method = options.method ?? "GET";

    if (path === "/brand/profile" && method === "GET") {
      if (server.profileFails !== null) throw server.profileFails;
      return parse(server.profile);
    }
    if (path === "/brand/profile" && method === "PATCH") {
      if (server.patchFails !== null) throw server.patchFails;
      const body = options.body as Record<string, unknown>;
      const fieldMeta = { ...server.profile.fieldMeta };
      // Como `markEditedByUser`: TODA clave del cuerpo queda marcada.
      for (const key of Object.keys(body)) {
        const existing = fieldMeta[key];
        fieldMeta[key] =
          existing === undefined
            ? { confidence: "high", sourceId: null, excerptRef: null, editedByUser: true }
            : { ...existing, editedByUser: true };
      }
      server.profile = companyProfileSchema.parse({
        ...server.profile,
        ...body,
        fieldMeta,
        brandRevision: server.profile.brandRevision + 1,
      });
      return parse(server.profile);
    }
    const reanalyse = /^\/brand\/sources\/([^/]+)\/reanalyse$/.exec(path);
    if (reanalyse !== null && method === "POST") {
      if (server.reanalyseFails !== null) throw server.reanalyseFails;
      server.sources = server.sources.map((s) =>
        s._id === reanalyse[1] ? source({ ...s, status: "analyzing" }) : s,
      );
      return parse(server.sources.find((s) => s._id === reanalyse[1]));
    }
    const one = /^\/brand\/sources\/([^/]+)$/.exec(path);
    if (one !== null && method === "PATCH") {
      if (server.primaryFails !== null) throw server.primaryFails;
      server.sources = server.sources.map((s) =>
        source({ ...s, isPrimary: s._id === one[1] }),
      );
      return parse(server.sources.find((s) => s._id === one[1]));
    }
    if (path === "/brand/sources/resolve") {
      return parse({
        sourceType: "tiktok",
        handle: "mimarca",
        canonicalUrl: "https://www.tiktok.com/@mimarca",
        displayName: null,
        avatarUrl: null,
        available: true,
      });
    }
    if (path === "/brand/sources" && method === "POST") {
      const created = source({
        _id: NEW,
        sourceType: "tiktok",
        canonicalUrl: "https://www.tiktok.com/@mimarca",
        isPrimary: false,
        status: "pending",
        lastAnalysedAt: null,
        analysisCount: 0,
        createdAt: T0 + 1,
      });
      server.sources = [...server.sources, created];
      return parse(created);
    }
    throw new Error(`ruta no esperada: ${method} ${path}`);
  });
}

function requests(method: string, pattern: RegExp) {
  return requestMock.mock.calls.filter(
    ([path, options]) => (options?.method ?? "GET") === method && pattern.test(path),
  );
}

const listCalls = () => listMock.mock.calls.length;

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
  const rendered = render(<BrandProfile />, { wrapper: Wrapper });
  await tick(0);
  await tick(0);
  return rendered;
}

function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

function row(name: string): HTMLElement {
  const found = screen
    .getAllByRole("listitem")
    .find(
      (li) => li.classList.contains("fgw-brand-source") && within(li).queryByText(name),
    );
  if (found === undefined) throw new Error(`no hay fila ${name}`);
  return found;
}

async function openEditor(sectionName: string) {
  fireEvent.click(screen.getByRole("button", { name: `Edit ${sectionName}` }));
  await tick(0);
}

async function menuAction(sourceName: string, action: string) {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${sourceName}` }));
  await tick(0);
  fireEvent.click(within(row(sourceName)).getByRole("button", { name: action }));
  await tick(0);
  await tick(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

describe("estados de §19 · loading, error, vacío", () => {
  it("mientras carga, perfil y fuentes anuncian `aria-busy`", async () => {
    installServer();
    requestMock.mockImplementation(() => new Promise(() => undefined));
    listMock.mockImplementation(() => new Promise(() => undefined));
    const { container } = await mount();
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);
    expect(screen.queryByText("CORE IDENTITY")).toBeNull();
  });

  it("un error del perfil no esconde la tarjeta de fuentes", async () => {
    installServer({
      profileFails: new ApiRequestError({ code: "service_unavailable", status: 503 }),
    });
    await mount();
    expect(screen.getByRole("alert").textContent).toContain(
      "That service isn't responding",
    );
    expect(screen.getByText("@mimarca")).toBeTruthy();
  });

  it("sin fuentes → ERR-E12 literal con `+ Add source`", async () => {
    installServer({ sources: [] });
    await mount();
    expect(
      screen.getByText(
        "No sources yet. Add your website or a social profile so we can learn your brand.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add source" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Secciones y badges · FR-020, F-025
// ---------------------------------------------------------------------------

describe("secciones y procedencia", () => {
  it("las secciones del PRD con sus subcampos en mayúsculas", async () => {
    installServer();
    await mount();
    const identity = section("Identity & Product");
    for (const label of [
      "CORE IDENTITY",
      "PRODUCT OFFERING",
      "UNIQUE BENEFITS",
      "PROBLEM SOLUTION",
    ]) {
      expect(within(identity).getByText(label)).toBeTruthy();
    }
    expect(section("Market & Competition")).toBeTruthy();
    expect(screen.getByText("Revision 3")).toBeTruthy();
  });

  it("badge de origen con las formas literales y confianza por campo", async () => {
    installServer();
    await mount();
    const identity = section("Identity & Product");
    expect(within(identity).getAllByText("from @mimarca on Instagram")).toHaveLength(2);
    expect(within(identity).getByText("from miproducto.com")).toBeTruthy();
    expect(within(identity).getByText("Confidence: low")).toBeTruthy();
    expect(within(identity).getAllByText("Confidence: high")).toHaveLength(2);
  });

  it("los `low` se agrupan bajo `Worth a quick check`", async () => {
    installServer();
    await mount();
    const box = screen.getByRole("complementary", { name: "Worth a quick check" });
    expect(within(box).getByText("UNIQUE BENEFITS")).toBeTruthy();
    expect(within(box).queryByText("CORE IDENTITY")).toBeNull();
  });

  it("un campo editado dice `Edited by you` y no la confianza vieja", async () => {
    installServer({
      profile: profile({
        fieldMeta: { uniqueBenefits: meta({ confidence: "low", editedByUser: true }) },
      }),
    });
    await mount();
    const identity = section("Identity & Product");
    expect(within(identity).queryByText("Confidence: low")).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Worth a quick check" }),
    ).toBeNull();
    expect(within(identity).getByText("Edited by you")).toBeTruthy();
    // -005: lo que la pantalla puede decir del re-análisis, y lo que no.
    expect(screen.getByText(/re-analysing a source won't overwrite them/)).toBeTruthy();
    expect(screen.getByText(/we can't show you the suggestion yet/)).toBeTruthy();
  });

  it("un `sourceId` de una fuente borrada se dice, no se oculta", async () => {
    installServer({ sources: [webSource({ isPrimary: true })] });
    await mount();
    expect(
      within(section("Identity & Product")).getAllByText("from a source you removed"),
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edición · FR-020, F-022
// ---------------------------------------------------------------------------

describe("editar una sección", () => {
  it("manda SÓLO el campo cambiado, sube la revisión y confirma", async () => {
    installServer();
    await mount();
    await openEditor("Identity & Product");
    fireEvent.change(screen.getByLabelText("PRODUCT OFFERING"), {
      target: { value: "Trail shoes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick(0);

    const patches = requests("PATCH", /^\/brand\/profile$/);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.[1]?.body).toEqual({ productOffering: "Trail shoes" });
    // Los otros tres siguen sin marcar en el servidor: el análisis los puede tocar.
    expect(server.profile.fieldMeta["coreIdentity"]?.editedByUser).toBe(false);

    expect(screen.getByText("Revision 4")).toBeTruthy();
    expect(
      within(section("Identity & Product")).getByRole("status").textContent,
    ).toContain("Saved");
    expect(screen.getByText("Trail shoes")).toBeTruthy();
    expect(
      within(section("Identity & Product")).getAllByText("Edited by you"),
    ).toHaveLength(1);
  });

  it("guardar sin cambios cierra sin `PATCH`", async () => {
    installServer();
    await mount();
    await openEditor("Market & Competition");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick(0);
    expect(requests("PATCH", /^\/brand\/profile$/)).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Edit Market & Competition" }),
    ).toBeTruthy();
  });

  it("una sección a la vez: los otros `Edit` quedan deshabilitados", async () => {
    installServer();
    await mount();
    await openEditor("Identity & Product");
    const other = screen.getByRole("button", { name: "Edit Market & Competition" });
    expect((other as HTMLButtonElement).disabled).toBe(true);
  });

  it("más de 4 000 caracteres bloquea el guardado y lo dice", async () => {
    installServer();
    await mount();
    await openEditor("Identity & Product");
    fireEvent.change(screen.getByLabelText("CORE IDENTITY"), {
      target: { value: "a".repeat(4001) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick(0);
    expect(requests("PATCH", /^\/brand\/profile$/)).toHaveLength(0);
    expect(screen.getByText("Keep this under 4000 characters.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("un fallo deja el formulario abierto con lo escrito, y no dice `Saved`", async () => {
    installServer({
      patchFails: new ApiRequestError({ code: "service_unavailable", status: 503 }),
    });
    const { container } = await mount();
    await openEditor("Identity & Product");
    fireEvent.change(screen.getByLabelText("CORE IDENTITY"), {
      target: { value: "Shoes, Inc." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick(0);
    // Neutral primero (trampa 38): el botón ya no está ocupado.
    expect(container.querySelector('button[aria-busy="true"]')).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByText("Revision 4")).toBeNull();
    expect((screen.getByLabelText("CORE IDENTITY") as HTMLTextAreaElement).value).toBe(
      "Shoes, Inc.",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "That service isn't responding",
    );
  });

  it("si la revisión se mueve con la sección abierta, avisa — y guarda igual sólo lo tocado", async () => {
    installServer({ sources: [source({ status: "analyzing" })] });
    await mount();
    await openEditor("Market & Competition");
    expect(
      screen.queryByText(/This profile changed while you had this section open/),
    ).toBeNull();

    // El análisis escribe el perfil mientras tanto.
    server.profile = profile({ brandRevision: 4, problemSolution: "Blisters" });
    await tick(BRAND_ANALYSIS_POLL_INTERVAL_MS);
    await tick(0);
    expect(
      screen.getByText(/This profile changed while you had this section open/),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("MARKET & COMPETITION"), {
      target: { value: "Niche" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick(0);
    expect(requests("PATCH", /^\/brand\/profile$/)[0]?.[1]?.body).toEqual({
      marketAndCompetition: "Niche",
    });
    expect(server.profile.problemSolution).toBe("Blisters");
  });
});

// ---------------------------------------------------------------------------
// Brand sources · F-024
// ---------------------------------------------------------------------------

describe("tarjeta `Brand sources`", () => {
  it("una fila por fuente: plataforma, nombre, primaria, estado y fecha", async () => {
    installServer();
    await mount();
    const ig = row("@mimarca");
    expect(within(ig).getByText("Instagram")).toBeTruthy();
    expect(within(ig).getByText("Primary")).toBeTruthy();
    expect(within(ig).getByText("Ready")).toBeTruthy();
    expect(within(ig).getByText("Last analysed Sep 23, 2026")).toBeTruthy();
    expect(within(row("miproducto.com")).queryByText("Primary")).toBeNull();
  });

  it("el `⋯` es un disclosure: `aria-expanded`, y la primaria no ofrece `Set as primary`", async () => {
    installServer();
    await mount();
    const trigger = screen.getByRole("button", { name: "More actions for @mimarca" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    await tick(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const ig = row("@mimarca");
    expect(within(ig).queryByRole("button", { name: "Set as primary" })).toBeNull();
    expect(within(ig).getByRole("button", { name: "Re-analyse" })).toBeTruthy();
    fireEvent.keyDown(within(ig).getByRole("button", { name: "Re-analyse" }), {
      key: "Escape",
    });
    await tick(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("re-analizar: un POST, la fila pasa a `Analyzing`", async () => {
    installServer();
    await mount();
    await menuAction("@mimarca", "Re-analyse");
    expect(requests("POST", /\/reanalyse$/)).toHaveLength(1);
    expect(within(row("@mimarca")).getByText("Analyzing")).toBeTruthy();
  });

  it("ERR-B11: cooldown con las horas, sin `Try again`, y un solo POST", async () => {
    installServer({
      reanalyseFails: new ApiRequestError({
        code: "rate_limited",
        status: 429,
        details: { code: "ERR-B11", retryAfterMs: 7_200_000 },
      }),
    });
    await mount();
    await menuAction("@mimarca", "Re-analyse");
    const ig = row("@mimarca");
    expect(within(ig).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(requests("POST", /\/reanalyse$/)).toHaveLength(1);
    expect(within(ig).getByRole("alert").textContent).toBe(
      "You've refreshed this source recently. Try again in 2 hours.",
    );
  });

  it("NFR-005: un timeout al re-analizar no se reintenta; se relee el estado", async () => {
    installServer({
      reanalyseFails: new ApiRequestError({ code: "timeout", status: 0 }),
    });
    await mount();
    const before = listCalls();
    await menuAction("@mimarca", "Re-analyse");
    // Tiempo de sobra para cualquier backoff de reintento: si la mutación
    // reintentara sola, acá aparecería un segundo POST.
    await tick(60_000);
    const ig = row("@mimarca");
    expect(within(ig).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(requests("POST", /\/reanalyse$/)).toHaveLength(1);
    expect(listCalls()).toBeGreaterThan(before);
    expect(within(ig).getByRole("alert").textContent).toContain("won't count twice");
  });

  it("marcar primaria: PATCH `{isPrimary: true}` y la marca se mueve", async () => {
    installServer();
    await mount();
    await menuAction("miproducto.com", "Set as primary");
    const patches = requests("PATCH", /^\/brand\/sources\//);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.[1]?.body).toEqual({ isPrimary: true });
    expect(within(row("miproducto.com")).getByText("Primary")).toBeTruthy();
    expect(within(row("@mimarca")).queryByText("Primary")).toBeNull();
  });

  it("404 cruzado al marcar primaria: se dice que ya no está y se relee", async () => {
    installServer({
      primaryFails: new ApiRequestError({ code: "not_found", status: 404 }),
    });
    await mount();
    const before = listCalls();
    await menuAction("miproducto.com", "Set as primary");
    expect(listCalls()).toBeGreaterThan(before);
    expect(screen.getByRole("alert").textContent).toBe(
      "This source isn't there anymore. The list has been refreshed.",
    );
  });

  it("quitar pide confirmación; `Cancel` no borra", async () => {
    installServer();
    await mount();
    await menuAction("miproducto.com", "Remove");
    const dialog = screen.getByRole("dialog", { name: "Remove miproducto.com?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await tick(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("quitar confirmado: DELETE y la fila desaparece", async () => {
    installServer();
    await mount();
    await menuAction("miproducto.com", "Remove");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    await tick(0);
    await tick(0);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toEqual({ method: "DELETE" });
    expect(screen.queryByText("miproducto.com")).toBeNull();
  });

  it("la única fuente (409 ERR-B01): se dice lo que la API rechazó y la fila sigue", async () => {
    installServer({
      sources: [source()],
      removeFails: new ApiRequestError({
        code: "conflict",
        status: 409,
        details: { code: "ERR-B01" },
      }),
    });
    await mount();
    await menuAction("@mimarca", "Remove");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    await tick(0);
    await tick(0);
    expect(within(row("@mimarca")).getByRole("alert").textContent).toBe(
      "This is the only source behind your brand profile. Add another one first.",
    );
  });

  it("stale: la oferta de refrescar está a la vista, fuera del `⋯`", async () => {
    installServer({ sources: [source({ status: "stale" })] });
    await mount();
    const ig = row("@mimarca");
    expect(within(ig).getByText("This analysis is more than 90 days old.")).toBeTruthy();
    fireEvent.click(within(ig).getByRole("button", { name: "Re-analyse" }));
    await tick(0);
    expect(requests("POST", /\/reanalyse$/)).toHaveLength(1);
  });

  it("con 5 fuentes no se ofrece `+ Add source` y se dice el cap (ERR-B10)", async () => {
    const five = [0, 1, 2, 3, 4].map((i) =>
      source({
        _id: `5555555${String(i)}-5555-4555-8555-555555555555`,
        handle: `marca${String(i)}`,
        isPrimary: i === 0,
      }),
    );
    installServer({ sources: five });
    await mount();
    expect(screen.queryByRole("button", { name: "+ Add source" })).toBeNull();
    expect(
      screen.getByText("You can analyse up to 5 sources per workspace."),
    ).toBeTruthy();
  });

  it("`+ Add source`: detecta, `Analyse`, y la fila nueva aparece en `Queued`", async () => {
    installServer();
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "+ Add source" }));
    await tick(0);
    fireEvent.change(
      screen.getByPlaceholderText("yoursite.com, instagram.com/yourbrand, or @yourbrand"),
      { target: { value: "tiktok.com/@mimarca" } },
    );
    await tick(RESOLVE_DEBOUNCE_MS);
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
    await tick(0);
    await tick(0);

    const creates = requests("POST", /^\/brand\/sources$/);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]?.idempotencyKey).toEqual(expect.any(String));
    expect(screen.queryByPlaceholderText(/yoursite\.com/)).toBeNull();
    const rows = screen
      .getAllByRole("listitem")
      .filter((li) => li.classList.contains("fgw-brand-source"));
    expect(rows).toHaveLength(3);
    expect(within(rows[2] as HTMLElement).getByText("TikTok")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Queued")).toBeTruthy();
  });

  it("cuando el análisis termina, el perfil se relee DESPUÉS de verlo terminado", async () => {
    installServer({ sources: [source({ status: "analyzing" })] });
    await mount();

    // La carrera real: en el mismo ciclo de polling, el `GET /brand/profile`
    // se sirve **antes** de que el análisis escriba, y el `GET /brand/sources`
    // (más lento) **después**. El listado dice `ready`, el polling se apaga, y
    // sin una relectura final el perfil queda viejo para siempre.
    const serveProfile = requestMock.getMockImplementation();
    let armed = true;
    requestMock.mockImplementation(async (path, options) => {
      const served = await serveProfile?.(path, options);
      if (armed && path === "/brand/profile" && (options?.method ?? "GET") === "GET") {
        armed = false;
        server.sources = [source({ status: "ready" })];
        server.profile = profile({ coreIdentity: "Written by the analysis" });
      }
      return served;
    });
    const serveList = listMock.getMockImplementation();
    listMock.mockImplementation(async (path, options) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (serveList === undefined) throw new Error("sin lista");
      return serveList(path, options);
    });

    await tick(BRAND_ANALYSIS_POLL_INTERVAL_MS);
    await tick(100);
    await tick(0);
    // Mucho después: ya no hay polling que lo arregle por casualidad.
    await tick(BRAND_ANALYSIS_POLL_INTERVAL_MS * 3);
    expect(within(row("@mimarca")).getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Written by the analysis")).toBeTruthy();
  });
});
