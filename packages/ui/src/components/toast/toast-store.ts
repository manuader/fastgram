export type ToastTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface ToastAction {
  /** Copy del enlace de acción. En el PRD §3.5 siempre es `View in Library`. */
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string | undefined;
  tone?: ToastTone | undefined;
  /** Milisegundos hasta el auto-cierre. `0` o `Infinity` lo dejan fijo. */
  duration?: number | undefined;
  action?: ToastAction | undefined;
}

export interface Toast {
  id: string;
  title: string;
  description?: string | undefined;
  tone: ToastTone;
  duration: number;
  action?: ToastAction | undefined;
}

export interface ToastStoreConfig {
  /** Cuántos toasts a la vez. Al superarlo se descarta el más viejo. */
  limit?: number;
  defaultDuration?: number;
}

export interface ToastStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly Toast[];
  add: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const DEFAULT_TOAST_DURATION = 5000;
export const DEFAULT_TOAST_LIMIT = 3;

/**
 * Cola de toasts, fuera de React.
 *
 * Está separada del componente a propósito: el límite, el descarte del más
 * viejo y el auto-cierre son la parte que puede fallar, y así se puede testear
 * con temporizadores falsos sin montar nada.
 */
export function createToastStore(config: ToastStoreConfig = {}): ToastStore {
  const limit = Math.max(1, config.limit ?? DEFAULT_TOAST_LIMIT);
  const defaultDuration = config.defaultDuration ?? DEFAULT_TOAST_DURATION;

  let toasts: readonly Toast[] = [];
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let sequence = 0;

  function emit(next: readonly Toast[]): void {
    toasts = next;
    for (const listener of listeners) listener();
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  function dismiss(id: string): void {
    clearTimer(id);
    const next = toasts.filter((toast) => toast.id !== id);
    if (next.length !== toasts.length) emit(next);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // Devuelve siempre la misma referencia mientras no haya cambios: es lo que
    // `useSyncExternalStore` necesita para no re-renderizar en bucle.
    getSnapshot: () => toasts,

    add(options) {
      sequence += 1;
      const id = `fg-toast-${sequence}`;
      const toast: Toast = {
        id,
        title: options.title,
        description: options.description,
        tone: options.tone ?? "neutral",
        duration: options.duration ?? defaultDuration,
        action: options.action,
      };

      const overflow = [...toasts, toast];
      const kept = overflow.slice(Math.max(0, overflow.length - limit));
      for (const dropped of overflow.slice(0, overflow.length - kept.length)) {
        clearTimer(dropped.id);
      }
      emit(kept);

      if (Number.isFinite(toast.duration) && toast.duration > 0) {
        timers.set(
          id,
          setTimeout(() => {
            dismiss(id);
          }, toast.duration),
        );
      }
      return id;
    },

    dismiss,

    clear() {
      for (const id of [...timers.keys()]) clearTimer(id);
      emit([]);
    },
  };
}
