/**
 * `/blitz/settings` · FR-055 (PRD:1255-1300) — auto-guardado contra un límite
 * de 3/min, los pesos que suman 100, y un banner que no puede mentir.
 *
 * ## Qué se mockea, y por qué ahí
 *
 * El corte está en **`apiRequest`**, el cliente tipado, igual que
 * `MyContentTab.test.tsx` lo pone en `apiList`. Y el doble no devuelve un
 * objeto fijo: **guarda el estado y aplica el patch**, como haría el servidor.
 * Sin eso, la línea base de la pantalla nunca avanzaría y un bug de "el patch
 * se calcula contra la respuesta vieja" no se vería — que es justo el bug que
 * convierte el segundo guardado en un `400`.
 *
 * ## Temporizadores falsos (la trampa ya medida, `MyContentTab.test.tsx`)
 *
 * `waitFor` no sabe avanzar los fake timers de vitest: detecta `typeof jest`,
 * que acá es `undefined`, así que espera con el reloj parado y muere por
 * timeout. Por eso el reloj se mueve a mano con `vi.advanceTimersByTimeAsync`
 * dentro de `act`, y siempre con **1 ms de más**: TanStack Query agenda la
 * notificación al observador con `setTimeout(cb, 0)` en el mismo tick, y
 * avanzar 0 no la corre.
 */
import { blitzPreferencesSchema, type BlitzPreferences } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MIN_INTERVAL_MS,
  PREFERENCES_UPDATES_PER_MINUTE,
} from "@/lib/blitz/autosave";
import { BlitzSettingsForm } from "./BlitzSettingsForm";
import { SaveStatusBanner } from "./SaveStatusBanner";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

// El import va después del `vi.mock` sólo para leerse en orden: `vi.mock` se
// iza por encima de todos los imports del archivo.
import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const SAVED = "All changes saved";
const PENDING = "Unsaved changes";
const SAVING = "Saving…";

function preferences(
  overrides: Readonly<Record<string, unknown>> = {},
): BlitzPreferences {
  return blitzPreferencesSchema.parse({
    slideshowWeight: 25,
    wallOfTextWeight: 25,
    greenScreenWeight: 25,
    videoHookWeight: 25,
    remixPercentage: 0,
    ownMediaPercentage: 0,
    mentionBusinessPercentage: 0,
    influencerChance: 50,
    smartTextPositioning: true,
    genderFilter: null,
    angleWeights: {},
    textStyleWeights: {},
    settingsApplication: { mode: "future_generations", targetQueuedItems: 5 },
    ...overrides,
  });
}

/** El "servidor": guarda el estado y aplica los patches que recibe. */
interface FakeServer {
  stored: BlitzPreferences;
  /** Si se fija, el PATCH queda en vuelo hasta que alguien llame a `release`. */
  hold: boolean;
  release: (() => void) | null;
  failNext: unknown;
}

let server: FakeServer;

function patchBodies(): readonly Record<string, unknown>[] {
  return requestMock.mock.calls
    .filter(([, options]) => options?.method === "PATCH")
    .map(([, options]) => (options?.body ?? {}) as Record<string, unknown>);
}

function installServer(): void {
  requestMock.mockImplementation(
    (_path: string, options?: ApiRequestOptions<unknown>): Promise<unknown> => {
      if (options?.method !== "PATCH") return Promise.resolve(server.stored);

      const failure = server.failNext;
      if (failure !== undefined) {
        server.failNext = undefined;
        return Promise.reject(failure);
      }

      const applied = blitzPreferencesSchema.parse({
        ...server.stored,
        ...(options.body as Record<string, unknown>),
      });

      if (!server.hold) {
        server.stored = applied;
        return Promise.resolve(applied);
      }
      return new Promise<BlitzPreferences>((resolve) => {
        server.release = () => {
          server.stored = applied;
          resolve(applied);
        };
      });
    },
  );
}

/**
 * `retry: false` contra el default del proyecto, por el mismo motivo que en
 * `MyContentTab.test.tsx`: con los reintentos puestos, un test del estado de
 * error mide el backoff de TanStack Query y no lo que esta pantalla decide.
 */
function renderForm() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<BlitzSettingsForm />, { wrapper: Wrapper });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(1);
  });
}

async function mount() {
  vi.useFakeTimers();
  const rendered = renderForm();
  await tick(0);
  return rendered;
}

function slider(name: string): HTMLInputElement {
  const found = screen.getByLabelText(name);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`"${name}" no es un input de rango.`);
  }
  return found;
}

/** Mover un slider. `userEvent` no sabe arrastrar un `range`. */
function drag(name: string, value: number): void {
  fireEvent.change(slider(name), { target: { value: String(value) } });
}

function networkFailure(): ApiRequestError {
  return new ApiRequestError({ code: "network_error", status: 0 });
}

beforeEach(() => {
  requestMock.mockReset();
  server = { stored: preferences(), hold: false, release: null, failNext: undefined };
  installServer();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("los estados de §19 — y el que esta pantalla no tiene", () => {
  it("mientras la primera carga está en vuelo: nada de formulario y nada de banner", () => {
    requestMock.mockReturnValue(new Promise(() => undefined));
    const { container } = renderForm();

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("un fallo de la API es un error, NO una pantalla de ajustes en blanco", async () => {
    // El equivalente al bug de la Library: una pantalla de ajustes sin
    // controles y un error de red se dibujan casi igual. Si además dijera
    // `All changes saved`, el usuario creería que sus ajustes están guardados
    // cuando ni siquiera se pudieron leer.
    requestMock.mockRejectedValue(networkFailure());
    renderForm();

    await screen.findByRole("alert");
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(
      screen.getByText("We couldn't reach the server. Check your connection."),
    ).toBeInTheDocument();
  });

  it("con datos: los controles con su valor, y el banner en verdad", async () => {
    server.stored = preferences({ influencerChance: 80 });
    await mount();

    expect(slider("Influencer frequency").value).toBe("80");
    expect(screen.getByText(SAVED)).toBeInTheDocument();
    // DATA-006 sintetiza defaults, así que un workspace nuevo nunca ve una
    // pantalla vacía: el estado `empty` de §19 no existe acá.
    expect(screen.getByText("Slideshow")).toBeInTheDocument();
  });
});

describe("el banner no puede mentir", () => {
  it("con un cambio esperando al debounce dice que hay algo sin guardar", async () => {
    await mount();
    drag("Influencer frequency", 70);

    expect(screen.getByText(PENDING)).toBeInTheDocument();
    // Ésta es la aserción entera. `All changes saved` con un cambio en el aire
    // es la frase por la que alguien cierra la pestaña y pierde su trabajo.
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(patchBodies()).toHaveLength(0);
  });

  it("con un guardado en vuelo dice `Saving…`, no `All changes saved`", async () => {
    server.hold = true;
    await mount();

    drag("Influencer frequency", 70);
    await tick(AUTOSAVE_DEBOUNCE_MS);

    expect(patchBodies()).toHaveLength(1);
    // La negativa va **primero**, y no es estilo: si fuera detrás del
    // `getByText(SAVING)`, un banner que dijera las dos cosas —o que dijera
    // `All changes saved`— fallaría por no encontrar `Saving…`, o sea por el
    // motivo equivocado, y el día que el copy cambie el test dejaría de medir
    // la mentira. Este repo ya tuvo una aserción escondida detrás de otra.
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(screen.getByText(SAVING)).toBeInTheDocument();
  });

  it("después de un guardado que falló NO dice `All changes saved`, y el cambio sigue ahí", async () => {
    server.failNext = networkFailure();
    await mount();

    drag("Influencer frequency", 70);
    await tick(AUTOSAVE_DEBOUNCE_MS);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(SAVED)).toBeNull();
    // El cambio no se pierde al fallar: sigue en pantalla y sigue sucio, así
    // que el siguiente intento lo vuelve a mandar.
    expect(slider("Influencer frequency").value).toBe("70");
    expect(
      screen.getByText("Your change is still here — it just isn't saved yet."),
    ).toBeInTheDocument();
  });

  it("cuando el guardado sale bien, y sólo entonces, dice `All changes saved`", async () => {
    await mount();
    drag("Influencer frequency", 70);
    await tick(AUTOSAVE_DEBOUNCE_MS);

    expect(screen.getByText(SAVED)).toBeInTheDocument();
    expect(server.stored.influencerChance).toBe(70);
  });

  it("un conjunto que no suma 100 tampoco dice `All changes saved`", () => {
    // El estado `blocked` no se alcanza desde los controles —`setWeight`
    // mantiene la suma— así que se prueba el banner directamente. Sin esta
    // rama, un conjunto sucio que no se está mandando pasaría por guardado.
    render(
      <SaveStatusBanner
        status="blocked"
        error={null}
        blockedLabel="Content mix"
        onRetry={() => undefined}
      />,
    );
    expect(screen.queryByText(SAVED)).toBeNull();
    expect(
      screen.getByText(
        "Content mix doesn't add up to 100 yet, so it isn't being saved. Adjust it to continue.",
      ),
    ).toBeInTheDocument();
  });
});

describe("auto-guardado contra el límite de 3/min (§9.6)", () => {
  it("una ráfaga de movimientos es UNA sola petición", async () => {
    await mount();

    // Un arrastre real emite decenas de eventos. Sin debounce, cada uno sería
    // un PATCH y el tercero ya sería un 429.
    for (const value of [51, 55, 60, 64, 70]) drag("Influencer frequency", value);
    expect(patchBodies()).toHaveLength(0);

    await tick(AUTOSAVE_DEBOUNCE_MS);
    expect(patchBodies()).toEqual([{ influencerChance: 70 }]);
  });

  it("diez cambios repartidos en un minuto no pasan de tres peticiones", async () => {
    await mount();

    // Ésta es la prueba de que el debounce **solo** no alcanzaría: diez
    // ediciones separadas por seis segundos superan el debounce cada vez, así
    // que sin el piso de cadencia serían diez PATCH y siete `429`.
    for (let i = 1; i <= 10; i += 1) {
      drag("Influencer frequency", i * 5);
      await tick(6_000);
    }

    expect(patchBodies().length).toBeLessThanOrEqual(PREFERENCES_UPDATES_PER_MINUTE);
    // Y no es que no se guarde nada: al vaciarse el piso sale el valor final,
    // que es el que el usuario dejó en pantalla.
    await tick(AUTOSAVE_MIN_INTERVAL_MS);
    expect(server.stored.influencerChance).toBe(50);
    expect(slider("Influencer frequency").value).toBe("50");
    expect(screen.getByText(SAVED)).toBeInTheDocument();
  });

  it("editar con un guardado en vuelo no lanza una segunda petición encima", async () => {
    server.hold = true;
    await mount();

    drag("Influencer frequency", 70);
    await tick(AUTOSAVE_DEBOUNCE_MS);
    expect(patchBodies()).toHaveLength(1);

    // El usuario sigue moviendo el slider mientras la primera petición viaja.
    drag("Influencer frequency", 90);
    await tick(AUTOSAVE_DEBOUNCE_MS);
    expect(patchBodies()).toHaveLength(1);

    server.hold = false;
    await act(async () => {
      server.release?.();
      await vi.advanceTimersByTimeAsync(1);
    });

    await tick(AUTOSAVE_MIN_INTERVAL_MS);

    // La segunda petición lleva **el valor final**, no el intermedio: el cuerpo
    // se calcula al mandarlo, no al agendarlo. Si se encolaran cuerpos, acá
    // saldrían dos PATCH con 70 y 90 y el usuario habría gastado dos de sus
    // tres peticiones del minuto en un estado que ya descartó.
    expect(patchBodies()).toEqual([{ influencerChance: 70 }, { influencerChance: 90 }]);
    expect(server.stored.influencerChance).toBe(90);
  });

  it("`Try again` después de un fallo NO se salta el piso de cadencia", async () => {
    server.failNext = networkFailure();
    await mount();

    drag("Influencer frequency", 70);
    await tick(AUTOSAVE_DEBOUNCE_MS);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(patchBodies()).toHaveLength(1);

    // `fireEvent` y no `userEvent`: el segundo mete sus propias esperas, que
    // con el reloj congelado no avanzan (misma familia de trampa que
    // `waitFor`).
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await tick(1_000);
    // Un botón de reintento que dispara al instante es la forma más rápida de
    // que el usuario se coma el 429 tres clicks después.
    expect(patchBodies()).toHaveLength(1);

    await tick(AUTOSAVE_MIN_INTERVAL_MS);
    expect(patchBodies()).toHaveLength(2);
    expect(server.stored.influencerChance).toBe(70);
    expect(screen.getByText(SAVED)).toBeInTheDocument();
  });
});

describe("los cuatro pesos, que el servidor valida como unidad", () => {
  it("mover uno manda los cuatro, y suman exactamente 100", async () => {
    await mount();

    drag("Slideshow", 40);
    await tick(AUTOSAVE_DEBOUNCE_MS);

    const [body] = patchBodies();
    // Los cuatro, o `400`: un set parcial lo rechaza el contrato aunque los
    // valores sean correctos.
    expect(body).toEqual({
      slideshowWeight: 40,
      wallOfTextWeight: 20,
      greenScreenWeight: 20,
      videoHookWeight: 20,
    });
    // Y lo que se ve en pantalla es lo que se mandó: el reequilibrio no es
    // invisible, el usuario puede corregirlo.
    expect(slider("Wall of text").value).toBe("20");
    expect(screen.getByText("100 / 100")).toBeInTheDocument();
  });

  it("dos ajustes seguidos del mix siguen mandando un conjunto válido", async () => {
    await mount();

    drag("Slideshow", 40);
    await tick(AUTOSAVE_DEBOUNCE_MS);
    drag("Green screen", 10);
    await tick(AUTOSAVE_MIN_INTERVAL_MS);

    const bodies = patchBodies();
    expect(bodies).toHaveLength(2);
    const second = bodies[1] ?? {};
    const sum =
      Number(second["slideshowWeight"]) +
      Number(second["wallOfTextWeight"]) +
      Number(second["greenScreenWeight"]) +
      Number(second["videoHookWeight"]);
    expect(sum).toBe(100);
    expect(second["greenScreenWeight"]).toBe(10);
  });
});

describe("genderFilter — el `null` es un valor", () => {
  it("quitar el filtro manda `null`, no se queda sin mandar", async () => {
    server.stored = preferences({ genderFilter: "woman" });
    await mount();

    fireEvent.change(screen.getByLabelText("Gender filter"), { target: { value: "" } });
    await tick(AUTOSAVE_DEBOUNCE_MS);

    // Con un `patch.genderFilter ?? base` este PATCH no existiría y la
    // pantalla enseñaría "sin filtro" mientras el servidor sigue filtrando.
    expect(patchBodies()).toEqual([{ genderFilter: null }]);
    expect(server.stored.genderFilter).toBeNull();
  });
});
