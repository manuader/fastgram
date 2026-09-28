import { describe, expect, it } from "vitest";
import {
  JOB_CATALOG,
  maxLifetimeSeconds,
  retryDelaySeconds,
  type JobPolicy,
} from "./catalog.js";

const jobs = Object.values(JOB_CATALOG) as readonly JobPolicy[];

describe("catálogo de jobs — PRD §9.5", () => {
  it("están los 21 del PRD, más brand-backgrounds (PU-MEDIA-002), media-import (PU-MEME-001), publishing-sweep (PU-PUB-008), audio-extract (sprint 7, H) y los tres del sprint 9: library-import, design-system y ads-sync", () => {
    expect(jobs).toHaveLength(28);
  });

  it("ningún nombre de cola repetido", () => {
    // El nombre es contrato entre productor y consumidor: dos jobs con el
    // mismo nombre hacen que uno consuma los mensajes del otro.
    const nombres = jobs.map((j) => j.name);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it("cada job dice dónde lo especifica el PRD", () => {
    // `brand-backgrounds`, `media-import` y `publishing-sweep` salen del plan de
    // uso personal, y los del sprint 9 de `PU-S9-*`, no de §9.5. Ojo: los de
    // fuera de §9.5 dicen "(fuera de §9.5)" y matchearían `§9\.5` solos; por
    // eso el id de la tarea se exige aparte.
    for (const j of jobs) {
      expect(j.prd, j.name).toMatch(
        /§9\.5|PU-MEDIA-002|PU-MEME-001|PU-PUB-008|PU-S9-\d{3}/,
      );
      if (j.prd.includes("fuera de §9.5"))
        expect(j.prd, j.name).toMatch(/PU-[A-Z0-9]+-\d{3}/);
    }
  });
});

describe("el invariante que evita publicar dos veces", () => {
  it("ningún job NO idempotente tiene reintentos", () => {
    // Es el chequeo más importante del archivo. Un reintento automático de una
    // publicación puede dejar dos posts en la cuenta del usuario, y eso no se
    // deshace desde acá.
    for (const j of jobs) {
      if (!j.idempotent) {
        expect(j.maxAttempts, `${j.name} no es idempotente y reintenta`).toBe(1);
      }
    }
  });

  it("publishing es el job no idempotente, y no reintenta", () => {
    expect(JOB_CATALOG.publishing.idempotent).toBe(false);
    expect(JOB_CATALOG.publishing.maxAttempts).toBe(1);
  });
});

describe("los plazos del PRD, fijados", () => {
  it("el watcher de TikTok aguanta las 72 horas que pide INT-001", () => {
    // TikTok puede tardar 24–48 h en publicar del carril lento. Abandonar
    // antes deja el post en limbo sin que nadie se entere.
    const w = JOB_CATALOG.tiktokSlowLaneWatcher;
    const horas = (w.maxAttempts * w.retryDelaySeconds) / 3600;
    expect(horas).toBeGreaterThanOrEqual(72);
  });

  it("un build de contenido no se cuelga más de 5 minutos", () => {
    // El PRD dice 30 s – 2 min. Más allá está roto, y conviene fallar y
    // reembolsar el save antes que dejar al usuario mirando un spinner.
    expect(JOB_CATALOG.contentBuild.timeoutSeconds).toBeLessThanOrEqual(300);
  });

  it("el pipeline de influencer cubre los 15–20 min de FR-080", () => {
    expect(JOB_CATALOG.influencerPipeline.timeoutSeconds).toBeGreaterThanOrEqual(1_200);
  });

  it("el pipeline de influencer reintenta poco: es el driver de costo #1", () => {
    // 250 créditos y 15–20 min de GPU por intento. Reintentar tres veces un
    // fallo permanente quema una hora de GPU para llegar al mismo error.
    expect(JOB_CATALOG.influencerPipeline.maxAttempts).toBeLessThanOrEqual(2);
  });

  it("AI Studio respeta el cap de 10 en vuelo de FR-090", () => {
    expect(JOB_CATALOG.aiStudioGeneration.concurrency).toBe(10);
  });

  it("la purga de snapshots reintenta más que el resto", () => {
    // Es una obligación de retención, no una optimización: si falla hay que
    // reintentarla, no saltearla.
    expect(JOB_CATALOG.snapshotPurge.maxAttempts).toBeGreaterThan(3);
  });
});

describe("backoff", () => {
  it("el primer intento no espera", () => {
    for (const j of jobs) expect(retryDelaySeconds(j, 1)).toBe(0);
  });

  it("el exponencial duplica", () => {
    const j = JOB_CATALOG.contentBuild; // 15 s, exponencial
    expect(retryDelaySeconds(j, 2)).toBe(15);
    expect(retryDelaySeconds(j, 3)).toBe(30);
    expect(retryDelaySeconds(j, 4)).toBe(60);
  });

  it("el fijo no crece — el watcher de TikTok depende de eso", () => {
    const w = JOB_CATALOG.tiktokSlowLaneWatcher;
    expect(retryDelaySeconds(w, 2)).toBe(1_800);
    expect(retryDelaySeconds(w, 100)).toBe(1_800);
  });

  it("el exponencial se topa en 1 hora", () => {
    // Sin tope, un backoff exponencial con muchos intentos termina
    // programando el siguiente para dentro de varios días.
    expect(retryDelaySeconds(JOB_CATALOG.snapshotPurge, 20)).toBe(3_600);
  });

  it("ningún job puede vivir más de una semana, salvo el de TikTok", () => {
    const SEMANA = 7 * 86_400;
    for (const j of jobs) {
      if (j.name === "tiktok-slow-lane-watcher") continue;
      expect(maxLifetimeSeconds(j), j.name).toBeLessThan(SEMANA);
    }
  });
});

describe("jobs programados", () => {
  it("el reset de cuota se declara como RED, no como mecanismo", () => {
    // El reset real se calcula en lectura contra el reloj. Si dependiera de
    // este cron, la cuota de un cliente dependería de que el cron haya
    // corrido. El comentario del catálogo lo dice; este test lo fija.
    const r = JOB_CATALOG.quotaReset;
    expect(r.scheduled?.cron).toBe("0 0 * * *");
    expect(r.scheduled?.why).toMatch(/Red, no mecanismo/);
  });

  it("todo job programado explica por qué corre a esa hora", () => {
    for (const j of jobs) {
      if (j.scheduled !== undefined) {
        expect(j.scheduled.why.length, j.name).toBeGreaterThan(20);
      }
    }
  });
});
