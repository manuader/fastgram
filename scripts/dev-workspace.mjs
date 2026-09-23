/**
 * Workspace de desarrollo para usar la app en local, sin auth ni suscripciones.
 *
 * Decisión del dueño (2026-09-23): las suscripciones y la auth multiusuario
 * quedan para más adelante (rama `auth-y-suscripciones`). Hasta entonces la web
 * habla con la API con **una** API key de servidor (`FASTGRAM_API_KEY`), y este
 * script es lo que la produce.
 *
 * Qué hace, idempotente salvo la key:
 *  - usuario y workspace de desarrollo con ids fijos (se reutilizan si existen);
 *  - plan **`pro`**: §16.1, «Unlimited content saves». Con `free` el trial no
 *    tiene número (PRD §16.1 «Limited content») y aceptar en Blitz o crear
 *    contenido responde 503 — justo lo que la decisión dice que no importa hoy;
 *  - `status: active` y perfil de marca `ready`, para que Blitz no responda
 *    `company_profile_not_ready`;
 *  - revoca las keys de desarrollo anteriores y emite una nueva.
 *
 * La key se imprime **una sola vez** por stdout y no se escribe en ningún
 * archivo (CLAUDE.md: nunca un secreto en el repo). Copiala a tu entorno.
 *
 * Uso: `pnpm dev:workspace` (con `docker compose up -d` y `pnpm db:migrate`).
 */
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

const USER_ID = "0de70000-0000-4000-8000-000000000001";
const COMPANY_ID = "0de70000-0000-4000-8000-000000000002";
const KEY_LABEL = "dev-local";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** `fsln_live_` + 32 base62, el formato que valida `apps/api/src/auth/api-keys.ts`. */
function newToken() {
  const bytes = randomBytes(64);
  let out = "";
  for (const b of bytes) {
    if (b >= 248) continue; // 248 = 62 * 4: descarta el sesgo del módulo
    out += BASE62[b % 62];
    if (out.length === 32) break;
  }
  if (out.length < 32) return newToken();
  return `fsln_live_${out}`;
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  await sql.begin(async (tx) => {
    await tx`
      insert into users (id, external_identity_id, email, full_name, timezone)
      values (${USER_ID}, ${"dev_" + USER_ID}, 'dev@fastgram.local', 'Dev', 'UTC')
      on conflict (id) do nothing`;
    await tx`
      insert into companies (id, name, owner_user_id, plan_id, billing_anchor_day,
                             timezone, status, subscription_status)
      values (${COMPANY_ID}, 'Mi workspace', ${USER_ID}, 'pro', 1, 'UTC', 'active', 'active')
      on conflict (id) do update
        set plan_id = 'pro', status = 'active', subscription_status = 'active'`;
    await tx`
      insert into workspace_memberships (company_id, user_id, role, status)
      select ${COMPANY_ID}, ${USER_ID}, 'owner', 'active'
      where not exists (select 1 from workspace_memberships
                         where company_id = ${COMPANY_ID} and user_id = ${USER_ID})`;
    await tx`
      insert into company_profiles (company_id, status)
      values (${COMPANY_ID}, 'ready')
      on conflict (company_id) do update set status = 'ready'`;
    await tx`
      update api_keys set revoked_at = now()
       where company_id = ${COMPANY_ID} and label = ${KEY_LABEL} and revoked_at is null`;
  });

  const token = newToken();
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  await sql`
    insert into api_keys (company_id, label, hash, kind)
    values (${COMPANY_ID}, ${KEY_LABEL}, ${hash}, 'workspace')`;

  process.stdout.write(
    [
      "",
      `Workspace de desarrollo listo: ${COMPANY_ID} (plan pro, perfil ready).`,
      "API key nueva (se muestra UNA vez; las anteriores de desarrollo quedaron revocadas):",
      "",
      `  FASTGRAM_API_KEY=${token}`,
      "",
      "Exportala en el entorno de apps/web (no la guardes en el repo).",
      "",
    ].join("\n"),
  );
} finally {
  await sql.end();
}
