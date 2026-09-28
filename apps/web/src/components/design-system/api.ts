"use client";

/**
 * Design system de la marca · sprint 9 (M), `/design-system`.
 *
 * Todo cuelga de la misma clave: importar, editar, generar o aprobar
 * invalidan `designSystemKeys.all()` y la tarjeta se vuelve a pintar.
 *
 * El import es la subida de §9.8 en tres pasos, como el Media Bank: reserva →
 * PUT directo al storage (`putSignedUpload`) → `POST /design-system/import`.
 * Mientras el worker procesa, `GET /design-system` devuelve la versión nueva
 * en `latest` con `status: importing`: la tarjeta la sondea cada 3 s.
 */
import {
  DESIGN_SYSTEM_ZIP_MAX_MB,
  designSystemApproveResponseSchema,
  designSystemFontFileSchema,
  designSystemGenerateResponseSchema,
  designSystemSchema,
  designSystemStateSchema,
  uploadReservationSchema,
  type DesignSystemGenerateRequest,
  type DesignSystemResource,
  type DesignSystemState,
  type DesignSystemUpdateRequest,
  type UploadReservation,
} from "@fastgram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { apiRequest, apiSend } from "@/lib/api/client";
import { putSignedUpload, type UploadProgress } from "@/lib/media/upload/transport";

export const DESIGN_SYSTEM_PATH = "/design-system";

export const designSystemKeys = {
  all: () => ["design-system"] as const,
  font: (id: string, fileRef: string) => ["design-system", "font", id, fileRef] as const,
};

/** Cada cuánto se mira un import en curso. */
export const IMPORT_POLL_MS = 3_000;

export function isImporting(state: DesignSystemState | undefined): boolean {
  return state?.latest?.status === "importing";
}

export function useDesignSystem() {
  return useQuery({
    queryKey: designSystemKeys.all(),
    queryFn: ({ signal }) =>
      apiRequest<DesignSystemState>(DESIGN_SYSTEM_PATH, {
        signal,
        schema: designSystemStateSchema,
      }),
    refetchInterval: (query) => (isImporting(query.state.data) ? IMPORT_POLL_MS : false),
  });
}

export type ZipRejection = "not_zip" | "too_large" | "empty";

/** ¿Este archivo se puede subir? El servidor vuelve a mirar lo mismo. */
export function zipRejection(file: { name: string; size: number }): ZipRejection | null {
  if (file.size <= 0) return "empty";
  if (!file.name.toLowerCase().endsWith(".zip")) return "not_zip";
  if (file.size > DESIGN_SYSTEM_ZIP_MAX_MB * 1024 * 1024) return "too_large";
  return null;
}

export interface ImportInput {
  readonly file: File;
  readonly onProgress?: UploadProgress;
}

export async function importDesignSystem(
  input: ImportInput,
): Promise<DesignSystemResource> {
  const reservation = await apiRequest<UploadReservation>(
    `${DESIGN_SYSTEM_PATH}/upload-url`,
    {
      method: "POST",
      body: {
        filename: input.file.name,
        // Safari y Chrome en Windows lo declaran distinto: el servidor acepta los dos.
        contentType:
          input.file.type === "application/x-zip-compressed"
            ? "application/x-zip-compressed"
            : "application/zip",
        sizeBytes: input.file.size,
      },
      schema: uploadReservationSchema,
    },
  );
  await putSignedUpload({
    url: reservation.uploadUrl,
    method: reservation.method,
    headers: reservation.headers,
    body: input.file,
    onProgress: input.onProgress,
  });
  return apiRequest<DesignSystemResource>(`${DESIGN_SYSTEM_PATH}/import`, {
    method: "POST",
    body: { uploadId: reservation.uploadId },
    schema: designSystemSchema,
  });
}

function useInvalidating<TIn, TOut>(fn: (input: TIn) => Promise<TOut>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => client.invalidateQueries({ queryKey: designSystemKeys.all() }),
  });
}

export function useImportDesignSystem() {
  return useInvalidating(importDesignSystem);
}

export function useDeriveDesignSystem() {
  return useInvalidating(() =>
    apiRequest<DesignSystemResource>(`${DESIGN_SYSTEM_PATH}/derive`, {
      method: "POST",
      schema: designSystemSchema,
    }),
  );
}

export function useUpdateDesignSystem(id: string) {
  return useInvalidating((body: DesignSystemUpdateRequest) =>
    apiRequest<DesignSystemResource>(`${DESIGN_SYSTEM_PATH}/${id}`, {
      method: "PATCH",
      body,
      schema: designSystemSchema,
    }),
  );
}

export function useGenerateAssets(id: string) {
  return useInvalidating((body: DesignSystemGenerateRequest) =>
    apiRequest(`${DESIGN_SYSTEM_PATH}/${id}/generate`, {
      method: "POST",
      body,
      schema: designSystemGenerateResponseSchema,
    }),
  );
}

export function useApprovePending(id: string) {
  return useInvalidating((assetRef: string) =>
    apiRequest(
      `${DESIGN_SYSTEM_PATH}/${id}/pending/${encodeURIComponent(assetRef)}/approve`,
      {
        method: "POST",
        schema: designSystemApproveResponseSchema,
      },
    ),
  );
}

export function useDiscardPending(id: string) {
  return useInvalidating((assetRef: string) =>
    apiSend(`${DESIGN_SYSTEM_PATH}/${id}/pending/${encodeURIComponent(assetRef)}`, {
      method: "DELETE",
    }),
  );
}

export function useDeleteDesignSystem() {
  return useInvalidating((id: string) =>
    apiSend(`${DESIGN_SYSTEM_PATH}/${id}`, { method: "DELETE" }),
  );
}

export type FontLoadState = "idle" | "loading" | "ready" | "error";

/**
 * Carga una cara de la marca en el documento con `FontFace` (los bytes vienen
 * como `data:` URL de la API: ver el contrato). Devuelve el nombre de familia
 * CSS con el que hay que pintar el specimen.
 */
export function useBrandFontFace(
  designSystemId: string,
  fileRef: string | null,
  family: string,
  weight: number,
  style: "normal" | "italic",
): { readonly state: FontLoadState; readonly cssFamily: string } {
  const cssFamily = `fg-ds-${designSystemId.slice(0, 8)}-${family}`;
  const file = useQuery({
    queryKey: designSystemKeys.font(designSystemId, fileRef ?? "none"),
    queryFn: ({ signal }) =>
      apiRequest(
        `${DESIGN_SYSTEM_PATH}/${designSystemId}/font-files/${encodeURIComponent(fileRef ?? "")}`,
        {
          signal,
          schema: designSystemFontFileSchema,
        },
      ),
    enabled: fileRef !== null,
    staleTime: Infinity,
  });
  const [state, setState] = useState<FontLoadState>(
    fileRef === null ? "idle" : "loading",
  );
  useEffect(() => {
    if (file.isError) {
      setState("error");
      return;
    }
    const dataUrl = file.data?.dataUrl;
    if (dataUrl === undefined) return;
    // Sin `FontFace` (jsdom, navegadores viejos) el specimen sale con el reemplazo.
    if (typeof FontFace === "undefined") {
      setState("idle");
      return;
    }
    let cancelled = false;
    const face = new FontFace(cssFamily, `url(${dataUrl})`, {
      weight: String(weight),
      style,
    });
    face
      .load()
      .then((loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [file.data?.dataUrl, file.isError, cssFamily, weight, style]);
  return { state: fileRef === null ? "idle" : state, cssFamily };
}
