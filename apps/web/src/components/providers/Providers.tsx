"use client";

import { ToastProvider } from "@fastgram/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { createQueryClient } from "@/lib/api/query-client";

/**
 * Providers de cliente del root layout.
 *
 * El `QueryClient` se crea con `useState`, no como módulo global. Con un global
 * en un render de servidor, **todas** las peticiones del proceso comparten
 * caché: el workspace de un usuario se le serviría al siguiente. Es el error
 * clásico de TanStack Query en SSR y no se ve en desarrollo, que es lo que lo
 * hace caro.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>{children}</ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
