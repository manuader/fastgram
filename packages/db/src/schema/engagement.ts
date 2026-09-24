/**
 * Engagement (Reddit) — `FR-140`, `P4-ENGAGE-001…012`. Migración
 * `0021_engagement.sql`, donde está el porqué de cada restricción.
 *
 * Tres tablas que el modelo de datos del PRD no tiene (DATA-024/025 cubren
 * el lead y el medidor, no la configuración, la cuenta ni cada respuesta):
 *
 * - `engagement_settings` — subreddits, palabras clave y reglas de respuesta
 *   por marca (`F-192`, `F-196`).
 * - `reddit_accounts` — la cuenta de Reddit conectada por marca, tokens
 *   **cifrados** (`NFR-007`). Una por marca. No va en `connections`: Reddit
 *   no es una red de publicación (ver `core/connections/reddit.ts`).
 * - `engagement_replies` — cada respuesta enviada (por API o marcada a mano)
 *   con su etiqueta de tono `JV-5` y las respuestas crudas del juicio. Es la
 *   entrada del ban meter: el ratio se cuenta **acá**, en código.
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createdAtOnly, timestamps, tsColumn } from "./_shared.js";
import { leads } from "./discovery.js";
import { companies, companyRef } from "./identity.js";

export const engagementSettings = pgTable(
  "engagement_settings",
  {
    companyId: uuid()
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    subreddits: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    keywords: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    replyTone: text().notNull().default("casual"),
    customRules: text().notNull().default(""),
    allowLinks: boolean().notNull().default(false),
    discoveryEnabled: boolean().notNull().default(true),
    lastDiscoveryAt: tsColumn(),
    lastDiscoveryOutcome: text(),
    discoveryPausedUntil: tsColumn(),
    ...timestamps(),
  },
  (t) => [
    check(
      "engagement_settings_tone_check",
      sql`${t.replyTone} in ('casual', 'professional', 'friendly_expert')`,
    ),
  ],
);

export const redditAccounts = pgTable(
  "reddit_accounts",
  {
    companyId: uuid()
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    redditUserId: text().notNull(),
    username: text().notNull(),
    /** Ciphertext (`TokenCipher`). Nunca en claro. */
    accessToken: text(),
    /** Ciphertext. */
    refreshToken: text(),
    tokenExpiry: tsColumn(),
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text().notNull().default("active"),
    statusReason: text(),
    ...timestamps(),
  },
  (t) => [
    check(
      "reddit_accounts_status_check",
      sql`${t.status} in ('active', 'expired', 'revoked')`,
    ),
  ],
);

export const engagementReplies = pgTable(
  "engagement_replies",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: companyRef(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    text: text().notNull(),
    channel: text().notNull(),
    redditCommentName: text(),
    permalink: text(),
    sentAt: tsColumn().notNull(),
    tone: text(),
    toneAnswers: jsonb().$type<Record<string, unknown>>(),
    toneVersion: text(),
    classifiedAt: tsColumn(),
    ...createdAtOnly(),
  },
  (t) => [
    index("engagement_replies_company_sent_idx").on(t.companyId, t.sentAt),
    index("engagement_replies_lead_idx").on(t.companyId, t.leadId),
    check("engagement_replies_channel_check", sql`${t.channel} in ('api', 'manual')`),
    check(
      "engagement_replies_tone_check",
      sql`${t.tone} is null or ${t.tone} in ('value_add', 'subtle_mention', 'direct_promo')`,
    ),
  ],
);
