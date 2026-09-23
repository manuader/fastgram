/**
 * Fijar la contraseña nueva con el token del enlace · PRD §15.3. La lógica, y lo que este handler garantiza, está en
 * `lib/auth/bff.ts`.
 */
import { handlePasswordResetComplete } from "@/lib/auth/bff";

/** Node: lee `process.env` en ejecución y habla con `apps/api` por `fetch`. */
export const runtime = "nodejs";

/** Nunca cacheado: cada respuesta pone o borra la cookie de sesión. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handlePasswordResetComplete(request);
}
