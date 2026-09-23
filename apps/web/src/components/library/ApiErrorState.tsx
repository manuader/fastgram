"use client";

import { Button, buttonVariants, ErrorState } from "@fastgram/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  presentError,
  REMEDY_HREF,
  REMEDY_LABEL_KEY,
} from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";

export interface ApiErrorStateProps {
  /** El `ApiRequestError` que devolvió el hook. Cualquier otra cosa cae al genérico. */
  readonly error: unknown;
  /** Volver a pedir. Se usa tanto para `retry` como para `reload`. */
  readonly onRetry?: (() => void) | undefined;
  readonly className?: string | undefined;
}

/**
 * Un error del API, con **la salida que le corresponde** (PRD §19).
 *
 * Toda la decisión está en `lib/api/error-presentation.ts`; acá sólo se dibuja.
 * Lo que este componente garantiza es que ninguna pantalla vuelva a escribir
 * `<ErrorState onRetry={refetch}/>` a mano: ese botón, puesto sobre un 402 de
 * cuota, ofrece una salida que no existe.
 *
 * La acción se arma entera acá en vez de usar el `onRetry` de `ErrorState`
 * porque ese camino rotula el botón con `Try again` siempre, y `Reload` no es
 * `Try again`: uno dice "el servidor falló", el otro "lo tuyo está viejo".
 */
export function ApiErrorState({ error, onRetry, className }: ApiErrorStateProps) {
  const { titleKey, titleVars, descriptionKey, vars, remedy } = presentError(error);
  const labelKey = REMEDY_LABEL_KEY[remedy];
  const href = REMEDY_HREF[remedy];

  const description = descriptionKey === undefined ? undefined : tw(descriptionKey, vars);

  let action: ReactNode | undefined;
  if (labelKey !== null && href !== undefined) {
    // Una salida que lleva a otra pantalla es un enlace, no un botón: tiene que
    // poder abrirse en otra pestaña y anunciarse como enlace.
    action = (
      <Link href={href} className={buttonVariants({ variant: "secondary" })}>
        {tw(labelKey)}
      </Link>
    );
  } else if (labelKey !== null && onRetry !== undefined) {
    action = (
      <Button variant="secondary" onClick={onRetry}>
        {tw(labelKey)}
      </Button>
    );
  }

  return (
    <ErrorState
      title={tw(titleKey, titleVars)}
      {...(description === undefined ? {} : { description })}
      {...(action === undefined ? {} : { action })}
      {...(className === undefined ? {} : { className })}
    />
  );
}
