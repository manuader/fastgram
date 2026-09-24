"use client";

import { brandKitJobSchema, type BrandKitJob } from "@fastgram/contracts";
import { Button } from "@fastgram/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { tw } from "@/lib/i18n/t";

/**
 * `Generate brand backgrounds` — `POST /media/brand-kit` (PU-MEDIA-002).
 *
 * Los fondos se generan en el worker (unos segundos por imagen, ~4 s por video)
 * y entran al Media Bank ya `ready`, así que el listado no los ve por su polling
 * de `processing`. Por eso, después de encolar, se refresca el listado unas
 * veces a intervalos crecientes hasta que el lote pueda haber llegado.
 */
const REFRESH_AFTER_MS = [8_000, 20_000, 40_000, 75_000] as const;

export function BrandKitButton({ size = "sm" }: { readonly size?: "sm" | "lg" }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );

  const generate = useMutation<BrandKitJob, ApiRequestError>({
    mutationFn: () =>
      apiRequest<BrandKitJob>("media/brand-kit", {
        method: "POST",
        body: {},
        idempotencyKey: newIdempotencyKey(),
        schema: brandKitJobSchema,
      }),
    onSuccess: (job) => {
      setNotice(tw("brandKit.queued", { images: job.images, videos: job.videos }));
      for (const t of timers.current) clearTimeout(t);
      timers.current = REFRESH_AFTER_MS.map((ms) =>
        setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ["media"] });
        }, ms),
      );
    },
    onError: () => {
      setNotice(tw("brandKit.failed"));
    },
  });

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        size={size}
        variant="secondary"
        loading={generate.isPending}
        onClick={() => {
          generate.mutate();
        }}
      >
        {tw("brandKit.generate")}
      </Button>
      {notice !== null && (
        <span role="status" className="text-xs text-text-muted">
          {notice}
        </span>
      )}
    </span>
  );
}
