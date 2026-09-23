/**
 * `expectedOrigin` decide contra qué se compara el `Origin`. El caso que
 * importa es producción sin configuración: adivinar ahí es aceptar lo que no
 * hay que aceptar, así que falla cerrado.
 */
import { describe, expect, it } from "vitest";
import { APP_ORIGIN_ENV, checkCsrf, expectedOrigin } from "./csrf";

describe("expectedOrigin", () => {
  it("con la variable, su origen normalizado (sin path ni barra final)", () => {
    expect(
      expectedOrigin({ [APP_ORIGIN_ENV]: "https://App.Fastgram.test/ruta/" }, "x"),
    ).toEqual({
      ok: true,
      origin: "https://app.fastgram.test",
    });
  });

  it("una variable que no es URL http(s) es un error de configuración, no un origen", () => {
    expect(expectedOrigin({ [APP_ORIGIN_ENV]: "app.fastgram.test" }, "x")).toEqual({
      ok: false,
      reason: "app_origin_invalid",
    });
    expect(
      expectedOrigin({ [APP_ORIGIN_ENV]: "javascript:alert(1)" }, "x"),
    ).toMatchObject({
      ok: false,
    });
  });

  it("en producción sin variable, falla cerrado aunque haya Host", () => {
    expect(expectedOrigin({ NODE_ENV: "production" }, "app.fastgram.test")).toEqual({
      ok: false,
      reason: "app_origin_required",
    });
  });

  it("fuera de producción sin variable, http://<Host>", () => {
    expect(expectedOrigin({ NODE_ENV: "development" }, "LocalHost:3000")).toEqual({
      ok: true,
      origin: "http://localhost:3000",
    });
  });

  it("sin Host no hay origen propio contra el que comparar", () => {
    const expected = expectedOrigin({ NODE_ENV: "development" }, null);
    expect(expected).toEqual({ ok: true, origin: "" });
    expect(
      checkCsrf({ origin: "http://", secFetchSite: null, csrfHeader: "1", expected: "" }),
    ).toBe("missing_host");
  });
});

describe("checkCsrf", () => {
  const ok = {
    origin: "http://localhost:3000",
    secFetchSite: "same-origin",
    csrfHeader: "1",
    expected: "http://localhost:3000",
  };

  it("pasa con las tres guardas en orden", () => {
    expect(checkCsrf(ok)).toBeNull();
  });

  it("sin Sec-Fetch-Site (navegador sin Fetch Metadata) decide el Origin", () => {
    expect(checkCsrf({ ...ok, secFetchSite: null })).toBeNull();
  });

  it("`Origin: null` (iframe sandbox, file://) es ajeno", () => {
    expect(checkCsrf({ ...ok, origin: "null" })).toBe("origin_mismatch");
  });

  it("el header custom con otro valor no vale", () => {
    expect(checkCsrf({ ...ok, csrfHeader: "0" })).toBe("missing_csrf_header");
  });
});
