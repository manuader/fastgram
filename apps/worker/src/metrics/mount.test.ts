import { describe, expect, it } from "vitest";

import { createMetricsAdapters, xMetricsEnabled } from "./mount.js";

describe("createMetricsAdapters", () => {
  it("X está apagado por defecto: leer cuesta US$0,005 por post", () => {
    expect(xMetricsEnabled({})).toBe(false);
    expect(Object.keys(createMetricsAdapters({})).sort()).toEqual([
      "facebook",
      "instagram",
      "threads",
    ]);
  });

  it("METRICS_X_ENABLED=true lo monta; TikTok nunca (no hay scope ni id de video)", () => {
    const adapters = createMetricsAdapters({ METRICS_X_ENABLED: "true" });
    expect(adapters["x"]?.capabilities().costPerPostReadUsd).toBe(0.005);
    expect(adapters["tiktok"]).toBeUndefined();
  });
});
