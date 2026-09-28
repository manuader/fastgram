/**
 * Las migraciones aplican limpio sobre una base vacía.
 *
 * Suena obvio hasta que no lo es: una migración custom escrita a mano (`0002`) no la
 * valida drizzle-kit, y un typo en un `CREATE POLICY` recién se ve cuando alguien
 * despliega. Este test es el que lo ve antes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/migrate";
import {
  COMPANY_SCOPED_TABLES,
  NON_TENANT_TABLES,
  TENANT_ROOT_TABLE,
} from "../src/schema/index";
import { startTestDatabase, type TestDatabase } from "./helpers/postgres";
import { sql } from "drizzle-orm";
import { getTableName } from "drizzle-orm";

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await startTestDatabase();
});

afterAll(async () => {
  await ctx?.stop();
});

describe("migraciones", () => {
  it("crean las 61 tablas del modelo de datos (33 + blitz_prompt_requests, 0012 + brand_strategies y planned_slots, 0014 + autopilot_decisions y autopilot_runs, 0017 + content_mix_autotune y format_mix_adjustments, 0018 + influencer_generations, 0020 + engagement_settings, reddit_accounts y engagement_replies, 0021 + brand_audio_tracks, 0025 + notifications, 0028 + own_post_imports, 0029 + character_models, 0033 + sprint 9: brand_design_systems 0035, library_assets 0036, asset_decisions 0037, preference_signals, preference_weights y owner_preferences 0039, ad_accounts, ad_campaigns, ad_sets, ads, ad_experiments, ad_insights_daily y ad_actions 0040)", async () => {
    const rows = await ctx.db.execute<{ table_name: string }>(sql`
      select table_name
        from information_schema.tables
       where table_schema = 'public'
         and table_type = 'BASE TABLE'
         and table_name <> '__drizzle_migrations'
    `);
    const present = new Set(rows.map((r) => r.table_name));

    const expected = [
      ...COMPANY_SCOPED_TABLES.map((t) => getTableName(t)),
      getTableName(TENANT_ROOT_TABLE),
      ...NON_TENANT_TABLES.map((t) => t.table),
    ];

    for (const name of expected) {
      expect(present.has(name), `falta la tabla ${name}`).toBe(true);
    }
    expect(expected).toHaveLength(61);
    expect(present.size).toBe(61);
  });

  it("son idempotentes: volver a correrlas no hace nada", async () => {
    // El migrador de drizzle salta lo ya aplicado leyendo `__drizzle_migrations`.
    // Si una migración custom se hubiera escrito sin `IF NOT EXISTS` y el journal se
    // desincronizara, esto reventaría — que es exactamente lo que se quiere detectar.
    await expect(applyMigrations(ctx.db)).resolves.toBeUndefined();
  });

  it("habilitan pgvector (P1-DATA-013 · lo necesita FR-150 en P3)", async () => {
    const rows = await ctx.db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("crean el esquema y la función `app.current_company()`", async () => {
    const rows = await ctx.db.execute<{ proname: string }>(sql`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'current_company'
    `);
    expect(rows).toHaveLength(1);
  });

  it("crean el rol de aplicación, y NO es superusuario", async () => {
    // Un superusuario saltea RLS. Si este rol lo fuera, todas las políticas serían
    // decorativas y ningún otro test lo notaría.
    const rows = await ctx.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(sql`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'fastgram_app'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });
});

describe("índices de multi-tenancy", () => {
  it("toda tabla de cliente tiene un índice que arranca por company_id (IMPL §5.6)", async () => {
    const rows = await ctx.db.execute<{ tablename: string; indexdef: string }>(sql`
      select tablename, indexdef from pg_indexes where schemaname = 'public'
    `);

    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      const list = byTable.get(row.tablename) ?? [];
      list.push(row.indexdef);
      byTable.set(row.tablename, list);
    }

    for (const table of COMPANY_SCOPED_TABLES) {
      const name = getTableName(table);
      const defs = byTable.get(name) ?? [];
      const hasCompanyFirst = defs.some((def) =>
        /\(\s*company_id\b/.test(def.slice(def.indexOf("USING"))),
      );
      expect(
        hasCompanyFirst,
        `${name} no tiene ningún índice que empiece por company_id`,
      ).toBe(true);
    }
  });
});
