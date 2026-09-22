import { describe, expect, it } from "vitest";
import {
  describeSocialReaderContract,
  type SocialContentItem,
  type SocialReadCapabilities,
} from "@fastgram/ports";
import { MemorySocialReader, type MemorySocialProfile } from "./memory-social-reader.js";

/**
 * Primera ejecución de las siete aserciones de contrato de `SocialReader`.
 *
 * Las capacidades declaran **sólo tier B**, que es donde `D-01` quiere que
 * empiece el alta: sin OAuth y sin pedirle nada al usuario. El tier C queda
 * fuera porque `OQ-16` sigue abierto, y declararlo soportado pero apagado es
 * justo lo que el contrato rechaza.
 */
const CAPS: SocialReadCapabilities = {
  source: "instagram",
  tiers: ["B_public_api", "A_oauth"],
  profileSignals: ["displayName", "handle", "bio", "links", "followerCount"],
  contentSignals: ["externalId", "kind", "caption", "hashtags", "postedAt", "engagement"],
  maxContentItems: 12,
  requiresConnection: false,
  renderedFetchEnabled: false,
};

function item(externalId: string, postedAt: string | undefined): SocialContentItem {
  return {
    externalId,
    kind: "image",
    hashtags: ["#cafe"],
    mentions: [],
    engagement: { likes: 10 },
    mediaUrls: [`memory://media/${externalId}.jpg`],
    ...(postedAt === undefined ? {} : { postedAt: new Date(postedAt) }),
  };
}

const PUBLICA: MemorySocialProfile = {
  handle: "lamarca",
  displayName: "La Marca",
  signals: {
    displayName: "La Marca",
    handle: "lamarca",
    bio: "café de especialidad",
    links: ["https://lamarca.invalid"],
    followerCount: 4200,
  },
  content: [
    item("p1", "2026-09-01T10:00:00.000Z"),
    item("p3", "2026-09-20T10:00:00.000Z"),
    item("p2", "2026-09-10T10:00:00.000Z"),
  ],
};

const PRIVADA: MemorySocialProfile = {
  handle: "cerrada",
  signals: {},
  visibility: "private",
};

function makeReader(): MemorySocialReader {
  return new MemorySocialReader({ capabilities: CAPS, profiles: [PUBLICA, PRIVADA] });
}

describeSocialReaderContract({ describe, it }, "memory", {
  makeAdapter: makeReader,
  existingHandle: "lamarca",
  missingHandle: "no-existe-0000",
  privateHandle: "cerrada",
  resolvableInput: "@lamarca",
});

describe("MemorySocialReader — comportamiento propio del adaptador", () => {
  it("resolve acepta URL sin esquema, con esquema y @handle", async () => {
    const reader = makeReader();

    for (const input of [
      "@lamarca",
      "lamarca",
      "instagram.invalid/lamarca",
      "https://instagram.invalid/lamarca/",
    ]) {
      const outcome = await reader.resolve({ input });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") continue;
      expect(outcome.data.handle).toBe("lamarca");
      expect(outcome.data.available).toBe(true);
    }
  });

  it("un enlace a un post resuelve al perfil y lo avisa (ERR-B12)", async () => {
    const reader = makeReader();

    const outcome = await reader.resolve({
      input: "https://instagram.invalid/lamarca/p/abc123",
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    // `FR-011.1` obliga a avisarlo: el usuario pegó un post y va a analizar
    // una cuenta entera. Sin la bandera, el aviso no se puede mostrar.
    expect(outcome.data.resolvedFromPost).toBe(true);
    expect(outcome.data.handle).toBe("lamarca");
  });

  it("resolve de un handle bien formado que no existe es ok con available false", async () => {
    const reader = makeReader();

    const outcome = await reader.resolve({ input: "@fantasma" });

    // `ERR-B04`. No es una excepción: §9.14 pide que `resolve` alimente la
    // detección en vivo del input, y un throw por cada tecla no sirve.
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.data.available).toBe(false);
  });

  it("una entrada vacía es bad_request (ERR-B02)", async () => {
    const reader = makeReader();

    await expect(reader.resolve({ input: "   " })).rejects.toMatchObject({
      name: "PortError",
      code: "bad_request",
    });
  });

  it("readProfile descarta las señales que capabilities no declara", async () => {
    const reader = new MemorySocialReader({
      capabilities: CAPS,
      profiles: [
        {
          ...PUBLICA,
          // `category` no está en `profileSignals`: el extractor no la declara.
          signals: { ...PUBLICA.signals, category: "cafetería" },
        },
      ],
    });

    const outcome = await reader.readProfile({ handle: "lamarca" });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    // `OQ-19`: declarar en un lado y devolver en otro hace que el orquestador
    // pida OAuth cuando no hacía falta, o que no lo pida cuando sí.
    expect(outcome.data.category).toBeUndefined();
    expect(outcome.data.bio).toBe("café de especialidad");
  });

  it("un perfil sin contenido es insufficient_content, no un error (ERR-B09)", async () => {
    const reader = new MemorySocialReader({
      capabilities: CAPS,
      profiles: [{ handle: "vacia", signals: { handle: "vacia" }, content: [] }],
    });

    const outcome = await reader.readRecentContent({ handle: "vacia" });

    expect(outcome.status).toBe("insufficient_content");
    if (outcome.status === "ok") return;
    expect(outcome.attemptedTiers.length).toBeGreaterThan(0);
  });

  it("el techo de maxContentItems gana sobre un limit más grande", async () => {
    const reader = new MemorySocialReader({
      capabilities: { ...CAPS, maxContentItems: 2 },
      profiles: [PUBLICA],
    });

    const outcome = await reader.readRecentContent({ handle: "lamarca", limit: 10 });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.data).toHaveLength(2);
    expect(outcome.data.map((i) => i.externalId)).toEqual(["p3", "p2"]);
  });

  it("un ítem sin fecha va al final, no al medio", async () => {
    const reader = new MemorySocialReader({
      capabilities: CAPS,
      profiles: [
        {
          handle: "mixta",
          signals: {},
          content: [
            item("sin-fecha", undefined),
            item("con-fecha", "2026-01-01T00:00:00.000Z"),
          ],
        },
      ],
    });

    const outcome = await reader.readRecentContent({ handle: "mixta" });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.data.map((i) => i.externalId)).toEqual(["con-fecha", "sin-fecha"]);
  });

  it("un limit de cero o negativo es bad_request", async () => {
    const reader = makeReader();

    await expect(
      reader.readRecentContent({ handle: "lamarca", limit: 0 }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("con token resuelve por tier A y sin token por el mejor tier sin OAuth", async () => {
    const reader = makeReader();

    const conToken = await reader.readProfile({
      handle: "lamarca",
      accessToken: "tok",
    });
    const sinToken = await reader.readProfile({ handle: "lamarca" });

    expect(conToken.status === "ok" ? conToken.tier : null).toBe("A_oauth");
    // Sin token el tier A no es usable aunque esté declarado: `D-01` quiere
    // que el alta empiece sin pedir OAuth.
    expect(sinToken.status === "ok" ? sinToken.tier : null).toBe("B_public_api");
  });

  it("el tier C declarado pero apagado no se usa para resolver", async () => {
    const reader = new MemorySocialReader({
      capabilities: {
        ...CAPS,
        tiers: ["C_page_fetch", "B_public_api"],
        renderedFetchEnabled: false,
      },
      profiles: [PUBLICA],
    });

    const outcome = await reader.readProfile({ handle: "lamarca" });

    // Mientras `OQ-16` siga abierto el tier C va apagado, y apagado significa
    // que no se usa — no que se use y no se cuente.
    expect(outcome.status === "ok" ? outcome.tier : null).toBe("B_public_api");
  });

  it("el handle no distingue mayúsculas", async () => {
    const reader = makeReader();

    const outcome = await reader.readProfile({ handle: "LaMarca" });

    expect(outcome.status).toBe("ok");
  });
});
