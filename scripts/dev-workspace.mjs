/**
 * Workspace de desarrollo para usar la app en local, sin auth ni suscripciones.
 *
 * Decisión del dueño (2026-09-23): las suscripciones y la auth multiusuario
 * quedan para más adelante (rama `auth-y-suscripciones`). Hasta entonces la web
 * habla con la API con **una** API key de servidor (`FASTGRAM_API_KEY`), y este
 * script es lo que la produce. La lógica vive en `lib/dev-workspace.mjs`, que
 * también usa `pnpm start` (que no necesita esto: le pasa la key a la web solo).
 *
 * La key se imprime **una sola vez** por stdout y no se escribe en ningún
 * archivo (CLAUDE.md: nunca un secreto en el repo). Copiala a tu entorno.
 *
 * Uso: `pnpm dev:workspace` (con `docker compose up -d` y `pnpm db:migrate`).
 */
import { DEFAULT_DATABASE_URL, issueDevWorkspaceKey } from "./lib/dev-workspace.mjs";

const { companyId, token } = await issueDevWorkspaceKey({
  databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
});

process.stdout.write(
  [
    "",
    `Workspace de desarrollo listo: ${companyId} (plan pro, perfil ready).`,
    "API key nueva (se muestra UNA vez; las anteriores de desarrollo quedaron revocadas):",
    "",
    `  FASTGRAM_API_KEY=${token}`,
    "",
    "Exportala en el entorno de apps/web (no la guardes en el repo).",
    "",
  ].join("\n"),
);
