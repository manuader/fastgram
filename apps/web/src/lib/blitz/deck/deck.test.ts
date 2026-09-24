/**
 * La lógica pura del deck: gestos, teclas, qué pantalla toca, y la preview.
 * Corre en Node (ver `vitest.config.ts`): nada de esto necesita un DOM.
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/errors";
import { queuePollInterval } from "./api";
import {
  decisionFromDrag,
  isTypingTarget,
  keyToDecision,
  SWIPE_DISTANCE_PX,
  SWIPE_VELOCITY_PX_S,
  type KeyLike,
} from "./gestures";
import { deckViewFor } from "./state";
import {
  compactNumber,
  deckSuggestionSchema,
  explanationBullets,
  hasAudio,
  needsRefill,
  pendingSuggestions,
  QUEUE_POLL_MS,
  slidesOf,
} from "./suggestion";

const base = deckSuggestionSchema.parse({
  id: "s1",
  contentType: "wall-of-text",
  generatedText: "  Hook text  ",
});

function key(k: string, extra: Partial<KeyLike> = {}): KeyLike {
  return {
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...extra,
  };
}

function el(tagName: string, attrs: Record<string, string> = {}, editable = false) {
  return {
    tagName,
    isContentEditable: editable,
    getAttribute: (name: string) => attrs[name] ?? null,
  } as unknown as EventTarget;
}

describe("decisionFromDrag", () => {
  it("decide por distancia en las dos direcciones", () => {
    expect(decisionFromDrag(SWIPE_DISTANCE_PX, 0)).toBe("accept");
    expect(decisionFromDrag(-SWIPE_DISTANCE_PX, 0)).toBe("skip");
    expect(decisionFromDrag(SWIPE_DISTANCE_PX - 1, 0)).toBeNull();
  });

  it("un flick rápido decide aunque no llegue a la distancia", () => {
    expect(decisionFromDrag(30, SWIPE_VELOCITY_PX_S)).toBe("accept");
    expect(decisionFromDrag(-30, -SWIPE_VELOCITY_PX_S)).toBe("skip");
  });

  it("un flick en contra del desplazamiento no decide", () => {
    expect(decisionFromDrag(30, -SWIPE_VELOCITY_PX_S * 2)).toBeNull();
    expect(decisionFromDrag(-30, SWIPE_VELOCITY_PX_S * 2)).toBeNull();
  });
});

describe("keyToDecision", () => {
  it("← rechaza y → aprueba", () => {
    expect(keyToDecision(key("ArrowLeft"))).toBe("skip");
    expect(keyToDecision(key("ArrowRight"))).toBe("accept");
    expect(keyToDecision(key("ArrowUp"))).toBeNull();
  });

  it("con cualquier modificador no decide", () => {
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(keyToDecision(key("ArrowRight", { [mod]: true }))).toBeNull();
    }
  });

  it("no le roba las flechas a un campo de texto ni a un slider", () => {
    expect(keyToDecision(key("ArrowLeft", { target: el("INPUT") }))).toBeNull();
    expect(keyToDecision(key("ArrowLeft", { target: el("textarea") }))).toBeNull();
    expect(keyToDecision(key("ArrowLeft", { target: el("DIV", {}, true) }))).toBeNull();
    expect(
      keyToDecision(key("ArrowLeft", { target: el("DIV", { role: "slider" }) })),
    ).toBeNull();
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
  });
});

describe("deckViewFor", () => {
  const ok = { queueError: null, profileBlocked: false } as const;

  it("cargando, vacío y deck", () => {
    expect(deckViewFor({ ...ok, queueStatus: "pending", pending: [] }).kind).toBe(
      "loading",
    );
    expect(deckViewFor({ ...ok, queueStatus: "success", pending: [] })).toEqual({
      kind: "empty",
    });
    expect(deckViewFor({ ...ok, queueStatus: "success", pending: [base] }).kind).toBe(
      "deck",
    );
  });

  it("404 en GET /blitz/queue (marca inválida) es un error, no un modo sin previews", () => {
    const missing = new ApiRequestError({ code: "not_found", status: 404 });
    expect(
      deckViewFor({ ...ok, queueStatus: "error", queueError: missing, pending: [] }),
    ).toEqual({ kind: "error", error: missing });
  });

  it("un 500 o un fallo de red son error, nunca vacío", () => {
    for (const error of [
      new ApiRequestError({ code: "service_unavailable", status: 500 }),
      new ApiRequestError({ code: "network_error", status: 0 }),
    ]) {
      expect(
        deckViewFor({ ...ok, queueStatus: "error", queueError: error, pending: [] }).kind,
      ).toBe("error");
    }
  });

  it("perfil no listo gana sobre todo lo demás", () => {
    const notReady = new ApiRequestError({
      code: "company_profile_not_ready",
      status: 409,
    });
    expect(
      deckViewFor({ ...ok, queueStatus: "error", queueError: notReady, pending: [] })
        .kind,
    ).toBe("profile");
    expect(
      deckViewFor({
        ...ok,
        queueStatus: "success",
        pending: [base],
        profileBlocked: true,
      }).kind,
    ).toBe("profile");
  });
});

describe("preview", () => {
  it("sin slides arma una con el texto generado sobre el fondo", () => {
    expect(slidesOf(base)).toEqual([{ imageUrl: null, text: "Hook text" }]);
    const withBg = deckSuggestionSchema.parse({
      ...base,
      preview: { backgroundUrl: "https://cdn.example.test/bg.mp4" },
    });
    expect(slidesOf(withBg)).toEqual([
      { imageUrl: "https://cdn.example.test/bg.mp4", text: "Hook text" },
    ]);
  });

  it("con slides, la primera sin texto propio lleva el hook", () => {
    const s = deckSuggestionSchema.parse({
      ...base,
      contentType: "slideshow",
      preview: {
        slides: [{ imageUrl: "https://cdn.example.test/1.jpg" }, { text: "Two" }],
      },
    });
    expect(slidesOf(s)).toEqual([
      { imageUrl: "https://cdn.example.test/1.jpg", text: "Hook text" },
      { imageUrl: null, text: "Two" },
    ]);
  });

  it("hasAudio sólo con una URL de audio", () => {
    expect(hasAudio(base)).toBe(false);
    expect(
      hasAudio(
        deckSuggestionSchema.parse({
          ...base,
          preview: { audioUrl: "https://cdn.example.test/a.mp3" },
        }),
      ),
    ).toBe(true);
  });

  it("explanationBullets limpia marcadores y no inventa estructura", () => {
    expect(explanationBullets("- One\n* Two\n• Three\n2) Four\n\n")).toEqual([
      "One",
      "Two",
      "Three",
      "Four",
    ]);
    expect(explanationBullets("A single paragraph. With two sentences.")).toEqual([
      "A single paragraph. With two sentences.",
    ]);
    expect(explanationBullets(null)).toEqual([]);
  });

  it("compactNumber como lo muestra el PRD", () => {
    expect(compactNumber(106_800)).toBe("106.8K");
    expect(compactNumber(1_300_000)).toBe("1.3M");
  });

  it("el schema tolera campos desconocidos y rechaza un tipo que no es de Blitz", () => {
    expect(deckSuggestionSchema.safeParse({ ...base, extra: 1 }).success).toBe(true);
    expect(
      deckSuggestionSchema.safeParse({ ...base, contentType: "custom" }).success,
    ).toBe(false);
  });
});

describe("relleno de la cola", () => {
  it("pide más con 2 o menos", () => {
    expect(needsRefill(3)).toBe(false);
    expect(needsRefill(2)).toBe(true);
    expect(needsRefill(0)).toBe(true);
  });

  it("pendingSuggestions saca las ya decididas", () => {
    const other = { ...base, id: "s2" };
    expect(pendingSuggestions([base, other], new Set(["s1"]))).toEqual([other]);
  });

  it("queuePollInterval: pregunta con la cola corta o con un error transitorio, no con un 4xx", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...base, id: `s${String(i)}` }));
    expect(queuePollInterval(five, null)).toBe(false);
    expect(queuePollInterval([base], null)).toBe(QUEUE_POLL_MS);
    expect(queuePollInterval(undefined, null)).toBe(false);
    expect(
      queuePollInterval(
        undefined,
        new ApiRequestError({ code: "not_found", status: 404 }),
      ),
    ).toBe(false);
    expect(
      queuePollInterval(
        undefined,
        new ApiRequestError({ code: "service_unavailable", status: 500 }),
      ),
    ).toBe(QUEUE_POLL_MS);
    expect(
      queuePollInterval(
        undefined,
        new ApiRequestError({ code: "network_error", status: 0 }),
      ),
    ).toBe(QUEUE_POLL_MS);
  });
});
