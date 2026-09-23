/**
 * `/onboarding` decide en el servidor **qué** flujo monta: el de crear el
 * workspace o el de siempre. Lo decide con `readSessionState` — la misma
 * verificación contra `GET /auth/session` que el middleware.
 */
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/lib/auth/session";

const readSessionState = vi.fn<() => Promise<SessionState>>();
vi.mock("@/lib/auth/server-session", () => ({
  readSessionState: () => readSessionState(),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const { default: OnboardingPage } = await import("./page");
const { OnboardingEntry } = await import("@/components/onboarding/OnboardingEntry");

function authenticated(companyId: string | null): SessionState {
  return {
    kind: "authenticated",
    session: {
      userId: "u1",
      email: "a@b.test",
      companyId,
      onboardingComplete: companyId !== null,
      isStaff: false,
    },
  };
}

beforeEach(() => {
  readSessionState.mockReset();
});

describe("/onboarding · page", () => {
  it("sesión sin workspace → OnboardingEntry con hasWorkspace=false", async () => {
    readSessionState.mockResolvedValue(authenticated(null));
    const element = await OnboardingPage();
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(OnboardingEntry);
    expect(element.props).toEqual({ hasWorkspace: false });
  });

  it("sesión con workspace → hasWorkspace=true (el flujo de siempre)", async () => {
    readSessionState.mockResolvedValue(authenticated("c1"));
    const element = await OnboardingPage();
    expect(element.props).toEqual({ hasWorkspace: true });
  });

  it("sin sesión verificable → la misma salida que el middleware, con el motivo de §15.2", async () => {
    readSessionState.mockResolvedValue({ kind: "unverifiable" });
    await expect(OnboardingPage()).rejects.toMatchObject({
      to: "/login?reason=session_unverified&redirect_url=%2Fonboarding",
    });
  });

  it("anónimo → al login con vuelta a /onboarding", async () => {
    readSessionState.mockResolvedValue({ kind: "anonymous" });
    await expect(OnboardingPage()).rejects.toMatchObject({
      to: "/login?redirect_url=%2Fonboarding",
    });
  });
});
