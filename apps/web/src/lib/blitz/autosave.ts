"use client";

/**
 * El planificador del auto-guardado de `/blitz/settings` · FR-055 (PRD:1265).
 *
 * ## El problema, con números
 *
 * FR-055 pide auto-guardado. `PATCH /blitz/preferences` tiene un límite
 * **dedicado de 3 por minuto** (§9.6; `RATE_LIMITS.blitzPreferencesUpdate` es
 * literalmente `{ limit: 3, windowMs: 60_000 }`). Guardar en cada cambio agota
 * ese presupuesto en segundos: un slider emite decenas de eventos por arrastre,
 * y aunque emitiera uno solo, tocar los cuatro formatos son cuatro PATCH. El
 * usuario vería un `429` por **escribir**, que es el peor error posible en una
 * pantalla cuya promesa es que no hay que guardar.
 *
 * ## Dos mecanismos, porque uno solo no alcanza
 *
 * 1. **Debounce de {@link AUTOSAVE_DEBOUNCE_MS}.** Junta una ráfaga en una sola
 *    petición. 1,5 s no es un número redondo elegido al azar: tiene que
 *    sobrevivir a la pausa entre dos ajustes *relacionados* —arrastrar un
 *    slider y acto seguido corregir otro— que en una interacción deliberada
 *    está en el orden de medio segundo a segundo y medio. Más corto parte la
 *    ráfaga en dos peticiones; mucho más largo hace que el banner tarde en
 *    decir "guardado" y la pantalla parezca rota.
 *
 * 2. **Un piso de {@link AUTOSAVE_MIN_INTERVAL_MS} entre peticiones.** El
 *    debounce solo **no acota la tasa**: cuatro ajustes separados por dos
 *    segundos son cuatro peticiones en doce segundos, y la cuarta es un `429`.
 *    El piso es `60_000 / 3 = 20_000`, o sea el reparto **uniforme** del
 *    presupuesto. Se elige uniforme y no un bucket de 3 fichas a propósito: con
 *    un bucket, tres guardados seguidos dejan al cuarto esperando hasta 60 s;
 *    con el reparto uniforme la espera máxima es 20 s. Misma tasa, peor caso
 *    tres veces mejor.
 *
 * ## Qué pasa si el usuario sigue editando mientras hay un guardado en vuelo
 *
 * Nada se pierde y no se encima ninguna petición. Mientras `save()` está en
 * vuelo, un cambio nuevo sólo marca el estado como sucio; el planificador **no
 * lanza una segunda petición** (`inFlightRef`), y al resolverse la primera, si
 * quedó algo sucio, vuelve a agendar respetando el piso. Como el cuerpo del
 * PATCH se calcula **en el momento de mandarlo** —comparando el borrador con la
 * última respuesta confirmada, ver `buildPreferencesPatch`— la petición que
 * salga después lleva el estado final del usuario, no el que había cuando
 * empezó a editar. Encolar cuerpos en vez de recalcularlos daría el efecto
 * contrario: una ráfaga de PATCHes con estados intermedios que el usuario ya
 * descartó.
 *
 * ## Qué pasa si falla
 *
 * El cambio **sigue sucio**: se reintenta solo la próxima vez que el usuario
 * toque algo, y el banner ofrece un reintento explícito. Lo que no hay es
 * reintento automático en bucle — un `400` reintentado solo es una pantalla
 * que martillea el endpoint para siempre, y con 3/min sería además el resto de
 * la sesión en `429`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** §9.6 — el límite dedicado de `PATCH /blitz/preferences`. */
export const PREFERENCES_UPDATES_PER_MINUTE = 3;

export const AUTOSAVE_DEBOUNCE_MS = 1_500;

/** El reparto uniforme del presupuesto: una petición cada 20 s como mucho. */
export const AUTOSAVE_MIN_INTERVAL_MS = 60_000 / PREFERENCES_UPDATES_PER_MINUTE;

/**
 * `"noop"` = no había nada que mandar (el usuario revirtió su cambio).
 *
 * Distinguirlo importa: un guardado que no llegó a salir no consume el
 * presupuesto, así que no tiene por qué empujar el piso de cadencia y hacer
 * esperar 20 s al siguiente cambio real.
 */
export type SaveOutcome = "sent" | "noop";

/**
 * · `saved`   — no hay nada pendiente y el último intento, si lo hubo, salió
 *               bien. **Es el único estado en el que el banner puede decir
 *               `All changes saved`.**
 * · `pending` — hay cambios sin mandar, esperando el debounce o el piso.
 * · `saving`  — hay una petición en vuelo.
 * · `error`   — el último intento falló y el cambio sigue sin guardar.
 */
export type AutosaveStatus = "saved" | "pending" | "saving" | "error";

export interface UseAutosaveOptions {
  /** Calcula el cuerpo y lo manda. Rechaza si el guardado falló. */
  readonly save: () => Promise<SaveOutcome>;
  readonly debounceMs?: number;
  readonly minIntervalMs?: number;
}

export interface Autosave {
  readonly status: AutosaveStatus;
  readonly error: unknown;
  /** Algo cambió: agenda un guardado. */
  readonly queue: () => void;
  /** Reintentar ahora — **respetando igual el piso de cadencia**. */
  readonly retry: () => void;
}

export function useAutosave(options: UseAutosaveOptions): Autosave {
  const {
    save,
    debounceMs = AUTOSAVE_DEBOUNCE_MS,
    minIntervalMs = AUTOSAVE_MIN_INTERVAL_MS,
  } = options;

  const [status, setStatus] = useState<AutosaveStatus>("saved");
  const [error, setError] = useState<unknown>(null);

  const dirtyRef = useRef(false);
  const inFlightRef = useRef(false);
  const lastSentAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  // `save` y `schedule` se leen desde un temporizador, que dispara después del
  // commit: guardarlos en un ref sincronizado por efecto evita que el
  // planificador dependa de la identidad de un callback del componente (que
  // cambia en cada render y reiniciaría el debounce sin que nadie editara).
  const saveRef = useRef(save);
  const scheduleRef = useRef<(minDelayMs: number) => void>(() => undefined);
  const flushRef = useRef<() => void>(() => undefined);

  const schedule = useCallback(
    (minDelayMs: number) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const lastSentAt = lastSentAtRef.current;
      const floor =
        lastSentAt === null ? 0 : Math.max(0, lastSentAt + minIntervalMs - Date.now());
      timerRef.current = setTimeout(
        () => {
          flushRef.current();
        },
        Math.max(minDelayMs, floor),
      );
    },
    [minIntervalMs],
  );

  const flush = useCallback(() => {
    timerRef.current = null;
    // Con una petición en vuelo no se lanza otra: al resolverse, su propio
    // manejador vuelve a agendar si quedó algo sucio.
    if (inFlightRef.current) return;
    if (!dirtyRef.current) return;

    dirtyRef.current = false;
    inFlightRef.current = true;
    setStatus("saving");

    void saveRef.current().then(
      (outcome) => {
        inFlightRef.current = false;
        // El piso se mide desde que la petición **terminó**, no desde que
        // salió. Es más conservador que el limitador del servidor, que cuenta
        // llegadas, y esa holgura es justo lo que hace imposible pasarse de 3.
        if (outcome === "sent") lastSentAtRef.current = Date.now();
        if (!aliveRef.current) return;
        if (dirtyRef.current) {
          setStatus("pending");
          scheduleRef.current(0);
        } else {
          setStatus("saved");
        }
      },
      (cause: unknown) => {
        inFlightRef.current = false;
        lastSentAtRef.current = Date.now();
        // El cambio no se pierde: sigue sucio y se recalcula al reintentar.
        dirtyRef.current = true;
        if (!aliveRef.current) return;
        setError(cause);
        setStatus("error");
      },
    );
  }, []);

  useEffect(() => {
    saveRef.current = save;
    scheduleRef.current = schedule;
    flushRef.current = flush;
  });

  useEffect(
    () => () => {
      aliveRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const queue = useCallback(() => {
    dirtyRef.current = true;
    setError(null);
    // Si hay algo en vuelo el estado sigue siendo `saving` —es verdad: hay una
    // petición abierta— y pasa a `pending` cuando ésa termine. Lo que no puede
    // pasar nunca es volver a `saved` con algo sucio: de eso se encarga que
    // `saved` sólo se escriba en la rama en la que `dirtyRef` está limpio.
    setStatus((current) => (current === "saving" ? "saving" : "pending"));
    scheduleRef.current(debounceMs);
  }, [debounceMs]);

  const retry = useCallback(() => {
    if (!dirtyRef.current) return;
    setError(null);
    setStatus("pending");
    // `0` de debounce, pero el piso de cadencia se sigue aplicando: un botón de
    // reintento que lo saltara sería la forma más fácil de comerse el 429.
    scheduleRef.current(0);
  }, []);

  return { status, error, queue, retry };
}
