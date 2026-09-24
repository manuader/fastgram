/**
 * Las reglas de `posts.ts` que se pueden decidir sin base de datos.
 *
 * Lo que se fija acá es lo que el PRD **no** dice y por lo tanto nadie va a recordar en
 * seis meses: qué estados se pueden cancelar, que re-cancelar es un no-op, que un id de
 * otro workspace y uno inexistente producen exactamente el mismo motivo, y que el `title`
 * de TikTok aterriza en `caption`. Un cambio en cualquiera de esas cuatro cosas tiene que
 * ser deliberado, no un efecto lateral.
 */
import { describe, expect, it } from "vitest";
import {
  scheduleContentRequestSchema as scheduleRequestS7,
  scheduleTargetSchema,
} from "@fastgram/contracts";

import {
  CANCELLABLE_POST_STATUSES,
  cancelFailureOf,
  cancelPatchOf,
  collectFailures,
  deleteFailureOf,
  flattenTarget,
  isStorableId,
  copyPatchOf as copyPatchOfS7,
  manualRetryKey as manualRetryKeyS7,
  retryRefusalOf as retryRefusalOfS7,
  type CancellablePost,
} from "./posts.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const post = (
  status: string,
  cancellationPending = false,
  accountType: "oauth" | "warmed" = "oauth",
): CancellablePost => ({ status, cancellationPending, accountType });

describe("isStorableId", () => {
  it("acepta un uuid y rechaza cualquier otra cosa", () => {
    // Los ids del contrato son opacos, pero la columna es `uuid`: un id malformado que
    // llega a Postgres sale como 500, no como el 400 que ERR-F01/ERR-F02 especifican.
    expect(isStorableId(UUID_A)).toBe(true);
    expect(isStorableId(UUID_A.toUpperCase())).toBe(true);
    expect(isStorableId("post_1")).toBe(false);
    expect(isStorableId("")).toBe(false);
    expect(isStorableId(`${UUID_A} `)).toBe(false);
  });
});

describe("cancelFailureOf", () => {
  it("un id ajeno y uno inexistente dan el mismo motivo (§9.2)", () => {
    // Los dos llegan como `undefined` porque el repositorio scopeado devuelve `null` en
    // ambos casos. Si alguno fuera distinguible, el lote sería el canal lateral que el
    // PRD cierra pidiendo 404 y nunca 403.
    expect(cancelFailureOf(undefined)).toBe("not_found");
  });

  it("cancela desde los cuatro estados que todavía no salieron de nuestro lado", () => {
    for (const status of ["BUILDING", "CREATED", "SCHEDULED", "AWAITING_RECONNECT"]) {
      expect(cancelFailureOf(post(status))).toBeNull();
      expect(CANCELLABLE_POST_STATUSES.has(status)).toBe(true);
    }
  });

  it("no cancela lo que ya está en manos del proveedor ni lo terminal", () => {
    for (const status of [
      "UPLOADING_TO_TIKTOK",
      "IN_USER_INBOX",
      "POSTED",
      "FAILED",
      "DELETED",
    ]) {
      expect(cancelFailureOf(post(status))).toBe(`not_cancellable_status:${status}`);
    }
  });

  it("re-cancelar un post ya cancelado es un no-op, no un fallo", () => {
    // Si fuera fallo, el reintento de un lote cortado por timeout fallaría entero por los
    // ids que sí se habían cancelado, y el endpoint dejaría de ser reintentable.
    expect(cancelFailureOf(post("CANCELLED"))).toBeNull();
  });

  it("una cancelación warmed en curso gana sobre el estado", () => {
    // FR-060: se resuelve sola a CANCELLED o a POSTED, y dice explícitamente no reintentar.
    expect(cancelFailureOf(post("SCHEDULED", true))).toBe("cancellation_pending");
  });
});

describe("cancelPatchOf", () => {
  it("una cuenta OAuth pasa a CANCELLED y una warmed queda pendiente", () => {
    // FR-060 (PRD:1393): la warmed la opera una persona y la cancelación "se resuelve
    // sola a CANCELLED o a POSTED si salió antes". Escribir CANCELLED de una vez le
    // diría al usuario que algo no va a salir cuando todavía puede salir.
    expect(cancelPatchOf(post("SCHEDULED"))).toEqual({ status: "CANCELLED" });
    expect(cancelPatchOf(post("SCHEDULED", false, "warmed"))).toEqual({
      cancellationPending: true,
    });
  });

  it("un post ya cancelado no se reescribe", () => {
    // Reescribirlo movería `updatedAt` y diría que cambió algo que no cambió.
    expect(cancelPatchOf(post("CANCELLED"))).toBeNull();
    expect(cancelPatchOf(post("CANCELLED", false, "warmed"))).toBeNull();
  });
});

describe("deleteFailureOf", () => {
  it("borra desde cualquier estado y sólo falla si no está", () => {
    // ERR-P06 empuja en esta dirección: para liberar un contenido con posts vinculados,
    // "cancelar no basta, hay que borrarlos".
    expect(deleteFailureOf(post("POSTED"))).toBeNull();
    expect(deleteFailureOf(post("UPLOADING_TO_TIKTOK"))).toBeNull();
    expect(deleteFailureOf(undefined)).toBe("not_found");
  });
});

describe("collectFailures", () => {
  it("conserva el orden del pedido y no consulta los ids malformados", () => {
    const rows = new Map([[UUID_A, post("SCHEDULED")]]);
    const failures = collectFailures(
      ["no-soy-un-uuid", UUID_A, UUID_B],
      rows,
      cancelFailureOf,
    );
    expect(failures).toEqual([
      { id: "no-soy-un-uuid", reason: "invalid_id" },
      { id: UUID_B, reason: "not_found" },
    ]);
  });

  it("un lote entero aplicable no reporta nada", () => {
    const rows = new Map([
      [UUID_A, post("SCHEDULED")],
      [UUID_B, post("CANCELLED")],
    ]);
    expect(collectFailures([UUID_A, UUID_B], rows, cancelFailureOf)).toEqual([]);
  });
});

describe("flattenTarget", () => {
  it("el `title` de TikTok aterriza en `caption`", () => {
    // DATA-020 no tiene columna `title`; FR-060 describe los dos campos de TikTok como el
    // par título/cuerpo, igual que el caption/description de YouTube.
    const flat = flattenTarget(
      scheduleTargetSchema.parse({
        platform: "tiktok",
        connectionId: UUID_A,
        title: "Hook",
        description: "Cuerpo",
        tiktokSoundMode: "audible",
      }),
    );
    expect(flat).toMatchObject({
      platform: "tiktok",
      connectionId: UUID_A,
      caption: "Hook",
      description: "Cuerpo",
      tiktokSoundMode: "audible",
      warmedAccountId: null,
      instagramSlideshowFormat: null,
    });
  });

  it("Reddit no trae cuenta warmed: el contrato le quita la clave", () => {
    const flat = flattenTarget(
      scheduleTargetSchema.parse({
        platform: "reddit",
        connectionId: UUID_A,
        caption: "Texto",
      }),
    );
    expect(flat.warmedAccountId).toBeNull();
    expect(flat.caption).toBe("Texto");
    expect(flat.description).toBeNull();
  });

  it("Instagram conserva el formato de slideshow y la cuenta warmed", () => {
    const flat = flattenTarget(
      scheduleTargetSchema.parse({
        platform: "instagram",
        warmedAccountId: UUID_B,
        caption: "Pie",
        instagramSlideshowFormat: "carousel",
        discloseAsAds: true,
      }),
    );
    expect(flat).toMatchObject({
      platform: "instagram",
      warmedAccountId: UUID_B,
      connectionId: null,
      instagramSlideshowFormat: "carousel",
      discloseAsAds: true,
    });
  });

  it.each(["x", "threads", "facebook"] as const)(
    "%s (D-09): sólo OAuth, la copy va a `caption` y nada de TikTok",
    (platform) => {
      const flat = flattenTarget(
        scheduleTargetSchema.parse({ platform, connectionId: UUID_A, caption: "Texto" }),
      );
      expect(flat).toEqual({
        platform,
        connectionId: UUID_A,
        warmedAccountId: null,
        caption: "Texto",
        description: null,
        discloseAsAds: null,
        aiContentDisclaimer: null,
        instagramSlideshowFormat: null,
        postingMode: null,
        privacyLevel: null,
        tiktokSoundId: null,
        tiktokSoundMode: null,
      });
    },
  );

  it("todo lo que el target no trae queda en null, nunca en undefined", () => {
    // Las columnas nullable de `posts` se escriben con `null` explícito: con
    // `exactOptionalPropertyTypes`, "ausente" y "presente en undefined" no son lo mismo y
    // un `undefined` que llega al insert borra la intención en vez de expresarla.
    const flat = flattenTarget(
      scheduleTargetSchema.parse({ platform: "youtube", connectionId: UUID_A }),
    );
    for (const value of Object.values(flat)) {
      expect(value).not.toBeUndefined();
    }
    expect(flat.privacyLevel).toBeNull();
    expect(flat.postingMode).toBeNull();
  });
});

// ── Sprint 7 (publish-flow) ─────────────────────────────────────────────────

describe("retryRefusalOf", () => {
  it("sólo FAILED se reintenta", () => {
    expect(
      retryRefusalOfS7({ status: "SCHEDULED", errorCode: null }, false),
    ).not.toBeNull();
    expect(
      retryRefusalOfS7({ status: "FAILED", errorCode: "unknown" }, false),
    ).toBeNull();
  });

  it("entrega incierta o carril lento vencido exigen confirmación (NFR-015)", () => {
    for (const code of ["delivery_unconfirmed", "platform_processing_timeout"]) {
      expect(
        retryRefusalOfS7({ status: "FAILED", errorCode: code }, false),
      ).not.toBeNull();
      expect(retryRefusalOfS7({ status: "FAILED", errorCode: code }, true)).toBeNull();
    }
  });

  it("la clave del job manual no choca con la primera (trampa 39)", () => {
    expect(manualRetryKeyS7("p1", 5)).toBe("publishing:p1:manual:5");
  });
});

describe("copyPatchOf", () => {
  it("valida por code point contra el tope de la red", () => {
    expect(copyPatchOfS7("x", { caption: "🔥".repeat(280) })).toEqual({
      caption: "🔥".repeat(280),
    });
    expect(() => copyPatchOfS7("x", { caption: "a".repeat(281) })).toThrow();
  });

  it("descripción sólo donde la red la tiene", () => {
    expect(() => copyPatchOfS7("instagram", { description: "d" })).toThrow();
    expect(copyPatchOfS7("tiktok", { description: "d" })).toEqual({ description: "d" });
  });
});

describe("scheduleContentRequestSchema · postNow", () => {
  const targets = [{ platform: "x", caption: "hola" }];
  it("sin hora ni postNow no valida; con postNow sí", () => {
    expect(scheduleRequestS7.safeParse({ targets }).success).toBe(false);
    expect(scheduleRequestS7.safeParse({ targets, postNow: true }).success).toBe(true);
    expect(scheduleRequestS7.safeParse({ targets, scheduledAtUtc: 1 }).success).toBe(
      true,
    );
  });
});
