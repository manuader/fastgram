/**
 * Automations en la web — la lista, el wizard y la revisión (`FR-150`).
 *
 * Lo que persigue: los estados de la lista (vacío, error, fila con progreso);
 * que el wizard no avanza sin lo mínimo, que YouTube obliga a slideshow en 0 y
 * que "Generate" crea y genera; y en el detalle, las vistas Calendar/Grid, el
 * `Post details` que edita y re-rolla, y `Continue to launch` con los gates
 * (y `Ready to launch` cuando no hay ninguno). El corte del mock es
 * `apiRequest` / `apiSend`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationSlot, LaunchValidation } from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { ApiRequestError } from "@/lib/api/errors";
import { AutomationsList } from "./AutomationsList";
import { AutomationWizard } from "./AutomationWizard";
import { AutomationDetail } from "./AutomationDetail";

import type * as ApiClient from "@/lib/api/client";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiRequest: vi.fn(),
  apiList: vi.fn(),
  apiSend: vi.fn(),
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);

const ID = "0b8f3c1e-5d7a-4f2b-9c61-1a2b3c4d5e6f";

const AUTOMATION: Automation = {
  id: ID,
  name: "Octubre en redes",
  status: "REVIEW",
  accounts: [
    { platform: "instagram", accountType: "planned" },
    { platform: "youtube", accountType: "planned" },
  ],
  perAccountPerDay: 1,
  durationWeeks: 1,
  startDate: "2026-10-05",
  startDateUtc: Date.UTC(2026, 9, 5),
  timezone: "UTC",
  postingTimes: null,
  postingMode: "inbox",
  youtubePrivacyStatus: "public",
  discloseAsAds: false,
  aiContentDisclaimer: false,
  prefsSnapshot: {
    slideshowWeight: 0,
    wallOfTextWeight: 60,
    greenScreenWeight: 40,
    videoHookWeight: 0,
    remixPercentage: 0,
    ownMediaPercentage: 100,
    mentionBusinessPercentage: 0,
    influencerChance: 0,
    angleWeights: {},
    textStyleWeights: {},
    topics: [],
  },
  generationQuota: 14,
  generationQuotaUsed: 7,
  failureCode: null,
  launchValidation: null,
  progress: { total: 2, byStatus: { READY: 2 } },
  stats: {
    posts: 0,
    published: 0,
    pending: 0,
    failed: 0,
    views: 0,
    likes: 0,
    comments: 0,
  },
  createdAt: 1,
  updatedAt: 1,
  launchedAt: null,
  cancelledAt: null,
  completedAt: null,
};

const SLOT = (over: Partial<AutomationSlot>): AutomationSlot => ({
  id: "slot-1",
  index: 0,
  status: "READY",
  contentType: "wall-of-text",
  scheduledAt: Date.UTC(2026, 9, 5, 9),
  generatedText: "Tres errores al moler café",
  texts: ["Tres errores al moler café"],
  aiExplanation: "Encaja con la marca",
  topic: null,
  captionsByPlatform: {
    instagram: { caption: "Tres errores al moler café" },
    youtube: { caption: "Tres errores", description: "Tres errores al moler café" },
  },
  failureReason: null,
  errorCode: null,
  contentId: null,
  preview: null,
  generationAttempts: 1,
  posts: [],
  ...over,
});

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requestMock.mockReset();
  push.mockReset();
});

describe("lista (/automations)", () => {
  it("vacío: invita a crear la primera", async () => {
    requestMock.mockResolvedValue([]);
    wrap(<AutomationsList />);
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New automation/ })).toHaveAttribute(
      "href",
      "/automations/new",
    );
  });

  it("error: lo dice y deja reintentar", async () => {
    requestMock.mockRejectedValue(
      new ApiRequestError({ code: "network_error", status: 0 }),
    );
    wrap(<AutomationsList />);
    expect(
      await screen.findByText("We couldn't load your automations."),
    ).toBeInTheDocument();
  });

  it("una fila con estado, redes y progreso", async () => {
    requestMock.mockResolvedValue([AUTOMATION]);
    wrap(<AutomationsList />);
    const row = await screen.findByTestId("automation-row");
    const r = within(row);
    expect(r.getByText("Octubre en redes")).toBeInTheDocument();
    expect(r.getByText("In review")).toBeInTheDocument();
    expect(r.getByText("YouTube")).toBeInTheDocument();
    expect(r.getAllByText("2 of 2 ready").length).toBeGreaterThan(0);
    expect(row).toHaveAttribute("href", `/automations/${ID}`);
  });
});

describe("wizard (/automations/new)", () => {
  beforeEach(() => {
    requestMock.mockImplementation(async (path, options) => {
      if (path === "strategy") return { timezone: "UTC" };
      if (path === "/connections/accounts") return [];
      if (path === "/automations" && options?.method === "POST")
        return { ...AUTOMATION, status: "DRAFT", id: ID };
      if (path === `/automations/${ID}/generate`)
        return { ...AUTOMATION, status: "GENERATING" };
      throw new Error(`inesperado: ${String(path)}`);
    });
  });

  it("no avanza sin nombre, y YouTube obliga a slideshow en 0 antes de generar", async () => {
    const user = userEvent.setup();
    wrap(<AutomationWizard />);
    await screen.findByLabelText("Automation setup progress");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Give the campaign a name.")).toBeInTheDocument();

    await user.type(await screen.findByLabelText("Campaign name"), "Octubre");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Accounts: YouTube planificado.
    await user.selectOptions(
      await screen.findByLabelText("Where to post on YouTube"),
      "planned",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Content: el mix 25×4 trae slideshow > 0 → se ofrece ponerlo en 0.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("YouTube destinations need Slideshow at 0%."),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Set Slideshow to 0%" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.click(await screen.findByRole("button", { name: "Generate" }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/automations/${ID}`);
    });
    const post = requestMock.mock.calls.find(
      ([p, o]) => p === "/automations" && o?.method === "POST",
    );
    const body = post?.[1]?.body as {
      prefs: { slideshowWeight: number };
      accounts: unknown[];
    };
    expect(body.prefs.slideshowWeight).toBe(0);
    expect(body.accounts).toEqual([{ platform: "youtube", accountType: "planned" }]);
    expect(
      requestMock.mock.calls.some(([p]) => p === `/automations/${ID}/generate`),
    ).toBe(true);
  });
});

describe("detalle y revisión (/automations/:id)", () => {
  let slots: AutomationSlot[];
  let validation: LaunchValidation;

  beforeEach(() => {
    slots = [
      SLOT({}),
      SLOT({
        id: "slot-2",
        index: 1,
        scheduledAt: Date.UTC(2026, 9, 6, 9),
        status: "FAILED_GEN",
        failureReason: "no_unique_content",
        generatedText: null,
        texts: [],
      }),
    ];
    validation = {
      ok: false,
      checkedAt: 1,
      gates: [{ code: "content_generating", details: { slots: 1 } }],
      summary: { readySlots: 1, destinations: 2, posts: 2, contentSaves: 1 },
    };
    requestMock.mockImplementation(async (path, options) => {
      if (path === `/automations/${ID}`) return AUTOMATION;
      if (path === `/automations/${ID}/slots`) return slots;
      if (path === `/automations/${ID}/launch-validation`) return validation;
      if (path === `/automations/${ID}/slots/slot-1` && options?.method === "PATCH")
        return { ...SLOT({}), generatedText: "Nuevo" };
      if (path === `/automations/${ID}/slots/slot-2/reroll`)
        return SLOT({ id: "slot-2", status: "REROLLING" });
      throw new Error(`inesperado: ${String(path)}`);
    });
  });

  it("Calendar view y Grid view, con el motivo de un slot fallido", async () => {
    const user = userEvent.setup();
    wrap(<AutomationDetail automationId={ID} />);
    expect(await screen.findByTestId("slot-calendar")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Grid view" }));
    const grid = await screen.findByTestId("slot-grid");
    expect(
      within(grid).getByText("Every draft repeated something you already posted."),
    ).toBeInTheDocument();
  });

  it("Post details: edita texto y captions (el mapa entero) y re-rolla un fallido", async () => {
    const user = userEvent.setup();
    wrap(<AutomationDetail automationId={ID} />);
    await user.click(
      await screen.findByRole("button", { name: /9:00 AM · Wall of Text · Ready/ }),
    );
    const dialog = await screen.findByRole("dialog");
    const text = within(dialog).getByLabelText("Text 1");
    await user.clear(text);
    await user.type(text, "Nuevo");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const call = requestMock.mock.calls.find(([, o]) => o?.method === "PATCH");
      expect(call?.[1]?.body).toMatchObject({
        texts: ["Nuevo"],
        captionsByPlatform: {
          instagram: { caption: "Tres errores al moler café" },
          youtube: { caption: "Tres errores", description: "Tres errores al moler café" },
        },
      });
    });

    await user.click(
      await screen.findByRole("button", { name: /Wall of Text · Couldn't generate/ }),
    );
    const second = await screen.findByRole("dialog");
    // Sólo los formatos con peso > 0 (y sin slideshow por YouTube).
    const select = within(second).getByLabelText("Format for the re-roll");
    expect(within(select).queryByRole("option", { name: "Slideshow" })).toBeNull();
    await user.selectOptions(select, "green-screen");
    await user.click(
      within(second).getByRole("button", { name: "Re-roll this suggestion" }),
    );
    await waitFor(() => {
      const call = requestMock.mock.calls.find(
        ([p]) => p === `/automations/${ID}/slots/slot-2/reroll`,
      );
      expect(call?.[1]?.body).toEqual({ contentType: "green-screen" });
    });
  });

  it("Continue to launch: enumera los gates, y con todo bien dice Ready to launch", async () => {
    const user = userEvent.setup();
    wrap(<AutomationDetail automationId={ID} />);
    await user.click(await screen.findByRole("button", { name: "Continue to launch" }));
    expect(await screen.findByText("Content is still generating")).toBeInTheDocument();
    expect(
      screen.getByText("Wait for generation or re-rolls to finish, then try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch campaign" })).toBeDisabled();

    validation = { ...validation, ok: true, gates: [] };
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Ready to launch")).toBeInTheDocument();
    expect(
      screen.getByText("Everything checks out. Your posts will be reserved on launch."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch campaign" })).toBeEnabled();
  });

  it("404: la campaña no existe (o es de otra marca)", async () => {
    requestMock.mockRejectedValue(
      new ApiRequestError({ code: "not_found", status: 404 }),
    );
    wrap(<AutomationDetail automationId={ID} />);
    expect(await screen.findByText("Automation not found")).toBeInTheDocument();
  });
});
