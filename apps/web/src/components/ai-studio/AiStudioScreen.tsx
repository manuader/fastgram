"use client";

import { EmptyState, Skeleton, buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { CpuIcon, WandIcon } from "@/icons";
import { useAiStudioOptions, useGenerations } from "@/lib/ai-studio/api";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { Composer } from "./Composer";
import { GenerationCard } from "./GenerationCard";

function ComposerSkeleton() {
  return (
    <div
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5"
      aria-busy="true"
    >
      <Skeleton shape="text" width="40%" />
      <Skeleton height={36} />
      <Skeleton height={96} />
      <Skeleton height={36} />
      <Skeleton height={120} />
      <Skeleton height={44} />
    </div>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-3" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="rounded-2xl" height={260} />
      ))}
    </div>
  );
}

/**
 * AI Studio — `PU-LATER-005` (FR-090 adaptado al plan de uso personal, §4).
 *
 * A la izquierda, el panel para pedir (con el costo antes de generar); a la
 * derecha, la galería de la marca, que se refresca sola mientras algo está en
 * cola o generando. Estados: sin modelos configurados (lleva a Settings →
 * Models), cargando (esqueletos con la forma final), error (con reintento) y
 * galería vacía (ERR-E01).
 */
export function AiStudioScreen() {
  const options = useAiStudioOptions();
  const gallery = useGenerations();

  const header = (
    <header className="mb-6 flex flex-col gap-1">
      <h1 className="m-0 text-3xl font-semibold tracking-tight text-text">
        {tw("aiStudio.title")}
      </h1>
      <p className="m-0 max-w-2xl text-sm text-text-muted">{tw("aiStudio.subtitle")}</p>
    </header>
  );

  if (options.isError) {
    return (
      <div className="fgw-page">
        {header}
        <ApiErrorState
          error={options.error}
          onRetry={() => {
            void options.refetch();
          }}
        />
      </div>
    );
  }

  const nothingConfigured =
    options.data !== undefined &&
    !options.data.image.configured &&
    !options.data.video.configured;

  if (nothingConfigured) {
    return (
      <div className="fgw-page">
        {header}
        <EmptyState
          icon={<CpuIcon size={20} />}
          title={tw("aiStudio.setup.title")}
          description={tw("aiStudio.setup.body")}
          action={
            <Link
              href={ROUTES.settingsModels}
              className={buttonVariants({ variant: "primary", size: "md" })}
            >
              {tw("aiStudio.setup.action")}
            </Link>
          }
        />
      </div>
    );
  }

  const items = gallery.data ?? [];

  return (
    <div className="fgw-page">
      {header}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-6">
          {options.data === undefined ? (
            <ComposerSkeleton />
          ) : (
            <Composer options={options.data} />
          )}
        </div>

        <section
          aria-labelledby="ai-studio-gallery"
          className="flex min-w-0 flex-col gap-4"
        >
          <h2 id="ai-studio-gallery" className="m-0 text-lg font-semibold text-text">
            {tw("aiStudio.gallery.title")}
          </h2>
          {gallery.isError ? (
            <ApiErrorState
              error={gallery.error}
              onRetry={() => {
                void gallery.refetch();
              }}
            />
          ) : gallery.isPending ? (
            <GallerySkeleton />
          ) : items.length === 0 ? (
            <EmptyState preset="ERR-E01" icon={<WandIcon size={20} />} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((g) => (
                <GenerationCard key={g.id} generation={g} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
