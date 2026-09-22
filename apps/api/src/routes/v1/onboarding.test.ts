/**
 * Las piezas puras de `onboarding.ts` — `FR-010`.
 *
 * Acá sólo va lo que se puede fijar sin base: la traducción de nombres entre el
 * contrato y `core`, la derivación del paso, y la traducción del error. El
 * comportamiento de las tres rutas —incluido el scope, que es lo que no se
 * puede probar sin Postgres— está en `test/onboarding.int.test.ts`.
 *
 * ## Por qué la derivación del paso merece tests propios
 *
 * Porque es la decisión de diseño más cara del archivo: sin repositorio de
 * `onboarding_records`, el paso **no está guardado** y se deduce caminando
 * `advanceOnboarding`. Si esa deducción se equivoca, el wizard manda al usuario
 * a un paso que ya respondió (o lo deja pasar de uno que no). Estos casos fijan
 * los cinco desenlaces posibles contra la máquina de `core`, no contra una
 * reimplementación.
 */
import { describe, expect, it } from "vitest";
import type { OnboardingProfiling } from "@fastgram/contracts";
import { DomainError, type OnboardingRecord } from "@fastgram/core";

import { isApiRejection } from "../../http/errors.js";
import {
  asApiRejection,
  detailsOf,
  profilingOf,
  toDomainAnswers,
  walkToFurthestStep,
} from "./onboarding.js";

const NOW = new Date("2026-09-22T12:00:00.000Z");

const company = (over: Partial<Record<string, unknown>> = {}): never =>
  ({
    id: "c1",
    name: "Acme",
    websiteUrl: null,
    primaryBrandSourceId: null,
    logoUrl: null,
    ownerUserId: "u1",
    status: "draft",
    planId: "growth",
    subscriptionStatus: "trialing",
    billingAnchorDay: 1,
    timezone: "UTC",
    entitlements: [],
    apiOverageEnabled: false,
    partnerId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
    // El tipo real es `CompanyRow`; construirlo entero en cada caso enterraría
    // lo que el caso prueba bajo dieciséis campos que no mira nadie.
  }) as never;

const profile = (over: Partial<Record<string, unknown>> = {}): never =>
  ({
    id: "p1",
    companyId: "c1",
    coreIdentity: null,
    productOffering: null,
    uniqueBenefits: null,
    problemSolution: null,
    marketAndCompetition: null,
    toneOfVoice: null,
    targetAudience: null,
    businessModel: null,
    businessCategories: [],
    monthlyRevenueBand: null,
    teamSize: null,
    ownerRole: null,
    expectations: [],
    brandRevision: 0,
    status: "pending",
    fieldMeta: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as never;

/**
 * Sin `as const`, y a propósito: con él las listas quedan `readonly` y
 * `OnboardingProfiling` las declara mutables (`z.array` produce `string[]`),
 * así que `toDomainAnswers` no las acepta. Es el tipo del contrato el que manda.
 */
const FULL_ANSWERS: OnboardingProfiling = {
  ownerRole: "founder",
  teamSize: "1-5",
  businessModel: "b2c",
  businessCategories: ["retail"],
  monthlyRevenueBand: "0-10k",
  expectations: ["more reach"],
};

/** El registro base que arma la ruta, con lo que cada caso quiera encima. */
const record = (over: Partial<OnboardingRecord> = {}): OnboardingRecord => ({
  id: "c1",
  ownerUserId: "u1",
  draftCompanyId: "c1",
  step: "brand_source",
  sources: [],
  manualBranch: false,
  oauthConsents: 0,
  createdAt: NOW,
  ...over,
});

const SOURCE = {
  sourceType: "instagram",
  handle: "acme",
  canonicalUrl: "https://instagram.com/acme",
} as const;

describe("traducción de nombres entre el contrato y core", () => {
  it("`ownerRole` y `monthlyRevenueBand` viajan como `role` y `monthlyRevenue`", () => {
    // Son los dos únicos campos con dos nombres, y son justo los que
    // `REQUIRED_PROFILING_ANSWERS` exige: si la traducción se rompe, el
    // cuestionario completo se rechaza con "Please select your role".
    expect(toDomainAnswers(FULL_ANSWERS)).toEqual({
      role: "founder",
      teamSize: "1-5",
      businessModel: "b2c",
      businessCategories: ["retail"],
      monthlyRevenue: "0-10k",
      expectations: ["more reach"],
    });
  });

  it("manda `expectations` aunque el dominio no la exija: es lo que la acota", () => {
    // `REQUIRED_PROFILING_ANSWERS` tiene cinco claves y `expectations` no está.
    // Pero el bucle de 4 000 caracteres de `assertValidProfiling` recorre todo
    // lo que reciba, así que pasarla es lo que cierra la mitad de P1-ONB-004
    // que se puede cerrar sin inventar copy.
    expect(Object.keys(toDomainAnswers(FULL_ANSWERS))).toContain("expectations");
  });
});

describe("derivación de los detalles del paso 2", () => {
  it("sin fila de perfil, el paso está sin responder", () => {
    expect(detailsOf(company(), null)).toBeUndefined();
  });

  it("con fila pero sin `coreIdentity`, tampoco", () => {
    // La fila de perfil la crea el cuestionario o el análisis de marca; que
    // exista no dice nada sobre el paso 2.
    expect(detailsOf(company(), profile())).toBeUndefined();
  });

  it("`coreIdentity` es la descripción, y el nombre y el logo salen de la company", () => {
    expect(
      detailsOf(
        company({ name: "Acme", logoUrl: "https://cdn.test/logo.png" }),
        profile({ coreIdentity: "vendemos zapatillas" }),
      ),
    ).toEqual({
      name: "Acme",
      description: "vendemos zapatillas",
      logoUrl: "https://cdn.test/logo.png",
    });
  });

  it("sin logo, la clave no viaja (es opcional en el dominio, no `null`)", () => {
    const details = detailsOf(company(), profile({ coreIdentity: "x" }));
    expect(details).not.toHaveProperty("logoUrl");
  });
});

describe("derivación de las respuestas del paso 3", () => {
  it("sin fila de perfil, el paso está sin responder", () => {
    expect(profilingOf(null)).toBeUndefined();
  });

  it("con fila y columnas vacías devuelve el mapa vacío, no `undefined`", () => {
    // Es la diferencia entre *"Please select your role"* (preciso, del paso 3)
    // y *"Add your company details before finishing setup."* (genérico, el que
    // sale cuando el paso entero falta).
    expect(profilingOf(profile())).toEqual({
      role: "",
      teamSize: "",
      businessModel: "",
      businessCategories: [],
      monthlyRevenue: "",
      expectations: [],
    });
  });
});

describe("hasta dónde llega el wizard con lo que hay guardado", () => {
  it("sin fuentes y sin rama manual se queda en el paso 1", () => {
    expect(walkToFurthestStep(record()).step).toBe("brand_source");
  });

  it("con una fuente pero sin detalles, pasa al paso 2 y se queda", () => {
    expect(walkToFurthestStep(record({ sources: [SOURCE] })).step).toBe(
      "company_details",
    );
  });

  it("un nombre de una sola letra no deja pasar el paso 2", () => {
    // `MIN_COMPANY_NAME_CHARS` es 2 y la columna `companies.name` no tiene
    // CHECK de longitud: sin este gate, un workspace con nombre "A" avanzaría.
    const stuck = walkToFurthestStep(
      record({ sources: [SOURCE], details: { name: "A", description: "x" } }),
    );
    expect(stuck.step).toBe("company_details");
  });

  it("con detalles válidos pero sin cuestionario, se queda en el paso 3", () => {
    expect(
      walkToFurthestStep(
        record({ sources: [SOURCE], details: { name: "Acme", description: "x" } }),
      ).step,
    ).toBe("profiling");
  });

  it("con todo respondido llega a `processing` y NO sigue hasta `ready`", () => {
    // `advanceOnboarding("processing")` devuelve `ready` sin comprobar nada:
    // si el camino no parara acá, tener el formulario lleno equivaldría a haber
    // cerrado el alta, y `POST /onboarding/complete` no serviría para nada.
    expect(
      walkToFurthestStep(
        record({
          sources: [SOURCE],
          details: { name: "Acme", description: "x" },
          profiling: toDomainAnswers(FULL_ANSWERS),
        }),
      ).step,
    ).toBe("processing");
  });
});

describe("traducción del error del dominio al contrato", () => {
  it("`out_of_range` sale como `bad_request` sin tocar el mensaje", () => {
    // El código no está en `errorCodeSchema` (§9.3) y el mensaje es copy
    // CONFIRMED del PRD: lo primero se traduce, lo segundo no se toca.
    const rejection = asApiRejection(
      new DomainError("out_of_range", "Please select your role", { field: "role" }),
    );
    expect(isApiRejection(rejection)).toBe(true);
    if (!isApiRejection(rejection)) return;
    expect(rejection.status).toBe(400);
    expect(rejection.code).toBe("bad_request");
    expect(rejection.message).toBe("Please select your role");
  });

  it("el `field` sale con el nombre que el cliente mandó, no con el de core", () => {
    // `role` es la clave de `core`; el cuerpo tiene `ownerRole`. Publicar
    // `role` haría que la UI resaltara un input que no existe.
    const rejection = asApiRejection(
      new DomainError("out_of_range", "Please select your role", { field: "role" }),
    );
    expect(isApiRejection(rejection) && rejection.publicDetails).toEqual({
      field: "ownerRole",
    });
  });

  it("`monthlyRevenue` también se traduce de vuelta", () => {
    const rejection = asApiRejection(
      new DomainError("out_of_range", "Please select your monthly revenue", {
        field: "monthlyRevenue",
      }),
    );
    expect(isApiRejection(rejection) && rejection.publicDetails).toEqual({
      field: "monthlyRevenueBand",
    });
  });

  it("los `details` que no son `field` ni `code` se quedan en el log", () => {
    // `http/errors.ts` publica `publicDetails` entero, así que lo que se meta
    // acá sale. `length` y `step` son diagnóstico.
    const rejection = asApiRejection(
      new DomainError("out_of_range", "Each answer is limited to 4,000 characters.", {
        field: "expectations",
        length: 5000,
      }),
    );
    expect(isApiRejection(rejection) && rejection.publicDetails).toEqual({
      field: "expectations",
    });
  });

  it("`invalid_state` pasa de largo: ya tiene traducción en http/errors.ts", () => {
    // Es el 409 de "This onboarding is already finished." Traducirlo acá lo
    // convertiría en un 400.
    const original = new DomainError(
      "invalid_state",
      "This onboarding is already finished.",
    );
    expect(asApiRejection(original)).toBe(original);
  });

  it("lo que no es un DomainError vuelve tal cual", () => {
    const boom = new Error("boom");
    expect(asApiRejection(boom)).toBe(boom);
  });
});
