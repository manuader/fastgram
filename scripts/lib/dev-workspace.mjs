/**
 * Workspace de desarrollo y su API key — la lógica, sin imprimir nada.
 *
 * La usan dos entradas:
 *  - `scripts/dev-workspace.mjs` (`pnpm dev:workspace`), que imprime la key UNA
 *    vez para pegarla a mano;
 *  - `scripts/start.mjs` (PU-RUN-003), que se la pasa a la web **por el entorno
 *    del proceso hijo** y nunca la imprime ni la escribe.
 *
 * Por eso esto **devuelve** el token en vez de imprimirlo: quien llama decide
 * qué se hace con un secreto, y el default seguro es no hacer nada visible.
 *
 * Qué hace, idempotente salvo la key:
 *  - usuario y workspace de desarrollo con ids fijos (se reutilizan si existen);
 *  - plan **`pro`**: §16.1, «Unlimited content saves». Con `free` el trial no
 *    tiene número (PRD §16.1 «Limited content») y aceptar en Blitz o crear
 *    contenido responde 503;
 *  - `status: active` y perfil de marca `ready`, para que Blitz no responda
 *    `company_profile_not_ready`;
 *  - revoca las keys de desarrollo anteriores y emite una nueva. **Ojo:** cada
 *    `pnpm start` revoca la key que un `pnpm dev:workspace` anterior imprimió.
 */
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * Zona horaria de la máquina (uso personal): la marca de desarrollo y las que
 * se creen a partir de ella nacen en la hora local, no en UTC. Sólo en el
 * INSERT: si ya existe, se respeta lo que el usuario haya puesto en Strategy.
 */
const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export const DEFAULT_DATABASE_URL =
  "postgres://fastgram:fastgram@localhost:5432/fastgram";
export const DEV_USER_ID = "0de70000-0000-4000-8000-000000000001";
export const DEV_COMPANY_ID = "0de70000-0000-4000-8000-000000000002";
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

/**
 * Asegura el workspace de desarrollo y emite una key nueva.
 *
 * @param {{ databaseUrl?: string }} [options]
 * @returns {Promise<{ companyId: string, token: string }>}
 */
export async function issueDevWorkspaceKey({ databaseUrl = DEFAULT_DATABASE_URL } = {}) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into users (id, external_identity_id, email, full_name, timezone)
        values (${DEV_USER_ID}, ${"dev_" + DEV_USER_ID}, 'dev@fastgram.local', 'Dev', ${LOCAL_TZ})
        on conflict (id) do nothing`;
      await tx`
        insert into companies (id, name, owner_user_id, plan_id, billing_anchor_day,
                               timezone, status, subscription_status)
        values (${DEV_COMPANY_ID}, 'Mi workspace', ${DEV_USER_ID}, 'pro', 1, ${LOCAL_TZ}, 'active', 'active')
        on conflict (id) do update
          set plan_id = 'pro', status = 'active', subscription_status = 'active'`;
      await tx`
        insert into workspace_memberships (company_id, user_id, role, status)
        select ${DEV_COMPANY_ID}, ${DEV_USER_ID}, 'owner', 'active'
        where not exists (select 1 from workspace_memberships
                           where company_id = ${DEV_COMPANY_ID} and user_id = ${DEV_USER_ID})`;
      await tx`
        insert into company_profiles (company_id, status)
        values (${DEV_COMPANY_ID}, 'ready')
        on conflict (company_id) do update set status = 'ready'`;
      await tx`
        update api_keys set revoked_at = now()
         where company_id = ${DEV_COMPANY_ID} and label = ${KEY_LABEL} and revoked_at is null`;
    });

    const token = newToken();
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    await sql`
      insert into api_keys (company_id, label, hash, kind)
      values (${DEV_COMPANY_ID}, ${KEY_LABEL}, ${hash}, 'workspace')`;
    return { companyId: DEV_COMPANY_ID, token };
  } finally {
    await sql.end();
  }
}
