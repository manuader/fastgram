import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { readSession } from "@/lib/auth/server-session";
import { ROUTES } from "@/lib/nav/routes";

/**
 * Layout de todo lo que va **dentro** de la shell.
 *
 * El grupo `(app)` no añade un segmento a la URL: `/home` sigue siendo `/home`.
 * Lo que añade es esta frontera — quién lleva sidebar y quién no. `/login`,
 * `/onboarding` y `/status` viven fuera a propósito: un wizard de alta con el
 * menú de la app al lado invita a saltárselo, y una página de estado detrás de
 * una sesión no sirve el día que el login es lo que está caído.
 *
 * El `redirect` de aquí **no** es la guard —esa vive en el middleware— sino la
 * consecuencia de necesitar `session.isStaff` para decidir si la entrada
 * `Admin` existe. Sin sesión no hay shell que dibujar.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await readSession();
  if (session === null) redirect(ROUTES.login);

  return <AppShell isStaff={session.isStaff}>{children}</AppShell>;
}
