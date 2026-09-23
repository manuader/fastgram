"use client";

import { useState } from "react";
import { OnboardingFlow } from "./OnboardingFlow";
import { WorkspaceStep } from "./WorkspaceStep";

export interface OnboardingEntryProps {
  /**
   * Si la sesión ya resolvía un workspace **cuando se renderizó la página**
   * (`companyId !== null` de `GET /auth/session`, leído en el servidor por
   * `app/(public)/onboarding/page.tsx`).
   */
  readonly hasWorkspace: boolean;
}

/**
 * La puerta de `/onboarding`: sin workspace, primero se crea; con workspace, el
 * flujo de siempre (`OnboardingFlow`, sin cambios).
 *
 * ## Qué quiere decir "refrescar la sesión" tras el `201`, y por qué no es `router.refresh()`
 *
 * Lo único viejo después del alta es **esta prop**: la foto de la sesión que
 * sacó el servidor antes de que el workspace existiera. Por eso se reemplaza
 * por estado local y la pantalla pasa al paso 1 **sin ir al servidor**.
 *
 * · Del lado del servidor **no hay nada que invalidar**. El middleware y
 *   `readSessionState` le preguntan a `GET /auth/session` en cada request (el
 *   `cache()` de React dura un render), y la API resuelve el workspace por
 *   `users.default_workspace_id`, que el alta ya apuntó al nuevo. La próxima
 *   navegación ve el `companyId` sin que nadie haga nada.
 * · Ir al servidor ahora sería **perder el paso 1**. `resolveGuard` deriva
 *   `onboardingComplete` de `companyId !== null` (no hay otro dato en la
 *   sesión) y manda `/onboarding` → `/home` a quien lo tiene. Un
 *   `router.refresh()` o un `location.assign("/onboarding")` pasan por el
 *   middleware y terminan en `/home` con un workspace sin ninguna fuente.
 * · Del lado del cliente no hay caché que limpiar: `GET /onboarding` no se
 *   montó antes del alta (ver `useCreateWorkspace`). El `GET /onboarding` que
 *   dispara el paso 1 es la comprobación: la API lo contesta sólo si la sesión
 *   ya resuelve el workspace, y si no, `OnboardingFlow` muestra el error con su
 *   `Try again`.
 *
 * Consecuencia conocida, **no** de este archivo: recargar `/onboarding` a mitad
 * del paso 1 manda a `/home` (misma regla del guard). Ver el reporte.
 */
export function OnboardingEntry({ hasWorkspace }: OnboardingEntryProps) {
  const [ready, setReady] = useState(hasWorkspace);
  if (ready) return <OnboardingFlow />;
  return (
    <div className="fgw-onb-flow">
      <WorkspaceStep
        onReady={() => {
          setReady(true);
        }}
      />
    </div>
  );
}
