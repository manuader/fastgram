import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
  applyNotificationSettingsUpdate,
  assessConnectionHealth,
  checkNtfyUrl,
  checkTelegramBotToken,
  checkTelegramChatId,
  dailySummaryWindow,
  describeNotification,
  enabledChannels,
  localHourOf,
  parseNotificationSettings,
  queueAlertBucket,
  serializeNotificationSettings,
  shouldPush,
  toPublicNotificationSettings,
  type ConnectionHealthInput,
} from "./index.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

describe("preferencias: parseo", () => {
  it("sin archivo son los defaults", () => {
    const out = parseNotificationSettings(null);
    expect(out).toEqual({ ok: true, settings: DEFAULT_NOTIFICATION_SETTINGS });
  });

  it("ida y vuelta por el documento sin perder nada", () => {
    const updated = applyNotificationSettingsUpdate(DEFAULT_NOTIFICATION_SETTINGS, {
      ntfy: { url: "https://ntfy.sh/fg-abcdefghijkl", token: "tk_secret123" },
      telegram: { botToken: TOKEN, chatId: "123456" },
      categories: [{ category: "post_published", push: true }],
      dailySummaryHour: 9,
    });
    if (!updated.ok) throw new Error(updated.message);
    const back = parseNotificationSettings(
      JSON.parse(JSON.stringify(serializeNotificationSettings(updated.settings))),
    );
    expect(back).toEqual({ ok: true, settings: updated.settings });
  });

  it("un documento roto NO se repara con defaults (puede tener el token)", () => {
    expect(
      parseNotificationSettings({ version: 1, telegram: { enabled: true } }).ok,
    ).toBe(false);
    expect(parseNotificationSettings({ version: 99 }).ok).toBe(false);
    expect(parseNotificationSettings("x").ok).toBe(false);
  });

  it("una categoría desconocida (de una versión futura) se ignora", () => {
    const out = parseNotificationSettings({
      version: 1,
      categories: { algo_nuevo: { inApp: false, push: false } },
    });
    expect(out.ok).toBe(true);
  });
});

describe("preferencias: actualización y validación", () => {
  it("un secreto vacío conserva el guardado; null borra el canal", () => {
    const first = applyNotificationSettingsUpdate(DEFAULT_NOTIFICATION_SETTINGS, {
      telegram: { botToken: TOKEN, chatId: "42424242" },
    });
    if (!first.ok) throw new Error("no");
    const second = applyNotificationSettingsUpdate(first.settings, {
      telegram: { botToken: "", chatId: "99999999", enabled: false },
    });
    if (!second.ok) throw new Error("no");
    expect(second.settings.telegram).toEqual({
      enabled: false,
      botToken: TOKEN,
      chatId: "99999999",
    });
    const third = applyNotificationSettingsUpdate(second.settings, { telegram: null });
    expect(third.ok && third.settings.telegram).toBe(null);
  });

  it("rechaza URLs de ntfy sin topic, con credenciales o con otro esquema", () => {
    expect(checkNtfyUrl("https://ntfy.sh/")).not.toBeNull();
    expect(checkNtfyUrl("https://u:p@ntfy.sh/topic")).not.toBeNull();
    expect(checkNtfyUrl("ftp://ntfy.sh/topic")).not.toBeNull();
    expect(checkNtfyUrl("https://ntfy.sh/topic?x=1")).not.toBeNull();
    expect(checkNtfyUrl("https://ntfy.sh/fg_alerts-1")).toBeNull();
    expect(checkNtfyUrl("http://192.168.1.5:8080/ntfy/fg")).toBeNull();
  });

  it("valida el token y el chat de Telegram", () => {
    expect(checkTelegramBotToken(TOKEN)).toBeNull();
    expect(checkTelegramBotToken("abc")).not.toBeNull();
    expect(checkTelegramChatId("-1001234567")).toBeNull();
    expect(checkTelegramChatId("@my_channel")).toBeNull();
    expect(checkTelegramChatId("hola")).not.toBeNull();
  });

  it("devuelve el campo que falló", () => {
    const out = applyNotificationSettingsUpdate(DEFAULT_NOTIFICATION_SETTINGS, {
      telegram: { botToken: TOKEN },
    });
    expect(out).toMatchObject({ ok: false, field: "telegram.chatId" });
  });
});

describe("vista pública: nunca un secreto entero", () => {
  it("enmascara el topic, el token de ntfy y el del bot", () => {
    const out = applyNotificationSettingsUpdate(DEFAULT_NOTIFICATION_SETTINGS, {
      ntfy: { url: "https://ntfy.sh/fg-supersecret-topic", token: "tk_abcdef123456" },
      telegram: { botToken: TOKEN, chatId: "123456" },
    });
    if (!out.ok) throw new Error("no");
    const pub = toPublicNotificationSettings(out.settings);
    const text = JSON.stringify(pub);
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("tk_abcdef123456");
    expect(text).not.toContain(TOKEN);
    expect(pub.ntfy).toMatchObject({ configured: true, tokenSet: true });
    expect(pub.ntfy.urlMasked).toBe("https://ntfy.sh/fg…ic");
    expect(pub.telegram.botTokenHint).toBe(`…${TOKEN.slice(-4)}`);
    expect(pub.categories.map((c) => c.category)).toEqual([...NOTIFICATION_CATEGORIES]);
  });
});

describe("canales habilitados y push", () => {
  it("sin canales, nada va por push aunque la categoría lo pida", () => {
    expect(enabledChannels(DEFAULT_NOTIFICATION_SETTINGS)).toEqual([]);
    expect(shouldPush(DEFAULT_NOTIFICATION_SETTINGS, "post_failed")).toBe(false);
  });

  it("con ntfy prendido, push según la categoría", () => {
    const out = applyNotificationSettingsUpdate(DEFAULT_NOTIFICATION_SETTINGS, {
      ntfy: { url: "https://ntfy.sh/fg-topic" },
    });
    if (!out.ok) throw new Error("no");
    expect(enabledChannels(out.settings)).toEqual(["ntfy"]);
    expect(shouldPush(out.settings, "post_failed")).toBe(true);
    expect(shouldPush(out.settings, "post_published")).toBe(false);
  });
});

describe("salud de conexiones", () => {
  const base: ConnectionHealthInput = {
    platform: "instagram",
    status: "active",
    tokenExpiry: null,
    refreshTokenExpiry: null,
    tokenIssuedAt: null,
    hasRefreshToken: false,
  };

  it("un estado distinto de active es vencida", () => {
    expect(assessConnectionHealth({ ...base, status: "revoked" }, NOW)).toEqual({
      state: "expired",
      reason: "revoked",
    });
  });

  it("LinkedIn sin tokenExpiry: 60 días desde la emisión", () => {
    const issued = new Date(NOW - 55 * DAY);
    const out = assessConnectionHealth(
      { ...base, platform: "linkedin", tokenIssuedAt: issued },
      NOW,
    );
    expect(out).toEqual({ state: "expiring", deadline: new Date(NOW + 5 * DAY) });
    expect(
      assessConnectionHealth(
        { ...base, platform: "linkedin", tokenIssuedAt: new Date(NOW - 61 * DAY) },
        NOW,
      ).state,
    ).toBe("expired");
  });

  it("con refresh token manda el vencimiento del refresh, no el del access token", () => {
    const out = assessConnectionHealth(
      {
        ...base,
        platform: "tiktok",
        hasRefreshToken: true,
        tokenExpiry: new Date(NOW - DAY),
        refreshTokenExpiry: new Date(NOW + 300 * DAY),
      },
      NOW,
    );
    expect(out.state).toBe("ok");
    // X: refresh sin fecha conocida → no hay nada que avisar.
    expect(
      assessConnectionHealth({ ...base, platform: "x", hasRefreshToken: true }, NOW),
    ).toEqual({ state: "ok", deadline: null });
  });

  it("el borde de 7 días entra; 8 no", () => {
    expect(
      assessConnectionHealth({ ...base, tokenExpiry: new Date(NOW + 7 * DAY) }, NOW)
        .state,
    ).toBe("expiring");
    expect(
      assessConnectionHealth({ ...base, tokenExpiry: new Date(NOW + 8 * DAY) }, NOW)
        .state,
    ).toBe("ok");
  });
});

describe("textos y claves", () => {
  it("un post fallido lleva el mensaje seguro y una clave por post", () => {
    const d = describeNotification({
      kind: "post",
      brand: "Acme",
      postId: "p1",
      status: "FAILED",
      platform: "instagram",
      username: "acme",
      errorMessage: "Reconnect the account to publish this post.",
    });
    expect(d).toMatchObject({
      category: "post_failed",
      severity: "error",
      title: "Post failed on Instagram (@acme)",
      dedupeKey: "post:FAILED:p1",
      link: "/home",
    });
    expect(d.body).toContain("Reconnect the account");
  });

  it("LinkedIn por vencer usa el copy literal de N-10", () => {
    const d = describeNotification({
      kind: "connection_expiring",
      brand: "Acme",
      connectionId: "c1",
      platform: "linkedin",
      username: "acme",
      deadline: new Date("2026-09-30T00:00:00Z"),
    });
    expect(d.body).toContain(
      "LinkedIn connections last 60 days. Reconnect to keep posting without interruption.",
    );
    expect(d.dedupeKey).toBe("conn:expiring:c1:2026-09-30");
  });

  it("la cola atascada se repite por cubo, no por barrido", () => {
    const a = queueAlertBucket("waiting", NOW);
    expect(queueAlertBucket("waiting", NOW + 5 * 60_000)).toBe(a);
    expect(queueAlertBucket("waiting", NOW + 6 * 60 * 60_000)).not.toBe(a);
  });

  it("recorta títulos largos", () => {
    const d = describeNotification({
      kind: "campaign",
      brand: "A",
      automationId: "x",
      name: "n".repeat(500),
      status: "REVIEW",
    });
    expect(d.title.length).toBeLessThanOrEqual(200);
  });
});

describe("resumen diario", () => {
  it("antes de la hora local no toca; después resume ayer entero", () => {
    // 12:00 UTC = 09:00 en Buenos Aires (UTC-3).
    expect(localHourOf(NOW, "America/Argentina/Buenos_Aires")).toBe(9);
    expect(dailySummaryWindow(NOW, "America/Argentina/Buenos_Aires", 10)).toBeNull();
    const w = dailySummaryWindow(NOW, "America/Argentina/Buenos_Aires", 8);
    expect(w).toEqual({
      day: "2026-09-23",
      fromMs: Date.parse("2026-09-23T03:00:00.000Z"),
      toMs: Date.parse("2026-09-24T03:00:00.000Z"),
    });
  });

  it("una zona inválida cae a UTC en vez de romper el barrido", () => {
    expect(dailySummaryWindow(NOW, "No/Existe", 8)?.day).toBe("2026-09-23");
  });
});
