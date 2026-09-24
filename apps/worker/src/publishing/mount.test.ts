/**
 * El montaje de publicación: qué colas suma y qué publicadores arma. Construir
 * handlers y adaptadores no toca red ni base.
 */
import { FixedClock, MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import type { ConnectionTokens, Queue } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import { createHandlers, type WorkerHandlerDeps } from "../handlers.js";
import { createRealPublishers, publishersFor } from "./mount.js";

const clock = new FixedClock();
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const tokens: ConnectionTokens = { getAccessToken: async () => "t" };
const queue = {} as Queue;

const base: WorkerHandlerDeps = {
  db: {} as Database,
  renderer: new MemoryMediaRenderer(),
  normalizationRenderer: null,
  storage: new MemoryStorage(clock),
  clock,
  appRole: undefined,
  logger: silent,
  brandAnalysis: { kind: "unmounted", missing: ["x"] },
  copywriter: null,
};

describe("montaje de publicación", () => {
  it("sin `publishing`: ni watcher ni barrido (el comportamiento de antes)", () => {
    const { handlers } = createHandlers({ ...base, queue });
    expect(handlers[JOB_QUEUES.tiktokSlowLaneWatcher]).toBeUndefined();
    expect(handlers[JOB_QUEUES.publishingSweep]).toBeUndefined();
    expect(handlers[JOB_QUEUES.publishing]).toBeDefined();
  });

  it("con `publishing` y cola: suma el watcher y el barrido", () => {
    const { handlers } = createHandlers({
      ...base,
      queue,
      publishing: { publishers: {}, tokens, media: null, fingerprinter: null },
    });
    expect(handlers[JOB_QUEUES.tiktokSlowLaneWatcher]).toBeDefined();
    expect(handlers[JOB_QUEUES.publishingSweep]).toBeDefined();
  });

  it("los siete publicadores reales, uno por red de D-09 (YouTube y LinkedIn al final)", () => {
    const publishers = createRealPublishers({});
    expect(Object.keys(publishers).sort()).toEqual(
      ["facebook", "instagram", "threads", "tiktok", "x", "youtube", "linkedin"].sort(),
    );
    for (const [platform, publisher] of Object.entries(publishers)) {
      expect(publisher.capabilities().platform).toBe(platform);
    }
  });

  it("sin tokens no se monta ninguno", () => {
    expect(publishersFor(null, {})).toEqual({});
  });

  it("PUBLISH_YOUTUBE_PRIVACY y PUBLISH_LINKEDIN_VERSION: un valor inválido se ignora", () => {
    // Construir con valores basura no debe tirar (se usan los defaults).
    expect(() =>
      createRealPublishers({
        PUBLISH_YOUTUBE_PRIVACY: "secreto",
        PUBLISH_LINKEDIN_VERSION: "latest",
      }),
    ).not.toThrow();
    expect(
      createRealPublishers({ PUBLISH_YOUTUBE_PRIVACY: "Unlisted" })[
        "youtube"
      ]?.capabilities().platform,
    ).toBe("youtube");
  });
});
