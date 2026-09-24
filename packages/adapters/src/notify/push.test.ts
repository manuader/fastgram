import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  notificationSettingsFile,
  sendNtfy,
  sendTelegram,
  telegramText,
  type FetchLike,
  type PushMessage,
} from "./index.js";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(response: () => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response();
    },
  };
}

const MSG: PushMessage = {
  title: "Post failed on Instagram",
  body: "Acme: Reconnect the account.",
  severity: "error",
  clickUrl: "http://localhost:3000/home",
};

describe("ntfy", () => {
  it("POST al topic con el cuerpo, título, prioridad, click y token", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const out = await sendNtfy(
      { url: "https://ntfy.sh/fg-topic", token: "tk_abc" },
      MSG,
      { fetch: f.fetch },
    );
    expect(out).toEqual({ ok: true });
    const call = f.calls[0];
    expect(call?.url).toBe("https://ntfy.sh/fg-topic");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.body).toBe(MSG.body);
    expect(call?.init.headers).toMatchObject({
      Title: MSG.title,
      Priority: "4",
      Click: MSG.clickUrl,
      Authorization: "Bearer tk_abc",
    });
  });

  it("un título no ASCII va al cuerpo, nunca a una cabecera", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    await sendNtfy(
      { url: "https://ntfy.sh/t" },
      { ...MSG, title: "Publicación ✅" },
      {
        fetch: f.fetch,
      },
    );
    const init = f.calls[0]?.init;
    expect(init?.headers).not.toHaveProperty("Title");
    expect(init?.body).toBe(`Publicación ✅\n${MSG.body}`);
  });

  it("traduce los status a códigos estables", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [404, "not_found"],
      [429, "rate_limited"],
      [400, "bad_request"],
      [502, "unavailable"],
    ] as const) {
      const f = fakeFetch(() => new Response("nope", { status }));
      expect(
        await sendNtfy({ url: "https://ntfy.sh/t" }, MSG, { fetch: f.fetch }),
      ).toEqual({
        ok: false,
        code,
        status,
      });
    }
  });

  it("un timeout es `timeout`, un error de red es `unavailable`", async () => {
    const timeout: FetchLike = async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    };
    expect(await sendNtfy({ url: "https://ntfy.sh/t" }, MSG, { fetch: timeout })).toEqual(
      {
        ok: false,
        code: "timeout",
      },
    );
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await sendNtfy({ url: "https://ntfy.sh/t" }, MSG, { fetch: down })).toEqual({
      ok: false,
      code: "unavailable",
    });
  });
});

describe("Telegram", () => {
  it("sendMessage con chat_id y texto plano", async () => {
    const f = fakeFetch(() => Response.json({ ok: true, result: {} }));
    const out = await sendTelegram({ botToken: TOKEN, chatId: "42" }, MSG, {
      fetch: f.fetch,
    });
    expect(out).toEqual({ ok: true });
    expect(f.calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({
      chat_id: "42",
      text: telegramText(MSG),
    });
  });

  it("el error no trae el token ni la descripción del proveedor", async () => {
    const f = fakeFetch(() =>
      Response.json(
        {
          ok: false,
          error_code: 400,
          description: `Bad Request: chat not found ${TOKEN}`,
        },
        { status: 400 },
      ),
    );
    const out = await sendTelegram({ botToken: TOKEN, chatId: "42" }, MSG, {
      fetch: f.fetch,
    });
    expect(out).toEqual({ ok: false, code: "bad_request", status: 400 });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("404 (token inexistente) es `unauthorized`", async () => {
    const f = fakeFetch(() => Response.json({ ok: false }, { status: 404 }));
    expect(
      await sendTelegram({ botToken: TOKEN, chatId: "42" }, MSG, { fetch: f.fetch }),
    ).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("un token con / o ? no llega a armar la URL", async () => {
    const f = fakeFetch(() => Response.json({ ok: true }));
    const out = await sendTelegram({ botToken: "1:abc/../x?y", chatId: "42" }, MSG, {
      fetch: f.fetch,
    });
    expect(out).toEqual({ ok: false, code: "unauthorized" });
    expect(f.calls).toHaveLength(0);
  });

  it("recorta a 4096 caracteres", () => {
    expect(telegramText({ ...MSG, body: "x".repeat(10_000) }).length).toBe(4096);
  });
});

describe("archivo de preferencias", () => {
  it("se escribe con 0600 bajo FASTGRAM_HOME y se relee", async () => {
    const home = await mkdtemp(join(tmpdir(), "fg-notify-"));
    const file = notificationSettingsFile({ FASTGRAM_HOME: home });
    expect(await file.read()).toBeNull();
    await file.update(() => ({ next: { version: 1 }, result: null }));
    const path = join(home, "notifications.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
