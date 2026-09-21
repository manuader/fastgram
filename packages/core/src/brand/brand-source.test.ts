import { describe, expect, it } from "vitest";
import type { AcquisitionTier } from "@fastgram/ports";
import { DomainError } from "../errors.js";
import { HARD_CAPS } from "../quota/plans.js";
import {
  acquisitionPlan,
  interpretAcquisition,
  type AcquisitionStep,
} from "./acquisition.js";
import {
  STALE_AFTER_DAYS,
  assertCanRemoveSource,
  assertCanReanalyse,
  completeAnalysis,
  createBrandSource,
  failAnalysis,
  isStale,
  markStaleIfNeeded,
  setPrimarySource,
  startAnalysis,
  type BrandSource,
} from "./brand-source.js";

const NOW = new Date("2026-09-21T10:00:00Z");
const DAY = 86_400_000;

const source = (over: Partial<BrandSource> = {}): BrandSource => ({
  id: "bs_1",
  companyId: "co_1",
  sourceType: "instagram",
  handle: "mimarca",
  canonicalUrl: "https://instagram.com/mimarca",
  isPrimary: true,
  status: "pending",
  analysisCount: 0,
  createdAt: NOW,
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────
// D-01 — el orden B → C → A → D
// ───────────────────────────────────────────────────────────────────────────

describe("orden de adquisición B → C → A → D (FR-011.4, D-01)", () => {
  it("sin conexión y con C apagado: B, luego la oferta de A, luego D", () => {
    // C está apagado por defecto hasta OQ-16 y su ausencia NO rompe el alta.
    expect(
      acquisitionPlan({
        renderedFetchEnabled: false,
        hasConnection: false,
        requiresConnection: false,
      }),
    ).toEqual<AcquisitionTier[]>(["B_public_api", "A_oauth", "D_assisted"]);
  });

  it("con C encendido, C va entre B y A — nunca antes que B", () => {
    expect(
      acquisitionPlan({
        renderedFetchEnabled: true,
        hasConnection: false,
        requiresConnection: false,
      }),
    ).toEqual<AcquisitionTier[]>([
      "B_public_api",
      "C_rendered_fetch",
      "A_oauth",
      "D_assisted",
    ]);
  });

  it("el signup NUNCA arranca por OAuth: A jamás es el primer paso sin conexión", () => {
    // Es la decisión D-01 entera. Si A fuese primero, "pegá tu Instagram" se
    // convertiría en "autorizá a esta app", y se cae el segmento que EXT-001
    // existe para capturar.
    for (const renderedFetchEnabled of [true, false]) {
      const plan = acquisitionPlan({
        renderedFetchEnabled,
        hasConnection: false,
        requiresConnection: false,
      });
      expect(plan[0]).not.toBe("A_oauth");
    }
  });

  it("con la credencial YA conectada, A pasa al frente: no le pide nada a nadie", () => {
    const plan = acquisitionPlan({
      renderedFetchEnabled: false,
      hasConnection: true,
      requiresConnection: false,
    });
    expect(plan[0]).toBe("A_oauth");
    expect(plan).toContain("B_public_api");
  });

  it("D_assisted SIEMPRE cierra la lista: es el suelo del que no se cae", () => {
    const cases = [
      { renderedFetchEnabled: true, hasConnection: true, requiresConnection: false },
      { renderedFetchEnabled: false, hasConnection: false, requiresConnection: true },
      { renderedFetchEnabled: true, hasConnection: false, requiresConnection: true },
    ];
    for (const c of cases) {
      expect(acquisitionPlan(c).at(-1)).toBe("D_assisted");
    }
  });

  it("una plataforma que no lee nada en público no gasta B ni C", () => {
    expect(
      acquisitionPlan({
        renderedFetchEnabled: true,
        hasConnection: false,
        requiresConnection: true,
      }),
    ).toEqual<AcquisitionTier[]>(["D_assisted"]);
  });
});

describe("interpretar la escalada (FR-011.4)", () => {
  const step = (tier: AcquisitionTier, outcome: AcquisitionStep["outcome"]) => ({
    tier,
    outcome,
  });

  it("resuelto por B: se ofrece OAuth como MEJORA, después del análisis", () => {
    const v = interpretAcquisition([step("B_public_api", "ok")]);
    expect(v.resolvedTier).toBe("B_public_api");
    expect(v.offerOAuth).toBe(true);
    expect(v.degradedToAssisted).toBe(false);
  });

  it("resuelto por A: no hay nada que ofrecer", () => {
    const v = interpretAcquisition([step("A_oauth", "ok")]);
    expect(v.offerOAuth).toBe(false);
  });

  it("cuenta privada tras B y C: degrada a asistido, no falla", () => {
    const v = interpretAcquisition([
      step("B_public_api", "private"),
      step("C_rendered_fetch", "private"),
    ]);
    expect(v.resolvedTier).toBeNull();
    expect(v.degradedToAssisted).toBe(true);
    expect(v.offerOAuth).toBe(true);
  });

  it("el primer ok corta la escalada", () => {
    const v = interpretAcquisition([
      step("B_public_api", "unavailable"),
      step("C_rendered_fetch", "ok"),
    ]);
    expect(v.resolvedTier).toBe("C_rendered_fetch");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Alta, cap y unicidad
// ───────────────────────────────────────────────────────────────────────────

describe("alta de una Brand Source (DATA-031)", () => {
  const params = {
    id: "bs_1",
    companyId: "co_1",
    sourceType: "instagram" as const,
    handle: "mimarca",
    canonicalUrl: "https://instagram.com/mimarca",
    existingCount: 0,
    takenByAnotherWorkspace: false,
    now: NOW,
  };

  it("la primera fuente es la primaria", () => {
    expect(createBrandSource(params).isPrimary).toBe(true);
    expect(createBrandSource({ ...params, existingCount: 1 }).isPrimary).toBe(false);
  });

  it("nace en pending", () => {
    expect(createBrandSource(params).status).toBe("pending");
  });

  it("la sexta fuente se rechaza con el copy de ERR-B10", () => {
    expect(HARD_CAPS.brandSources).toBe(5);
    expect(() => createBrandSource({ ...params, existingCount: 4 })).not.toThrow();
    try {
      createBrandSource({ ...params, existingCount: 5 });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).message).toBe(
        "You can analyse up to 5 sources per workspace.",
      );
    }
  });

  it("un (sourceType, handle) ya usado en otro workspace se rechaza (ERR-B06)", () => {
    try {
      createBrandSource({ ...params, takenByAnotherWorkspace: true });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe("conflict");
      expect(err.message).toBe("This profile is already connected to another workspace.");
      expect(err.details?.reason).toBe("already_registered");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Análisis
// ───────────────────────────────────────────────────────────────────────────

describe("un fallo de OCR degrada a partial, NO a failed (AI-016)", () => {
  it("con OCR caído pero perfil completo, el estado es partial", () => {
    // Tratarlo como `failed` tiraría la bio, la categoría, los links y las 24
    // captions que SÍ se leyeron.
    const analyzing = startAnalysis(source(), NOW);
    const out = completeAnalysis(
      analyzing,
      { enrichmentFailed: true, allFieldsCovered: true },
      NOW,
    );
    expect(out.status).toBe("partial");
    expect(out.failureReason).toBeUndefined();
    expect(out.lastAnalysedAt).toEqual(NOW);
  });

  it("todo cubierto y sin fallos: ready", () => {
    const analyzing = startAnalysis(source(), NOW);
    expect(completeAnalysis(analyzing, { allFieldsCovered: true }, NOW).status).toBe(
      "ready",
    );
  });

  it("campos sin cubrir: partial, que es lo que dispara las preguntas (ERR-B09)", () => {
    const analyzing = startAnalysis(source(), NOW);
    expect(completeAnalysis(analyzing, { allFieldsCovered: false }, NOW).status).toBe(
      "partial",
    );
  });

  it("completar sin estar analizando es un error de estado", () => {
    expect(() => completeAnalysis(source(), { allFieldsCovered: true }, NOW)).toThrow(
      DomainError,
    );
  });

  it("una cuenta suspendida tras el análisis deja la fuente failed y nada más", () => {
    // FR-011.11: el CompanyProfile sobrevive. Por eso esta función no tiene
    // forma de tocarlo.
    const out = failAnalysis(source({ status: "analyzing" }), "not_found", NOW);
    expect(out.status).toBe("failed");
    expect(out.failureReason).toBe("not_found");
  });

  it("no se puede analizar dos veces a la vez", () => {
    expect(() => startAnalysis(source({ status: "analyzing" }), NOW)).toThrow(
      DomainError,
    );
  });
});

describe("límite de re-análisis por fuente y día (ERR-B11)", () => {
  it("3 análisis en la ventana pasan; el cuarto no", () => {
    expect(HARD_CAPS.reanalysesPerSourcePerDay).toBe(3);
    let s = startAnalysis(source(), NOW);
    expect(s.analysisCount).toBe(1);
    s = startAnalysis({ ...s, status: "ready" }, new Date(NOW.getTime() + 60_000));
    expect(s.analysisCount).toBe(2);
    s = startAnalysis({ ...s, status: "ready" }, new Date(NOW.getTime() + 120_000));
    expect(s.analysisCount).toBe(3);

    expect(() =>
      startAnalysis({ ...s, status: "ready" }, new Date(NOW.getTime() + 180_000)),
    ).toThrow(DomainError);
  });

  it("el mensaje dice cuántas horas faltan", () => {
    const s = source({
      status: "ready",
      analysisCount: 3,
      analysisWindowStartedAt: NOW,
    });
    try {
      assertCanReanalyse(s, new Date(NOW.getTime() + 2 * 3_600_000));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.message).toBe(
        "You've refreshed this source recently. Try again in 22 hours.",
      );
      expect(err.details?.code).toBe("ERR-B11");
    }
  });

  it("la ventana es MÓVIL: 24 h desde el primer análisis, no el día natural", () => {
    // Con día natural, 3 a las 23:59 y 3 más a las 00:01 son seis en dos
    // minutos. Con ventana móvil hay que esperar de verdad.
    const s = source({
      status: "ready",
      analysisCount: 3,
      analysisWindowStartedAt: NOW,
    });
    expect(() =>
      assertCanReanalyse(s, new Date(NOW.getTime() + 23 * 3_600_000)),
    ).toThrow(DomainError);
    expect(() =>
      assertCanReanalyse(s, new Date(NOW.getTime() + 24 * 3_600_000)),
    ).not.toThrow();
  });

  it("vencida la ventana, el contador vuelve a 1", () => {
    const s = startAnalysis(
      source({ status: "ready", analysisCount: 3, analysisWindowStartedAt: NOW }),
      new Date(NOW.getTime() + 25 * 3_600_000),
    );
    expect(s.analysisCount).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Staleness — 90 días
// ───────────────────────────────────────────────────────────────────────────

describe("stale a los 90 días (DATA-031)", () => {
  const analysed = source({
    status: "ready",
    lastAnalysedAt: NOW,
    analysisCount: 1,
    analysisWindowStartedAt: NOW,
  });

  it("89 días no; 90 sí", () => {
    expect(STALE_AFTER_DAYS).toBe(90);
    expect(isStale(analysed, new Date(NOW.getTime() + 89 * DAY))).toBe(false);
    expect(isStale(analysed, new Date(NOW.getTime() + 90 * DAY))).toBe(true);
  });

  it("una partial también envejece", () => {
    expect(
      isStale({ ...analysed, status: "partial" }, new Date(NOW.getTime() + 91 * DAY)),
    ).toBe(true);
  });

  it("una failed no envejece: ya está en un estado terminal", () => {
    expect(
      isStale({ ...analysed, status: "failed" }, new Date(NOW.getTime() + 999 * DAY)),
    ).toBe(false);
  });

  it("el barrido es idempotente", () => {
    const once = markStaleIfNeeded(analysed, new Date(NOW.getTime() + 100 * DAY));
    const twice = markStaleIfNeeded(once, new Date(NOW.getTime() + 200 * DAY));
    expect(once.status).toBe("stale");
    expect(twice).toEqual(once);
  });

  it("una stale se puede volver a analizar", () => {
    const refreshed = startAnalysis(
      { ...analysed, status: "stale" },
      new Date(NOW.getTime() + 100 * DAY),
    );
    expect(refreshed.status).toBe("analyzing");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Primaria
// ───────────────────────────────────────────────────────────────────────────

describe("exactamente una fuente primaria (FR-011.6)", () => {
  const sources = [
    source({ id: "bs_1", isPrimary: true }),
    source({ id: "bs_2", isPrimary: false, sourceType: "tiktok" }),
    source({ id: "bs_3", isPrimary: false, sourceType: "website" }),
  ];

  it("cambiar la primaria desmarca la anterior en la misma operación", () => {
    const out = setPrimarySource(sources, "bs_3");
    expect(out.filter((s) => s.isPrimary).map((s) => s.id)).toEqual(["bs_3"]);
  });

  it("marcar una que no existe es not_found", () => {
    expect(() => setPrimarySource(sources, "bs_9")).toThrow(DomainError);
  });

  it("sólo el owner puede borrar la primaria (FR-011.10)", () => {
    expect(() => assertCanRemoveSource(sources[0]!, "member")).toThrow(DomainError);
    expect(() => assertCanRemoveSource(sources[0]!, "owner")).not.toThrow();
    expect(() => assertCanRemoveSource(sources[1]!, "member")).not.toThrow();
  });
});
