import { describe, expect, it } from "vitest";
import {
  describeSocialPublisherContract,
  MAX_METRICS_BATCH,
  type PublishAccountRef,
  type PublishRequest,
  type SocialPublishCapabilities,
} from "@fastgram/ports";
import { MemorySocialPublisher } from "./memory-social-publisher.js";

/**
 * Primera ejecución de las ocho aserciones de contrato de `SocialPublisher`.
 *
 * **Corre dos veces, con dos formas de capacidades distintas**, porque la
 * mitad de la suite son ramas condicionales por plataforma: los modos de
 * publicación que `FR-060` le da sólo a TikTok, las cuentas warmed de TikTok e
 * Instagram, y la generación de caption que `INT-005` le niega a Reddit. Con
 * un solo adaptador montado, esas ramas se saltean sin decirlo y la suite
 * parece verde por cobertura que no existe.
 *
 * **Los números de estas capacidades son sintéticos.** Los límites reales de
 * caption de cada plataforma son del adaptador de proveedor, que no es esta
 * tarea; acá sólo tienen que ser coherentes consigo mismos.
 */
const ACCOUNT: PublishAccountRef = { accountType: "oauth", accountId: "conn_1" };

const TIKTOK_CAPS: SocialPublishCapabilities = {
  platform: "tiktok",
  provider: "memory",
  accountTypes: ["oauth", "warmed"],
  mediaKinds: ["video", "slideshow"],
  captionLimits: { caption: 120, description: 1000 },
  postingModes: ["inbox", "direct"],
  privacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: true,
  supportsAutoAddMusic: true,
  supportsCaptionGeneration: true,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
};

const REDDIT_CAPS: SocialPublishCapabilities = {
  platform: "reddit",
  provider: "memory",
  accountTypes: ["oauth"],
  mediaKinds: ["text", "image"],
  captionLimits: { caption: 300 },
  postingModes: [],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  // `INT-005`: Reddit devuelve 400 si se pide generación de caption.
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
};

const LIVE_PUBLISH: PublishRequest = {
  account: ACCOUNT,
  media: { kind: "video", urls: ["memory://media/clip.mp4"], durationSeconds: 12 },
  caption: "un hook corto",
  idempotencyKey: "live-1",
};

describeSocialPublisherContract({ describe, it }, "memory · tiktok", {
  makeAdapter: () => new MemorySocialPublisher({ capabilities: TIKTOK_CAPS }),
  account: ACCOUNT,
  livePublish: LIVE_PUBLISH,
});

describeSocialPublisherContract({ describe, it }, "memory · reddit", {
  makeAdapter: () => new MemorySocialPublisher({ capabilities: REDDIT_CAPS }),
  account: ACCOUNT,
  livePublish: {
    ...LIVE_PUBLISH,
    media: { kind: "text", urls: [] },
  },
});

describe("MemorySocialPublisher — comportamiento propio del adaptador", () => {
  it("un caption más largo que el límite declarado es bad_request", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });

    await expect(
      publisher.publish({ ...LIVE_PUBLISH, caption: "x".repeat(121) }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("el modo direct sin privacyLevel es bad_request (FR-060)", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });

    // Sin nivel explícito el post saldría con la visibilidad que decida la
    // plataforma, que es exactamente lo que `FR-060` no permite.
    await expect(
      publisher.publish({ ...LIVE_PUBLISH, postingMode: "direct" }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("aiGenerated en una ruta que no etiqueta es bad_request (INT-002)", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });

    await expect(
      publisher.publish({ ...LIVE_PUBLISH, aiGenerated: true }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("un postingMode en una ruta sin modos es bad_request", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: REDDIT_CAPS });

    await expect(
      publisher.publish({
        account: ACCOUNT,
        media: { kind: "text", urls: [] },
        caption: "hola",
        postingMode: "inbox",
        idempotencyKey: "reddit-1",
      }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("el modo inbox no es un fallo: queda esperando al usuario", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });

    const status = await publisher.publish({ ...LIVE_PUBLISH, postingMode: "inbox" });

    expect(status.kind).toBe("in_user_inbox");
    expect(status.permalink).toBeUndefined();
  });

  it("el reintento devuelve el mismo post, no uno nuevo (NFR-015)", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });

    const first = await publisher.publish(LIVE_PUBLISH);
    const second = await publisher.publish({ ...LIVE_PUBLISH, caption: "otro texto" });

    // Mismo `idempotencyKey` ⇒ mismo resultado, aunque el cuerpo cambie. Es
    // deliberado: el duplicado del carril lento no se puede deshacer, así que
    // ante la duda se devuelve lo ya entregado.
    expect(second.externalPostId).toBe(first.externalPostId);
    expect(second.publishedCaption).toBe("un hook corto");
  });

  it("outcomes permite ejercitar el fallo sin inventar un error de plataforma", async () => {
    const publisher = new MemorySocialPublisher({
      capabilities: TIKTOK_CAPS,
      outcomes: [
        {
          kind: "failed",
          failure: {
            reason: "post_limit_exceeded",
            message: "Ya publicaste demasiado hoy",
          },
        },
      ],
    });

    const status = await publisher.publish(LIVE_PUBLISH);

    expect(status.kind).toBe("failed");
    expect(status.failure?.reason).toBe("post_limit_exceeded");
  });

  it("fetchMetrics deduplica antes de pedir (NFR-012)", async () => {
    const publisher = new MemorySocialPublisher({
      capabilities: TIKTOK_CAPS,
      metrics: { mem_1: { views: 10, likes: 2 } },
    });
    await publisher.publish(LIVE_PUBLISH);

    const metrics = await publisher.fetchMetrics([
      { account: ACCOUNT, externalPostId: "mem_1" },
      { account: ACCOUNT, externalPostId: "mem_1" },
      { account: ACCOUNT, externalPostId: "no-existe" },
    ]);

    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.views).toBe(10);
  });

  it(`un lote de exactamente ${String(MAX_METRICS_BATCH)} referencias pasa`, async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });
    const refs = Array.from({ length: MAX_METRICS_BATCH }, (_, i) => ({
      account: ACCOUNT,
      externalPostId: `p-${String(i)}`,
    }));

    // El tope es inclusivo. Off-by-one acá significa rechazar lotes válidos.
    await expect(publisher.fetchMetrics(refs)).resolves.toHaveLength(0);
  });

  it("cancelar un post ya publicado no es error: devuelve que no se pudo", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });
    const status = await publisher.publish(LIVE_PUBLISH);

    const outcome = await publisher.cancel({
      account: ACCOUNT,
      externalPostId: status.externalPostId ?? "",
    });

    expect(outcome).toEqual({ cancelled: false, pending: false });
  });

  it("cancelar una referencia desconocida es not_found", async () => {
    const publisher = new MemorySocialPublisher({ capabilities: TIKTOK_CAPS });

    await expect(
      publisher.cancel({ account: ACCOUNT, externalPostId: "fantasma" }),
    ).rejects.toMatchObject({ name: "PortError", code: "not_found" });
  });

  it("getAccountOptions sembrado puede ser más chico que lo declarado", async () => {
    const publisher = new MemorySocialPublisher({
      capabilities: TIKTOK_CAPS,
      accountOptions: {
        conn_1: { allowedPrivacyLevels: ["SELF_ONLY"], directPostingAvailable: false },
      },
    });

    const options = await publisher.getAccountOptions(ACCOUNT);

    // `INT-001`: lo permitido por cuenta es un subconjunto de lo de la ruta y
    // cambia en vivo. `ERR-D14` es precisamente el caso de acá.
    expect(options.allowedPrivacyLevels).toEqual(["SELF_ONLY"]);
    expect(options.directPostingAvailable).toBe(false);
  });
});
