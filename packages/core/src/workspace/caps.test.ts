import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { HARD_CAPS } from "../quota/plans.js";
import { ANGLE_ERROR_CODES, type ContentAngle, type InfluencerRef } from "../angles/angles.js";
import type { CreditsLedger } from "../quota/content-saves.js";
import type { IdGenerator } from "../ids.js";
import {
  WORKSPACE_CAP_CODES,
  assertBatchSize,
  assertCanAddBrandSource,
  assertCanActivateInfluencer,
  assertCanStartGeneration,
} from "./caps.js";
import {
  createContentAngle,
  type ContentAngleRepository,
} from "./create-content-angle.js";
import { releaseAiStudioGeneration, startAiStudioGeneration } from "./ai-studio.js";
import { activateInfluencer, deactivateInfluencer } from "./influencers.js";

const TX = { __tx: "t1" };

function ids(): IdGenerator {
  let n = 0;
  return { newId: (p) => `${p}_${++n}` };
}

// ───────────────────────────────────────────────────────────────────────────
// Los cuatro caps, en el borde
// ───────────────────────────────────────────────────────────────────────────

describe("50 influencers ACTIVOS por workspace (§16.2)", () => {
  it("49 pasa, 50 no — el borde es donde vive el bug de >= vs >", () => {
    expect(HARD_CAPS.activeInfluencers).toBe(50);
    expect(() => assertCanActivateInfluencer(49)).not.toThrow();
    expect(() => assertCanActivateInfluencer(50)).toThrow(DomainError);
    expect(() => assertCanActivateInfluencer(51)).toThrow(DomainError);
  });

  it("el error dice cómo salir del bloqueo", () => {
    try {
      assertCanActivateInfluencer(50);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe("out_of_range");
      expect(err.message).toContain("Deactivate one");
      expect(err.details?.cap).toBe(50);
    }
  });
});

describe("5 brand sources por workspace (FR-011.6 · ERR-B10)", () => {
  it("4 pasa, 5 no", () => {
    expect(HARD_CAPS.brandSources).toBe(5);
    expect(() => assertCanAddBrandSource(4)).not.toThrow();
    expect(() => assertCanAddBrandSource(5)).toThrow(DomainError);
  });

  it("usa el copy literal de §19.5.1 y lleva el código ERR-B10", () => {
    try {
      assertCanAddBrandSource(5);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.message).toBe("You can analyse up to 5 sources per workspace.");
      expect(err.details?.code).toBe(WORKSPACE_CAP_CODES.maxBrandSources);
    }
  });
});

describe("10 generaciones de AI Studio en vuelo (NFR-025)", () => {
  it("9 pasa, 10 no", () => {
    expect(HARD_CAPS.inFlightGenerations).toBe(10);
    expect(() => assertCanStartGeneration(9)).not.toThrow();
    expect(() => assertCanStartGeneration(10)).toThrow(DomainError);
  });
});

describe("100 ids por operación en lote (§16.2)", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `id_${i}`);

  it("100 pasa, 101 no, 0 tampoco", () => {
    expect(HARD_CAPS.idsPerBatch).toBe(100);
    expect(() => assertBatchSize(list(100))).not.toThrow();
    expect(() => assertBatchSize(list(101))).toThrow(DomainError);
    expect(() => assertBatchSize([])).toThrow(DomainError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// El cap de ángulos, ahora CABLEADO
// ───────────────────────────────────────────────────────────────────────────

interface AngleRepoState {
  liveCount: number;
  activeIds: string[];
  perInfluencer: Record<string, number>;
  influencers: InfluencerRef[];
  brandRevision: number;
  inserted: ContentAngle[];
  weightsWritten: Record<string, number>[];
}

function angleRepo(over: Partial<AngleRepoState> = {}): {
  repository: ContentAngleRepository;
  state: AngleRepoState;
} {
  const state: AngleRepoState = {
    liveCount: 0,
    activeIds: [],
    perInfluencer: {},
    influencers: [],
    brandRevision: 7,
    inserted: [],
    weightsWritten: [],
    ...over,
  };

  const repository: ContentAngleRepository = {
    async countLiveAngles() {
      return state.liveCount;
    },
    async listActiveAngleIds() {
      return state.activeIds;
    },
    async countAnglesPerInfluencer() {
      return state.perInfluencer;
    },
    async listWorkspaceInfluencers() {
      return state.influencers;
    },
    async currentBrandRevision() {
      return state.brandRevision;
    },
    async insertAngle(_companyId, angle) {
      state.inserted.push(angle);
      state.activeIds = [...state.activeIds, angle.id];
    },
    async writeAngleWeights(_companyId, weights) {
      state.weightsWritten.push({ ...weights });
    },
  };

  return { repository, state };
}

const angleInput = {
  companyId: "co_1",
  actorId: "usr_1",
  transaction: TX,
  title: "Consistency Without Burnout",
  description: "Highlights how non-marketers can produce on-brand content.",
  targetAudience: "Solo founders",
};

describe("crear un ángulo — el cap de 100 por fin se aplica (FR-056)", () => {
  it("con 99 ángulos vivos se puede crear el 100", async () => {
    const { repository, state } = angleRepo({ liveCount: 99, activeIds: [] });
    await createContentAngle({ ids: ids(), repository }, angleInput);
    expect(state.inserted).toHaveLength(1);
  });

  it("con 100 ángulos vivos el 101 se rechaza con MAX_ANGLES_EXCEEDED", async () => {
    // Antes de este caso de uso, la base aceptaba el 101.
    const { repository, state } = angleRepo({ liveCount: 100 });
    try {
      await createContentAngle({ ids: ids(), repository }, angleInput);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(ANGLE_ERROR_CODES.maxAngles);
    }
    expect(state.inserted).toHaveLength(0);
    expect(state.weightsWritten).toHaveLength(0);
  });

  it("el conteo excluye borrados: borrar libera slot", async () => {
    // El repositorio cuenta VIVOS. Con 120 creados y 20 borrados, liveCount
    // es 100 y no se puede crear; con 99 vivos sí. El caso de uso no puede
    // verificar esto por su cuenta — lo que sí hace es no contar dos veces.
    const { repository, state } = angleRepo({ liveCount: 99 });
    await createContentAngle({ ids: ids(), repository }, angleInput);
    expect(state.inserted).toHaveLength(1);
  });
});

describe("crear un ángulo reparte los pesos EN LA MISMA transacción (§9.4)", () => {
  it("el ángulo nace activo y el mapa se reescribe (FR-056, criterio 1)", async () => {
    const { repository, state } = angleRepo({ liveCount: 2, activeIds: ["a", "b"] });
    const out = await createContentAngle({ ids: ids(), repository }, angleInput);

    expect(out.angle.isActive).toBe(true);
    expect(state.weightsWritten).toHaveLength(1);
    // El ejemplo literal del PRD: 3 ángulos → 34/33/33.
    expect(out.weights).toEqual({ a: 34, b: 33, [out.angle.id]: 33 });
    expect(Object.values(out.weights).reduce((x, y) => x + y, 0)).toBe(100);
  });

  it("el nuevo ángulo SIEMPRE aparece en el mapa, aunque el listado no lo traiga", async () => {
    // Si el repositorio devolviera los activos sin el recién insertado, el
    // mapa quedaría sumando 100 sobre N-1 y el ángulo nuevo no saldría nunca:
    // sin error, sin alerta, sin forma de deducirlo.
    const { repository } = angleRepo({ liveCount: 1, activeIds: ["a"] });
    const stale: ContentAngleRepository = {
      ...repository,
      async insertAngle() {},
      async listActiveAngleIds() {
        return ["a"];
      },
    };
    const out = await createContentAngle({ ids: ids(), repository: stale }, angleInput);
    expect(Object.keys(out.weights)).toContain(out.angle.id);
    expect(Object.values(out.weights).reduce((x, y) => x + y, 0)).toBe(100);
  });

  it("si el cap rechaza, no se escribe ni el ángulo ni el mapa", async () => {
    const { repository, state } = angleRepo({ liveCount: 100, activeIds: ["a"] });
    await expect(
      createContentAngle({ ids: ids(), repository }, angleInput),
    ).rejects.toThrow(DomainError);
    expect(state.weightsWritten).toHaveLength(0);
  });
});

describe("crear un ángulo — campos y enlaces (FR-056)", () => {
  it("los tres campos de texto son obligatorios", async () => {
    const { repository } = angleRepo();
    for (const field of ["title", "description", "targetAudience"] as const) {
      await expect(
        createContentAngle(
          { ids: ids(), repository },
          { ...angleInput, [field]: "   " },
        ),
      ).rejects.toThrow(DomainError);
    }
  });

  it("title 200, description 2000, targetAudience 500 — y uno más falla", async () => {
    const { repository } = angleRepo();
    const cases = [
      ["title", 200],
      ["description", 2000],
      ["targetAudience", 500],
    ] as const;
    for (const [field, max] of cases) {
      await expect(
        createContentAngle(
          { ids: ids(), repository },
          { ...angleInput, [field]: "a".repeat(max) },
        ),
      ).resolves.toBeDefined();
      await expect(
        createContentAngle(
          { ids: ids(), repository },
          { ...angleInput, [field]: "a".repeat(max + 1) },
        ),
      ).rejects.toThrow(DomainError);
    }
  });

  it("10 ángulos por influencer: con 9 se puede enlazar, con 10 no", async () => {
    expect(HARD_CAPS.anglesPerInfluencer).toBe(10);
    const influencers: InfluencerRef[] = [
      { id: "inf_1", isActive: true, isTrained: true },
    ];

    const ok = angleRepo({ influencers, perInfluencer: { inf_1: 9 } });
    await expect(
      createContentAngle(
        { ids: ids(), repository: ok.repository },
        { ...angleInput, influencerIds: ["inf_1"] },
      ),
    ).resolves.toBeDefined();

    const full = angleRepo({ influencers, perInfluencer: { inf_1: 10 } });
    try {
      await createContentAngle(
        { ids: ids(), repository: full.repository },
        { ...angleInput, influencerIds: ["inf_1"] },
      );
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(
        ANGLE_ERROR_CODES.maxPerInfluencer,
      );
    }
  });

  it("un influencer sin entrenar no se puede enlazar", async () => {
    const { repository } = angleRepo({
      influencers: [{ id: "inf_1", isActive: true, isTrained: false }],
    });
    await expect(
      createContentAngle(
        { ids: ids(), repository },
        { ...angleInput, influencerIds: ["inf_1"] },
      ),
    ).rejects.toThrow(DomainError);
  });

  it("un influencer de otro workspace es not_found, no forbidden (§9.2)", async () => {
    const { repository } = angleRepo({ influencers: [] });
    try {
      await createContentAngle(
        { ids: ids(), repository },
        { ...angleInput, influencerIds: ["inf_ajeno"] },
      );
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("not_found");
    }
  });
});

describe("guardarraíl de brandRevision al persistir un ángulo generado (AI-005)", () => {
  it("si la marca cambió entre generar y guardar, se rechaza", async () => {
    const { repository, state } = angleRepo({ brandRevision: 8 });
    await expect(
      createContentAngle(
        { ids: ids(), repository },
        { ...angleInput, expectedBrandRevision: 7 },
      ),
    ).rejects.toThrow(DomainError);
    expect(state.inserted).toHaveLength(0);
  });

  it("si coincide, se guarda", async () => {
    const { repository } = angleRepo({ brandRevision: 7 });
    await expect(
      createContentAngle(
        { ids: ids(), repository },
        { ...angleInput, expectedBrandRevision: 7 },
      ),
    ).resolves.toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AI Studio
// ───────────────────────────────────────────────────────────────────────────

const credits = (remaining: number): CreditsLedger => ({
  remaining,
  resetAt: new Date("2026-10-01T00:00:00Z"),
});

describe("arrancar una generación de AI Studio (NFR-025 + §16.2)", () => {
  it("reserva los créditos exactos del catálogo", () => {
    const out = startAiStudioGeneration({
      operation: "image",
      inFlightCount: 0,
      credits: credits(100),
    });
    expect(out.reservedCredits).toBe(4);
    expect(out.credits.remaining).toBe(96);
  });

  it("un lote multiplica por unidades", () => {
    const out = startAiStudioGeneration({
      operation: "image",
      units: 4,
      inFlightCount: 0,
      credits: credits(100),
    });
    expect(out.reservedCredits).toBe(16);
    expect(out.credits.remaining).toBe(84);
  });

  it("con 10 en vuelo NO se reservan créditos: el cap de concurrencia va primero", () => {
    // Al revés habría que devolver créditos con una escritura compensatoria,
    // que es donde se pierden.
    const before = credits(100);
    expect(() =>
      startAiStudioGeneration({
        operation: "video",
        inFlightCount: 10,
        credits: before,
      }),
    ).toThrow(DomainError);
    expect(before.remaining).toBe(100);
  });

  it("sin saldo se rechaza aunque haya hueco de concurrencia", () => {
    expect(() =>
      startAiStudioGeneration({
        operation: "video",
        inFlightCount: 0,
        credits: credits(10),
      }),
    ).toThrow(DomainError);
  });

  it("una generación fallida devuelve exactamente lo reservado", () => {
    const start = startAiStudioGeneration({
      operation: "influencer",
      inFlightCount: 0,
      credits: credits(300),
    });
    expect(start.credits.remaining).toBe(50);
    const back = releaseAiStudioGeneration(start.credits, "influencer");
    expect(back.remaining).toBe(300);
  });

  it("pedir cero o media generación es un error", () => {
    for (const units of [0, -1, 1.5]) {
      expect(() =>
        startAiStudioGeneration({
          operation: "image",
          units,
          inFlightCount: 0,
          credits: credits(100),
        }),
      ).toThrow(DomainError);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Influencers
// ───────────────────────────────────────────────────────────────────────────

describe("activar un influencer", () => {
  const inf = {
    id: "inf_1",
    companyId: "co_1",
    isActive: false,
    isTrained: true,
  };

  it("con 49 activos se puede activar el 50", () => {
    expect(activateInfluencer(inf, 49).isActive).toBe(true);
  });

  it("con 50 activos no", () => {
    expect(() => activateInfluencer(inf, 50)).toThrow(DomainError);
  });

  it("uno sin entrenar no se activa: ocuparía un slot sin producir nada", () => {
    expect(() => activateInfluencer({ ...inf, isTrained: false }, 0)).toThrow(
      DomainError,
    );
  });

  it("activar uno ya activo es un no-op y no cuenta contra el cap", () => {
    const active = { ...inf, isActive: true };
    expect(activateInfluencer(active, 50)).toBe(active);
  });

  it("desactivar libera slot en el acto", () => {
    const out = deactivateInfluencer({ ...inf, isActive: true });
    expect(out.isActive).toBe(false);
  });
});
