import { describe, expect, it } from "vitest";
import {
  PortError,
  type ConnectionTokenStore,
  type ConnectionTokenUpdate,
  type IntegrationsSnapshot,
  type OAuthClient,
  type OAuthRefreshRequest,
  type OAuthTokenSet,
  type StoredConnectionTokens,
  type TokenCipher,
} from "@fastgram/ports";

import {
  applyIntegrationUpdate,
  resolveRedirectBase,
  toPublicIntegrationApp,
} from "./integrations.js";
import {
  ConnectionTokenError,
  createConnectionTokens,
  resolveAccessToken,
} from "./tokens.js";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-24T12:00:00.000Z");
const HOUR = 3_600_000;

/** Un "cifrado" reversible y visible: basta para ver qué se guardó. */
const cipher: TokenCipher = {
  encrypt: (p) => Promise.resolve(`enc(${p})`),
  decrypt: (c) => Promise.resolve(c.replace(/^enc\((.*)\)$/, "$1")),
};

class FakeStore implements ConnectionTokenStore {
  saved: ConnectionTokenUpdate | null = null;
  expiredReason: string | null = null;
  constructor(public row: StoredConnectionTokens | null) {}
  load(companyId: string) {
    return Promise.resolve(
      this.row !== null && this.row.companyId === companyId ? this.row : null,
    );
  }
  saveTokens(_c: string, _id: string, update: ConnectionTokenUpdate) {
    this.saved = update;
    return Promise.resolve();
  }
  markExpired(_c: string, _id: string, reason: string) {
    this.expiredReason = reason;
    return Promise.resolve();
  }
}

class FakeClient implements OAuthClient {
  readonly usesPkce = true;
  readonly refreshWith = "refresh_token" as const;
  calls: OAuthRefreshRequest[] = [];
  constructor(
    readonly platform: "x",
    private readonly result: OAuthTokenSet | PortError,
  ) {}
  authorizeUrl() {
    return "https://example.invalid";
  }
  exchangeCode() {
    return Promise.resolve([]);
  }
  refresh(req: OAuthRefreshRequest) {
    this.calls.push(req);
    return this.result instanceof PortError
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

const configured: IntegrationsSnapshot = {
  apps: { x: { clientId: "client-x", clientSecret: "secret-x-0123456789" } },
};

function row(over: Partial<StoredConnectionTokens> = {}): StoredConnectionTokens {
  return {
    id: "c1",
    companyId: A,
    platform: "x",
    status: "active",
    accessToken: "enc(at-old)",
    refreshToken: "enc(rt-old)",
    tokenExpiry: new Date(NOW.getTime() + 2 * HOUR),
    refreshTokenExpiry: null,
    tokenIssuedAt: new Date(NOW.getTime() - HOUR),
    ...over,
  };
}

function deps(store: FakeStore, client: FakeClient, snapshot = configured) {
  return {
    store,
    cipher,
    clients: { x: client },
    integrations: {
      read: () => Promise.resolve(snapshot),
      write: () => Promise.resolve(),
    },
    now: () => NOW,
  };
}

const fresh: OAuthTokenSet = {
  accessToken: "at-new",
  refreshToken: "rt-new",
  expiresAt: new Date(NOW.getTime() + 2 * HOUR),
};

describe("resolveAccessToken", () => {
  it("token vigente lejos del vencimiento: se descifra y no se refresca", async () => {
    const store = new FakeStore(row());
    const client = new FakeClient("x", fresh);
    const r = await resolveAccessToken(deps(store, client), {
      companyId: A,
      connectionId: "c1",
    });
    expect(r).toMatchObject({ accessToken: "at-old", refreshed: false });
    expect(client.calls).toHaveLength(0);
  });

  it("por vencer: refresca con el refresh token y guarda los nuevos cifrados", async () => {
    const store = new FakeStore(row({ tokenExpiry: new Date(NOW.getTime() + 60_000) }));
    const client = new FakeClient("x", fresh);
    const r = await resolveAccessToken(deps(store, client), {
      companyId: A,
      connectionId: "c1",
    });
    expect(r).toMatchObject({ accessToken: "at-new", refreshed: true });
    expect(client.calls[0]).toMatchObject({ refreshToken: "rt-old" });
    expect(store.saved).toMatchObject({
      accessToken: "enc(at-new)",
      refreshToken: "enc(rt-new)",
      tokenIssuedAt: NOW,
    });
  });

  it("la plataforma rechaza el refresco → expired + marca la conexión", async () => {
    const store = new FakeStore(row({ tokenExpiry: new Date(NOW.getTime() - 1) }));
    const client = new FakeClient(
      "x",
      new PortError("unauthorized", "invalid_grant", { source: "test" }),
    );
    await expect(
      resolveAccessToken(deps(store, client), { companyId: A, connectionId: "c1" }),
    ).rejects.toMatchObject({ reason: "expired" });
    expect(store.expiredReason).toBe("refresh_rejected");
  });

  it("fallo transitorio con el token vigente: se usa el viejo y no se marca nada", async () => {
    const store = new FakeStore(row({ tokenExpiry: new Date(NOW.getTime() + 60_000) }));
    const client = new FakeClient("x", new PortError("timeout", "t", { source: "test" }));
    const r = await resolveAccessToken(deps(store, client), {
      companyId: A,
      connectionId: "c1",
    });
    expect(r.accessToken).toBe("at-old");
    expect(store.expiredReason).toBeNull();
  });

  it("fallo transitorio con el token vencido: refresh_failed, sin marcar expired", async () => {
    const store = new FakeStore(row({ tokenExpiry: new Date(NOW.getTime() - 1) }));
    const client = new FakeClient(
      "x",
      new PortError("provider_unavailable", "5xx", { source: "test" }),
    );
    await expect(
      resolveAccessToken(deps(store, client), { companyId: A, connectionId: "c1" }),
    ).rejects.toMatchObject({ reason: "refresh_failed" });
    expect(store.expiredReason).toBeNull();
  });

  it("otra marca → not_found; conexión revocada → inactive", async () => {
    const client = new FakeClient("x", fresh);
    await expect(
      resolveAccessToken(deps(new FakeStore(row()), client), {
        companyId: "otra",
        connectionId: "c1",
      }),
    ).rejects.toBeInstanceOf(ConnectionTokenError);
    await expect(
      resolveAccessToken(deps(new FakeStore(row({ status: "revoked" })), client), {
        companyId: A,
        connectionId: "c1",
      }),
    ).rejects.toMatchObject({ reason: "inactive" });
  });

  it("vencido y sin credenciales de la app: integration_not_configured", async () => {
    const store = new FakeStore(row({ tokenExpiry: new Date(NOW.getTime() - 1) }));
    await expect(
      resolveAccessToken(deps(store, new FakeClient("x", fresh), { apps: {} }), {
        companyId: A,
        connectionId: "c1",
      }),
    ).rejects.toMatchObject({ reason: "integration_not_configured" });
  });
});

describe("createConnectionTokens (puerto ConnectionTokens)", () => {
  it("un refresco rechazado sale como unauthorized y la transacción no se revierte", async () => {
    const store = new FakeStore(row({ tokenExpiry: new Date(NOW.getTime() - 1) }));
    const client = new FakeClient(
      "x",
      new PortError("unauthorized", "no", { source: "t" }),
    );
    let committed = false;
    const { store: _s, ...rest } = deps(store, client);
    const tokens = createConnectionTokens({
      ...rest,
      withStore: async (_companyId, fn) => {
        // Una "transacción": si `fn` lanza, no se confirma.
        const result = await fn(store);
        committed = true;
        return result;
      },
    });
    await expect(tokens.getAccessToken("c1", { companyId: A })).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(committed).toBe(true);
    expect(store.expiredReason).toBe("refresh_rejected");
  });

  it("otra marca → not_found", async () => {
    const store = new FakeStore(row());
    const { store: _s, ...rest } = deps(store, new FakeClient("x", fresh));
    const tokens = createConnectionTokens({ ...rest, withStore: (_c, fn) => fn(store) });
    await expect(
      tokens.getAccessToken("c1", { companyId: "otra" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("credenciales de las apps", () => {
  it("la vista pública nunca lleva el secret", () => {
    const view = toPublicIntegrationApp(
      "x",
      { clientId: "cid", clientSecret: "super-secret-value-9876" },
      resolveRedirectBase({}),
    );
    expect(JSON.stringify(view)).not.toContain("super-secret-value");
    expect(view).toMatchObject({
      hasSecret: true,
      secretLast4: "9876",
      configured: true,
    });
    expect(view.redirectUri).toBe("http://localhost:3000/api/fastgram/oauth/x/callback");
  });

  it("cambiar el client id sin secret nuevo descarta el guardado", () => {
    const current = { clientId: "old", clientSecret: "s-000000000000" };
    const same = applyIntegrationUpdate(current, { clientId: "old" }, "t");
    const other = applyIntegrationUpdate(current, { clientId: "new" }, "t");
    expect(same.ok && same.config.clientSecret).toBe("s-000000000000");
    expect(other.ok && other.config.clientSecret).toBeFalsy();
  });

  it("TikTok exige https: con localhost no está permitido; con FASTGRAM_PUBLIC_URL sí", () => {
    const local = toPublicIntegrationApp("tiktok", undefined, resolveRedirectBase({}));
    const tunnel = toPublicIntegrationApp(
      "tiktok",
      undefined,
      resolveRedirectBase({ FASTGRAM_PUBLIC_URL: "https://fg.example.com/" }),
    );
    expect(local.redirectAllowed).toBe(false);
    expect(tunnel.redirectAllowed).toBe(true);
    expect(tunnel.redirectUri).toBe(
      "https://fg.example.com/api/fastgram/oauth/tiktok/callback",
    );
    expect(
      resolveRedirectBase({ FASTGRAM_PUBLIC_URL: "https://fg.example.com/x?y" }),
    ).toMatchObject({ source: "local", publicUrlInvalid: true });
  });
});
