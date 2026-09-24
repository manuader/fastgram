import { describe, expect, it } from "vitest";

import {
  evaluatePublishGuards,
  publishGuardPolicyFor,
  type GuardNeighbor,
  type GuardSubject,
  type PublishGuardPolicy,
} from "./guards.js";
import {
  nextPublishRetry,
  resumeAfterReconnect,
  slowLaneWatchDecision,
  AWAITING_RECONNECT_GRACE_MS,
  SLOW_LANE_WATCH_WINDOW_MS,
} from "./retry.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BA = "America/Argentina/Buenos_Aires";
// 2026-09-24 15:00 en Buenos Aires (UTC−3) = 18:00Z.
const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);

const policy: PublishGuardPolicy = { dailyCap: 3, brandGapMinutes: 10, timezone: BA };

const subject = (over: Partial<GuardSubject> = {}): GuardSubject => ({
  id: "p-self",
  brandId: "brand-a",
  network: "instagram",
  scheduledAtMs: NOW,
  fingerprint: "hash-self",
  ...over,
});

const out = (over: Partial<GuardNeighbor>): GuardNeighbor => ({
  id: `n-${Math.random().toString(36).slice(2)}`,
  brandId: "brand-a",
  network: "instagram",
  atMs: NOW - HOUR,
  state: "out",
  ...over,
});

describe("guardas anti-bot al publicar — PU-PUB-007", () => {
  it("sin nada alrededor, publica", () => {
    expect(
      evaluatePublishGuards({ subject: subject(), nowMs: NOW, policy, neighbors: [] }),
    ).toEqual({ kind: "publish" });
  });

  describe("regla 1 · nunca la misma pieza en dos marcas", () => {
    it("rechaza si la misma huella ya salió en otra marca", () => {
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy,
        neighbors: [
          out({
            brandId: "brand-b",
            fingerprint: "hash-self",
            atMs: NOW - 5 * 24 * HOUR,
          }),
        ],
      });
      expect(decision).toMatchObject({ kind: "reject", code: "duplicate_across_brands" });
    });

    it("la misma huella en la MISMA marca no es duplicado entre marcas", () => {
      // Publicar la misma pieza en IG y en TikTok de una marca es el caso normal.
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy,
        neighbors: [out({ network: "tiktok", fingerprint: "hash-self" })],
      });
      expect(decision).toEqual({ kind: "publish" });
    });

    it("una pendiente de otra marca con la misma huella no bloquea (todavía no salió)", () => {
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy,
        neighbors: [
          out({
            brandId: "brand-b",
            state: "pending",
            fingerprint: "hash-self",
            atMs: NOW + 5 * HOUR,
          }),
        ],
      });
      expect(decision).toEqual({ kind: "publish" });
    });

    it("sin huella calculada no rechaza por duplicado", () => {
      const decision = evaluatePublishGuards({
        subject: subject({ fingerprint: null }),
        nowMs: NOW,
        policy,
        neighbors: [out({ brandId: "brand-b", fingerprint: null })],
      });
      expect(decision).toEqual({ kind: "publish" });
    });
  });

  describe("regla 2 · tope por red y día local de la marca", () => {
    it("con el tope lleno, reprograma al día siguiente a la misma hora local", () => {
      const neighbors = [1, 2, 3].map((h) => out({ atMs: NOW - h * HOUR }));
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy,
        neighbors,
      });
      expect(decision).toEqual({
        kind: "reschedule",
        atMs: NOW + 24 * HOUR,
        reason: "daily_cap",
      });
    });

    it("cuenta el día de la MARCA, no el UTC", () => {
      // 01:30Z del 25 son las 22:30 del 24 en Buenos Aires: mismo día local que
      // las tres de la tarde. En UTC serían días distintos y pasaría.
      const lateNow = Date.UTC(2026, 8, 25, 1, 30);
      const neighbors = [1, 2, 3].map((h) => out({ atMs: NOW - h * HOUR }));
      const decision = evaluatePublishGuards({
        subject: subject({ scheduledAtMs: lateNow }),
        nowMs: lateNow,
        policy,
        neighbors,
      });
      expect(decision).toMatchObject({ kind: "reschedule", reason: "daily_cap" });
    });

    it("otras redes de la marca no gastan el tope de ésta", () => {
      const neighbors = [1, 2, 3].map((h) =>
        out({ network: "tiktok", atMs: NOW - h * HOUR }),
      );
      expect(
        evaluatePublishGuards({ subject: subject(), nowMs: NOW, policy, neighbors }),
      ).toEqual({ kind: "publish" });
    });

    it("el tope es el de la estrategia", () => {
      const neighbors = [out({ atMs: NOW - HOUR })];
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy: { ...policy, dailyCap: 1 },
        neighbors,
      });
      expect(decision).toMatchObject({ kind: "reschedule", reason: "daily_cap" });
    });

    it("si el día siguiente también está lleno, sigue buscando", () => {
      const neighbors = [
        ...[1, 2, 3].map((h) => out({ atMs: NOW - h * HOUR })),
        ...[1, 2, 3].map((h) =>
          out({ state: "pending", atMs: NOW + 24 * HOUR - h * HOUR }),
        ),
      ];
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy,
        neighbors,
      });
      expect(decision).toEqual({
        kind: "reschedule",
        atMs: NOW + 48 * HOUR,
        reason: "daily_cap",
      });
    });

    it("tope 0 explícito rechaza con código estable", () => {
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy: { ...policy, dailyCap: 0 },
        neighbors: [],
      });
      expect(decision).toMatchObject({ kind: "reject", code: "anti_bot_no_slot" });
    });
  });

  describe("regla 3 · separación entre marcas del mismo dueño", () => {
    it("si otra marca publicó hace 4 min, espera a completar los 10", () => {
      const decision = evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy,
        neighbors: [out({ brandId: "brand-b", network: "tiktok", atMs: NOW - 4 * MIN })],
      });
      expect(decision).toEqual({
        kind: "reschedule",
        atMs: NOW + 6 * MIN,
        reason: "brand_gap",
      });
    });

    it("hace 11 minutos ya no molesta", () => {
      expect(
        evaluatePublishGuards({
          subject: subject(),
          nowMs: NOW,
          policy,
          neighbors: [out({ brandId: "brand-b", atMs: NOW - 11 * MIN })],
        }),
      ).toEqual({ kind: "publish" });
    });

    it("dos marcas a la misma hora: exactamente una cede", () => {
      const a = subject({ id: "p-a", brandId: "brand-a" });
      const b = subject({ id: "p-b", brandId: "brand-b" });
      const pendingA: GuardNeighbor = {
        id: "p-a",
        brandId: "brand-a",
        network: "instagram",
        atMs: NOW,
        state: "pending",
      };
      const pendingB: GuardNeighbor = {
        id: "p-b",
        brandId: "brand-b",
        network: "instagram",
        atMs: NOW,
        state: "pending",
      };

      const forA = evaluatePublishGuards({
        subject: a,
        nowMs: NOW,
        policy,
        neighbors: [pendingB],
      });
      const forB = evaluatePublishGuards({
        subject: b,
        nowMs: NOW,
        policy,
        neighbors: [pendingA],
      });

      expect(forA).toEqual({ kind: "publish" });
      expect(forB).toEqual({
        kind: "reschedule",
        atMs: NOW + 10 * MIN,
        reason: "brand_gap",
      });
    });

    it("una pendiente POSTERIOR de otra marca no lo frena: cede ella", () => {
      expect(
        evaluatePublishGuards({
          subject: subject(),
          nowMs: NOW,
          policy,
          neighbors: [out({ brandId: "brand-b", state: "pending", atMs: NOW + 3 * MIN })],
        }),
      ).toEqual({ kind: "publish" });
    });

    it("gap 0 la apaga", () => {
      expect(
        evaluatePublishGuards({
          subject: subject(),
          nowMs: NOW,
          policy: { ...policy, brandGapMinutes: 0 },
          neighbors: [out({ brandId: "brand-b", atMs: NOW - MIN })],
        }),
      ).toEqual({ kind: "publish" });
    });
  });

  it("se ignora a sí mismo en la lista de vecinos", () => {
    const self: GuardNeighbor = {
      id: "p-self",
      brandId: "brand-a",
      network: "instagram",
      atMs: NOW,
      state: "pending",
      fingerprint: "hash-self",
    };
    expect(
      evaluatePublishGuards({
        subject: subject(),
        nowMs: NOW,
        policy: { ...policy, dailyCap: 1 },
        neighbors: [self],
      }),
    ).toEqual({ kind: "publish" });
  });
});

describe("política desde la estrategia", () => {
  it("sin estrategia guardada: los defaults de §5 (3 y 10)", () => {
    expect(publishGuardPolicyFor(null, "instagram", BA)).toEqual({
      dailyCap: 3,
      brandGapMinutes: 10,
      timezone: BA,
    });
  });

  it("toma el dailyCap de la red y la separación de la marca", () => {
    const p = publishGuardPolicyFor(
      {
        networks: [{ network: "instagram", enabled: true, perDay: 2, dailyCap: 2 }],
        brandGapMinutes: 25,
      },
      "instagram",
      BA,
    );
    expect(p).toEqual({ dailyCap: 2, brandGapMinutes: 25, timezone: BA });
  });

  it("un jsonb roto cae al default en vez de romper", () => {
    const p = publishGuardPolicyFor({ networks: "basura", brandGapMinutes: 5 }, "x", BA);
    expect(p.dailyCap).toBe(3);
  });
});

describe("reintentos — PU-PUB-008", () => {
  it("un transitorio antes de entregar se reintenta con backoff 1/5/15 min", () => {
    const delays = [0, 1, 2].map((retriesSoFar) =>
      nextPublishRetry({ retriesSoFar, retryable: true, deliveryUncertain: false }),
    );
    expect(delays).toEqual([
      { kind: "retry", delayMs: 60_000, retryNumber: 1 },
      { kind: "retry", delayMs: 300_000, retryNumber: 2 },
      { kind: "retry", delayMs: 900_000, retryNumber: 3 },
    ]);
    expect(
      nextPublishRetry({ retriesSoFar: 3, retryable: true, deliveryUncertain: false }),
    ).toEqual({ kind: "give_up" });
  });

  it("entrega incierta NUNCA se reintenta (NFR-015)", () => {
    expect(
      nextPublishRetry({ retriesSoFar: 0, retryable: true, deliveryUncertain: true }),
    ).toEqual({ kind: "give_up" });
  });

  it("un error permanente no se reintenta", () => {
    expect(
      nextPublishRetry({ retriesSoFar: 0, retryable: false, deliveryUncertain: false }),
    ).toEqual({ kind: "give_up" });
  });

  it("respeta el Retry-After si es mayor, con tope de 1 h", () => {
    expect(
      nextPublishRetry({
        retriesSoFar: 0,
        retryable: true,
        deliveryUncertain: false,
        retryAfterSeconds: 120,
      }),
    ).toMatchObject({ delayMs: 120_000 });
    expect(
      nextPublishRetry({
        retriesSoFar: 0,
        retryable: true,
        deliveryUncertain: false,
        retryAfterSeconds: 99_999,
      }),
    ).toMatchObject({ delayMs: 3_600_000 });
  });
});

describe("AWAITING_RECONNECT — P3-PUB-002", () => {
  it("dentro del margen se reanuda, a un minuto de ahora si la hora pasó", () => {
    expect(resumeAfterReconnect({ scheduledAtMs: NOW - HOUR, nowMs: NOW })).toEqual({
      kind: "resume",
      atMs: NOW + MIN,
    });
  });

  it("si la hora todavía no llegó, conserva la hora", () => {
    expect(resumeAfterReconnect({ scheduledAtMs: NOW + HOUR, nowMs: NOW })).toEqual({
      kind: "resume",
      atMs: NOW + HOUR,
    });
  });

  it("fuera del margen, vence", () => {
    expect(
      resumeAfterReconnect({
        scheduledAtMs: NOW - AWAITING_RECONNECT_GRACE_MS - 1,
        nowMs: NOW,
      }),
    ).toEqual({ kind: "expire" });
  });
});

describe("watcher del carril lento — P3-PUB-004", () => {
  const base = { watchStartedAtMs: NOW, nowMs: NOW + HOUR };

  it("procesando dentro de la ventana: sigue mirando", () => {
    expect(slowLaneWatchDecision({ ...base, status: "processing" })).toEqual({
      kind: "keep_watching",
      delayMs: 30 * MIN,
    });
  });

  it("procesando pasadas las 72 h: se da por fallido, nunca se reprograma", () => {
    expect(
      slowLaneWatchDecision({
        status: "processing",
        watchStartedAtMs: NOW,
        nowMs: NOW + SLOW_LANE_WATCH_WINDOW_MS,
      }),
    ).toEqual({ kind: "give_up" });
  });

  it("en el inbox pasadas las 72 h: deja de mirar SIN fallar", () => {
    expect(
      slowLaneWatchDecision({
        status: "in_user_inbox",
        watchStartedAtMs: NOW,
        nowMs: NOW + SLOW_LANE_WATCH_WINDOW_MS,
      }),
    ).toEqual({ kind: "stop" });
  });

  it("publicado o fallido: para", () => {
    expect(slowLaneWatchDecision({ ...base, status: "published" })).toEqual({
      kind: "stop",
    });
    expect(slowLaneWatchDecision({ ...base, status: "failed" })).toEqual({
      kind: "stop",
    });
  });
});

describe("regla 4 · cuota oficial de la instalación (YouTube, PU-LATER-001)", () => {
  const LA = "America/Los_Angeles";
  const yt = (brandId: string, atMs: number, state: "out" | "pending" = "out") =>
    out({ brandId, network: "youtube", atMs, state, fingerprint: null });

  it("la política de youtube trae 100 por día del Pacífico; las demás redes no", () => {
    expect(publishGuardPolicyFor(null, "youtube", BA).platformDailyQuota).toEqual({
      max: 100,
      timezone: LA,
    });
    expect(
      publishGuardPolicyFor(null, "linkedin", BA).platformDailyQuota,
    ).toBeUndefined();
    expect(
      publishGuardPolicyFor({ networks: [], brandGapMinutes: 0 }, "youtube", BA)
        .platformDailyQuota,
    ).toEqual({ max: 100, timezone: LA });
  });

  it("con la cuota del día llena sumando TODAS las marcas, reprograma al día siguiente", () => {
    // 100 subidas hoy (día del Pacífico), repartidas en 50 marcas: ninguna
    // pasa su tope propio, pero el proyecto de Google sí.
    const neighbors: GuardNeighbor[] = [];
    for (let i = 0; i < 100; i += 1) {
      neighbors.push(yt(`brand-${String(i % 50)}`, NOW - HOUR + i * 1000));
    }
    const decision = evaluatePublishGuards({
      subject: subject({ network: "youtube", fingerprint: null }),
      nowMs: NOW,
      policy: {
        dailyCap: 24,
        brandGapMinutes: 0,
        timezone: BA,
        platformDailyQuota: { max: 100, timezone: LA },
      },
      neighbors,
    });
    expect(decision).toMatchObject({ kind: "reschedule", reason: "platform_quota" });
    if (decision.kind === "reschedule") {
      expect(decision.atMs).toBe(NOW + 24 * HOUR);
    }
  });

  it("99 subidas: todavía hay lugar, publica", () => {
    const neighbors = Array.from({ length: 99 }, (_, i) =>
      yt(`brand-${String(i % 50)}`, NOW - HOUR + i * 1000),
    );
    expect(
      evaluatePublishGuards({
        subject: subject({ network: "youtube", fingerprint: null }),
        nowMs: NOW,
        policy: {
          dailyCap: 24,
          brandGapMinutes: 0,
          timezone: BA,
          platformDailyQuota: { max: 100, timezone: LA },
        },
        neighbors,
      }),
    ).toEqual({ kind: "publish" });
  });
});
