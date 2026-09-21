import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { PLANS } from "../quota/plans.js";
import { detectBrandSource } from "../brand/source-input.js";
import {
  MAX_ANSWER_CHARS,
  ONBOARDING_MESSAGES,
  advanceOnboarding,
  assertBrandSourceStepComplete,
  assertCanCreateWorkspace,
  assertNoOAuthRequired,
  assertValidCompanyDetails,
  assertValidProfiling,
  manualSourceDraft,
  planOnboardingCompletion,
  resumeOnboarding,
  type OnboardingRecord,
} from "./onboarding.js";

const NOW = new Date("2026-09-21T10:00:00Z");

const record = (over: Partial<OnboardingRecord> = {}): OnboardingRecord => ({
  id: "onb_1",
  ownerUserId: "usr_1",
  draftCompanyId: "co_draft",
  step: "brand_source",
  sources: [],
  manualBranch: false,
  oauthConsents: 0,
  createdAt: NOW,
  ...over,
});

const details = {
  name: "Mimarca",
  description: "Ceramic mugs made in small batches.",
};

const profiling = {
  role: "founder",
  teamSize: "1-5",
  businessModel: "dtc",
  businessCategories: ["retail"],
  monthlyRevenue: "0-10k",
};

const instagramSource = () => {
  const d = detectBrandSource("instagram.com/mimarca");
  if (d.kind !== "resolved") throw new Error("esperaba resolved");
  return { sourceType: d.sourceType, handle: d.handle, canonicalUrl: d.canonicalUrl };
};

// ───────────────────────────────────────────────────────────────────────────
// FLOW-009 / criterio 6 y 11 — el alta sin web y sin OAuth
// ───────────────────────────────────────────────────────────────────────────

describe("alta SÓLO con un perfil social (FR-010 criterio 6, FLOW-009)", () => {
  it("se completa el wizard entero sin escribir ninguna URL de web", () => {
    let r = record({ sources: [instagramSource()] });
    r = advanceOnboarding(r);
    expect(r.step).toBe("company_details");

    r = advanceOnboarding({ ...r, details });
    expect(r.step).toBe("profiling");

    r = advanceOnboarding({ ...r, profiling });
    expect(r.step).toBe("processing");

    r = advanceOnboarding(r);
    expect(r.step).toBe("ready");

    expect(r.sources.every((s) => s.sourceType !== "website")).toBe(true);
  });

  it("D-01: no hace falta autorizar OAuth en NINGÚN momento (criterio 11)", () => {
    const r = record({ sources: [instagramSource()], step: "ready" });
    expect(r.oauthConsents).toBe(0);
    expect(() => assertNoOAuthRequired(r)).not.toThrow();
  });

  it("si alguien mete un consentimiento OAuth obligatorio, la aserción lo caza", () => {
    // El camino se rompe por añadido: alguien pone un `Connect your account`
    // como paso obligatorio y todo sigue verde salvo esto.
    const r = record({ sources: [instagramSource()], oauthConsents: 1 });
    expect(() => assertNoOAuthRequired(r)).toThrow(DomainError);
  });
});

describe("el resto del wizard es IDÉNTICO sea cual sea el origen (criterio 7)", () => {
  it("web y social recorren exactamente la misma secuencia de pasos", () => {
    const run = (sources: OnboardingRecord["sources"]) => {
      let r = record({ sources });
      const steps = [r.step];
      r = advanceOnboarding(r);
      steps.push(r.step);
      r = advanceOnboarding({ ...r, details });
      steps.push(r.step);
      r = advanceOnboarding({ ...r, profiling });
      steps.push(r.step);
      r = advanceOnboarding(r);
      steps.push(r.step);
      return steps;
    };

    const web = run([
      {
        sourceType: "website",
        handle: "miproducto.com",
        canonicalUrl: "https://miproducto.com",
      },
    ]);
    const social = run([instagramSource()]);
    expect(web).toEqual(social);
  });

  it("advanceOnboarding no recibe el sourceType: la bifurcación no existe", () => {
    // Es el criterio 7 hecho firma. Si el avance dependiera del origen,
    // habría dos caminos y a la tercera corrección dejarían de coincidir.
    expect(advanceOnboarding.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Paso 1
// ───────────────────────────────────────────────────────────────────────────

describe("paso de Brand source (FR-010, ERR-B01)", () => {
  it("sin fuente y sin rama manual, el copy literal", () => {
    try {
      assertBrandSourceStepComplete(record());
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.message).toBe("Add a website or a social profile to continue");
      expect(err.details?.code).toBe("ERR-B01");
    }
  });

  it("la rama manual basta y produce una fuente de tipo manual", () => {
    const r = record({ manualBranch: true, sources: [manualSourceDraft()] });
    expect(() => assertBrandSourceStepComplete(r)).not.toThrow();
    expect(r.sources[0]?.sourceType).toBe("manual");
  });

  it("Use description instead sin fuente registrada también deja avanzar", () => {
    expect(() =>
      assertBrandSourceStepComplete(record({ manualBranch: true })),
    ).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Paso 2 y 3 — copy literal de FR-010
// ───────────────────────────────────────────────────────────────────────────

describe("Company details (FR-010, copy literal)", () => {
  it("nombre vacío → Company name is required", () => {
    try {
      assertValidCompanyDetails({ ...details, name: "  " });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).message).toBe(ONBOARDING_MESSAGES.companyNameRequired);
    }
  });

  it("un carácter → must be at least 2 characters; dos → pasa", () => {
    try {
      assertValidCompanyDetails({ ...details, name: "M" });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).message).toBe(ONBOARDING_MESSAGES.companyNameTooShort);
    }
    expect(() => assertValidCompanyDetails({ ...details, name: "Mi" })).not.toThrow();
  });

  it("4 000 caracteres pasan; 4 001 no", () => {
    expect(MAX_ANSWER_CHARS).toBe(4000);
    expect(() =>
      assertValidCompanyDetails({ ...details, description: "a".repeat(4000) }),
    ).not.toThrow();
    try {
      assertValidCompanyDetails({ ...details, description: "a".repeat(4001) });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).message).toBe(
        "Each answer is limited to 4,000 characters.",
      );
    }
  });
});

describe("cuestionario (FR-010)", () => {
  it("cada campo obligatorio tiene su mensaje exacto", () => {
    const expected: Record<string, string> = {
      role: "Please select your role",
      teamSize: "Please select your team size",
      businessModel: "Please select your business model",
      businessCategories: "Please select at least one business category",
      monthlyRevenue: "Please select your monthly revenue",
    };
    for (const [key, message] of Object.entries(expected)) {
      const answers = { ...profiling, [key]: key === "businessCategories" ? [] : "" };
      try {
        assertValidProfiling(answers);
        expect.unreachable(`${key} tenía que lanzar`);
      } catch (e) {
        expect((e as DomainError).message, key).toBe(message);
      }
    }
  });

  it("un cuestionario completo pasa", () => {
    expect(() => assertValidProfiling(profiling)).not.toThrow();
  });

  it("el tope de 4 000 caracteres también aplica a las respuestas libres", () => {
    expect(() =>
      assertValidProfiling({ ...profiling, roleOther: "a".repeat(4001) }),
    ).toThrow(DomainError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Reanudación y cierre
// ───────────────────────────────────────────────────────────────────────────

describe("reanudar tras recargar (FR-010, criterio 3)", () => {
  it("vuelve al paso guardado, no al primero", () => {
    expect(resumeOnboarding(record({ step: "profiling" }))).toBe("profiling");
  });

  it("avanzar sin los datos del paso actual no cuela", () => {
    expect(() => advanceOnboarding(record({ step: "company_details" }))).toThrow(
      DomainError,
    );
    expect(() => advanceOnboarding(record({ step: "profiling" }))).toThrow(DomainError);
  });

  it("un alta terminada no se puede volver a avanzar", () => {
    expect(() => advanceOnboarding(record({ step: "ready" }))).toThrow(DomainError);
  });
});

describe("cierre del alta (FR-010, System behavior)", () => {
  it("crea el workspace, siembra ángulos, arranca la cola y marca completo", () => {
    const plan = planOnboardingCompletion(record({ step: "processing" }), 0);
    expect(plan).toEqual({
      createWorkspace: true,
      seedContentAngles: true,
      startDiscoveryRefill: true,
      markComplete: true,
    });
  });

  it("con ángulos ya existentes NO se siembra: FR-011.7 #7 evita duplicar", () => {
    const plan = planOnboardingCompletion(record({ step: "processing" }), 7);
    expect(plan.seedContentAngles).toBe(false);
  });

  it("no se puede cerrar un alta que va por la mitad", () => {
    expect(() => planOnboardingCompletion(record({ step: "profiling" }), 0)).toThrow(
      DomainError,
    );
  });
});

describe("cuota de workspaces por plan (§16.1)", () => {
  it("cada plan respeta su número", () => {
    expect(PLANS.free.workspaces).toBe(1);
    expect(PLANS.growth.workspaces).toBe(3);
    expect(PLANS.pro.workspaces).toBe(10);

    expect(() => assertCanCreateWorkspace("free", 0)).not.toThrow();
    expect(() => assertCanCreateWorkspace("free", 1)).toThrow(DomainError);
    expect(() => assertCanCreateWorkspace("growth", 2)).not.toThrow();
    expect(() => assertCanCreateWorkspace("growth", 3)).toThrow(DomainError);
    expect(() => assertCanCreateWorkspace("pro", 9)).not.toThrow();
    expect(() => assertCanCreateWorkspace("pro", 10)).toThrow(DomainError);
  });

  it("el copy es el literal observado, aunque diga 'try again later'", () => {
    try {
      assertCanCreateWorkspace("free", 1);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).message).toBe(
        "You've reached your workspace creation limit. Please try again later.",
      );
    }
  });
});
