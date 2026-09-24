import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  PLATFORM_FIELD_LIMITS,
  SCHEDULING_ERROR_CODES,
  TIKTOK_SLOW_LANE_MAX_HOURS,
  WARMED_MAX_DAYS_AHEAD,
  assertAccountSelection,
  assertCanCancel,
  assertCanReschedule,
  assertValidCopy,
  assertValidTikTokOptions,
  assertWarmedSchedulable,
  isAwaitingUserAction,
  planCaptionGeneration,
  planPostFanOut,
  resolveConnection,
  type Connection,
  type Entitlements,
  type ExistingPost,
  type Platform,
  type PlatformTarget,
  type WarmedAccount,
} from "./schedule-post.js";

const NOW = new Date("2026-09-21T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

const entitlements = (over: Partial<Entitlements> = {}): Entitlements => ({
  tiktokDirect: true,
  autoCaptions: true,
  warmedPosting: true,
  ...over,
});

const target = (over: Partial<PlatformTarget> = {}): PlatformTarget => ({
  platform: "tiktok",
  ...over,
});

const warmed = (over: Partial<WarmedAccount> = {}): WarmedAccount => ({
  id: "wa_1",
  platform: "tiktok",
  status: "active",
  minLeadTimeMs: 2 * DAY,
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────
// Resolución de cuenta
// ───────────────────────────────────────────────────────────────────────────

describe("connection_ambiguous (FR-060)", () => {
  const conns: Connection[] = [
    { id: "cx_1", platform: "instagram", isActive: true },
    { id: "cx_2", platform: "instagram", isActive: true },
    { id: "cx_3", platform: "tiktok", isActive: true },
    { id: "cx_4", platform: "tiktok", isActive: false },
  ];

  it("con UNA conexión activa, connectionId es opcional", () => {
    expect(resolveConnection("tiktok", undefined, conns)).toBe("cx_3");
  });

  it("con DOS, es obligatorio y el error lista las candidatas", () => {
    try {
      resolveConnection("instagram", undefined, conns);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.details?.code).toBe(SCHEDULING_ERROR_CODES.connectionAmbiguous);
      expect(err.details?.candidates).toEqual(["cx_1", "cx_2"]);
    }
  });

  it("las inactivas no cuentan para la ambigüedad", () => {
    // cx_4 está inactiva, así que TikTok tiene una sola activa.
    expect(() => resolveConnection("tiktok", undefined, conns)).not.toThrow();
  });

  it("sin ninguna conexión, el mensaje dice qué hacer", () => {
    expect(() => resolveConnection("youtube", undefined, conns)).toThrow(DomainError);
  });

  it("una conexión ajena o inexistente es not_found, no forbidden (§9.2)", () => {
    try {
      resolveConnection("instagram", "cx_ajena", conns);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("not_found");
    }
  });
});

describe("connectionId y warmedAccountId son mutuamente excluyentes", () => {
  it("los dos a la vez es error", () => {
    expect(() =>
      assertAccountSelection(target({ connectionId: "cx_1", warmedAccountId: "wa_1" })),
    ).toThrow(DomainError);
  });

  it("uno solo, o ninguno, pasa", () => {
    expect(() => assertAccountSelection(target({ connectionId: "cx_1" }))).not.toThrow();
    expect(() =>
      assertAccountSelection(target({ warmedAccountId: "wa_1" })),
    ).not.toThrow();
    expect(() => assertAccountSelection(target())).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TikTok
// ───────────────────────────────────────────────────────────────────────────

describe("posting_mode es sólo TikTok OAuth (FR-060)", () => {
  const ctx = {
    entitlements: entitlements(),
    allowedPrivacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  };

  it("en otra plataforma se rechaza con su código", () => {
    try {
      assertValidTikTokOptions(
        target({ platform: "instagram", postingMode: "direct" }),
        ctx,
      );
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(
        SCHEDULING_ERROR_CODES.postingModeNotSupported,
      );
    }
  });

  it("con una cuenta warmed también se rechaza", () => {
    expect(() =>
      assertValidTikTokOptions(
        target({ postingMode: "inbox", warmedAccountId: "wa_1" }),
        ctx,
      ),
    ).toThrow(DomainError);
  });

  it("inbox no pide privacy level", () => {
    expect(() =>
      assertValidTikTokOptions(target({ postingMode: "inbox" }), ctx),
    ).not.toThrow();
  });
});

describe("privacy level (FR-060, criterio 2)", () => {
  const ctx = {
    entitlements: entitlements(),
    allowedPrivacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  };

  it("con posting directo es OBLIGATORIO", () => {
    try {
      assertValidTikTokOptions(target({ postingMode: "direct" }), ctx);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(
        SCHEDULING_ERROR_CODES.privacyLevelRequired,
      );
    }
  });

  it("un valor fuera de los que declara la plataforma devuelve allowed_values", () => {
    // La lista viene del creator info de TikTok, no de una constante nuestra.
    try {
      assertValidTikTokOptions(
        target({ postingMode: "direct", privacyLevel: "FRIENDS_OF_FRIENDS" }),
        ctx,
      );
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.details?.code).toBe(SCHEDULING_ERROR_CODES.invalidPrivacyLevel);
      expect(err.details?.allowed_values).toEqual(ctx.allowedPrivacyLevels);
    }
  });

  it("sin modo directo, mandar privacy level es error", () => {
    try {
      assertValidTikTokOptions(
        target({ postingMode: "inbox", privacyLevel: "SELF_ONLY" }),
        ctx,
      );
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(
        SCHEDULING_ERROR_CODES.privacyLevelWithoutDirect,
      );
    }
  });

  it("sin el entitlement tiktokDirect falla con mensaje claro", () => {
    expect(() =>
      assertValidTikTokOptions(
        target({ postingMode: "direct", privacyLevel: "SELF_ONLY" }),
        {
          ...ctx,
          entitlements: entitlements({ tiktokDirect: false }),
        },
      ),
    ).toThrow(DomainError);
  });

  it("directo con entitlement y valor válido pasa", () => {
    expect(() =>
      assertValidTikTokOptions(
        target({ postingMode: "direct", privacyLevel: "PUBLIC_TO_EVERYONE" }),
        ctx,
      ),
    ).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Warmed
// ───────────────────────────────────────────────────────────────────────────

describe("cuentas warmed (FR-060, criterio 3)", () => {
  it("usa el lead time DE LA CUENTA, no uno global", () => {
    const fast = warmed({ id: "wa_fast", minLeadTimeMs: 12 * HOUR });
    const slow = warmed({ id: "wa_slow", minLeadTimeMs: 3 * DAY });
    const in2Days = new Date(NOW.getTime() + 2 * DAY);

    expect(() =>
      assertWarmedSchedulable(fast, in2Days, NOW, entitlements()),
    ).not.toThrow();
    // La misma fecha, otra cuenta: con un lead time global esto pasaría.
    expect(() => assertWarmedSchedulable(slow, in2Days, NOW, entitlements())).toThrow(
      DomainError,
    );
  });

  it("el techo son 30 días", () => {
    expect(WARMED_MAX_DAYS_AHEAD).toBe(30);
    const at30 = new Date(NOW.getTime() + 30 * DAY);
    const at31 = new Date(NOW.getTime() + 31 * DAY);
    expect(() =>
      assertWarmedSchedulable(warmed(), at30, NOW, entitlements()),
    ).not.toThrow();
    expect(() => assertWarmedSchedulable(warmed(), at31, NOW, entitlements())).toThrow(
      DomainError,
    );
  });

  it("sólo TikTok e Instagram; YouTube y Reddit son sólo OAuth", () => {
    const later = new Date(NOW.getTime() + 5 * DAY);
    for (const platform of ["tiktok", "instagram"] as Platform[]) {
      expect(() =>
        assertWarmedSchedulable(warmed({ platform }), later, NOW, entitlements()),
      ).not.toThrow();
    }
    for (const platform of ["youtube", "reddit", "linkedin"] as Platform[]) {
      expect(() =>
        assertWarmedSchedulable(warmed({ platform }), later, NOW, entitlements()),
      ).toThrow(DomainError);
    }
  });

  it("una cuenta pendiente de aprobación da el copy literal del PRD", () => {
    try {
      assertWarmedSchedulable(
        warmed({ status: "pending_approval" }),
        new Date(NOW.getTime() + 5 * DAY),
        NOW,
        entitlements(),
      );
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).message).toBe(
        "This warmed account is awaiting your approval. Approve the account, then reschedule this post.",
      );
    }
  });

  it("sin el entitlement de warmed posting no se programa", () => {
    expect(() =>
      assertWarmedSchedulable(
        warmed(),
        new Date(NOW.getTime() + 5 * DAY),
        NOW,
        entitlements({ warmedPosting: false }),
      ),
    ).toThrow(DomainError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Captions
// ───────────────────────────────────────────────────────────────────────────

describe("la generación de captions rellena SÓLO lo vacío (FR-060, AI-006)", () => {
  it("un valor escrito por el usuario SIEMPRE gana", () => {
    const out = planCaptionGeneration(
      target({ platform: "instagram", caption: "Mi caption a mano" }),
      entitlements(),
    );
    expect(out.fieldsToGenerate).toEqual([]);
  });

  it("un campo vacío o en blanco sí se genera", () => {
    expect(
      planCaptionGeneration(target({ platform: "instagram" }), entitlements())
        .fieldsToGenerate,
    ).toEqual(["caption"]);
    expect(
      planCaptionGeneration(
        target({ platform: "instagram", caption: "   " }),
        entitlements(),
      ).fieldsToGenerate,
    ).toEqual(["caption"]);
  });

  it("TikTok tiene dos campos: title y description", () => {
    const out = planCaptionGeneration(target({ platform: "tiktok" }), entitlements());
    expect(out.fieldsToGenerate).toEqual(["caption", "description"]);
  });

  it("con el title escrito sólo se genera la description", () => {
    const out = planCaptionGeneration(
      target({ platform: "tiktok", caption: "Mi título" }),
      entitlements(),
    );
    expect(out.fieldsToGenerate).toEqual(["description"]);
  });

  it("reddit no lo soporta", () => {
    expect(() =>
      planCaptionGeneration(target({ platform: "reddit" }), entitlements()),
    ).toThrow(DomainError);
  });

  it("sin el entitlement autoCaptions, payment_required", () => {
    try {
      planCaptionGeneration(
        target({ platform: "instagram" }),
        entitlements({ autoCaptions: false }),
      );
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe("payment_required");
    }
  });
});

describe("topes de caracteres — sólo los que el PRD confirma", () => {
  it("Instagram: 2 200; TikTok: 90 de título y 4 000 de descripción", () => {
    expect(PLATFORM_FIELD_LIMITS.instagram.caption).toBe(2200);
    expect(PLATFORM_FIELD_LIMITS.tiktok.caption).toBe(90);
    expect(PLATFORM_FIELD_LIMITS.tiktok.description).toBe(4000);

    expect(() =>
      assertValidCopy(target({ platform: "instagram", caption: "a".repeat(2200) })),
    ).not.toThrow();
    expect(() =>
      assertValidCopy(target({ platform: "instagram", caption: "a".repeat(2201) })),
    ).toThrow(DomainError);
    expect(() =>
      assertValidCopy(target({ platform: "tiktok", caption: "a".repeat(91) })),
    ).toThrow(DomainError);
  });

  it("YouTube 100/5 000 y LinkedIn 3 000: los de la doc citada en schedule-post.ts", () => {
    expect(PLATFORM_FIELD_LIMITS.youtube).toEqual({ caption: 100, description: 5000 });
    expect(PLATFORM_FIELD_LIMITS.linkedin).toEqual({ caption: 3000, description: null });
    // Reddit sigue sin número: sin verificar, NO sin límite.
    expect(PLATFORM_FIELD_LIMITS.reddit.caption).toBeNull();
  });

  it("X 280, Threads 500 y Facebook 2 200: los de sus adaptadores", () => {
    expect(PLATFORM_FIELD_LIMITS.x.caption).toBe(280);
    expect(PLATFORM_FIELD_LIMITS.threads.caption).toBe(500);
    expect(PLATFORM_FIELD_LIMITS.facebook.caption).toBe(2200);
    for (const [platform, max] of [
      ["x", 280],
      ["threads", 500],
      ["facebook", 2200],
    ] as const) {
      expect(() =>
        assertValidCopy(target({ platform, caption: "a".repeat(max) })),
      ).not.toThrow();
      expect(() =>
        assertValidCopy(target({ platform, caption: "a".repeat(max + 1) })),
      ).toThrow(DomainError);
    }
  });

  it("cuenta por code point, como el pre-flight del publicador", () => {
    // 280 emojis son 560 unidades UTF-16 y 280 code points.
    expect(() =>
      assertValidCopy(target({ platform: "x", caption: "😀".repeat(280) })),
    ).not.toThrow();
    expect(() =>
      assertValidCopy(target({ platform: "x", caption: "😀".repeat(281) })),
    ).toThrow(DomainError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fan-out
// ───────────────────────────────────────────────────────────────────────────

describe("un Post por (contenido × plataforma × cuenta) (FR-060, criterio 1)", () => {
  const accounts = new Map<Platform, { kind: "connection" | "warmed"; id: string }>([
    ["instagram", { kind: "connection", id: "cx_1" }],
    ["tiktok", { kind: "connection", id: "cx_3" }],
    ["youtube", { kind: "connection", id: "cx_5" }],
  ]);

  it("tres plataformas producen tres posts independientes", () => {
    const posts = planPostFanOut({
      contentId: "cnt_1",
      contentStatus: "CREATED",
      targets: [
        target({ platform: "instagram", caption: "ig" }),
        target({ platform: "tiktok", caption: "tt" }),
        target({ platform: "youtube", caption: "yt" }),
      ],
      resolvedAccounts: accounts,
      scheduledFor: new Date(NOW.getTime() + DAY),
    });
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => p.platform)).toEqual(["instagram", "tiktok", "youtube"]);
    expect(posts.every((p) => p.status === "SCHEDULED")).toBe(true);
    // Cada uno lleva su propia copy.
    expect(posts.map((p) => p.caption)).toEqual(["ig", "tt", "yt"]);
  });

  it("si la pieza todavía construye, el post nace en BUILDING y espera", () => {
    const posts = planPostFanOut({
      contentId: "cnt_1",
      contentStatus: "BUILDING",
      targets: [target({ platform: "instagram" })],
      resolvedAccounts: accounts,
      scheduledFor: new Date(NOW.getTime() + DAY),
    });
    expect(posts[0]?.status).toBe("BUILDING");
  });

  it("una pieza FAILED no se programa", () => {
    expect(() =>
      planPostFanOut({
        contentId: "cnt_1",
        contentStatus: "FAILED",
        targets: [target({ platform: "instagram" })],
        resolvedAccounts: accounts,
        scheduledFor: NOW,
      }),
    ).toThrow(DomainError);
  });

  it("sin plataformas no hay nada que programar", () => {
    expect(() =>
      planPostFanOut({
        contentId: "cnt_1",
        contentStatus: "CREATED",
        targets: [],
        resolvedAccounts: accounts,
        scheduledFor: NOW,
      }),
    ).toThrow(DomainError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Reprogramar y cancelar
// ───────────────────────────────────────────────────────────────────────────

const post = (over: Partial<ExistingPost> = {}): ExistingPost => ({
  id: "post_1",
  status: "SCHEDULED",
  scheduledFor: new Date(NOW.getTime() + 3 * DAY),
  isWarmed: false,
  ...over,
});

describe("el carril lento de TikTok bloquea la reprogramación (criterio 5)", () => {
  it("con tiktokProcessingDelayed no se reprograma: crearía un duplicado", () => {
    // TikTok suele publicar solo en 24–48 h. Reprogramar publica dos veces, y
    // borrar un duplicado ya publicado no siempre se puede.
    expect(() =>
      assertCanReschedule(
        post({ status: "UPLOADING_TO_TIKTOK", tiktokProcessingDelayed: true }),
      ),
    ).toThrow(DomainError);
  });

  it("Fastlane reintenta hasta 72 h antes de darlo por fallido", () => {
    expect(TIKTOK_SLOW_LANE_MAX_HOURS).toBe(72);
  });

  it("una cancelación en curso no se reintenta: se resuelve sola", () => {
    expect(() => assertCanReschedule(post({ cancellationPending: true }))).toThrow(
      DomainError,
    );
  });

  it("un post ya publicado no se reprograma", () => {
    expect(() => assertCanReschedule(post({ status: "POSTED" }))).toThrow(DomainError);
  });

  it("un SCHEDULED normal sí", () => {
    expect(() => assertCanReschedule(post())).not.toThrow();
  });
});

describe("cancelación (FR-060)", () => {
  it("un post warmed del mismo día ya no se cancela", () => {
    const today = new Date(NOW.getTime() + 6 * HOUR);
    try {
      assertCanCancel(post({ isWarmed: true, scheduledFor: today }), NOW);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).message).toBe(
        "Posts scheduled for today are handed off quickly and can't be cancelled once they're being posted.",
      );
    }
  });

  it("uno warmed de mañana sí", () => {
    const tomorrow = new Date(NOW.getTime() + DAY);
    expect(() =>
      assertCanCancel(post({ isWarmed: true, scheduledFor: tomorrow }), NOW),
    ).not.toThrow();
  });

  it("uno ya entregado a TikTok no se cancela", () => {
    expect(() => assertCanCancel(post({ status: "UPLOADING_TO_TIKTOK" }), NOW)).toThrow(
      DomainError,
    );
    expect(() => assertCanCancel(post({ status: "IN_USER_INBOX" }), NOW)).toThrow(
      DomainError,
    );
  });
});

describe("IN_USER_INBOX NO es un error (criterio 4)", () => {
  it("es una acción pendiente del usuario, igual que AWAITING_RECONNECT", () => {
    expect(isAwaitingUserAction("IN_USER_INBOX")).toBe(true);
    expect(isAwaitingUserAction("AWAITING_RECONNECT")).toBe(true);
    expect(isAwaitingUserAction("FAILED")).toBe(false);
    expect(isAwaitingUserAction("POSTED")).toBe(false);
  });
});
