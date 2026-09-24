"use client";

/**
 * Automations (campañas multi-semana) — `FR-150`, `F-210…F-220`.
 *
 * | Operación                 | Ruta                                               |
 * |---------------------------|----------------------------------------------------|
 * | lista                     | `GET /automations`                                 |
 * | crear (DRAFT)             | `POST /automations`                                |
 * | una / renombrar / config  | `GET · PATCH /automations/:id`                     |
 * | borrar                    | `DELETE /automations/:id`                          |
 * | generar                   | `POST /automations/:id/generate`                   |
 * | slots                     | `GET /automations/:id/slots`                       |
 * | editar / sacar un slot    | `PATCH · DELETE /automations/:id/slots/:slotId`    |
 * | re-roll                   | `POST /automations/:id/slots/:slotId/reroll`       |
 * | abrir en el editor        | `POST /automations/:id/slots/:slotId/content`      |
 * | launchValidation          | `GET /automations/:id/launch-validation`           |
 * | lanzar / cancelar         | `POST /automations/:id/launch · /cancel`           |
 *
 * La marca es la de la cookie (el proxy la manda como `X-Fastgram-Workspace`).
 * Mientras algo se genera o se construye, la campaña y sus slots se vuelven a
 * pedir cada {@link AUTOMATION_POLL_MS}.
 */
import {
  automationSchema,
  automationSlotContentSchema,
  automationSlotSchema,
  launchValidationSchema,
  type Automation,
  type AutomationSlot,
  type BlitzContentType,
  type CreateAutomationRequest,
  type LaunchValidation,
  type UpdateAutomationRequest,
  type UpdateAutomationSlotRequest,
} from "@fastgram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";

export const AUTOMATIONS_PATH = "/automations";
/** Generar una copy con un 7B local tarda segundos: 4 s se siente vivo. */
export const AUTOMATION_POLL_MS = 4_000;

export const automationKeys = {
  all: ["automations"] as const,
  list: () => ["automations", "list"] as const,
  one: (id: string) => ["automations", "one", id] as const,
  slots: (id: string) => ["automations", "slots", id] as const,
};

const path = (id: string, rest = "") =>
  `${AUTOMATIONS_PATH}/${encodeURIComponent(id)}${rest}`;
const slotPath = (id: string, slotId: string, rest = "") =>
  path(id, `/slots/${encodeURIComponent(slotId)}${rest}`);

/** Estados en los que algo cambia solo: se vuelve a pedir. */
export function isAutomationBusy(status: Automation["status"] | undefined): boolean {
  return status === "GENERATING" || status === "BUILDING";
}

export function slotsBusy(slots: readonly AutomationSlot[] | undefined): boolean {
  return (
    slots?.some(
      (s) =>
        s.status === "PENDING_GEN" ||
        s.status === "GENERATING" ||
        s.status === "REROLLING" ||
        s.status === "QUEUED_BUILD" ||
        s.status === "BUILDING",
    ) === true
  );
}

export function useAutomations(): UseQueryResult<Automation[], ApiRequestError> {
  return useQuery<Automation[], ApiRequestError>({
    queryKey: automationKeys.list(),
    queryFn: ({ signal }) =>
      apiRequest<Automation[]>(AUTOMATIONS_PATH, {
        signal,
        schema: z.array(automationSchema),
      }),
    refetchInterval: (q) =>
      q.state.data?.some((a) => isAutomationBusy(a.status)) === true
        ? AUTOMATION_POLL_MS
        : false,
  });
}

export function useAutomation(id: string): UseQueryResult<Automation, ApiRequestError> {
  return useQuery<Automation, ApiRequestError>({
    queryKey: automationKeys.one(id),
    queryFn: ({ signal }) =>
      apiRequest<Automation>(path(id), { signal, schema: automationSchema }),
    refetchInterval: (q) =>
      isAutomationBusy(q.state.data?.status) ? AUTOMATION_POLL_MS : false,
  });
}

export function useAutomationSlots(
  id: string,
  enabled = true,
): UseQueryResult<AutomationSlot[], ApiRequestError> {
  return useQuery<AutomationSlot[], ApiRequestError>({
    queryKey: automationKeys.slots(id),
    queryFn: ({ signal }) =>
      apiRequest<AutomationSlot[]>(path(id, "/slots"), {
        signal,
        schema: z.array(automationSlotSchema),
      }),
    enabled,
    refetchInterval: (q) => (slotsBusy(q.state.data) ? AUTOMATION_POLL_MS : false),
  });
}

function useInvalidate() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: automationKeys.all });
}

export function useCreateAutomation(): UseMutationResult<
  Automation,
  ApiRequestError,
  CreateAutomationRequest
> {
  const invalidate = useInvalidate();
  return useMutation<Automation, ApiRequestError, CreateAutomationRequest>({
    mutationFn: (body) =>
      apiRequest<Automation>(AUTOMATIONS_PATH, {
        method: "POST",
        body,
        schema: automationSchema,
      }),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateAutomation(
  id: string,
): UseMutationResult<Automation, ApiRequestError, UpdateAutomationRequest> {
  const client = useQueryClient();
  return useMutation<Automation, ApiRequestError, UpdateAutomationRequest>({
    mutationFn: (body) =>
      apiRequest<Automation>(path(id), {
        method: "PATCH",
        body,
        schema: automationSchema,
      }),
    onSuccess: (saved) => {
      client.setQueryData(automationKeys.one(id), saved);
      void client.invalidateQueries({ queryKey: automationKeys.list() });
    },
  });
}

export function useDeleteAutomation(): UseMutationResult<void, ApiRequestError, string> {
  const invalidate = useInvalidate();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) => apiSend(path(id), { method: "DELETE" }),
    onSuccess: () => void invalidate(),
  });
}

/** `POST …/generate`, `…/launch` y `…/cancel`: devuelven la campaña. */
export function useAutomationAction(
  id: string,
  action: "generate" | "launch" | "cancel",
): UseMutationResult<Automation, ApiRequestError, void> {
  const invalidate = useInvalidate();
  return useMutation<Automation, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest<Automation>(path(id, `/${action}`), {
        method: "POST",
        schema: automationSchema,
      }),
    onSettled: () => void invalidate(),
  });
}

/** `launchValidation` a pedido ("Continue to launch"). */
export function useLaunchValidation(
  id: string,
): UseMutationResult<LaunchValidation, ApiRequestError, void> {
  return useMutation<LaunchValidation, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest<LaunchValidation>(path(id, "/launch-validation"), {
        schema: launchValidationSchema,
      }),
  });
}

export function useUpdateSlot(
  id: string,
): UseMutationResult<
  AutomationSlot,
  ApiRequestError,
  { readonly slotId: string; readonly body: UpdateAutomationSlotRequest }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slotId, body }) =>
      apiRequest<AutomationSlot>(slotPath(id, slotId), {
        method: "PATCH",
        body,
        schema: automationSlotSchema,
      }),
    onSuccess: () => void invalidate(),
  });
}

export function useRerollSlot(
  id: string,
): UseMutationResult<
  AutomationSlot,
  ApiRequestError,
  { readonly slotId: string; readonly contentType: BlitzContentType | null }
> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ slotId, contentType }) =>
      apiRequest<AutomationSlot>(slotPath(id, slotId, "/reroll"), {
        method: "POST",
        body: contentType === null ? {} : { contentType },
        schema: automationSlotSchema,
      }),
    onSuccess: () => void invalidate(),
  });
}

export function useRemoveSlot(
  id: string,
): UseMutationResult<AutomationSlot, ApiRequestError, string> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (slotId) =>
      apiRequest<AutomationSlot>(slotPath(id, slotId), {
        method: "DELETE",
        schema: automationSlotSchema,
      }),
    onSuccess: () => void invalidate(),
  });
}

/** Crea (una vez) la pieza del slot para abrirla en `/library/:id/edit`. */
export function useSlotContent(
  id: string,
): UseMutationResult<string, ApiRequestError, string> {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (slotId) =>
      (
        await apiRequest<{ contentId: string }>(slotPath(id, slotId, "/content"), {
          method: "POST",
          schema: automationSlotContentSchema,
        })
      ).contentId,
    onSuccess: () => void invalidate(),
  });
}
