"use client";

import { Button, Skeleton } from "@fastgram/ui";
import { useQuery } from "@tanstack/react-query";
import { brandLogoSchema } from "@fastgram/contracts";
import { useId, useRef, useState, type ChangeEvent } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import {
  dataUrlBytes,
  downscaleImage,
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  intelKeys,
  useUpdateBrandLogo,
} from "@/lib/brand/intel";
import { apiRequest } from "@/lib/api/client";
import { tw } from "@/lib/i18n/t";

const ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * Logo de la marca — `P1-ONB-003`. `companies.logo_url` nunca se escribía; acá
 * se sube (reducido en el navegador a {@link LOGO_MAX_SIDE}px, PNG) y se ve en
 * el selector de marca, que lee `GET /workspaces`.
 *
 * Estados: cargando, sin logo (iniciales), subiendo, error (archivo inválido o
 * de la API), con logo (Replace / Remove).
 */
export function LogoCard() {
  const baseId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<"type" | "size" | "read" | null>(null);
  const update = useUpdateBrandLogo();
  const logo = useQuery({
    queryKey: intelKeys.logo(),
    queryFn: ({ signal }) =>
      apiRequest("/brand/logo", { signal, schema: brandLogoSchema }),
  });
  const current = logo.data?.logoUrl ?? null;

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    setLocalError(null);
    if (!ACCEPT.split(",").includes(file.type)) {
      setLocalError("type");
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = await downscaleImage(file, LOGO_MAX_SIDE, "image/png");
    } catch {
      setLocalError("read");
      return;
    }
    if (dataUrlBytes(dataUrl) > LOGO_MAX_BYTES) {
      setLocalError("size");
      return;
    }
    update.mutate(dataUrl);
  }

  return (
    <section className="fgw-brand-section" aria-labelledby={`${baseId}-title`}>
      <header className="fgw-brand-section__header">
        <h2 id={`${baseId}-title`} className="fgw-brand-section__title">
          {tw("brand.logo.title")}
        </h2>
      </header>
      {logo.isPending ? (
        <Skeleton height={64} width={64} />
      ) : logo.isError ? (
        <ApiErrorState
          error={logo.error}
          onRetry={() => {
            void logo.refetch();
          }}
        />
      ) : (
        <div className="flex items-center gap-3">
          {current === null ? (
            <span
              className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-border text-xs text-text-muted"
              aria-hidden="true"
            >
              {tw("brand.logo.placeholder")}
            </span>
          ) : (
            <img
              src={current}
              alt={tw("brand.logo.alt")}
              className="h-16 w-16 rounded-md border border-border object-contain"
            />
          )}
          <p className="fgw-brand__note m-0">
            {tw(current === null ? "brand.logo.none" : "brand.logo.shown")}
          </p>
        </div>
      )}
      <input
        ref={input}
        id={`${baseId}-file`}
        type="file"
        accept={ACCEPT}
        className="fg-visually-hidden"
        onChange={(e) => {
          void onFile(e);
        }}
      />
      {localError !== null && (
        <p className="fgw-brand-field__error" role="alert">
          {tw(
            localError === "type"
              ? "brand.logo.badType"
              : localError === "size"
                ? "brand.logo.tooBig"
                : "brand.logo.unreadable",
          )}
        </p>
      )}
      {update.isError && (
        <ApiErrorState
          error={update.error}
          onRetry={() => {
            update.reset();
            input.current?.click();
          }}
        />
      )}
      <div className="fgw-brand-section__actions">
        <Button
          size="sm"
          loading={update.isPending}
          disabled={update.isPending || logo.isPending}
          onClick={() => input.current?.click()}
        >
          {tw(current === null ? "brand.logo.upload" : "brand.logo.replace")}
        </Button>
        {current !== null && (
          <Button
            size="sm"
            variant="secondary"
            disabled={update.isPending}
            onClick={() => {
              update.mutate(null);
            }}
          >
            {tw("brand.logo.remove")}
          </Button>
        )}
        {update.isSuccess && (
          <span className="fgw-brand-section__saved" role="status">
            {tw("brand.logo.saved")}
          </span>
        )}
      </div>
    </section>
  );
}
