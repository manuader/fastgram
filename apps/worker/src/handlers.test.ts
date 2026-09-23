/**
 * Qué colas monta el worker según la configuración. Construir un handler no
 * toca la base (sólo cierra sobre sus dependencias), así que alcanza con dobles.
 */
import { FixedClock, MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import { describe, expect, it } from "vitest";

import { createLlmBrandSynthesizer } from "./brand/synthesizer.js";
import {
  brandAnalysisUnmountedWhy,
  createHandlers,
  NORMALIZATION_UNMOUNTED_WHY,
  type BrandAnalysisMount,
  type WorkerHandlerDeps,
} from "./handlers.js";

const clock = new FixedClock();
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const SIN_ANALISIS: BrandAnalysisMount = {
  kind: "unmounted",
  missing: ["BRAND_SNAPSHOT_RAW_RETENTION_DAYS"],
};

function deps(
  normalizationRenderer: WorkerHandlerDeps["normalizationRenderer"],
  brandAnalysis: BrandAnalysisMount = SIN_ANALISIS,
): WorkerHandlerDeps {
  return {
    // Ningún handler toca la base al construirse; el doble vacío lo prueba: si
    // alguno la tocara, el test explotaría acá en vez de pasar.
    db: {} as Database,
    renderer: new MemoryMediaRenderer(),
    normalizationRenderer,
    storage: new MemoryStorage(clock),
    clock,
    appRole: undefined,
    logger: silent,
    brandAnalysis,
  };
}

/** Las siete que se montan siempre, con o sin servicio de render. */
const SIEMPRE = [
  JOB_QUEUES.contentBuild,
  JOB_QUEUES.publishing,
  JOB_QUEUES.influencerPipeline,
  JOB_QUEUES.discoveryRefill,
  JOB_QUEUES.brandSourceStalenessSweep,
  JOB_QUEUES.snapshotPurge,
  JOB_QUEUES.quotaReset,
].sort();

describe("createHandlers", () => {
  it("sin servicio de render: media-normalization NO se monta, y se dice por qué", () => {
    const { handlers, unmounted } = createHandlers(deps(null));
    expect(Object.keys(handlers).sort()).toEqual(SIEMPRE);
    expect(unmounted).toEqual([
      { queue: JOB_QUEUES.mediaNormalization, why: NORMALIZATION_UNMOUNTED_WHY },
      {
        queue: JOB_QUEUES.brandSourceAnalysis,
        why: brandAnalysisUnmountedWhy(["BRAND_SNAPSHOT_RAW_RETENTION_DAYS"]),
      },
    ]);
    expect(NORMALIZATION_UNMOUNTED_WHY).toContain("processing");
  });

  it("con servicio de render: media-normalization se monta", () => {
    const { handlers, unmounted } = createHandlers(deps(new MemoryMediaRenderer()));
    expect(Object.keys(handlers).sort()).toEqual(
      [...SIEMPRE, JOB_QUEUES.mediaNormalization].sort(),
    );
    expect(unmounted.map((u) => u.queue)).toEqual([JOB_QUEUES.brandSourceAnalysis]);
  });

  it("sin configuración de análisis: brand-source-analysis NO se monta y nombra lo que falta", () => {
    const { handlers, unmounted } = createHandlers(
      deps(null, { kind: "unmounted", missing: ["LLM_BASE_URL + LLM_API_KEY"] }),
    );
    expect(handlers[JOB_QUEUES.brandSourceAnalysis]).toBeUndefined();
    const why = unmounted.find((u) => u.queue === JOB_QUEUES.brandSourceAnalysis)?.why;
    expect(why).toContain("LLM_BASE_URL + LLM_API_KEY");
    expect(why).toContain("pending");
  });

  it("con extractor, LLM y retención: brand-source-analysis se monta", () => {
    const llm = {
      complete: () => Promise.reject(new Error("no se llama al construir")),
      completeJson: () => Promise.reject(new Error("no se llama al construir")),
    };
    const { handlers, unmounted } = createHandlers(
      deps(new MemoryMediaRenderer(), {
        kind: "mounted",
        readers: {},
        synthesizer: createLlmBrandSynthesizer({ llm }),
        rawRetentionDays: 30,
      }),
    );
    expect(Object.keys(handlers).sort()).toEqual(
      [...SIEMPRE, JOB_QUEUES.mediaNormalization, JOB_QUEUES.brandSourceAnalysis].sort(),
    );
    expect(unmounted).toEqual([]);
  });
});
