/**
 * Qué colas monta el worker según la configuración. Construir un handler no
 * toca la base (sólo cierra sobre sus dependencias), así que alcanza con dobles.
 */
import { FixedClock, MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import { describe, expect, it } from "vitest";

import { createLlmBrandSynthesizer } from "./brand/synthesizer.js";
import type { SuggestionCopywriter } from "./discovery/copywriter.js";
import { REFILL_WITHOUT_LLM_WHY } from "./discovery/refill-handler.js";
import { BRAND_BACKGROUNDS_UNMOUNTED_WHY } from "./brand-kit/mount.js";
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

/** Un copywriter que nunca se llama: construir el handler no lo invoca. */
const COPYWRITER: SuggestionCopywriter = {
  write: () => Promise.reject(new Error("no se llama al construir")),
};

function deps(
  normalizationRenderer: WorkerHandlerDeps["normalizationRenderer"],
  brandAnalysis: BrandAnalysisMount = SIN_ANALISIS,
  copywriter: SuggestionCopywriter | null = COPYWRITER,
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
    copywriter,
  };
}

/** Las ocho que se montan siempre, con o sin servicio de render. */
const SIEMPRE = [
  JOB_QUEUES.contentBuild,
  JOB_QUEUES.contentRebuild,
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
      { queue: JOB_QUEUES.brandBackgrounds, why: BRAND_BACKGROUNDS_UNMOUNTED_WHY },
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
    // El de memoria no genera fondos: `brand-backgrounds` sigue afuera.
    expect(unmounted.map((u) => u.queue)).toEqual([
      JOB_QUEUES.brandBackgrounds,
      JOB_QUEUES.brandSourceAnalysis,
    ]);
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
    expect(unmounted.map((u) => u.queue)).toEqual([JOB_QUEUES.brandBackgrounds]);
  });

  it("brand-backgrounds se monta con el generador del renderer de normalización", () => {
    // Un doble con la forma de `HttpMediaRenderer`: los dos puertos.
    const both = Object.assign(new MemoryMediaRenderer(), {
      generateBrandBackground: () =>
        Promise.reject(new Error("no se llama al construir")),
    });
    const { handlers, unmounted } = createHandlers(deps(both));
    expect(handlers[JOB_QUEUES.brandBackgrounds]).toBeDefined();
    expect(unmounted.map((u) => u.queue)).not.toContain(JOB_QUEUES.brandBackgrounds);
  });

  it("trampa 46: el generador NO sale del renderer de builds", () => {
    // Negativa primero: con el de builds capaz de generar y sin el de
    // normalización, no se monta — el de builds es el de memoria sin render.
    const builds = Object.assign(new MemoryMediaRenderer(), {
      generateBrandBackground: () => Promise.reject(new Error("no se llama")),
    });
    const { handlers, unmounted } = createHandlers({ ...deps(null), renderer: builds });
    expect(handlers[JOB_QUEUES.brandBackgrounds]).toBeUndefined();
    expect(unmounted.map((u) => u.queue)).toContain(JOB_QUEUES.brandBackgrounds);
  });

  it("sin LLM: discovery-refill se monta igual (inerte) y el arranque dice por qué", () => {
    const { handlers, unmounted } = createHandlers(
      deps(new MemoryMediaRenderer(), SIN_ANALISIS, null),
    );
    expect(handlers[JOB_QUEUES.discoveryRefill]).toBeDefined();
    expect(unmounted).toContainEqual({
      queue: JOB_QUEUES.discoveryRefill,
      why: REFILL_WITHOUT_LLM_WHY,
    });
    expect(REFILL_WITHOUT_LLM_WHY).toContain("LLM_MODEL");
  });
});
