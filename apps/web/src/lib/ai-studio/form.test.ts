import { aiStudioOptionsSchema, type AiStudioOptions } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { budgetUsedFraction, formatUsd, parseBudgetInput } from "../models/budget";
import {
  galleryRefetchInterval,
  initialForm,
  specFor,
  toRequest,
  withModel,
} from "./form";

const spec = (over: Record<string, unknown>) => ({
  label: "M",
  kind: "video",
  aspectRatios: ["16:9", "9:16", "1:1"],
  aspectFromImage: false,
  counts: [1],
  durationsSeconds: [5, 10],
  promptRequired: true,
  imageInput: "none",
  maxReferenceImages: 0,
  docsUrl: "https://docs.test",
  listPrice: null,
  ...over,
});

const OPTIONS: AiStudioOptions = aiStudioOptionsSchema.parse({
  image: {
    kind: "image",
    configured: false,
    provider: null,
    defaultModel: null,
    models: [],
  },
  video: {
    kind: "video",
    configured: true,
    provider: "higgsfield",
    defaultModel: "t2v",
    models: [
      spec({ id: "t2v" }),
      spec({
        id: "i2v",
        aspectRatios: [],
        aspectFromImage: true,
        durationsSeconds: [4, 8],
        imageInput: "required",
        promptRequired: false,
      }),
      spec({ id: "ltx", aspectRatios: ["16:9"], durationsSeconds: [6, 8, 10] }),
    ],
  },
  budget: {
    month: "2026-09",
    budgetUsd: 30,
    budgetSource: "default",
    chargedUsd: 0,
    reservedUsd: 0,
    remainingUsd: 30,
    generations: 0,
  },
});

describe("formulario de AI Studio", () => {
  it("arranca con el modelo de Settings, vertical y la primera duración", () => {
    expect(initialForm(OPTIONS, "video")).toMatchObject({
      model: "t2v",
      aspectRatio: "9:16",
      durationSeconds: 5,
    });
  });

  it("cambiar de modelo corrige lo que el nuevo no acepta", () => {
    const f = withModel(OPTIONS, initialForm(OPTIONS, "video"), "ltx");
    expect(f).toMatchObject({ aspectRatio: "16:9", durationSeconds: 6 });
  });

  it("no hay pedido sin prompt; un image-to-video pide una URL https, no un prompt", () => {
    const f = initialForm(OPTIONS, "video");
    expect(toRequest(f, specFor(OPTIONS, f))).toBeNull();
    expect(toRequest({ ...f, prompt: "waves" }, specFor(OPTIONS, f))).toEqual({
      kind: "video",
      model: "t2v",
      prompt: "waves",
      aspectRatio: "9:16",
      count: 1,
      durationSeconds: 5,
    });
    const i2v = withModel(OPTIONS, f, "i2v");
    expect(toRequest(i2v, specFor(OPTIONS, i2v))).toBeNull();
    expect(
      toRequest({ ...i2v, imageUrl: "http://localhost/a.png" }, specFor(OPTIONS, i2v)),
    ).toBeNull();
    expect(
      toRequest({ ...i2v, imageUrl: "https://cdn.test/a.png" }, specFor(OPTIONS, i2v)),
    ).toMatchObject({ imageUrl: "https://cdn.test/a.png", durationSeconds: 4 });
  });

  it("la galería se refresca sólo con algo en vuelo", () => {
    expect(galleryRefetchInterval(undefined)).toBe(false);
    expect(galleryRefetchInterval([{ status: "ready" }] as never)).toBe(false);
    expect(galleryRefetchInterval([{ status: "generating" }] as never)).toBe(4000);
  });
});

describe("presupuesto (formato)", () => {
  it("dólares con centavos; centavos de centavo si el monto es chico", () => {
    expect(formatUsd(30)).toBe("$30.00");
    expect(formatUsd(0.0028)).toBe("$0.0028");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("parsea el input del tope", () => {
    expect(parseBudgetInput("42.50")).toBe(42.5);
    expect(parseBudgetInput("$1,000")).toBe(1000);
    expect(parseBudgetInput("-3")).toBeNull();
    expect(parseBudgetInput("10.001")).toBeNull();
    expect(parseBudgetInput("abc")).toBeNull();
  });

  it("fracción usada: cobrado + en vuelo, con techo en 1", () => {
    const base = OPTIONS.budget;
    expect(budgetUsedFraction({ ...base, chargedUsd: 15, reservedUsd: 0 })).toBe(0.5);
    expect(budgetUsedFraction({ ...base, chargedUsd: 25, reservedUsd: 10 })).toBe(1);
  });
});
