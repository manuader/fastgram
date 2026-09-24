/**
 * Las tarjetas nuevas de `/brand` (sprint 7): propuestas (ERR-B14),
 * ángulos (AI-005) y cuestionario (F-006), contra un `apiRequest` falso.
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

import { apiList, apiRequest, type ApiRequestOptions } from "@/lib/api/client";
import { AnglesCard } from "./AnglesCard";
import { ProfilingCard } from "./ProfilingCard";
import { ProposalsCard } from "./ProposalsCard";

const requestMock = vi.mocked(apiRequest);
const listMock = vi.mocked(apiList);

const SRC = "11111111-1111-4111-8111-111111111111";
const ANGLE = "33333333-3333-4333-8333-333333333333";

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

const profileBody = {
  coreIdentity: "",
  productOffering: "Handmade mugs",
  uniqueBenefits: "",
  problemSolution: "",
  marketAndCompetition: "",
  businessCategories: [],
  expectations: [],
  brandRevision: 5,
  status: "ready",
  fieldMeta: {},
};

function answer(options: ApiRequestOptions<unknown> | undefined, value: unknown) {
  return Promise.resolve(
    options?.schema === undefined ? value : options.schema.parse(value),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProposalsCard · ERR-B14", () => {
  it("muestra la propuesta y Replace manda la referencia y la revisión vista", async () => {
    requestMock.mockImplementation((path, options) => {
      if (path === "/brand/profile/proposals") {
        return answer(options, {
          brandRevision: 4,
          proposals: [
            {
              field: "productOffering",
              value: "Handmade mugs",
              currentValue: "My words",
              confidence: "high",
              sourceId: SRC,
              sourceType: "website",
              excerpt: "we sell handmade mugs",
              excerptRef: "snap#productOffering",
              reason: "edited_by_user",
            },
          ],
        });
      }
      return answer(options, profileBody);
    });
    wrap(<ProposalsCard poll={false} />);
    expect(
      await screen.findByText("This source suggests a different answer — replace?"),
    ).toBeTruthy();
    expect(screen.getByText("My words")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/brand/profile/proposals/productOffering",
        expect.objectContaining({
          method: "POST",
          body: {
            action: "accept",
            excerptRef: "snap#productOffering",
            expectedBrandRevision: 4,
          },
        }),
      );
    });
  });

  it("sin propuestas no dibuja nada", async () => {
    requestMock.mockImplementation((_path, options) =>
      answer(options, { brandRevision: 1, proposals: [] }),
    );
    const { container } = wrap(<ProposalsCard poll={false} />);
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});

describe("AnglesCard · AI-005", () => {
  it("vacío → sugerir → guardar con expectedBrandRevision", async () => {
    listMock.mockResolvedValue({ items: [], cursor: null, hasMore: false });
    requestMock.mockImplementation((path, options) => {
      if (path === "/blitz/preferences") return Promise.reject(new Error("no"));
      if (path === "/blitz/angles/generate") {
        return answer(options, {
          title: "Kiln disasters",
          description: "What goes wrong in the kiln.",
          targetAudience: "Hobbyists",
          brandRevision: 9,
        });
      }
      if (path === "/blitz/angles") {
        return answer(options, {
          _id: ANGLE,
          title: "Kiln disasters",
          description: "What goes wrong in the kiln.",
          targetAudience: "Hobbyists",
          isActive: true,
          influencerIds: [],
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return Promise.reject(new Error(`ruta no esperada: ${path}`));
    });
    wrap(<AnglesCard />);
    expect(await screen.findByText("No content angles yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suggest an angle" }));
    expect(await screen.findByDisplayValue("Kiln disasters")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save angle" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "/blitz/angles",
        expect.objectContaining({
          method: "POST",
          body: {
            title: "Kiln disasters",
            description: "What goes wrong in the kiln.",
            targetAudience: "Hobbyists",
            expectedBrandRevision: 9,
          },
        }),
      );
    });
  });
});

describe("ProfilingCard · F-006", () => {
  it("sin respuestas dice la copy literal y no manda nada", async () => {
    wrap(<ProfilingCard profile={profileBody as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Please select your role")).toBeTruthy();
    expect(screen.getByText("Please select at least one business category")).toBeTruthy();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
