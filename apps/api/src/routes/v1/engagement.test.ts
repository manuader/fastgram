/**
 * `contracts` es standalone y duplica los enums de `core` (ver la cabecera de
 * `resources/engagement.ts`). Si `core` agrega un valor y el contrato no, la
 * API respondería algo que el contrato rechaza: este test lo corta antes.
 */
import { describe, expect, it } from "vitest";
import {
  banRiskLevelSchema,
  leadTierSchema,
  replyIssueSchema,
  replyToneSchema,
  replyToneStyleSchema,
  threadStateSchema,
  LEAD_VIEWS as CONTRACT_VIEWS,
} from "@fastgram/contracts";
import {
  BAN_RISK_LEVELS,
  LEAD_TIERS,
  REPLY_ISSUES,
  REPLY_TONES,
  REPLY_TONE_STYLES,
  THREAD_STATES,
} from "@fastgram/core";
import { LEAD_VIEWS as DB_VIEWS } from "@fastgram/db";

describe("engagement: contratos y core dicen lo mismo", () => {
  it("enums", () => {
    expect(banRiskLevelSchema.options).toEqual([...BAN_RISK_LEVELS]);
    expect(leadTierSchema.options).toEqual([...LEAD_TIERS]);
    expect(replyIssueSchema.options).toEqual([...REPLY_ISSUES]);
    expect(replyToneSchema.options).toEqual([...REPLY_TONES]);
    expect(replyToneStyleSchema.options).toEqual([...REPLY_TONE_STYLES]);
    expect(threadStateSchema.options).toEqual([...THREAD_STATES]);
    expect([...CONTRACT_VIEWS]).toEqual([...DB_VIEWS]);
  });
});
