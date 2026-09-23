"use client";

import { useEffect, useState } from "react";

/**
 * La hora, re-leída cada `intervalMs` mientras `active`.
 *
 * Existe por el aviso de "no empezó" del paso 4: el umbral de 3 min se cruza
 * **sin que cambie ningún dato**. El polling no alcanza, porque TanStack Query
 * comparte estructura: si `GET /onboarding` devuelve lo mismo, no hay render
 * nuevo, y una fuente en `pending` se vería "recién encolada" para siempre.
 * Inactivo no hay temporizador: una pantalla con todo terminado no se repinta.
 */
export function useNow(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [active, intervalMs]);
  return now;
}
