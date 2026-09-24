"use client";

/**
 * Hooks de Engagement (Reddit) — `FR-140`, `P4-ENGAGE-006…012`. Por marca: el
 * proxy manda `X-Fastgram-Workspace` con la marca activa.
 *
 * "Send" (`useSendReply`) genera una `Idempotency-Key` **por intento de
 * envío** (no por render): un doble clic o un reintento del proxy no comenta
 * dos veces. Sólo se llama desde el diálogo de confirmación.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import {
  banMeterSchema,
  engagementOverviewSchema,
  engagementQueuedSchema,
  engagementSettingsSchema,
  leadDetailSchema,
  leadListSchema,
  leadSchema,
  redditAppSchema,
  redditAuthorizeResponseSchema,
  sendReplyResultSchema,
  type BanMeter,
  type EngagementOverview,
  type EngagementSettings,
  type Lead,
  type LeadDetail,
  type LeadList,
  type LeadView,
  type RedditApp,
  type SendReplyResult,
  type UpdateEngagementSettingsRequest,
  type UpdateRedditAppRequest,
} from "@fastgram/contracts";
import { apiRequest, apiSend } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { newIdempotencyKey } from "../api/idempotency-key";

export const engagementKeys = {
  all: () => ["engagement"] as const,
  overview: () => ["engagement", "overview"] as const,
  leads: (view: LeadView, unseen: boolean, q: string) =>
    ["engagement", "leads", view, unseen, q] as const,
  lead: (id: string) => ["engagement", "lead", id] as const,
};

/** Cada cuánto se relee un lead con el borrador en curso (lo genera el worker). */
export const REPLY_POLL_MS = 2_500;

export function useEngagementOverview(): UseQueryResult<
  EngagementOverview,
  ApiRequestError
> {
  return useApiQuery<EngagementOverview>({
    queryKey: engagementKeys.overview(),
    path: "/engagement/overview",
    schema: engagementOverviewSchema,
  });
}

export function useLeads(
  view: LeadView,
  unseen: boolean,
  q: string,
): UseQueryResult<LeadList, ApiRequestError> {
  return useApiQuery<LeadList>({
    queryKey: engagementKeys.leads(view, unseen, q),
    path: "/engagement/leads",
    query: {
      view,
      unseen: unseen ? "true" : undefined,
      q: q.trim() === "" ? undefined : q.trim(),
      limit: 50,
    },
    schema: leadListSchema,
  });
}

export function useLead(id: string | null): UseQueryResult<LeadDetail, ApiRequestError> {
  return useApiQuery<LeadDetail>({
    queryKey: engagementKeys.lead(id ?? "none"),
    path: `/engagement/leads/${id ?? "none"}`,
    schema: leadDetailSchema,
    enabled: id !== null,
    refetchInterval: (query) =>
      query.state.data?.lead.replyStatus === "generating" ||
      (query.state.data?.lead.scoreStatus === "pending" &&
        query.state.data.lead.source === "manual")
        ? REPLY_POLL_MS
        : false,
  });
}

function useInvalidateEngagement(): () => Promise<void> {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: engagementKeys.all() });
}

export function useSaveSettings(): UseMutationResult<
  EngagementSettings,
  ApiRequestError,
  UpdateEngagementSettingsRequest
> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: (body) =>
      apiRequest<EngagementSettings>("/engagement/settings", {
        method: "PUT",
        body,
        schema: engagementSettingsSchema,
      }),
    onSuccess: invalidate,
  });
}

export function useSaveRedditApp(): UseMutationResult<
  RedditApp,
  ApiRequestError,
  UpdateRedditAppRequest
> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: (body) =>
      apiRequest<RedditApp>("/engagement/reddit-app", {
        method: "PUT",
        body,
        schema: redditAppSchema,
      }),
    onSuccess: invalidate,
  });
}

/** Pide la URL de Reddit y lleva el navegador ahí. */
export function useConnectReddit(): UseMutationResult<
  { url: string },
  ApiRequestError,
  void
> {
  return useMutation({
    mutationFn: () =>
      apiRequest<{ url: string }>("/engagement/reddit/authorize", {
        schema: redditAuthorizeResponseSchema,
      }),
    onSuccess: (res) => {
      window.location.assign(res.url);
    },
  });
}

export function useDisconnectReddit(): UseMutationResult<void, ApiRequestError, void> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: () => apiSend("/engagement/reddit/account", { method: "DELETE" }),
    onSettled: invalidate,
  });
}

export function useDiscoverNow(): UseMutationResult<
  { queued: boolean },
  ApiRequestError,
  void
> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: () =>
      apiRequest<{ queued: boolean }>("/engagement/discover", {
        method: "POST",
        schema: engagementQueuedSchema,
      }),
    onSuccess: invalidate,
  });
}

export function useCreateManualLead(): UseMutationResult<
  Lead,
  ApiRequestError,
  { url: string; title: string; body?: string }
> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: (body) =>
      apiRequest<Lead>("/engagement/leads", { method: "POST", body, schema: leadSchema }),
    onSuccess: invalidate,
  });
}

export function useDeleteLead(): UseMutationResult<void, ApiRequestError, string> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: (id) => apiSend(`/engagement/leads/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useMarkSeen(): UseMutationResult<Lead, ApiRequestError, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) =>
      apiRequest<Lead>(`/engagement/leads/${id}/seen`, {
        method: "POST",
        schema: leadSchema,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["engagement", "leads"] }),
  });
}

export function useGenerateReply(): UseMutationResult<
  Lead,
  ApiRequestError,
  { id: string; regenerate: boolean }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, regenerate }) =>
      apiRequest<Lead>(`/engagement/leads/${id}/reply/generate`, {
        method: "POST",
        body: { regenerate },
        schema: leadSchema,
      }),
    onSuccess: (_lead, { id }) =>
      qc.invalidateQueries({ queryKey: engagementKeys.lead(id) }),
  });
}

export function useSaveDraft(): UseMutationResult<
  LeadDetail,
  ApiRequestError,
  { id: string; text: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }) =>
      apiRequest<LeadDetail>(`/engagement/leads/${id}/reply`, {
        method: "PUT",
        body: { text },
        schema: leadDetailSchema,
      }),
    onSuccess: (detail, { id }) => qc.setQueryData(engagementKeys.lead(id), detail),
  });
}

export function useSendReply(): UseMutationResult<
  SendReplyResult,
  ApiRequestError,
  { id: string; text: string }
> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: ({ id, text }) =>
      apiRequest<SendReplyResult>(`/engagement/leads/${id}/send`, {
        method: "POST",
        body: { text, confirm: true },
        idempotencyKey: newIdempotencyKey(),
        schema: sendReplyResultSchema,
      }),
    onSettled: invalidate,
  });
}

export function useMarkSent(): UseMutationResult<
  SendReplyResult,
  ApiRequestError,
  { id: string; text: string; commentUrl?: string }
> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: ({ id, text, commentUrl }) =>
      apiRequest<SendReplyResult>(`/engagement/leads/${id}/mark-sent`, {
        method: "POST",
        body:
          commentUrl === undefined || commentUrl.trim() === ""
            ? { text }
            : { text, commentUrl },
        idempotencyKey: newIdempotencyKey(),
        schema: sendReplyResultSchema,
      }),
    onSettled: invalidate,
  });
}

export function useSyncLead(): UseMutationResult<
  { queued: boolean },
  ApiRequestError,
  string
> {
  return useMutation({
    mutationFn: (id) =>
      apiRequest<{ queued: boolean }>(`/engagement/leads/${id}/sync`, {
        method: "POST",
        schema: engagementQueuedSchema,
      }),
  });
}

export function useRefreshBanMeter(): UseMutationResult<BanMeter, ApiRequestError, void> {
  const invalidate = useInvalidateEngagement();
  return useMutation({
    mutationFn: () =>
      apiRequest<BanMeter>("/engagement/ban-meter/refresh", {
        method: "POST",
        schema: banMeterSchema,
      }),
    onSuccess: invalidate,
  });
}
