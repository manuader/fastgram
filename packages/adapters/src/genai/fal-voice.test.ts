/**
 * `FalVoiceClient` contra un `fetch` que contesta lo que documentan las
 * páginas de API de fal leídas el 2026-09-24 (`fal-voice-catalog.ts`): el
 * envío a la cola, `IN_QUEUE`/`COMPLETED`, las salidas `audio` (Eleven v3) y
 * `video` + `duration` (OmniHuman), y el `content_policy_violation`. Ninguna
 * llamada real.
 */
import { describe, expect, it } from "vitest";
import { isPortError, type GenJobHandle } from "@fastgram/ports";

import type { GenFetch } from "./http.js";
import { FalVoiceClient, parseVoiceResult } from "./fal-voice.js";
import {
  FAL_ELEVEN_V3,
  FAL_OMNIHUMAN_V15,
  FAL_WAN_ANIMATE_REPLACE,
} from "./fal-voice-catalog.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function fake(respond: (req: Seen, i: number) => Response): {
  fetch: GenFetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (url, init) => {
      const req: Seen = {
        url,
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
      };
      seen.push(req);
      return Promise.resolve(respond(req, seen.length - 1));
    },
  };
}

const BASE = "https://queue.fal.run";
const RID = "11111111-2222-4333-8444-555555555555";
const accepted = (model: string) => ({
  request_id: RID,
  response_url: `${BASE}/${model}/requests/${RID}`,
  status_url: `${BASE}/${model}/requests/${RID}/status`,
});
const handleFor = (model: string): GenJobHandle => ({
  requestId: RID,
  statusUrl: accepted(model).status_url,
  responseUrl: accepted(model).response_url,
});

const client = (fetch: GenFetch) =>
  new FalVoiceClient({ baseUrl: BASE, apiKey: "fal-secret-key", fetch, timeoutMs: 1000 });

async function portCode(p: Promise<unknown>): Promise<string> {
  let caught: unknown = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (caught === null) throw new Error("expected a PortError");
  if (isPortError(caught)) return caught.code;
  throw caught;
}

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";
const AUDIO = "data:audio/mpeg;base64,SUQz";

describe("FalVoiceClient — voz (Eleven v3)", () => {
  it("POST a la cola con text, voice y language_code, y Key auth", async () => {
    const { fetch, seen } = fake(() => json(200, accepted(FAL_ELEVEN_V3)));
    const sub = await client(fetch).generateSpeech({
      model: FAL_ELEVEN_V3,
      text: "  Stop scrolling. ",
      voice: "Aria",
      languageCode: "es",
    });
    expect(sub.kind).toBe("accepted");
    expect(seen[0]?.url).toBe(`${BASE}/${FAL_ELEVEN_V3}`);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers["Authorization"]).toBe("Key fal-secret-key");
    expect(seen[0]?.body).toEqual({
      text: "Stop scrolling.",
      voice: "Aria",
      language_code: "es",
    });
  });

  it("sin voz no manda el campo (el modelo usa Rachel)", async () => {
    const { fetch, seen } = fake(() => json(200, accepted(FAL_ELEVEN_V3)));
    await client(fetch).generateSpeech({ model: FAL_ELEVEN_V3, text: "Hi" });
    expect(seen[0]?.body).toEqual({ text: "Hi" });
  });

  it("rechaza sin llamar: voz con forma rara, texto vacío o > 5000", async () => {
    const { fetch, seen } = fake(() => json(200, accepted(FAL_ELEVEN_V3)));
    const c = client(fetch);
    expect(
      await portCode(
        c.generateSpeech({ model: FAL_ELEVEN_V3, text: "x", voice: "<script>" }),
      ),
    ).toBe("bad_request");
    expect(await portCode(c.generateSpeech({ model: FAL_ELEVEN_V3, text: "  " }))).toBe(
      "bad_request",
    );
    expect(
      await portCode(c.generateSpeech({ model: FAL_ELEVEN_V3, text: "a".repeat(5001) })),
    ).toBe("bad_request");
    expect(await portCode(c.generateSpeech({ model: "fal-ai/other", text: "x" }))).toBe(
      "bad_request",
    );
    expect(seen).toHaveLength(0);
  });

  it("estima $0.10 cada 1000 caracteres", async () => {
    const { fetch } = fake(() => json(500, {}));
    const e = await client(fetch).estimateSpeech({
      model: FAL_ELEVEN_V3,
      text: "a".repeat(250),
    });
    expect(e.usd).toBe(0.025);
    expect(e.source).toBe("price_list");
    expect(e.sourceUrl).toContain(FAL_ELEVEN_V3);
  });

  it("el resultado `audio` es la salida", async () => {
    const { fetch } = fake((_req, i) =>
      i === 0
        ? json(200, { status: "COMPLETED" })
        : json(200, {
            audio: { url: "https://v3.fal.media/files/a/voice.mp3" },
          }),
    );
    const state = await client(fetch).pollVoice(handleFor(FAL_ELEVEN_V3));
    expect(state).toEqual({
      status: "completed",
      output: { url: "https://v3.fal.media/files/a/voice.mp3" },
    });
  });
});

describe("FalVoiceClient — voz (MiniMax)", () => {
  it("manda voice_setting.voice_id, language_boost por nombre y output_format url", async () => {
    const { fetch, seen } = fake(() =>
      json(200, accepted("fal-ai/minimax/speech-02-hd")),
    );
    await client(fetch).generateSpeech({
      model: "fal-ai/minimax/speech-02-hd",
      text: "Hola",
      voice: "Wise_Woman",
      languageCode: "es",
    });
    expect(seen[0]?.body).toEqual({
      text: "Hola",
      output_format: "url",
      voice_setting: { voice_id: "Wise_Woman" },
      language_boost: "Spanish",
    });
  });

  it("Turbo cuesta $0.06 cada 1000", async () => {
    const { fetch } = fake(() => json(500, {}));
    const e = await client(fetch).estimateSpeech({
      model: "fal-ai/minimax/speech-02-turbo",
      text: "a".repeat(1000),
    });
    expect(e.usd).toBe(0.06);
  });
});

describe("FalVoiceClient — talking avatar (OmniHuman v1.5)", () => {
  it("manda image_url, audio_url, resolution y prompt", async () => {
    const { fetch, seen } = fake(() => json(200, accepted(FAL_OMNIHUMAN_V15)));
    await client(fetch).generateAvatar({
      model: FAL_OMNIHUMAN_V15,
      imageUrl: IMAGE,
      audioUrl: AUDIO,
      resolution: "720p",
      audioSeconds: 12,
      prompt: "news anchor",
    });
    expect(seen[0]?.url).toBe(`${BASE}/${FAL_OMNIHUMAN_V15}`);
    expect(seen[0]?.body).toEqual({
      image_url: IMAGE,
      audio_url: AUDIO,
      resolution: "720p",
      prompt: "news anchor",
    });
  });

  it("respeta el tope de audio por resolución (60 s a 720p, 30 s a 1080p)", async () => {
    const { fetch, seen } = fake(() => json(200, accepted(FAL_OMNIHUMAN_V15)));
    const c = client(fetch);
    const base = {
      model: FAL_OMNIHUMAN_V15,
      imageUrl: IMAGE,
      audioUrl: AUDIO,
    };
    expect(
      await portCode(
        c.generateAvatar({ ...base, resolution: "1080p", audioSeconds: 31 }),
      ),
    ).toBe("bad_request");
    expect(
      await portCode(c.generateAvatar({ ...base, resolution: "720p", audioSeconds: 61 })),
    ).toBe("bad_request");
    expect(
      await portCode(c.generateAvatar({ ...base, resolution: "4k", audioSeconds: 5 })),
    ).toBe("bad_request");
    expect(seen).toHaveLength(0);
  });

  it("rechaza una entrada que fal no puede leer (http local)", async () => {
    const { fetch, seen } = fake(() => json(200, accepted(FAL_OMNIHUMAN_V15)));
    expect(
      await portCode(
        client(fetch).generateAvatar({
          model: FAL_OMNIHUMAN_V15,
          imageUrl: "http://localhost:9000/bucket/portrait.png",
          audioUrl: AUDIO,
          resolution: "720p",
          audioSeconds: 5,
        }),
      ),
    ).toBe("bad_request");
    expect(seen).toHaveLength(0);
  });

  it("estima $0.16 por segundo, redondeando el segundo para arriba", async () => {
    const { fetch } = fake(() => json(500, {}));
    const e = await client(fetch).estimateAvatar({
      model: FAL_OMNIHUMAN_V15,
      imageUrl: IMAGE,
      audioUrl: AUDIO,
      resolution: "720p",
      audioSeconds: 10.2,
    });
    expect(e.usd).toBe(1.76);
  });

  it("el resultado trae el video y la duración cobrada", () => {
    expect(
      parseVoiceResult({
        video: { url: "https://v3.fal.media/files/b/out.mp4", content_type: "video/mp4" },
        duration: 12.4,
      }),
    ).toEqual({
      status: "completed",
      output: { url: "https://v3.fal.media/files/b/out.mp4", contentType: "video/mp4" },
      billedSeconds: 12.4,
      mediaSeconds: 12.4,
    });
    expect(
      parseVoiceResult({ audio: { url: "https://fal.media/a.mp3" }, duration_ms: 8250 }),
    ).toMatchObject({ mediaSeconds: 8.25 });
  });

  it("content_policy_violation al enviar es un rechazo, no un error", async () => {
    const { fetch } = fake(() =>
      json(422, {
        detail: [{ type: "content_policy_violation", msg: "flagged", loc: ["body"] }],
      }),
    );
    const sub = await client(fetch).generateAvatar({
      model: FAL_OMNIHUMAN_V15,
      imageUrl: IMAGE,
      audioUrl: AUDIO,
      resolution: "720p",
      audioSeconds: 5,
    });
    expect(sub).toEqual({
      kind: "rejected",
      status: "nsfw",
      message: expect.any(String) as string,
    });
  });

  it("un COMPLETED con error es un fallo con el mensaje saneado", async () => {
    const { fetch } = fake(() =>
      json(200, { status: "COMPLETED", error: "Face not detected\nin image" }),
    );
    const state = await client(fetch).pollVoice(handleFor(FAL_OMNIHUMAN_V15));
    expect(state).toEqual({ status: "failed", message: "Face not detected in image" });
  });

  it("no sigue una URL de estado de otro origen (la key viaja ahí)", async () => {
    const { fetch, seen } = fake(() => json(200, { status: "IN_QUEUE" }));
    expect(
      await portCode(
        client(fetch).pollVoice({
          requestId: RID,
          statusUrl: "https://evil.example/status",
        }),
      ),
    ).toBe("provider_contract_violation");
    expect(seen).toHaveLength(0);
  });
});

describe("FalVoiceClient — character swap (Wan Animate Replace)", () => {
  it("manda video_url, image_url y resolution", async () => {
    const { fetch, seen } = fake(() => json(200, accepted(FAL_WAN_ANIMATE_REPLACE)));
    await client(fetch).generateSwap({
      model: FAL_WAN_ANIMATE_REPLACE,
      imageUrl: IMAGE,
      videoUrl: "data:video/mp4;base64,AAAA",
      resolution: "480p",
      videoSeconds: 5,
    });
    expect(seen[0]?.body).toEqual({
      video_url: "data:video/mp4;base64,AAAA",
      image_url: IMAGE,
      resolution: "480p",
    });
  });

  it("estima por cuadros ÷ 16; sin fps asume 60 (lo caro) y lo dice", async () => {
    const { fetch } = fake(() => json(500, {}));
    const c = client(fetch);
    const base = {
      model: FAL_WAN_ANIMATE_REPLACE,
      imageUrl: IMAGE,
      videoUrl: IMAGE,
      videoSeconds: 5,
    };
    // Ejemplo literal de la página: 5 s a 60 fps en 720p = $1.50.
    const e720 = await c.estimateSwap({ ...base, resolution: "720p", fps: 60 });
    expect(e720.usd).toBe(1.5);
    const unknown = await c.estimateSwap({ ...base, resolution: "480p" });
    expect(unknown.usd).toBe(0.75);
    expect(unknown.basis).toContain("assumed 60");
  });
});

describe("FalVoiceClient — errores y credenciales", () => {
  it("401 → unauthorized, 429 → rate_limited, 503 → provider_unavailable", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [429, "rate_limited"],
      [503, "provider_unavailable"],
    ] as const) {
      const { fetch } = fake(() => json(status, { detail: "nope" }));
      expect(
        await portCode(
          client(fetch).generateSpeech({ model: FAL_ELEVEN_V3, text: "hello" }),
        ),
      ).toBe(code);
    }
  });

  it("el mensaje del error nunca trae la key", async () => {
    const { fetch } = fake(() => json(401, { detail: "bad key fal-secret-key" }));
    let caught: unknown = null;
    try {
      await client(fetch).generateSpeech({ model: FAL_ELEVEN_V3, text: "hello" });
    } catch (e) {
      caught = e;
    }
    expect(isPortError(caught)).toBe(true);
    if (isPortError(caught)) {
      expect(caught.message).not.toContain("fal-secret-key");
      expect(JSON.stringify(caught.toPublic())).not.toContain("fal-secret-key");
    }
  });

  it("probar credenciales llama a la API de precios con el endpoint id", async () => {
    const { fetch, seen } = fake(() => json(200, { prices: [] }));
    const r = await client(fetch).checkVoiceCredentials(FAL_OMNIHUMAN_V15);
    expect(r.probe).toBe("pricing endpoint");
    expect(seen[0]?.url).toBe(
      `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(FAL_OMNIHUMAN_V15)}`,
    );
  });

  it("sin key no se construye", () => {
    expect(() => new FalVoiceClient({ baseUrl: BASE, apiKey: " " })).toThrow();
  });
});
