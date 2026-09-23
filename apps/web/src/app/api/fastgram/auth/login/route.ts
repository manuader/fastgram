/**
 * Entrar · F-002 · PRD §15.2. La lógica, y lo que este handler garantiza, está en
 * `lib/auth/bff.ts`.
 */
import { handleLogin } from "@/lib/auth/bff";

/** Node: lee `process.env` en ejecución y habla con `apps/api` por `fetch`. */
export const runtime = "nodejs";

/** Nunca cacheado: cada respuesta pone o borra la cookie de sesión. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleLogin(request);
}
