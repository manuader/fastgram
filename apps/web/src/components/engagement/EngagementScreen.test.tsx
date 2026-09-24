/**
 * Engagement → Actions · `FR-140`, `D-11`.
 *
 * El corte está en el cliente tipado (`apiRequest`), como en los tests de
 * Today. Las respuestas pasan por el schema del contrato antes de llegar al
 * doble: una forma que la API no puede devolver no entra.
 *
 * Lo que más importa: **"Send" no llama a la API sin pasar por el diálogo de
 * confirmación**, y con el ban meter en `danger` ni siquiera se habilita.
 */
import {
  engagementOverviewSchema,
  leadDetailSchema,
  leadListSchema,
  sendReplyResultSchema,
  type EngagementOverview,
  type Lead,
  type LeadDetail,
} from "@fastgram/contracts";
import { ToastProvider } from "@fastgram/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngagementScreen } from "./EngagementScreen";

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
  usePathname: () => "/engagement/actions",
}));

import { apiRequest } from "@/lib/api/client";

const requestMock = vi.mocked(apiRequest);
const LEAD_ID = "11111111-1111-4111-8111-111111111111";

function overview(level: EngagementOverview["banMeter"]["level"]): EngagementOverview {
  return engagementOverviewSchema.parse({
    settings: {
      subreddits: ["freelance"],
      keywords: ["invoice"],
      replyTone: "casual",
      customRules: "",
      allowLinks: false,
      discoveryEnabled: true,
    },
    configured: true,
    redditApp: {
      configured: true,
      clientId: "cid",
      hasSecret: true,
      developerUsername: "acme_dev",
      redirectUri: "http://localhost:3000/engagement/reddit/callback",
      scopes: ["identity", "read", "submit"],
      consoleUrl: "https://www.reddit.com/prefs/apps",
      policyUrl: "https://support.reddithelp.com/x",
    },
    account: {
      username: "acme_founder",
      status: "active",
      statusReason: null,
      scopes: ["identity", "read", "submit"],
      connectedAt: "2026-09-24T00:00:00.000Z",
    },
    discovery: { available: true, lastRunAt: null, lastOutcome: null, pausedUntil: null },
    banMeter: {
      level,
      promoRatio: level === "danger" ? 0.9 : 0.2,
      counts: { valueAdd: 8, subtle: 1, direct: 1, unlabeled: 0 },
      sampleSize: 10,
      smallSample: false,
      windowDays: 30,
      sendBlocked: level === "danger",
      computedAt: null,
    },
  });
}

const lead: Lead = {
  id: LEAD_ID,
  source: "discovery",
  redditPostId: "abc123",
  subreddit: "freelance",
  title: "Which invoice tool should I use?",
  body: "Need something simple.",
  author: "someone",
  url: "https://www.reddit.com/r/freelance/comments/abc123/x/",
  redditScore: 3,
  numComments: 2,
  postedAt: "2026-09-24T10:00:00.000Z",
  matchedKeywords: ["invoice"],
  scoreStatus: "scored",
  leadScore: 0.82,
  tier: "top",
  scoreComponents: {
    buyingSignal: 1,
    fitToAudience: 0.5,
    hasProblem: 0.9,
    replyWelcome: 0.8,
    alreadyAnswered: 0.1,
  },
  whyThisLead: "They ask for a tool.",
  engagementScore: 7,
  seen: true,
  newActivity: false,
  replied: false,
  repliedAt: null,
  threadState: null,
  ourComments: 0,
  repliesToUs: 0,
  lastSyncedAt: null,
  replyStatus: "ready",
  replyDraft: "Use a spreadsheet with due dates.",
  createdAt: "2026-09-24T11:00:00.000Z",
};

function detail(over: Partial<LeadDetail> = {}): LeadDetail {
  return leadDetailSchema.parse({
    lead,
    contextComments: [],
    replies: [],
    draftIssues: [],
    canSend: true,
    sendBlockedReason: null,
    ...over,
  });
}

function install(o: EngagementOverview, d: LeadDetail, leads: Lead[] = [lead]): void {
  requestMock.mockImplementation(async (rawPath: string) => {
    const path = rawPath.replace(/^\//, "");
    if (path === "engagement/overview") return o;
    if (path === "engagement/leads")
      return leadListSchema.parse({ items: leads, hasMore: false });
    if (path === `engagement/leads/${LEAD_ID}`) return d;
    if (path === `engagement/leads/${LEAD_ID}/send`) {
      return sendReplyResultSchema.parse({
        reply: {
          id: "22222222-2222-4222-8222-222222222222",
          text: lead.replyDraft,
          channel: "api",
          url: null,
          sentAt: "2026-09-24T12:00:00.000Z",
          tone: null,
        },
        lead: { ...lead, replied: true },
      });
    }
    throw new Error(`ruta inesperada: ${rawPath}`);
  });
}

function renderScreen(node: ReactNode = <EngagementScreen />): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

const sendCalls = () =>
  requestMock.mock.calls.filter(([p]) => String(p).endsWith(`/leads/${LEAD_ID}/send`));

afterEach(() => {
  requestMock.mockReset();
});

describe("EngagementScreen", () => {
  it("sin leads: el estado vacío literal del PRD", async () => {
    install(overview("safe"), detail(), []);
    renderScreen();
    expect(
      await screen.findByText(
        "Try adjusting your filters or fetch new leads to discover conversations where your audience is seeking solutions.",
      ),
    ).toBeTruthy();
  });

  it("Send pasa por la confirmación: cancelar no llama a la API; confirmar sí, con confirm e Idempotency-Key", async () => {
    install(overview("safe"), detail());
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByText("Which invoice tool should I use?"));
    await user.click(await screen.findByTestId("send-button"));
    expect(await screen.findByText("Post this reply on Reddit?")).toBeTruthy();

    // La negativa primero (trampa 35).
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sendCalls()).toHaveLength(0);

    await user.click(screen.getByTestId("send-button"));
    await user.click(await screen.findByTestId("confirm-send"));
    await vi.waitFor(() => {
      expect(sendCalls()).toHaveLength(1);
    });
    const [, options] = sendCalls()[0] as [
      string,
      { body: unknown; idempotencyKey?: string; method?: string },
    ];
    expect(options.method).toBe("POST");
    expect(options.body).toEqual({
      text: "Use a spreadsheet with due dates.",
      confirm: true,
    });
    expect(typeof options.idempotencyKey).toBe("string");
  });

  it("ban meter en Danger: Send deshabilitado y el motivo a la vista", async () => {
    install(
      overview("danger"),
      detail({ canSend: false, sendBlockedReason: "ban_meter_danger" }),
    );
    const user = userEvent.setup();
    renderScreen();
    expect(
      await screen.findByText("Danger - Very high risk, stop promotional engagement"),
    ).toBeTruthy();
    await user.click(await screen.findByText("Which invoice tool should I use?"));
    const send = await screen.findByTestId("send-button");
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByTestId("send-blocked")).textContent).toContain(
      "ban meter is in Danger",
    );
    expect(sendCalls()).toHaveLength(0);
  });

  it("la marca sin divulgación se muestra como problema del borrador", async () => {
    install(
      overview("safe"),
      detail({
        draftIssues: ["brand_without_disclosure"],
        canSend: false,
        sendBlockedReason: "reply_blocked",
      }),
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByText("Which invoice tool should I use?"));
    expect((await screen.findByTestId("draft-issues")).textContent).toContain(
      "without saying you're affiliated",
    );
  });
});
