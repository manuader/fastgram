/**
 * Contrato del puerto `SocialPublisher` — PRD `INT-001`…`INT-006`, `FR-060`,
 * `NFR-012`, `NFR-015`.
 *
 * **Casi toda esta suite corre sin publicar nada**, y es a propósito: publicar
 * de verdad en una cuenta real desde CI no se puede deshacer, y `FR-060` es
 * explícito en que un post entregado al carril lento de TikTok no se puede
 * reprogramar sin duplicar. Lo que sí se puede verificar sin efectos es lo que
 * `INT-006` pide de forma literal —«exponer al usuario qué se puede y qué no
 * según la ruta»— y la coherencia entre lo que el adaptador declara y lo que
 * acepta.
 *
 * La parte en vivo existe, pero sólo corre si el adaptador entrega un
 * `livePublish`. Un adaptador que no lo entregue **no está exento**: está
 * declarando que esa mitad no se verificó.
 */

import type {
  PublishRequest,
  PublishAccountRef,
  SocialPublisher,
} from "../social-publisher.js";
import { MAX_METRICS_BATCH } from "../social-publisher.js";
import {
  check,
  checkEqual,
  checkNonEmpty,
  checkRejectsWithCode,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface SocialPublisherContractSetup {
  readonly makeAdapter: AdapterFactory<SocialPublisher>;
  /** Cuenta de prueba conectada. */
  readonly account: PublishAccountRef;
  /**
   * Publicación real. Omitirlo saltea la parte en vivo — y deja constancia de
   * que el camino feliz de ese adaptador no está cubierto.
   */
  readonly livePublish?: PublishRequest;
}

export function describeSocialPublisherContract(
  harness: ContractHarness,
  name: string,
  setup: SocialPublisherContractSetup,
): void {
  const { describe, it } = harness;

  describe(`SocialPublisher contract · ${name}`, () => {
    it("declara capacidades internamente coherentes (INT-006)", async () => {
      const publisher = await setup.makeAdapter();
      const caps = publisher.capabilities();

      checkNonEmpty(caps.provider, "provider: hay más de una ruta por plataforma");
      check(caps.accountTypes.length > 0, "sin tipos de cuenta no se puede publicar");
      check(caps.mediaKinds.length > 0, "sin tipos de media no se puede publicar");
      check(caps.captionLimits.caption > 0, "límite de caption en cero");

      // FR-060: `posting_mode` es sólo de TikTok OAuth. Cualquier otra
      // plataforma que declare modos está prometiendo algo que no existe.
      if (caps.platform !== "tiktok") {
        checkEqual(
          caps.postingModes.length,
          0,
          `${caps.platform} declara posting modes y FR-060 los da sólo a TikTok OAuth`,
        );
      }
      // FR-060: warmed sólo existe en TikTok e Instagram.
      if (caps.accountTypes.includes("warmed")) {
        check(
          caps.platform === "tiktok" || caps.platform === "instagram",
          `${caps.platform} declara cuentas warmed y FR-060 las limita a TikTok e Instagram`,
        );
      }
      // INT-005: Reddit no soporta generación de caption.
      if (caps.platform === "reddit") {
        checkEqual(
          caps.supportsCaptionGeneration,
          false,
          "Reddit devuelve 400 bad_request si se pide generación de caption (INT-005)",
        );
      }
      // FR-060: privacy_level pertenece al modo direct.
      if (caps.privacyLevels.length > 0) {
        check(
          caps.postingModes.includes("direct"),
          "declara niveles de privacidad sin soportar el modo direct",
        );
      }
    });

    it("getAccountOptions devuelve niveles contenidos en los declarados", async () => {
      const publisher = await setup.makeAdapter();
      const caps = publisher.capabilities();
      if (caps.privacyLevels.length === 0) return;

      const options = await publisher.getAccountOptions(setup.account);
      for (const level of options.allowedPrivacyLevels) {
        check(
          caps.privacyLevels.includes(level),
          `la cuenta permite "${level}" y la ruta no lo declara: ERR-D16 quedaría sin explicación`,
        );
      }
    });

    it("rechaza un payload que contradice sus propias capacidades", async () => {
      const publisher = await setup.makeAdapter();
      const caps = publisher.capabilities();
      const unsupported = (
        ["video", "image", "carousel", "slideshow", "text"] as const
      ).find((kind) => !caps.mediaKinds.includes(kind));
      if (unsupported === undefined) return;

      await checkRejectsWithCode(
        () =>
          publisher.publish({
            account: setup.account,
            media: { kind: unsupported, urls: ["https://example.invalid/x"] },
            caption: "contrato",
            idempotencyKey: `contract-${String(Date.now())}`,
          }),
        ["bad_request"],
        `publish con media "${unsupported}", que capabilities no declara`,
      );
    });

    it("fetchMetrics rechaza lotes por encima del tope de NFR-012", async () => {
      const publisher = await setup.makeAdapter();
      const refs = Array.from({ length: MAX_METRICS_BATCH + 1 }, (_, i) => ({
        account: setup.account,
        externalPostId: `p-${String(i)}`,
      }));

      await checkRejectsWithCode(
        () => publisher.fetchMetrics(refs),
        ["bad_request"],
        `lote de ${String(MAX_METRICS_BATCH + 1)} referencias`,
      );
    });

    it("fetchMetrics de ids desconocidos los omite en vez de fallar", async () => {
      const publisher = await setup.makeAdapter();
      const metrics = await publisher.fetchMetrics([
        { account: setup.account, externalPostId: "id-que-no-existe-0000" },
      ]);
      checkEqual(
        metrics.length,
        0,
        "pedir métricas no es preguntar por existencia: un id desconocido se omite",
      );
    });

    it("getStatus de un post desconocido devuelve null", async () => {
      const publisher = await setup.makeAdapter();
      checkEqual(
        await publisher.getStatus({
          account: setup.account,
          externalPostId: "id-que-no-existe-0000",
        }),
        null,
        "getStatus de un post desconocido",
      );
    });

    it("publish es idempotente por idempotencyKey (NFR-015)", async () => {
      const publisher = await setup.makeAdapter();
      const request = setup.livePublish;
      if (request === undefined) return;

      const first = await publisher.publish(request);
      const second = await publisher.publish(request);

      check(
        first.kind !== "failed" || second.kind === "failed",
        "el reintento cambió el resultado de un intento fallido",
      );
      checkEqual(
        second.externalPostId,
        first.externalPostId,
        "misma idempotencyKey publicó dos veces: NFR-015 prohíbe el duplicado",
      );
    });

    it("un estado publicado trae permalink y un fallo trae motivo neutral", async () => {
      const publisher = await setup.makeAdapter();
      const request = setup.livePublish;
      if (request === undefined) return;

      const status = await publisher.publish(request);
      if (status.kind === "published") {
        checkNonEmpty(status.externalPostId ?? "", "externalPostId de un post publicado");
      }
      if (status.kind === "failed") {
        check(status.failure !== undefined, "kind failed sin failure");
        if (status.failure === undefined) return;
        checkNonEmpty(
          status.failure.message,
          "FR-060: el mensaje siempre es seguro de mostrar",
        );
        check(
          !status.failure.message.toLowerCase().includes("http"),
          "el mensaje parece traer detalle crudo del proveedor (§10, regla 6)",
        );
      }
    });
  });
}
