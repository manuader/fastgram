/**
 * «What Blitz learned» — sprint 9 (Q). El corte está en `apiRequest`, como en
 * `BlitzSettingsForm.test.tsx`: el doble responde por ruta y guarda lo que
 * recibe, así se ve qué manda cada control.
 */
import { preferencesViewSchema, type PreferencesView } from "@fastgram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api/errors";
import { WhatBlitzLearned } from "./WhatBlitzLearned";
import { phraseOf } from "./phrases";

import type * as ApiClient from "@/lib/api/client";

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
}));

import { apiRequest, type ApiRequestOptions } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

function view(overrides: Partial<PreferencesView> = {}): PreferencesView {
  return preferencesViewSchema.parse({
    scope: "brand",
    settings: {
      enabled: true,
      exploration: 0.15,
      halfLifeDays: 30,
      explorationSource: "owner",
      halfLifeSource: "owner",
    },
    ownerDefaults: { exploration: 0.15, halfLifeDays: 30 },
    signals: { total: 16, lastAt: 1_790_596_800_000 },
    learned: [
      {
        feature: "clip.kind=reaction",
        family: "clip.kind",
        value: "reaction",
        label: null,
        aspect: "clip",
        direction: "likes",
        score: 0.62,
        accepts: 12,
        total: 14,
        evidence: 14,
        source: "brand",
      },
      {
        feature: "bg.tone=dark",
        family: "bg.tone",
        value: "dark",
        label: null,
        aspect: "background",
        direction: "avoids",
        score: -0.6,
        accepts: 1,
        total: 5,
        evidence: 5,
        source: "owner",
      },
    ],
    computedAt: 1_790_596_800_000,
    ...overrides,
  });
}

type Handler = (path: string, options?: ApiRequestOptions<unknown>) => Promise<unknown>;

function serve(handler: Handler): void {
  requestMock.mockImplementation((path, options) => handler(path, options));
}

function calls(method: string): { path: string; body: unknown }[] {
  return requestMock.mock.calls
    .filter(([, o]) => (o?.method ?? "GET") === method)
    .map(([path, o]) => ({ path, body: o?.body }));
}

function renderIt() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<WhatBlitzLearned />, { wrapper: Wrapper });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe("frases por código", () => {
  it("«You accept reaction memes» · 12 of 14; lo evitado y editable dice «skip or swap»", () => {
    const v = view();
    expect(phraseOf(v.learned[0]!)).toEqual({
      text: "You accept reaction memes",
      evidence: "12 of 14",
    });
    expect(phraseOf(v.learned[1]!)).toEqual({
      text: "You usually skip or swap dark backgrounds",
      evidence: "4 of 5",
    });
  });

  it("un valor que la web no conoce no se muestra", () => {
    const item = { ...view().learned[0]!, value: "hologram" };
    expect(phraseOf(item)).toBeNull();
  });

  it("un id sin nombre usa la frase genérica", () => {
    const item = {
      ...view().learned[0]!,
      feature: "angle=0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a",
      family: "angle" as const,
      value: "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a",
      aspect: null,
    };
    expect(phraseOf(item)?.text).toBe("You accept one of your angles");
    expect(phraseOf({ ...item, label: "Myths" })?.text).toBe(
      "You accept the “Myths” angle",
    );
  });
});

describe("<WhatBlitzLearned />", () => {
  it("loading → lista con evidencia, y marca lo que viene de otras marcas", async () => {
    serve(() => Promise.resolve(view()));
    renderIt();
    expect(
      screen.getByRole("status", { name: "Loading what Blitz learned…" }),
    ).toBeTruthy();

    const list = await screen.findByRole("list", { name: "What Blitz learned" });
    expect(within(list).getByText("You accept reaction memes")).toBeTruthy();
    expect(within(list).getByText("12 of 14")).toBeTruthy();
    expect(within(list).getByText(/from your other brands/)).toBeTruthy();
    expect(screen.getByText("16 decisions so far")).toBeTruthy();
    expect(calls("GET").map((c) => c.path)).toEqual(["/preferences"]);
  });

  it("empty: nada aprendido todavía, con cuántas decisiones van", async () => {
    serve(() =>
      Promise.resolve(view({ learned: [], signals: { total: 1, lastAt: null } })),
    );
    renderIt();
    expect(await screen.findByText("Nothing learned yet")).toBeTruthy();
    expect(screen.getByText(/1 decision so far/)).toBeTruthy();
  });

  it("error: muestra el estado de error y reintenta", async () => {
    let fail = true;
    serve(() =>
      fail
        ? Promise.reject(new ApiRequestError({ code: "network_error", status: 0 }))
        : Promise.resolve(view()),
    );
    renderIt();
    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText("You accept reaction memes")).toBeTruthy();
  });

  it("la exploración se guarda al elegirla; «My default» manda null", async () => {
    serve((_path, o) =>
      Promise.resolve(
        o?.method === "PATCH"
          ? view({
              settings: {
                ...view().settings,
                exploration: 0.3,
                explorationSource: "brand",
              },
            })
          : view(),
      ),
    );
    renderIt();
    const select = await screen.findByLabelText("Try something different");
    fireEvent.change(select, { target: { value: "0.3" } });
    await waitFor(() => {
      expect(calls("PATCH")).toEqual([
        { path: "/preferences", body: { exploration: 0.3 } },
      ]);
    });
    fireEvent.change(await screen.findByLabelText("Try something different"), {
      target: { value: "" },
    });
    await waitFor(() => {
      expect(calls("PATCH").at(-1)).toEqual({
        path: "/preferences",
        body: { exploration: null },
      });
    });
  });

  it("apagar para esta marca", async () => {
    serve(() => Promise.resolve(view()));
    renderIt();
    fireEvent.click(
      await screen.findByRole("switch", {
        name: "Use what Blitz learned for this brand",
      }),
    );
    await waitFor(() => {
      expect(calls("PATCH")).toEqual([
        { path: "/preferences", body: { enabled: false } },
      ]);
    });
  });

  it("reset: pide confirmación y manda confirm: true", async () => {
    serve(() => Promise.resolve(view()));
    renderIt();
    fireEvent.click(
      await screen.findByRole("button", { name: "Forget this brand's learning" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(calls("POST")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
    await waitFor(() => {
      expect(calls("POST")).toEqual([
        { path: "/preferences/reset", body: { scope: "brand", confirm: true } },
      ]);
    });
  });

  it("todas mis marcas: pide la vista del dueño y el reset es del dueño", async () => {
    serve((path) =>
      Promise.resolve(
        path === "/preferences/owner"
          ? view({
              scope: "owner",
              settings: { ...view().settings, explorationSource: "owner" },
            })
          : view(),
      ),
    );
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "All my brands" }));
    expect(
      await screen.findByRole("button", { name: "Forget the shared learning" }),
    ).toBeTruthy();
    expect(calls("GET").map((c) => c.path)).toContain("/preferences/owner");
    // El dueño no tiene on/off: eso es por marca.
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
