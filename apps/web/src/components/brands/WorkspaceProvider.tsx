"use client";

import { useToast } from "@fastgram/ui";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ApiRequestError } from "@/lib/api/errors";
import {
  clearWorkspaceCookie,
  readWorkspaceCookie,
  writeWorkspaceCookie,
} from "@/lib/brands/workspace-cookie";
import {
  brandKeys,
  fetchMode,
  fetchWorkspaces,
  isBrandIndependentKey,
  resolveActiveWorkspace,
  type AppMode,
  type Workspace,
} from "@/lib/brands/workspaces";
import { tw } from "@/lib/i18n/t";

export interface WorkspaceContextValue {
  /**
   * `null` mientras `GET /mode` no respondió. Si falla, `standard`: ante la
   * duda no se esconde nada (una API vieja sin `/mode` no es modo personal).
   */
  mode: AppMode | null;
  isPersonal: boolean;
  workspaces: UseQueryResult<Workspace[], ApiRequestError>;
  /** La marca que se muestra como activa (ver `resolveActiveWorkspace`). */
  active: Workspace | null;
  /** El id de la cookie, o `null` si se opera sobre la default. */
  selectedId: string | null;
  switchTo: (workspace: Workspace, options?: { silent?: boolean }) => void;
  /** Tras borrar una marca: si era la activa, vuelve a la default. */
  forget: (workspaceId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/**
 * La marca activa para toda la shell · `PU-BRAND-001`.
 *
 * Tres cosas y ninguna más:
 *
 * 1. **Cambiar de marca resetea la caché** de todo lo que depende de la marca
 *    (`resetQueries`, no `invalidateQueries`). Invalidar dejaría en pantalla
 *    los posts de la marca anterior mientras llegan los de la nueva — y eso es
 *    mostrar datos de un workspace bajo el nombre de otro, aunque sea un
 *    segundo. Reset los vuelve a `loading`.
 * 2. **La cookie la lee un efecto**, no el render: el HTML del servidor no la
 *    conoce (el shell es de cliente) y leerla durante el render rompería la
 *    hidratación.
 * 3. **Una marca inválida se limpia sola.** Con el header puesto, la API
 *    responde `404` a *toda* petición si la marca no existe o no es del dueño
 *    — incluida `GET /workspaces`, que en otro caso nunca da 404. Así que un
 *    404 de la lista con cookie puesta significa "tu cookie apunta a una marca
 *    borrada": se borra la cookie y se vuelve a la default. Lo mismo si la
 *    lista llega bien pero no incluye la marca de la cookie.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cookieRead, setCookieRead] = useState(false);

  useEffect(() => {
    setSelectedId(readWorkspaceCookie());
    setCookieRead(true);
  }, []);

  const modeQuery = useQuery<AppMode, ApiRequestError>({
    queryKey: brandKeys.mode(),
    queryFn: ({ signal }) => fetchMode(signal),
    staleTime: Infinity,
    retry: false,
  });
  const mode: AppMode | null = modeQuery.isError ? "standard" : (modeQuery.data ?? null);
  const isPersonal = mode === "personal";

  const workspaces = useQuery<Workspace[], ApiRequestError>({
    queryKey: brandKeys.workspaces(),
    queryFn: ({ signal }) => fetchWorkspaces(signal),
    enabled: isPersonal,
    // Un 404 acá no se reintenta: es la señal de cookie inválida (punto 3).
    retry: (failureCount, error) => error.status !== 404 && failureCount < 2,
  });

  const active = useMemo(
    () =>
      workspaces.data === undefined
        ? null
        : resolveActiveWorkspace(workspaces.data, selectedId),
    [workspaces.data, selectedId],
  );

  const resetBrandScopedQueries = useCallback(() => {
    void queryClient.resetQueries({
      predicate: (query) => !isBrandIndependentKey(query.queryKey),
    });
  }, [queryClient]);

  const backToDefault = useCallback(
    (notify: boolean) => {
      clearWorkspaceCookie();
      setSelectedId(null);
      resetBrandScopedQueries();
      void queryClient.invalidateQueries({ queryKey: brandKeys.workspaces() });
      if (notify) toast({ title: tw("brands.invalidReset"), tone: "warning" });
    },
    [queryClient, resetBrandScopedQueries, toast],
  );

  // Punto 3. `handled` evita que un mismo fallo dispare el reset dos veces
  // mientras la lista se vuelve a pedir.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!cookieRead || selectedId === null) return;
    const invalidByStatus = workspaces.isError && workspaces.error.status === 404;
    const invalidByList =
      workspaces.isSuccess && !workspaces.data.some((w) => w.id === selectedId);
    if (!invalidByStatus && !invalidByList) return;
    if (handled.current === selectedId) return;
    handled.current = selectedId;
    backToDefault(true);
  }, [
    cookieRead,
    selectedId,
    workspaces.isError,
    workspaces.error,
    workspaces.isSuccess,
    workspaces.data,
    backToDefault,
  ]);

  const switchTo = useCallback(
    (workspace: Workspace, options?: { silent?: boolean }) => {
      // Elegir la que ya se ve (también la default sin cookie) no hace nada:
      // resetear la caché por un no-cambio sería un parpadeo gratuito.
      if (workspace.id === active?.id) return;
      writeWorkspaceCookie(workspace.id);
      handled.current = null;
      setSelectedId(workspace.id);
      resetBrandScopedQueries();
      if (options?.silent !== true) {
        toast({
          title: tw("brands.switched", { name: workspace.name }),
          tone: "success",
          duration: 2500,
        });
      }
    },
    [active, resetBrandScopedQueries, toast],
  );

  const forget = useCallback(
    (workspaceId: string) => {
      if (workspaceId === selectedId) backToDefault(false);
    },
    [selectedId, backToDefault],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({ mode, isPersonal, workspaces, active, selectedId, switchTo, forget }),
    [mode, isPersonal, workspaces, active, selectedId, switchTo, forget],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (context === null) {
    throw new Error("useWorkspace() necesita un <WorkspaceProvider> por encima.");
  }
  return context;
}
