import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  batchFailureReasonSchema,
  blitzQuotaExceededDetailsSchema,
  contentQuotaExceededDetailsSchema,
  errorCodeSchema,
  errorEnvelopeSchema,
  insufficientCreditsDetailsSchema,
  rateLimitedDetailsSchema,
} from "./errors";

describe("sobre de error · PRD:2257 §9.3", () => {
  it("acepta la forma literal de FR-180 (PRD:1863), sin `details`", () => {
    const literal = {
      error: { code: "unauthorized", message: "Invalid or revoked API key" },
    };
    expect(errorEnvelopeSchema.parse(literal)).toEqual(literal);
  });

  it("acepta `details` cuando está", () => {
    const parsed = errorEnvelopeSchema.parse({
      error: {
        code: "rate_limited",
        message: "API rate limit exceeded",
        details: { retryAfterMs: 1000 },
      },
    });
    expect(parsed.error.details).toEqual({ retryAfterMs: 1000 });
  });

  it("rechaza un código que el PRD no nombra → 400 bad_request", () => {
    expect(() => apiErrorSchema.parse({ code: "kaboom", message: "x" })).toThrow();
  });

  it("rechaza un sobre sin `message`", () => {
    expect(() => errorEnvelopeSchema.parse({ error: { code: "not_found" } })).toThrow();
  });
});

describe("códigos de error, literales del PRD", () => {
  it.each([
    ["unauthorized", "FR-180 · PRD:1863"],
    ["not_found", "§9.2 · PRD:2251"],
    ["bad_request", "FR-050 · PRD:1129"],
    ["conflict", "§9.3 · PRD:2288"],
    ["gone", "§9.8 · PRD:2339"],
    ["payment_required", "FR-080 · PRD:1519"],
    ["forbidden", "FR-060 · PRD:1390"],
    ["rate_limited", "ERR-R01 · PRD:3211"],
    ["service_unavailable", "ERR-R06 · PRD:3216"],
    ["blitz_quota_exceeded", "ERR-R02 · PRD:3212"],
    ["content_quota_exceeded", "ERR-R03 · PRD:3213"],
    ["content_still_building", "ERR-P02 · PRD:3184"],
    ["content_edit_in_progress", "ERR-P03 · PRD:3185"],
    ["stale_revision", "ERR-P04 · PRD:3186"],
    ["content_not_editable", "ERR-P05 · PRD:3187"],
    ["content_has_linked_posts", "ERR-P06 · PRD:3188"],
    ["content_unavailable_for_type", "ERR-P07 · PRD:3189"],
    ["company_profile_not_ready", "ERR-P08 · PRD:3190"],
    ["unsupported_content_state", "FR-051 · PRD:1195"],
    ["media_in_use", "§19.10 · PRD:3226"],
    ["connection_ambiguous", "FR-060 · PRD:1390"],
    ["posting_mode_not_supported_for_platform", "FR-060 · PRD:1390"],
    ["privacy_level_required", "FR-060 · PRD:1390"],
    ["invalid_privacy_level", "FR-060 · PRD:1390"],
    ["privacy_level_not_allowed_without_direct_mode", "FR-060 · PRD:1390"],
    ["tiktok_creator_info_unavailable", "FR-060 · PRD:1390"],
    ["tiktok_post_limit_exceeded", "ERR-R05 · PRD:3215"],
    ["youtube_post_limit_exceeded", "ERR-R05 · PRD:3215"],
    ["instagram_post_limit_exceeded", "ERR-R05 · PRD:3215"],
    ["MAX_ANGLES_EXCEEDED", "FR-056 · PRD:1319"],
    ["MAX_ANGLES_PER_INFLUENCER_EXCEEDED", "FR-056 · PRD:1319"],
  ])("%s está en el enum (%s)", (code) => {
    expect(errorCodeSchema.parse(code)).toBe(code);
  });

  it("no hay códigos de más: el enum tiene exactamente los del PRD", () => {
    expect(errorCodeSchema.options).toHaveLength(31);
  });
});

describe("`details` tipados", () => {
  it("ERR-R01 · PRD:3211 — retryAfterMs", () => {
    expect(rateLimitedDetailsSchema.parse({ retryAfterMs: 0 }).retryAfterMs).toBe(0);
  });

  it("ERR-R02 · PRD:3212 — resetAt obligatorio", () => {
    expect(() => blitzQuotaExceededDetailsSchema.parse({})).toThrow();
  });

  it("ERR-R03 · PRD:3213 — count y limit obligatorios; ERR-R04 no lleva resetAt", () => {
    expect(
      contentQuotaExceededDetailsSchema.parse({ count: 30, limit: 30 }).resetAt,
    ).toBeUndefined();
    expect(() => contentQuotaExceededDetailsSchema.parse({ count: 30 })).toThrow();
  });

  it("FR-080 · PRD:1519 — balance y required", () => {
    expect(
      insufficientCreditsDetailsSchema.parse({ balance: 10, required: 250 }),
    ).toEqual({
      balance: 10,
      required: 250,
    });
  });
});

describe("motivos de fallo por id en lote · ERR-F01 · PRD:3200", () => {
  it.each([
    "not_found",
    "invalid_id",
    "past_cutoff",
    "cancellation_pending",
    "provider_operation_in_progress",
    "past_submit_cutoff",
    "task_lookup_truncated",
    "task_running",
  ])("%s es un motivo válido", (reason) => {
    expect(batchFailureReasonSchema.parse(reason)).toBe(reason);
  });

  it("`not_cancellable_status:<status>` lleva el estado pegado", () => {
    expect(batchFailureReasonSchema.parse("not_cancellable_status:POSTED")).toBe(
      "not_cancellable_status:POSTED",
    );
    expect(() => batchFailureReasonSchema.parse("not_cancellable_status:")).toThrow();
  });

  it("rechaza un motivo inventado", () => {
    expect(() => batchFailureReasonSchema.parse("because_i_said_so")).toThrow();
  });
});
