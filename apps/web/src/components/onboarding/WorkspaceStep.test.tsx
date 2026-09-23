/**
 * `/onboarding` sin workspace · `P1-TENANT-001` (web), FR-010, §15.4.
 *
 * ## Dónde está el corte, y por qué no en `apiRequest`
 *
 * `OnboardingFlow.test.tsx` mockea `apiRequest`. Acá el corte está **más
 * abajo**, en `fetch`, porque dos de las cosas que hay que medir viven en el
 * cliente real: que la escritura salga por el proxy
 * (`/api/fastgram/v1/onboarding/workspace`) y que lleve el header anti-CSRF que
 * el proxy exige (`x-fastgram-csrf`). Con `apiRequest` mockeado, quitar ese
 * header seguiría verde.
 *
 * El doble enruta por método + path y **escribe** en su estado: tras el `201`,
 * `GET /onboarding` deja de ser `403` — igual que la API, que resuelve el
 * workspace de la sesión por request.
 *
 * ## Reloj real
 *
 * Nada de este paso es tiempo (no hay debounce ni polling hasta el paso 1, y
 * con cero fuentes el paso 1 no hace polling). Con fake timers `waitFor` no
 * avanza en vitest; con reloj real `findBy*` alcanza.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";
import { ApiRequestError } from "@/lib/api/errors";
import { OnboardingEntry } from "./OnboardingEntry";

const PROXY = "/api/fastgram/v1";
const BRAND_TITLE = "Where can we learn about your brand?";
const WORKSPACE_TITLE = "Create your workspace";

const WORKSPACE = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Mi Marca",
  websiteUrl: null,
  status: "draft",
  planId: "free",
  subscriptionStatus: "trialing",
  timezone: "UTC",
  createdAt: "2026-09-23T12:00:00.000Z",
};

const ONBOARDING = {
  step: "brand_source",
  sources: [],
  manualBranch: false,
  details: null,
  profiling: null,
  oauthConsents: 0,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const forbidden = () =>
  json(403, {
    error: {
      code: "forbidden",
      message: "Your account isn't an active member of any workspace yet.",
    },
  });

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

interface Server {
  hasWorkspace: boolean;
  /** Lo que contesta el alta. Por defecto, `201` (y el workspace pasa a existir). */
  create: (body: unknown) => Response | Promise<Response>;
  /** Lo que contesta `GET /onboarding` con workspace. */
  onboarding: () => Response | Promise<Response>;
  calls: Call[];
}

let server: Server;

function installServer(overrides: Partial<Server> = {}): void {
  server = {
    hasWorkspace: false,
    create: () => {
      server.hasWorkspace = true;
      return json(201, { data: WORKSPACE });
    },
    onboarding: () => json(200, { data: ONBOARDING }),
    calls: [],
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body =
        typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      server.calls.push({
        method,
        path: url.pathname,
        headers: new Headers(init.headers),
        body,
      });
      if (method === "POST" && url.pathname === `${PROXY}/onboarding/workspace`) {
        return server.create(body);
      }
      if (method === "GET" && url.pathname === `${PROXY}/onboarding`) {
        return server.hasWorkspace ? server.onboarding() : forbidden();
      }
      throw new Error(`ruta no esperada: ${method} ${url.pathname}`);
    }),
  );
}

beforeEach(() => {
  installServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function mount(hasWorkspace: boolean, client: QueryClient = newClient()) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<OnboardingEntry hasWorkspace={hasWorkspace} />, { wrapper: Wrapper });
}

function input(label: RegExp): HTMLInputElement {
  const found = screen.getByLabelText(label);
  if (!(found instanceof HTMLInputElement)) throw new Error("no es un input");
  return found;
}
const nameInput = () => input(/^Company Name$/);
const websiteInput = () => input(/^Company Website/);

function fill(name: string, website = ""): void {
  fireEvent.change(nameInput(), { target: { value: name } });
  fireEvent.change(websiteInput(), { target: { value: website } });
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

const posts = () =>
  server.calls.filter(
    (c) => c.method === "POST" && c.path === `${PROXY}/onboarding/workspace`,
  );
const onboardingGets = () =>
  server.calls.filter((c) => c.method === "GET" && c.path === `${PROXY}/onboarding`);

/** Un `Promise` que el test resuelve a mano: para mirar el estado *mientras* corre. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------

describe("sin workspace · el paso que lo crea", () => {
  it("es lo primero que se ve, y no pide GET /onboarding (sería un 403)", () => {
    mount(false);
    expect(
      screen.getByRole("heading", { level: 1, name: WORKSPACE_TITLE }),
    ).toBeVisible();
    // Label de verdad, no placeholder: `getByLabelText` falla si no hay `<label for>`.
    expect(nameInput()).toBeRequired();
    expect(websiteInput()).not.toBeRequired();
    expect(websiteInput()).toHaveAccessibleDescription(
      "No website? Leave it empty — you can add a social profile in the next step.",
    );
    expect(server.calls).toEqual([]);
  });

  it("201 → sale por el proxy con el header anti-CSRF, sin web = null, y sigue al paso 1", async () => {
    mount(false);
    fill("Mi Marca", "   ");
    submit();

    expect(
      await screen.findByRole("heading", { level: 1, name: BRAND_TITLE }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: WORKSPACE_TITLE })).toBeNull();

    expect(posts()).toHaveLength(1);
    const [post] = posts();
    expect(post?.body).toEqual({ name: "Mi Marca", websiteUrl: null });
    expect(post?.headers.get("x-fastgram-csrf")).toBe("1");
    expect(post?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // La API no la lee y el alta ya es idempotente por usuario.
    expect(post?.headers.get("idempotency-key")).toBeNull();

    // El paso 1 le preguntó a la API **después** del alta, y le contestó.
    expect(onboardingGets()).toHaveLength(1);
    expect(server.calls.indexOf(onboardingGets()[0] as Call)).toBeGreaterThan(
      server.calls.indexOf(post as Call),
    );
  });

  it("con web, la manda recortada", async () => {
    mount(false);
    fill("Mi Marca", "  mimarca.com ");
    submit();
    await screen.findByRole("heading", { level: 1, name: BRAND_TITLE });
    expect(posts()[0]?.body).toEqual({ name: "Mi Marca", websiteUrl: "mimarca.com" });
  });

  it("mientras crea: botón ocupado, formulario aria-busy, y un segundo envío no sale", async () => {
    const pending = deferred<Response>();
    installServer({
      create: () => pending.promise,
    });
    const { container } = mount(false);
    fill("Mi Marca");
    submit();

    const button = await screen.findByRole("button", {
      name: /Creating Workspace\.\.\./,
    });
    expect(button).toBeDisabled();
    expect(container.querySelector("form")).toHaveAttribute("aria-busy", "true");
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(posts()).toHaveLength(1);

    server.hasWorkspace = true;
    await act(async () => {
      pending.resolve(json(201, { data: WORKSPACE }));
      await pending.promise;
    });
    await screen.findByRole("heading", { level: 1, name: BRAND_TITLE });
    expect(posts()).toHaveLength(1);
  });
});

describe("409 workspace_already_exists · no es un error", () => {
  it("sigue al paso 1 sin mostrar ningún alert", async () => {
    installServer({
      hasWorkspace: true,
      create: () =>
        json(409, {
          error: {
            code: "conflict",
            message:
              "You already have a workspace. Creating additional workspaces isn't available yet.",
            details: { reason: "workspace_already_exists" },
          },
        }),
    });
    mount(false);
    fill("Mi Marca");
    submit();

    expect(
      await screen.findByRole("heading", { level: 1, name: BRAND_TITLE }),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/already have a workspace/)).toBeNull();
    expect(onboardingGets()).toHaveLength(1);
  });
});

describe("errores de campo · asociados al input", () => {
  it("400 details.field=name → literal bajo el nombre, aria-invalid, descrito por él, con foco", async () => {
    installServer({
      create: () =>
        json(400, {
          error: {
            code: "bad_request",
            message: "Company name must be at least 2 characters",
            details: { field: "name", length: 1 },
          },
        }),
    });
    mount(false);
    fill("M");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Company name must be at least 2 characters");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(nameInput()).toHaveAccessibleDescription(
      "Company name must be at least 2 characters",
    );
    expect(nameInput().getAttribute("aria-describedby")).toBe(alert.id);
    expect(nameInput()).toHaveFocus();
    // El otro campo, intacto.
    expect(websiteInput()).not.toHaveAttribute("aria-invalid");
    // Sigue en el paso: un 400 no avanza.
    expect(
      screen.getByRole("heading", { level: 1, name: WORKSPACE_TITLE }),
    ).toBeVisible();

    // Corregir el campo retira su error.
    fireEvent.change(nameInput(), { target: { value: "Mi Marca" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
  });

  it("400 name vacío → 'Company name is required'", async () => {
    installServer({
      create: () =>
        json(400, {
          error: {
            code: "bad_request",
            message: "Company name is required",
            details: { field: "name" },
          },
        }),
    });
    mount(false);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Company name is required",
    );
    expect(posts()[0]?.body).toEqual({ name: "", websiteUrl: null });
  });

  it("409 website_already_registered → en el campo de web, con el literal de FR-010", async () => {
    installServer({
      create: () =>
        json(409, {
          error: {
            code: "conflict",
            message: "This website is already registered.",
            details: { reason: "website_already_registered", field: "websiteUrl" },
          },
        }),
    });
    mount(false);
    fill("Mi Marca", "tomada.com");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This website is already registered.");
    expect(websiteInput()).toHaveAttribute("aria-invalid", "true");
    expect(websiteInput().getAttribute("aria-describedby")?.split(" ")).toContain(
      alert.id,
    );
    expect(websiteInput()).toHaveFocus();
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
    // No confundirlo con el otro 409: no avanza.
    expect(onboardingGets()).toHaveLength(0);
  });

  it("400 SSRF en la web → su literal, no el genérico", async () => {
    installServer({
      create: () =>
        json(400, {
          error: {
            code: "bad_request",
            message: "Localhost URLs are not allowed",
            details: { field: "websiteUrl" },
          },
        }),
    });
    mount(false);
    fill("Mi Marca", "http://localhost");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Localhost URLs are not allowed",
    );
    expect(websiteInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("un literal que no está en la lista igual marca el campo, con el genérico del campo", async () => {
    installServer({
      create: () =>
        json(400, {
          error: {
            code: "bad_request",
            message: "Some new server wording",
            details: { field: "websiteUrl" },
          },
        }),
    });
    mount(false);
    fill("Mi Marca", "x");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please enter a valid website URL",
    );
    expect(screen.queryByText("Some new server wording")).toBeNull();
  });
});

describe("errores de formulario", () => {
  it("503 → alert sobre el botón con Try again, que reenvía", async () => {
    let attempt = 0;
    installServer({
      create: () => {
        attempt += 1;
        if (attempt === 1) {
          return json(503, {
            error: { code: "service_unavailable", message: "down" },
          });
        }
        server.hasWorkspace = true;
        return json(201, { data: WORKSPACE });
      },
    });
    mount(false);
    fill("Mi Marca");
    submit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That service isn't responding. Try again shortly.");
    expect(nameInput()).not.toHaveAttribute("aria-invalid");
    expect(websiteInput()).not.toHaveAttribute("aria-invalid");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 1, name: BRAND_TITLE });
    expect(posts()).toHaveLength(2);
  });

  it("401 → alert sin Try again (reintentar no arregla una sesión muerta)", async () => {
    installServer({
      create: () =>
        json(401, { error: { code: "unauthorized", message: "Sign in to continue." } }),
    });
    mount(false);
    fill("Mi Marca");
    submit();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

/**
 * Este test **no** protege una línea de código propio: `useCreateWorkspace` no
 * toca la caché. Lo que fija es una propiedad de TanStack de la que depende el
 * diseño —una query en error y sin datos vuelve a `pending` al montarse—, para
 * que un cambio de config global (`retryOnMount: false`) o de versión no la
 * rompa en silencio. Se midió: con y sin `removeQueries` en el hook, verde.
 */
describe("tras el alta, la caché de antes del workspace no se sirve", () => {
  it("un 403 de GET /onboarding ya en caché no aparece: el paso 1 espera la respuesta nueva", async () => {
    const client = newClient();
    // Lo que habría quedado si algo hubiera preguntado antes del alta.
    await client.prefetchQuery({
      queryKey: queryKeys.onboarding(),
      queryFn: () => {
        throw new ApiRequestError({ code: "forbidden", status: 403 });
      },
    });
    expect(client.getQueryState(queryKeys.onboarding())?.status).toBe("error");

    const answer = deferred<Response>();
    installServer({ onboarding: () => answer.promise });
    const { container } = mount(false, client);
    fill("Mi Marca");
    submit();

    // Señal neutral (trampa 38): el esqueleto del flujo, que existe en los dos mundos.
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Access Denied")).toBeNull();

    await act(async () => {
      answer.resolve(json(200, { data: ONBOARDING }));
      await answer.promise;
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: BRAND_TITLE }),
    ).toBeVisible();
  });
});

describe("con workspace · el flujo de siempre", () => {
  it("no muestra el paso del workspace y arranca en el paso 1", async () => {
    installServer({ hasWorkspace: true });
    mount(true);
    expect(
      await screen.findByRole("heading", { level: 1, name: BRAND_TITLE }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: WORKSPACE_TITLE })).toBeNull();
    expect(posts()).toHaveLength(0);
  });
});
