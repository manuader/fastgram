import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingEntry } from "@/components/onboarding/OnboardingEntry";
import { readSessionState } from "@/lib/auth/server-session";
import { resolveNavigation } from "@/lib/auth/route-policy";
import { ROUTES } from "@/lib/nav/routes";

export const metadata: Metadata = { title: "Onboarding · FastGram" };

/**
 * `/onboarding` · FR-010, FR-011 (EXTENSION), §15.4. Server component fino:
 * todo lo que habla con la API de negocio es cliente (`apps/web` no hace fetch
 * de negocio desde el servidor).
 *
 * Lo único que se lee acá es **si la sesión tiene workspace**, y se lee del
 * servidor porque es el único que puede: `GET /auth/session` no pasa por el
 * proxy (regla 3) y el cliente no tiene otra forma de saberlo — un `403` de
 * `GET /onboarding` también lo daría una membresía suspendida. Es la misma
 * verificación que ya hizo el middleware en esta navegación (una llamada más
 * a la API por carga de `/onboarding`; el middleware no comparte su `cache()`
 * con el render).
 *
 * Pasos construidos: crear el workspace (`P1-TENANT-001`), 1 (`P1-ONB-002`) y 4
 * (`P1-ONB-005`). El wizard es `P1-ONB-001`.
 */
export default async function OnboardingPage() {
  const state = await readSessionState();
  if (state.kind !== "authenticated") {
    // El middleware ya lo habría redirigido; esto cubre que la sesión cambie
    // entre su verificación y la de este render. Misma regla, mismo destino.
    const decision = resolveNavigation(ROUTES.onboarding, state);
    redirect(decision.redirectTo ?? ROUTES.login);
  }
  return <OnboardingEntry hasWorkspace={state.session.companyId !== null} />;
}
