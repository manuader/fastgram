"use client";

import { X } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { cn } from "../../cn.js";
import { t } from "../../i18n/t.js";
import { toastVariants } from "./toast.variants.js";
import {
  createToastStore,
  type Toast as ToastData,
  type ToastOptions,
  type ToastStore,
  type ToastStoreConfig,
} from "./toast-store.js";

export interface ToastContextValue {
  /** Encola un toast y devuelve su id. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export interface ToastProviderProps extends ToastStoreConfig {
  children?: ReactNode;
  /** Store propio. Útil para tests y para disparar toasts desde fuera de React. */
  store?: ToastStore;
}

/**
 * Provee la cola de toasts y renderiza su viewport (PRD §3.5).
 * Va una sola vez, lo más arriba posible del árbol.
 */
export function ToastProvider({
  children,
  store,
  limit,
  defaultDuration,
}: ToastProviderProps) {
  const activeStore = useMemo(() => {
    if (store !== undefined) return store;
    const config: ToastStoreConfig = {};
    if (limit !== undefined) config.limit = limit;
    if (defaultDuration !== undefined) config.defaultDuration = defaultDuration;
    return createToastStore(config);
  }, [store, limit, defaultDuration]);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast: activeStore.add,
      dismiss: activeStore.dismiss,
      clear: activeStore.clear,
    }),
    [activeStore],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster store={activeStore} />
    </ToastContext.Provider>
  );
}

/** Acceso a la cola de toasts. Falla fuerte si falta el provider. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error("useToast() necesita un <ToastProvider> por encima.");
  }
  return context;
}

export interface ToasterProps {
  store: ToastStore;
  className?: string;
}

/**
 * Viewport de los toasts.
 *
 * El contenedor existe siempre y es la live region: si la región apareciera
 * junto con el primer toast, buena parte de los lectores de pantalla no
 * anunciaría nada. `polite` para no interrumpir; los de error añaden
 * `role="alert"`, que sí interrumpe, porque ahí interrumpir está justificado.
 */
export function Toaster({ store, className }: ToasterProps) {
  const toasts = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  return (
    <div
      className={cn("fg-toast-viewport", className)}
      role="region"
      aria-label={t("toast.region")}
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((item) => (
        <ToastItem
          key={item.id}
          toast={item}
          onDismiss={() => {
            store.dismiss(item.id);
          }}
        />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: ToastData;
  onDismiss: () => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  return (
    <div
      className={toastVariants({ tone: toast.tone })}
      role={toast.tone === "danger" ? "alert" : "status"}
    >
      <div className="fg-toast__content">
        <p className="fg-toast__title">{toast.title}</p>
        {toast.description !== undefined && (
          <p className="fg-toast__description">{toast.description}</p>
        )}
      </div>
      {toast.action !== undefined && (
        <button
          type="button"
          className="fg-toast__action fg-btn fg-btn--link"
          onClick={toast.action.onClick}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="fg-toast__close fg-btn fg-btn--ghost fg-btn--icon"
        aria-label={t("toast.dismiss")}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
