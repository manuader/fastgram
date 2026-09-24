import { describe, expect, it } from "vitest";
import { OAUTH_PLATFORMS } from "@fastgram/ports";

import {
  applyIntegrationUpdate,
  resolveRedirectBase,
  toPublicIntegrationApp,
  redirectAllowed,
} from "./integrations.js";
import { OAUTH_PLATFORM_SPECS, publishScopesOf, requestedScopesOf } from "./platforms.js";

describe("specs de YouTube y LinkedIn — PU-LATER-001/002", () => {
  it("hay spec para cada plataforma con OAuth", () => {
    for (const p of OAUTH_PLATFORMS) expect(OAUTH_PLATFORM_SPECS[p].platform).toBe(p);
  });

  it("youtube pide upload + readonly; publicar exige los dos (readonly da la identidad)", () => {
    expect(publishScopesOf("youtube")).toEqual([
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ]);
    // Google exime localhost de https: la redirect local sirve.
    expect(redirectAllowed(OAUTH_PLATFORM_SPECS.youtube, resolveRedirectBase({}))).toBe(
      true,
    );
  });

  it("linkedin exige https (doc) y los scopes de Páginas son opcionales", () => {
    expect(redirectAllowed(OAUTH_PLATFORM_SPECS.linkedin, resolveRedirectBase({}))).toBe(
      false,
    );
    expect(requestedScopesOf("linkedin", undefined)).toEqual([
      "openid",
      "profile",
      "w_member_social",
    ]);
    expect(requestedScopesOf("linkedin", { optionalScopes: true })).toEqual([
      "openid",
      "profile",
      "w_member_social",
      "w_organization_social",
      "r_organization_admin",
    ]);
    // Los opcionales nunca son requisito para publicar (un perfil publica sin ellos).
    expect(publishScopesOf("linkedin")).not.toContain("w_organization_social");
    // En una red sin opcionales, el flag no cambia nada.
    expect(requestedScopesOf("x", { optionalScopes: true })).toEqual(
      OAUTH_PLATFORM_SPECS.x.scopes,
    );
  });
});

describe("optionalScopes en la app de la instalación", () => {
  it("se guarda, se conserva si no se manda y se pierde al cambiar de app", () => {
    const on = applyIntegrationUpdate(
      undefined,
      { clientId: "li-app", clientSecret: "secret-0123456789", optionalScopes: true },
      "t1",
    );
    expect(on.ok && on.config.optionalScopes).toBe(true);
    if (!on.ok) return;

    const kept = applyIntegrationUpdate(on.config, { clientId: "li-app" }, "t2");
    expect(kept.ok && kept.config.optionalScopes).toBe(true);

    const off = applyIntegrationUpdate(
      on.config,
      { clientId: "li-app", optionalScopes: false },
      "t3",
    );
    expect(off.ok && off.config.optionalScopes).toBeUndefined();

    const other = applyIntegrationUpdate(on.config, { clientId: "otra-app" }, "t4");
    expect(other.ok && other.config.optionalScopes).toBeUndefined();
  });

  it("la vista pública muestra lo que se pide y si los opcionales están prendidos", () => {
    const base = resolveRedirectBase({ FASTGRAM_PUBLIC_URL: "https://t.example.com" });
    const view = toPublicIntegrationApp(
      "linkedin",
      { clientId: "li", clientSecret: "secret-0123456789", optionalScopes: true },
      base,
    );
    expect(view.optionalScopesEnabled).toBe(true);
    expect(view.scopes).toContain("w_organization_social");
    expect(view.optionalScopes).toEqual([
      "w_organization_social",
      "r_organization_admin",
    ]);
    expect(view.redirectAllowed).toBe(true);

    const yt = toPublicIntegrationApp("youtube", undefined, base);
    expect(yt).toMatchObject({ optionalScopes: [], optionalScopesEnabled: false });
    expect(yt.setupNote).toContain("private");
  });
});
