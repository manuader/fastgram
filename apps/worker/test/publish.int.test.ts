/**
 * El handler de `publishing`, contra Postgres — `FR-060`, `NFR-005`, `NFR-015`.
 *
 * ## Qué persigue este archivo
 *
 * Que programar un post signifique algo. `POST /content/:id/schedule` crea las
 * filas y encola un job por cada una; sin consumidor, el post se queda en
 * `SCHEDULED` para siempre y **nada falla**.
 *
 * Pero lo que de verdad se mide acá no es el camino feliz: es que este handler
 * **no duplique**. Publicar es la única operación del sistema que no se puede
 * deshacer desde nuestro lado — un segundo post en la cuenta del usuario no lo
 * borra nadie— y por eso el job tiene `maxAttempts: 1` y este archivo nunca
 * relanza. Los casos que importan son:
 *
 *  - que un fallo se **escriba y se muestre** en vez de reintentarse;
 *  - que una cancelación pendiente **frene** la publicación;
 *  - que lo que pasó en la plataforma **gane** sobre lo que diga la fila, porque
 *    el post ya existe y la base tiene que decir la verdad;
 *  - que una segunda corrida del mismo job **no publique dos veces**.
 *
 * Corre con `SET LOCAL ROLE fastgram_app`: sin el rol, la conexión de
 * desarrollo es superusuaria, saltea RLS, y el archivo mediría la mitad.
 */
import { FixedClock, MemorySocialPublisher } from "@fastgram/adapters";
import { APP_ROLE, type DbHandle } from "@fastgram/db";
import {
  PortError,
  type JobContext,
  type PublishStatus,
  type SocialPublisher,
  type SocialPublishCapabilities,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPublishHandler } from "../src/publishing/publish-handler.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { openDb, readPost, seedCompany, seedPost } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const clock = new FixedClock(NOW);
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let companyId: string;

/**
 * Capacidades de TikTok, **declaradas por el test y no por el adaptador**.
 *
 * `MemorySocialPublisher` las exige sin default a propósito: una tabla de
 * capacidades por plataforma adentro del adaptador de memoria sería una
 * afirmación sobre un proveedor real sin evidencia. Acá son las del caso que se
 * está probando y nada más.
 */
const CAPS: SocialPublishCapabilities = {
  platform: "tiktok",
  accountTypes: ["oauth", "warmed"],
  mediaKinds: ["video", "slideshow"],
  captionLimits: { captionMaxChars: 2200 },
  postingModes: ["inbox", "direct"],
  privacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  supportsAiLabel: true,
  supportsPaidPartnership: true,
  supportsScheduling: true,
};

/** Cuenta llamadas: es la aserción que importa para `NFR-015`. */
class PublicadorContado implements SocialPublisher {
  readonly inner: MemorySocialPublisher;
  llamadas = 0;
  lanzar: Error | null = null;
  /**
   * Corre **durante** la publicación.
   *
   * Es la única forma de provocar la carrera que importa: la cancelación que
   * entra entre que el handler lee la fila y que escribe el resultado. Con
   * `Promise.all` desde afuera no se reproduce, porque las dos transacciones del
   * handler son cortas y se ordenan solas.
   */
  durante: (() => Promise<void>) | null = null;

  constructor(outcomes: readonly PublishStatus[] = []) {
    this.inner = new MemorySocialPublisher({ capabilities: CAPS, clock, outcomes });
  }
  capabilities() {
    return this.inner.capabilities();
  }
  async getAccountOptions(...a: Parameters<SocialPublisher["getAccountOptions"]>) {
    return this.inner.getAccountOptions(...a);
  }
  async publish(...a: Parameters<SocialPublisher["publish"]>) {
    this.llamadas += 1;
    if (this.durante !== null) {
      const fn = this.durante;
      this.durante = null;
      await fn();
    }
    if (this.lanzar !== null) {
      const e = this.lanzar;
      this.lanzar = null;
      throw e;
    }
    return this.inner.publish(...a);
  }
  async getStatus(...a: Parameters<SocialPublisher["getStatus"]>) {
    return this.inner.getStatus(...a);
  }
  async cancel(...a: Parameters<SocialPublisher["cancel"]>) {
    return this.inner.cancel(...a);
  }
  async fetchMetrics(...a: Parameters<SocialPublisher["fetchMetrics"]>) {
    return this.inner.fetchMetrics(...a);
  }
}

let publicador: PublicadorContado;

const handler = (over: Record<string, SocialPublisher> = {}) =>
  createPublishHandler({
    db: handle.db,
    publishers: { tiktok: publicador, ...over },
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
  });

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: "job_1",
  payload,
  attempt: 1,
  // La ruta encola con `retryLimit: 0`: un solo intento, por `NFR-015`.
  maxAttempts: 1,
});

beforeAll(async () => {
  handle = openDb();
  companyId = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  publicador = new PublicadorContado();
});

describe("el camino feliz", () => {
  it("publica y deja el post en POSTED con su permalink", async () => {
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    const post = await readPost(handle, postId);
    expect(post.status).toBe("POSTED");
    expect(post.post_url).not.toBeNull();
    expect(post.posted_at).not.toBeNull();
    expect(publicador.llamadas).toBe(1);
  });

  it("`in_user_inbox` NO es un error", async () => {
    // `FR-060`: el post quedó como borrador dentro de la app del creador y falta
    // que él pulse Post. Marcarlo `FAILED` haría que el usuario lo reintente y
    // termine con dos.
    publicador = new PublicadorContado([{ kind: "in_user_inbox" }]);
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    const post = await readPost(handle, postId);
    expect(post.status).toBe("IN_USER_INBOX");
    expect(post.error_code).toBeNull();
  });

  it("guarda la copy ajustada por la plataforma", async () => {
    // `DATA-020`: si la plataforma cambió la copy, la que vale es la publicada.
    publicador = new PublicadorContado([
      {
        kind: "published",
        externalPostId: "x1",
        permalink: "https://tiktok.test/x1",
        publishedCaption: "hola (ajustado)",
        captionAdjustmentReason: "repeated_mention",
      },
    ]);
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    expect((await readPost(handle, postId)).published_caption).toBe("hola (ajustado)");
  });

  it("el carril lento queda en UPLOADING_TO_TIKTOK, no en POSTED", async () => {
    // `NFR-015`: mientras `processingDelayed` esté puesto **no se reprograma**,
    // porque crearía un duplicado. Decir `POSTED` afirmaría que salió algo que
    // todavía no salió.
    publicador = new PublicadorContado([
      { kind: "processing", externalPostId: "x2", processingDelayed: true },
    ]);
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    const post = await readPost(handle, postId);
    expect(post.status).toBe("UPLOADING_TO_TIKTOK");
    expect(post.tiktok_processing_delayed).toBe(true);
    expect(post.posted_at).toBeNull();
  });
});

describe("no duplicar es la regla — NFR-015", () => {
  it("una segunda corrida del mismo job NO publica dos veces", async () => {
    // El post ya quedó en `POSTED`, así que la segunda lectura lo saltea antes
    // de llegar a la plataforma. Es la primera de las dos defensas; la otra es
    // la `idempotencyKey`, abajo.
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));
    await handler()(ctx({ companyId, postId }));

    expect(publicador.llamadas).toBe(1);
  });

  it("la `idempotencyKey` es estable por post", async () => {
    // La defensa que queda si el proceso se cae **entre** publicar y escribir:
    // la fila sigue en `SCHEDULED`, el chequeo de estado no frena nada, y lo
    // único que evita el segundo post es que el adaptador reconozca la clave y
    // devuelva el resultado anterior.
    const { postId } = await seedPost(handle, companyId);
    await handler()(ctx({ companyId, postId }));
    const primera = await readPost(handle, postId);

    // Se devuelve la fila a `SCHEDULED` a mano: es exactamente el estado que
    // deja un crash entre la llamada y la escritura.
    await handle.sql`update posts set status = 'SCHEDULED' where id = ${postId}::uuid`;
    await handler()(ctx({ companyId, postId }));

    // Dos llamadas al puerto y **un solo post**: el mismo permalink de la
    // primera vez, o sea que el adaptador no creó uno nuevo.
    expect(publicador.llamadas).toBe(2);
    const segunda = await readPost(handle, postId);
    expect(segunda.post_url).toBe(primera.post_url);
    expect(segunda.status).toBe("POSTED");
  });

  it("una cancelación pendiente frena la publicación", async () => {
    // Las cuentas warmed las opera una persona, así que cancelar no es
    // inmediato (`FR-060`). Publicar con la bandera puesta publicaría justo lo
    // que el usuario pidió frenar — y no hay vuelta atrás.
    const { postId } = await seedPost(handle, companyId, { cancellationPending: true });

    await handler()(ctx({ companyId, postId }));

    expect(publicador.llamadas).toBe(0);
    expect((await readPost(handle, postId)).status).toBe("SCHEDULED");
  });

  it("un post que ya no está en SCHEDULED no se toca", async () => {
    const { postId } = await seedPost(handle, companyId, { status: "CANCELLED" });

    await handler()(ctx({ companyId, postId }));

    expect(publicador.llamadas).toBe(0);
    expect((await readPost(handle, postId)).status).toBe("CANCELLED");
  });
});

describe("los fallos se escriben, no se reintentan", () => {
  it("un rechazo de la plataforma deja FAILED con su motivo neutral", async () => {
    publicador = new PublicadorContado([
      {
        kind: "failed",
        failure: {
          reason: "post_limit_exceeded",
          message: "You've hit the daily limit.",
        },
      },
    ]);
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    const post = await readPost(handle, postId);
    expect(post.status).toBe("FAILED");
    // Código neutral (§10, regla 6): nunca el de la plataforma.
    expect(post.error_code).toBe("post_limit_exceeded");
    expect(post.error_message).toBe("You've hit the daily limit.");
  });

  it("si la llamada FALLA, el handler no relanza", async () => {
    // Relanzar acá no compra nada —`maxAttempts` es 1— y sí deja el post en
    // `SCHEDULED` para siempre, que es el estado colgado que este handler vino a
    // cerrar. Un throw del puerto significa que la **llamada** falló, no que el
    // post se publicó: el puerto lo dice explícito.
    publicador.lanzar = new PortError("provider_unavailable", "no responde", {
      source: "t",
    });
    const { postId } = await seedPost(handle, companyId);

    await expect(handler()(ctx({ companyId, postId }))).resolves.toBeUndefined();

    const post = await readPost(handle, postId);
    expect(post.status).toBe("FAILED");
    expect(post.error_code).toBe("provider_unavailable");
  });

  it("una pieza sin archivos no se publica", async () => {
    // El build nunca terminó, o el post se programó antes. Es definitivo: este
    // job no se reintenta y el build no va a volver a correr solo.
    const { postId } = await seedPost(handle, companyId, {
      contentStatus: "BUILDING",
      files: [],
    });

    await handler()(ctx({ companyId, postId }));

    expect(publicador.llamadas).toBe(0);
    const post = await readPost(handle, postId);
    expect(post.status).toBe("FAILED");
    expect(post.error_code).toBe("content_not_ready");
  });

  it("una plataforma sin publicador montado falla la fila en vez de colgarla", async () => {
    const { postId } = await seedPost(handle, companyId, { platform: "instagram" });

    await handler()(ctx({ companyId, postId }));

    const post = await readPost(handle, postId);
    expect(post.status).toBe("FAILED");
    expect(post.error_code).toBe("provider_unavailable");
  });
});

describe("la plataforma gana sobre la fila", () => {
  it("si cancelan mientras se publica, el post queda POSTED", async () => {
    // El caso opuesto al del build, y es deliberado: allá el resultado se
    // descarta si la pieza cambió; acá el post **ya existe en la plataforma**.
    // Mostrarlo como `CANCELLED` sería mentir sobre algo que cualquiera puede
    // ver en el perfil del usuario. Verificado rompiéndolo: con un chequeo de
    // estado antes de escribir, este test se pone rojo.
    const { postId } = await seedPost(handle, companyId);
    publicador.durante = async () => {
      await handle.sql`update posts set status = 'CANCELLED' where id = ${postId}::uuid`;
    };

    await handler()(ctx({ companyId, postId }));

    expect(publicador.llamadas).toBe(1);
    expect((await readPost(handle, postId)).status).toBe("POSTED");
  });
});

describe("aislamiento", () => {
  it("un job con el workspace equivocado no toca el post", async () => {
    const otro = await seedCompany(handle);
    const { postId } = await seedPost(handle, otro);

    await handler()(ctx({ companyId, postId }));

    expect(publicador.llamadas).toBe(0);
    expect((await readPost(handle, postId)).status).toBe("SCHEDULED");
  });
});

describe("payloads que no son de este mundo", () => {
  it("sin `postId` se descarta sin publicar", async () => {
    await expect(handler()(ctx({ companyId }))).resolves.toBeUndefined();
    expect(publicador.llamadas).toBe(0);
  });

  it("un post que no existe no es un error", async () => {
    await expect(
      handler()(ctx({ companyId, postId: "00000000-0000-4000-8000-000000000000" })),
    ).resolves.toBeUndefined();
  });
});
