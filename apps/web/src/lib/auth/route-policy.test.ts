/**
 * Las guards son lo único de esta shell que **no** se ve abriendo el navegador:
 * un redirect que sobra o que falta se manifiesta como "la app no carga" o,
 * peor, como una pantalla que alguien no debería estar viendo. Por eso la regla
 * es una función pura y por eso tiene test.
 */
import { describe, expect, it } from "vitest";
import {
  resolveGuard,
  resolveNavigation,
  RETURN_TO_PARAM,
  safeReturnTo,
} from "./route-policy";
import type { Session } from "./session";

const ready: Session = {
  userId: "u1",
  email: "u1@example.test",
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

  /**
   * El fallo que esto evita no se ve en la pantalla que lo sufre: sin sesión,
   * un `fetch` a `/api/fastgram/v1/content` seguiría el 307 hasta `/login`,
   * recibiría **200 con HTML**, y la Library mostraría "el servidor mandó algo
   * que no entiendo" en vez de "no estás autenticado". El handler tiene que
   * poder contestar su propio 401 con el sobre de §9.3.
   */
  it("no redirige los route handlers: contestan ellos, con JSON", () => {
    for (const session of [null, ready, mid]) {
      expect(resolveGuard({ pathname: "/api/fastgram/v1/content", session })).toBeNull();
    }
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

describe("resolveNavigation · el estado verificado de la sesión", () => {
  it("authenticated se comporta como la guard con sesión", () => {
    expect(
      resolveNavigation("/login", { kind: "authenticated", session: ready }),
    ).toEqual({
      redirectTo: "/home",
      clearSessionCookie: false,
    });
    expect(resolveNavigation("/home", { kind: "authenticated", session: ready })).toEqual(
      {
        redirectTo: null,
        clearSessionCookie: false,
      },
    );
  });

  it("sin workspace (companyId null) → /onboarding", () => {
    const noCompany: Session = { ...ready, companyId: null, onboardingComplete: false };
    expect(
      resolveNavigation("/home", { kind: "authenticated", session: noCompany })
        .redirectTo,
    ).toBe("/onboarding");
  });

  it("rejected (401 de la API) va al login como sin sesión y borra la cookie", () => {
    expect(resolveNavigation("/calendar", { kind: "rejected" })).toEqual({
      redirectTo: `/login?${RETURN_TO_PARAM}=%2Fcalendar`,
      clearSessionCookie: true,
    });
    // En una ruta pública no redirige, pero la cookie muerta se borra igual.
    expect(resolveNavigation("/login", { kind: "rejected" })).toEqual({
      redirectTo: null,
      clearSessionCookie: true,
    });
  });

  it("unverifiable NO es 'sin sesión': login con el motivo de §15.2, sin borrar la cookie", () => {
    const decision = resolveNavigation("/calendar", { kind: "unverifiable" });
    expect(decision.clearSessionCookie).toBe(false);
    const url = new URL(decision.redirectTo ?? "", "http://x");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("reason")).toBe("session_unverified");
    expect(url.searchParams.get(RETURN_TO_PARAM)).toBe("/calendar");
  });

  it("unverifiable deja pasar lo público y /logout: salir no depende de la API", () => {
    for (const pathname of [
      "/login",
      "/signup",
      "/status",
      "/logout",
      "/forgot-password",
    ]) {
      expect(resolveNavigation(pathname, { kind: "unverifiable" }).redirectTo).toBeNull();
    }
  });

  it("anonymous es la guard sin sesión, sin tocar cookies", () => {
    expect(resolveNavigation("/home", { kind: "anonymous" })).toEqual({
      redirectTo: `/login?${RETURN_TO_PARAM}=%2Fhome`,
      clearSessionCookie: false,
    });
  });

  it("los route handlers no se tocan en ningún estado", () => {
    for (const state of [
      { kind: "anonymous" },
      { kind: "rejected" },
      { kind: "unverifiable" },
    ] as const) {
      expect(resolveNavigation("/api/fastgram/v1/content", state)).toEqual({
        redirectTo: null,
        clearSessionCookie: false,
      });
    }
  });

  it("las rutas de recuperación son públicas", () => {
    expect(resolveGuard({ pathname: "/forgot-password", session: null })).toBeNull();
    expect(resolveGuard({ pathname: "/reset-password", session: null })).toBeNull();
  });
});

describe("safeReturnTo · el login no es un redirector abierto", () => {
  it("acepta rutas relativas de la app, con query", () => {
    expect(safeReturnTo("/calendar")).toBe("/calendar");
    expect(safeReturnTo("/library?tab=media")).toBe("/library?tab=media");
  });

  it("rechaza todo lo que el navegador leería como otro host", () => {
    for (const raw of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "/\tevil",
      "javascript:alert(1)",
      "evil.test",
      "",
    ]) {
      expect(safeReturnTo(raw)).toBeNull();
    }
    expect(safeReturnTo("/\u0009/evil.test")).toBeNull();
  });

  it("no devuelve al login, al signup ni al logout", () => {
    expect(safeReturnTo("/login")).toBeNull();
    expect(safeReturnTo("/signup?x=1")).toBeNull();
    expect(safeReturnTo("/logout")).toBeNull();
  });

  it("null y undefined → null", () => {
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
  });
});
