import type { ReactNode } from "react";

/**
 * Layout de las pantallas **sin** shell: login, signup, logout, callbacks de
 * OAuth y SSO, onboarding, retorno de checkout de partner y `/status`.
 *
 * El grupo `(public)` no cambia ninguna URL —`/login` sigue siendo `/login`—;
 * lo que hace es separar dos cosas que se parecen y no son iguales. "Público"
 * aquí quiere decir *sin sidebar*, no *sin sesión*: `/onboarding` exige sesión
 * y aun así no lleva menú, porque un wizard de alta con la app entera al lado
 * invita a saltárselo. Quién exige sesión lo decide `lib/auth/route-policy.ts`,
 * que es otra pregunta y vive en otro sitio.
 *
 * El `<main id="main">` está aquí y no en cada página: es el destino del enlace
 * "Skip to content" del root layout, y si faltara en una sola pantalla ese
 * enlace no haría nada justo ahí.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="fgw-public">
      {children}
    </main>
  );
}
