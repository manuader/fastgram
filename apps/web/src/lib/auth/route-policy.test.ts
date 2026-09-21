/**
 * Las guards son lo único de esta shell que **no** se ve abriendo el navegador:
 * un redirect que sobra o que falta se manifiesta como "la app no carga" o,
 * peor, como una pantalla que alguien no debería estar viendo. Por eso la regla
 * es una función pura y por eso tiene test.
 */
import { describe, expect, it } from "vitest";
import { resolveGuard, RETURN_TO_PARAM } from "./route-policy";
import type { Session } from "./session";

const ready: Session = {
  userId: "u1",
  companyId: "c1",
  onboardingComplete: true,
  isStaff: false,
};
const mid: Session = { ...ready, onboardingComplete: false };

describe("resolveGuard · sin sesión", () => {
  it("manda `/` al login", () => {
    expect(resolveGuard({ pathname: "/", session: null })).toEqual({
      redirectTo: "/login",
    });
  });

  it("deja pasar las rutas públicas", () => {
    for (const pathname of [
      "/login",
      "/login/factor-two",
      "/signup",
      "/status",
      "/auth/sso-callback",
      "/auth/tiktok/callback",
      "/partner/checkout/success",
    ]) {
      expect(resolveGuard({ pathname, session: null })).toBeNull();
    }
  });

  it("guarda a dónde iba, para volver después del login", () => {
    expect(resolveGuard({ pathname: "/calendar", session: null })).toEqual({
      redirectTo: `/login?${RETURN_TO_PARAM}=%2Fcalendar`,
    });
  });

  it("no confunde un prefijo con un segmento", () => {
    // `/logout-everywhere` NO es hijo de `/logout`: si `startsWith` se hiciera
    // sin la barra, una ruta futura con ese nombre entraría sin sesión.
    expect(resolveGuard({ pathname: "/logout-everywhere", session: null })).toEqual({
      redirectTo: `/login?${RETURN_TO_PARAM}=%2Flogout-everywhere`,
    });
  });
});

describe("resolveGuard · con sesión", () => {
  it("manda `/` a home", () => {
    expect(resolveGuard({ pathname: "/", session: ready })).toEqual({
      redirectTo: "/home",
    });
  });

  it("saca del login a quien ya entró", () => {
    expect(resolveGuard({ pathname: "/login", session: ready })).toEqual({
      redirectTo: "/home",
    });
  });

  it("deja la app en paz", () => {
    expect(resolveGuard({ pathname: "/home", session: ready })).toBeNull();
    expect(resolveGuard({ pathname: "/content/slideshow", session: ready })).toBeNull();
  });

  it("devuelve al wizard a quien no terminó el alta", () => {
    expect(resolveGuard({ pathname: "/home", session: mid })).toEqual({
      redirectTo: "/onboarding",
    });
  });

  it("pero no lo encierra: logout, upgrade y status siguen accesibles", () => {
    for (const pathname of ["/onboarding", "/logout", "/upgrade", "/status"]) {
      expect(resolveGuard({ pathname, session: mid })).toBeNull();
    }
  });

  it("no deja volver al wizard ya terminado", () => {
    expect(resolveGuard({ pathname: "/onboarding", session: ready })).toEqual({
      redirectTo: "/home",
    });
  });

  it("no hay bucle: el destino de cada redirect se queda quieto", () => {
    for (const session of [null, ready, mid]) {
      const first = resolveGuard({ pathname: "/home", session });
      if (first === null) continue;
      const target = first.redirectTo.split("?")[0] ?? "";
      expect(resolveGuard({ pathname: target, session })).toBeNull();
    }
  });
});
