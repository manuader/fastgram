import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/server-session";
import { resolveGuard } from "@/lib/auth/route-policy";
import { ROUTES } from "@/lib/nav/routes";

/**
 * `/` · PRD:216 — "redirect a /home (autenticado) o /login".
 *
 * En la práctica el middleware ya lo resuelve antes de llegar aquí. Esta página
 * existe igual por dos razones: que la ruta exista en el árbol del App Router
 * (si no, un `/` que esquivara el middleware sería un 404), y que la decisión
 * salga de la **misma** función pura, no de un `redirect("/home")` a mano que
 * mañana discrepe.
 */
export default async function RootPage() {
  const session = await readSession();
  const decision = resolveGuard({ pathname: ROUTES.root, session });
  redirect(decision === null ? ROUTES.home : decision.redirectTo);
}
