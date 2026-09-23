/**
 * Qué colas monta el worker según la configuración. Construir un handler no
 * toca la base (sólo cierra sobre sus dependencias), así que alcanza con dobles.
 */
import { FixedClock, MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import { describe, expect, it } from "vitest";

import {
  createHandlers,
  NORMALIZATION_UNMOUNTED_WHY,
  type WorkerHandlerDeps,
} from "./handlers.js";

const clock = new FixedClock();
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function deps(
  normalizationRenderer: WorkerHandlerDeps["normalizationRenderer"],
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
    ]);
    expect(NORMALIZATION_UNMOUNTED_WHY).toContain("processing");
  });

  it("con servicio de render: media-normalization se monta, y nada queda afuera", () => {
    const { handlers, unmounted } = createHandlers(deps(new MemoryMediaRenderer()));
    expect(Object.keys(handlers).sort()).toEqual(
      [...SIEMPRE, JOB_QUEUES.mediaNormalization].sort(),
    );
    expect(unmounted).toEqual([]);
  });
});
