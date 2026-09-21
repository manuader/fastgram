/**
 * Sesión del usuario en la shell.
 *
 * **Esto es una costura, no la autenticación.** El PRD §3.1 pone Clerk detrás
 * de `/login`, `/signup` y `/auth/sso-callback`, y eso es una tarea de P1-AUTH,
 * no de la shell. Lo que hace falta hoy es que las guards de `P1-UI-004` sean
 * reales y testeables: para eso alcanza con un tipo de sesión y una forma de
 * leerla.
 *
 * Cuando entre el proveedor de verdad, sólo cambia `readSession()`. Ni las
 * guards ni una sola pantalla se enteran.
 */
import { z } from "zod";

/**
 * Nombre de la cookie. Es de la shell, no de Clerk: cuando Clerk entre, este
 * módulo lee su sesión y esta cookie desaparece.
 */
export const SESSION_COOKIE = "fg_session";

export const sessionSchema = z.object({
  userId: z.string().min(1),
  /** `null` mientras el usuario no ha elegido workspace → guard `ERR-U04`. */
  companyId: z.string().min(1).nullable(),
  /** FR-010: hasta que el onboarding no cierra, la app entera redirige allí. */
  onboardingComplete: z.boolean(),
  /** PRD:329 — `Admin` sólo para staff. Sin esto, la entrada no se pinta. */
  isStaff: z.boolean().default(false),
});
export type Session = z.infer<typeof sessionSchema>;

/**
 * Sesión de desarrollo.
 *
 * Sin ella, y mientras P1-AUTH no exista, `pnpm dev` no muestra ni una
 * pantalla: todo redirige a un `/login` que todavía no tiene proveedor. Con
 * ella, la shell se puede abrir y mirar — que es exactamente lo que le falta a
 * este trabajo.
 *
 * **Nunca en producción.** `readSession` la ignora si `NODE_ENV === "production"`.
 */
export const DEV_SESSION: Session = {
  userId: "dev-user",
  companyId: "dev-company",
  onboardingComplete: true,
  isStaff: false,
};

/**
 * Decodifica el valor de la cookie. Devuelve `null` ante cualquier cosa que no
 * sea una sesión válida: una cookie corrupta es "no hay sesión", no un 500.
 */
export function parseSessionCookie(raw: string | undefined): Session | null {
  if (raw === undefined || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    const result = sessionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** ¿Vale el fallback de desarrollo? Fuera de producción, sí. */
export function devSessionAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}
