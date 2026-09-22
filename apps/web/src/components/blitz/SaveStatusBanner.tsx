"use client";

import { Spinner } from "@fastgram/ui";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import { presentError } from "@/lib/api/error-presentation";
import type { AutosaveStatus } from "@/lib/blitz/autosave";

/**
 * Lo que la pantalla puede estar diciendo, que es **más** que lo que sabe el
 * planificador: `blocked` es "hay un conjunto sucio que todavía no cumple su
 * regla de suma, así que no se está mandando". Para el planificador eso es un
 * guardado sin nada que mandar; para el usuario es un cambio sin guardar.
 */
export type BannerStatus = AutosaveStatus | "blocked";

export interface SaveStatusBannerProps {
  readonly status: BannerStatus;
  readonly error: unknown;
  /** Qué conjunto está bloqueado, ya traducido. */
  readonly blockedLabel?: string | undefined;
  readonly onRetry: () => void;
}

/**
 * El banner de auto-guardado de FR-055 (PRD:1265) — `✓ All changes saved`.
 *
 * ## Lo único que este componente tiene que hacer bien
 *
 * **No mentir.** `All changes saved` es una frase sobre la que el usuario toma
 * una decisión irreversible: cierra la pestaña. Enseñarla con una petición en
 * vuelo, o después de una que falló, o con un conjunto que no se está mandando,
 * es peor que no enseñar nada — porque sin banner el usuario duda y con un
 * banner que miente, no.
 *
 * Por eso el `saved` es el **único** camino que produce esa frase, y los otros
 * cuatro estados tienen copy propio. El estado lo decide
 * `useAutosave` salvo por `blocked`, que la pantalla añade encima.
 *
 * El fallo se dibuja con `ApiErrorState` y no con un texto propio: ese
 * componente ya decide la salida por el código del error (§19.8), así que un
 * `429` ofrece reintentar y un `402` no ofrece un botón que no sirve. Además
 * pone `role="alert"`, que es lo que hace que el fallo se anuncie sin que el
 * usuario mire el banner.
 */
export function SaveStatusBanner({
  status,
  error,
  blockedLabel,
  onRetry,
}: SaveStatusBannerProps) {
  if (status === "error") {
    const { remedy } = presentError(error);
    return (
      <div className="fgw-autosave fgw-autosave--error" data-status="error">
        <ApiErrorState
          error={error}
          // El reintento se ofrece sólo cuando la salida es reintentar: un
          // `400` reintentado da otro `400`, y ese botón enseñaría al usuario
          // que el producto no funciona.
          {...(remedy === "retry" ? { onRetry } : {})}
        />
        <p className="fgw-autosave__hint">{tw("prefs.saveFailedHint")}</p>
      </div>
    );
  }

  if (status === "blocked") {
    return (
      <p className="fgw-autosave" data-status="blocked" role="status">
        <span className="fgw-autosave__label">
          {tw("prefs.blocked", { group: blockedLabel ?? "" })}
        </span>
      </p>
    );
  }

  if (status === "saving") {
    return (
      <p className="fgw-autosave" data-status="saving" role="status">
        <Spinner size="sm" aria-hidden />
        <span className="fgw-autosave__label">{tw("prefs.saving")}</span>
      </p>
    );
  }

  if (status === "pending") {
    return (
      // No hay botón de `Save now`, y es deliberado: adelantar el guardado no
      // puede saltarse el piso de cadencia sin comerse el 429, así que un botón
      // que a veces no hace nada durante veinte segundos enseña desconfianza.
      // Lo que el usuario necesita saber es que hay algo sin guardar.
      <p className="fgw-autosave" data-status="pending" role="status">
        <span className="fgw-autosave__label">{tw("prefs.pending")}</span>
        <span className="fgw-autosave__hint">{tw("prefs.pendingHint")}</span>
      </p>
    );
  }

  return (
    <p className="fgw-autosave" data-status="saved" role="status">
      <span aria-hidden="true">✓</span>
      <span className="fgw-autosave__label">{tw("prefs.saved")}</span>
    </p>
  );
}
