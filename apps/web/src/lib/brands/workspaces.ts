/**
 * Marcas (workspaces) y modo de la app · `PU-BRAND-001`, `PU-UI-001`.
 *
 * El contrato lo fijó el coordinador del sprint 1 (`GET/POST /workspaces`,
 * `PATCH/DELETE /workspaces/:id`, `GET /mode`). Todavía no está en
 * `@fastgram/contracts`, así que el schema vive acá; el día que el paquete lo
 * exporte, este `workspaceSchema` se borra y se importa de allí.
 */
import { z } from "zod";
import { apiRequest, apiSend } from "@/lib/api/client";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";

export const PROFILE_STATUSES = ["pending", "ready", "failed", "partial"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  profileStatus: z.enum(PROFILE_STATUSES),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const APP_MODES = ["personal", "standard"] as const;
export type AppMode = (typeof APP_MODES)[number];

export const modeSchema = z.object({ mode: z.enum(APP_MODES) });

/** Límite del contrato: `name` de 1 a 80 caracteres, recortado. */
export const WORKSPACE_NAME_MAX = 80;

export type NameProblem = "required" | "too_long";

/** Validación del nombre del lado del cliente: la misma regla que la API. */
export function validateWorkspaceName(raw: string): NameProblem | null {
  const name = raw.trim();
  if (name === "") return "required";
  if (name.length > WORKSPACE_NAME_MAX) return "too_long";
  return null;
}

/**
 * Claves de caché. **No** cuelgan de ningún recurso del workspace: al cambiar
 * de marca se resetea todo lo demás, y la lista de marcas y el modo son lo
 * único que no depende de cuál esté activa (la lista es la del dueño).
 */
export const brandKeys = {
  workspaces: () => ["workspaces"] as const,
  mode: () => ["app-mode"] as const,
};

/** Prefijos que sobreviven al cambio de marca. */
export const BRAND_INDEPENDENT_ROOTS: ReadonlySet<string> = new Set([
  "workspaces",
  "app-mode",
  "service-status",
]);

export function isBrandIndependentKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && BRAND_INDEPENDENT_ROOTS.has(root);
}

export async function fetchWorkspaces(signal?: AbortSignal): Promise<Workspace[]> {
  return apiRequest("workspaces", {
    schema: z.array(workspaceSchema),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function fetchMode(signal?: AbortSignal): Promise<AppMode> {
  const data = await apiRequest("mode", {
    schema: modeSchema,
    ...(signal === undefined ? {} : { signal }),
  });
  return data.mode;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return apiRequest("workspaces", {
    method: "POST",
    body: { name: name.trim(), ...browserTimeZone() },
    idempotencyKey: newIdempotencyKey(),
    schema: workspaceSchema,
  });
}

/** La marca nace en la hora local de quien la crea: sin esto hereda UTC. */
function browserTimeZone(): { timezone?: string } {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone === "" ? {} : { timezone: zone };
  } catch {
    return {};
  }
}

export async function renameWorkspace(id: string, name: string): Promise<Workspace> {
  return apiRequest(`workspaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { name: name.trim() },
    schema: workspaceSchema,
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await apiSend(`workspaces/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Qué marca se muestra como activa.
 *
 * Con cookie válida, esa. Sin cookie, **la más antigua** — decisión que el
 * contrato no cubre: sin header la API opera sobre la company de la key, y la
 * lista no dice cuál es. La de la key es la que existía antes que cualquier
 * marca creada desde la app, y la lista viene por `created_at` ascendente,
 * así que es la primera. Si un día la key apunta a otra, esto miente: la
 * salida correcta sería que `GET /workspaces` marque la default.
 */
export function resolveActiveWorkspace(
  workspaces: readonly Workspace[],
  selectedId: string | null,
): Workspace | null {
  if (selectedId !== null) {
    const match = workspaces.find((workspace) => workspace.id === selectedId);
    if (match !== undefined) return match;
  }
  return workspaces[0] ?? null;
}
