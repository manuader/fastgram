/**
 * Contrato del puerto `SocialReader` — PRD `INT-014`, `FR-011`, §19.5.1.
 *
 * Lo que fija esta suite es el principio rector de §19.5.1: **ninguno de estos
 * estados bloquea el alta**. Un adaptador que lance donde el contrato promete
 * un resultado rompe la escalera `B → C → A → D` de `FR-011.4` — y con ella se
 * rompe `D-01` entero, que es lo que permite que alguien sin web y sin ganas
 * de autorizar nada llegue a Blitz.
 *
 * También se verifica que las capacidades declaradas y el comportamiento real
 * coincidan. `OQ-19` advierte que la cobertura sin OAuth va a ser desigual
 * entre las cinco plataformas; un extractor que declare señales que después no
 * trae haría que el orquestador pida OAuth cuando no hacía falta, o que no lo
 * pida cuando sí.
 */

import type { SocialReadOutcome, SocialReader } from "../social-reader.js";
import { DEFAULT_CONTENT_ITEMS } from "../social-reader.js";
import {
  check,
  checkEqual,
  checkNonEmpty,
  checkResolves,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface SocialReaderContractSetup {
  readonly makeAdapter: AdapterFactory<SocialReader>;
  /** Handle público que existe y tiene contenido. */
  readonly existingHandle: string;
  /** Handle que con seguridad no existe. `ERR-B04`. */
  readonly missingHandle: string;
  /** Cuenta privada, si la plataforma permite tener una de prueba. `ERR-B05`. */
  readonly privateHandle?: string;
  /** Entrada en texto libre que debe resolver a `existingHandle` (`FR-011.1`). */
  readonly resolvableInput: string;
}

function assertOutcomeShape<T>(outcome: SocialReadOutcome<T>, where: string): void {
  if (outcome.status === "ok") {
    check(outcome.tier.length > 0, `${where}: tier vacío en un resultado ok`);
    return;
  }
  check(
    outcome.attemptedTiers.length > 0,
    `${where}: attemptedTiers vacío — sin eso el orquestador no sabe qué escalón probar`,
  );
}

export function describeSocialReaderContract(
  harness: ContractHarness,
  name: string,
  setup: SocialReaderContractSetup,
): void {
  const { describe, it } = harness;

  describe(`SocialReader contract · ${name}`, () => {
    it("declara capacidades coherentes con la fuente que dice implementar", async () => {
      const reader = await setup.makeAdapter();
      const caps = reader.capabilities();

      checkEqual(caps.source, reader.source, "capabilities.source vs reader.source");
      check(caps.tiers.length > 0, "un extractor sin ningún tier no puede leer nada");
      check(
        caps.profileSignals.length > 0,
        "sin señales de perfil no hay nada que sintetizar (AI-016)",
      );
      check(
        caps.maxContentItems > 0 && caps.maxContentItems <= DEFAULT_CONTENT_ITEMS * 10,
        `maxContentItems implausible: ${String(caps.maxContentItems)}`,
      );
      // La implicación va en este sentido y no en el otro, y el otro estaba
      // mal: `tiers` es «lo que el adaptador **sabe** hacer» y
      // `renderedFetchEnabled` es «bandera de **configuración**», según el
      // propio puerto. Con `!C || enabled` —que era lo que decía— y `enabled`
      // obligado a `false` mientras `OQ-16` siga abierto, ningún adaptador
      // podía declarar el tier C jamás, y la bandera quedaba como duplicado
      // de la lista. "Sé hacerlo, está apagado" es el estado normal.
      check(
        !caps.renderedFetchEnabled || caps.tiers.includes("C_page_fetch"),
        "prende el tier C sin declararlo entre los que sabe usar",
      );
      check(
        !caps.renderedFetchEnabled,
        "el tier C tiene que ir apagado mientras OQ-16 (revisión legal del scraping) siga abierto",
      );
      check(
        !caps.tiers.includes("D_assisted"),
        "el tier D es asistido por el usuario y no pasa por este puerto (FR-011.4)",
      );
    });

    it("resolve devuelve la forma canónica sin crear nada (§9.14)", async () => {
      const reader = await setup.makeAdapter();
      const outcome = await reader.resolve({ input: setup.resolvableInput });
      assertOutcomeShape(outcome, "resolve");

      check(
        outcome.status === "ok",
        `resolve de una entrada válida dio ${outcome.status}`,
      );
      if (outcome.status !== "ok") return;
      checkEqual(outcome.data.sourceType, reader.source, "sourceType resuelto");
      checkNonEmpty(outcome.data.canonicalUrl, "canonicalUrl");
      checkNonEmpty(outcome.data.handle, "handle");
      checkEqual(outcome.data.available, true, "available de un perfil que existe");
    });

    it("un handle inexistente es un resultado not_found, no una excepción", async () => {
      const reader = await setup.makeAdapter();
      const outcome = await checkResolves(
        () => reader.readProfile({ handle: setup.missingHandle }),
        "readProfile de un handle inexistente (§19.5.1: nada bloquea el alta)",
      );
      assertOutcomeShape(outcome, "readProfile");
      checkEqual(outcome.status, "not_found", "estado de un handle inexistente");
    });

    it("una cuenta privada es un resultado private, no una excepción (ERR-B05)", async () => {
      const reader = await setup.makeAdapter();
      const handle = setup.privateHandle;
      if (handle === undefined) return;

      const outcome = await checkResolves(
        () => reader.readProfile({ handle }),
        "readProfile de una cuenta privada",
      );
      checkEqual(outcome.status, "private", "estado de una cuenta privada");
    });

    it("readProfile sólo devuelve señales que capabilities declaró", async () => {
      const reader = await setup.makeAdapter();
      const declared = new Set<string>(reader.capabilities().profileSignals);
      const outcome = await reader.readProfile({ handle: setup.existingHandle });
      assertOutcomeShape(outcome, "readProfile");
      if (outcome.status !== "ok") return;

      for (const key of Object.keys(outcome.data)) {
        check(
          declared.has(key),
          `devolvió "${key}" sin declararlo en capabilities.profileSignals`,
        );
      }
    });

    it("readRecentContent respeta el límite y ordena del más nuevo al más viejo", async () => {
      const reader = await setup.makeAdapter();
      const limit = 5;
      const outcome = await reader.readRecentContent({
        handle: setup.existingHandle,
        limit,
      });
      assertOutcomeShape(outcome, "readRecentContent");
      if (outcome.status !== "ok") return;

      check(
        outcome.data.length <= limit,
        `devolvió ${String(outcome.data.length)} ítems con limit ${String(limit)}`,
      );

      let previous = Number.POSITIVE_INFINITY;
      for (const item of outcome.data) {
        checkNonEmpty(item.externalId, "externalId del ítem");
        check(
          Array.isArray(item.hashtags),
          "hashtags tiene que existir, aunque sea vacío",
        );
        if (item.postedAt === undefined) continue;
        const current = item.postedAt.getTime();
        check(
          current <= previous,
          "el orden no es del más reciente al más viejo: AI-016 pondera y FR-011.3 habla de los últimos N",
        );
        previous = current;
      }
    });

    it("no expone credenciales en lo que devuelve (NFR-007)", async () => {
      const reader = await setup.makeAdapter();
      const outcome = await reader.readProfile({
        handle: setup.existingHandle,
        accessToken: "token-de-prueba-no-debe-volver",
      });
      if (outcome.status !== "ok") return;
      const serialized = JSON.stringify(outcome.data);
      check(
        !serialized.includes("token-de-prueba-no-debe-volver"),
        "el token de entrada volvió en la respuesta",
      );
    });
  });
}
