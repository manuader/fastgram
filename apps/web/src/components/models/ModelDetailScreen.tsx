"use client";

import { Badge, Button, Skeleton } from "@fastgram/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { UserIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { FAILURE_COPY, STATUS_COPY } from "@/lib/influencers/form";
import { ROUTES } from "@/lib/nav/routes";
import { isTraining, useCharacterModel, useDeleteModel } from "./api";
import { BrandsSection, DetailsSection, VoiceSection } from "./ModelSettings";
import { TalkingHeadPanel } from "@/components/studio/generative";
import { UgcPanel } from "./UgcPanel";

const SOURCE_COPY = {
  photos: "charModels.source.photos",
  soul_id: "charModels.source.soul",
  influencer: "charModels.source.influencer",
} as const;

/**
 * `/models/:modelId` — el detalle de un modelo de la biblioteca: retrato y
 * estado, detalles (notas que usa `JV-6`), voz (fal), asignación a marcas y
 * «Generate UGC for <marca>». Estados: cargando, error (404 incluido) y
 * entrenando (con avance).
 */
export function ModelDetailScreen({ modelId }: { readonly modelId: string }) {
  const router = useRouter();
  const query = useCharacterModel(modelId);
  const remove = useDeleteModel(modelId);
  const [confirming, setConfirming] = useState(false);

  const back = (
    <Link href={ROUTES.models} className="text-sm text-text-muted hover:text-text">
      {tw("charModels.back")}
    </Link>
  );

  if (query.isError) {
    return (
      <div className="fgw-page flex flex-col gap-4">
        {back}
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div className="fgw-page flex flex-col gap-4" aria-busy="true">
        {back}
        <Skeleton className="h-64 w-48 rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const model = query.data;
  const tone =
    model.status === "ready" ? "success" : model.status === "failed" ? "danger" : "info";

  return (
    <div className="fgw-page flex flex-col gap-8">
      {back}
      <header className="flex flex-wrap items-start gap-6">
        <div className="aspect-[3/4] w-40 overflow-hidden rounded-2xl bg-surface-sunken">
          {model.portraitUrl === "" ? (
            <div className="flex h-full items-center justify-center text-text-subtle">
              <UserIcon size={32} />
            </div>
          ) : (
            <img src={model.portraitUrl} alt="" className="h-full w-full object-cover" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="m-0 text-3xl font-semibold tracking-tight text-text">
            {model.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{tw(STATUS_COPY[model.status])}</Badge>
            <span className="text-xs text-text-muted">
              {tw(SOURCE_COPY[model.source])}
            </span>
          </div>
          {isTraining(model) && (
            <p className="m-0 text-sm text-text-muted" role="status">
              {tw("charModels.training", { progress: model.progress })}
            </p>
          )}
          {model.failure !== null && (
            <p className="m-0 text-sm text-danger" role="alert">
              {tw(FAILURE_COPY[model.failure.code])}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            {confirming ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() => {
                    remove.mutate(undefined, {
                      onSuccess: () => {
                        router.push(ROUTES.models);
                      },
                    });
                  }}
                >
                  {tw("charModels.delete.confirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  {tw("charModels.cancel")}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {tw("charModels.delete.open")}
              </Button>
            )}
          </div>
          {confirming && (
            <p className="m-0 text-xs text-text-muted">{tw("charModels.delete.body")}</p>
          )}
          {remove.isError && (
            <p className="m-0 text-sm text-danger" role="alert">
              {remove.error.serverMessage ?? tw("charModels.saveFailed")}
            </p>
          )}
        </div>
      </header>
      <UgcPanel model={model} />
      {/* Sprint 8 (P4-INFL-011): el modelo hablando a cámara, con su voz. */}
      {model.status === "ready" && <TalkingHeadPanel characterModelId={model.id} />}
      <div className="grid gap-8 lg:grid-cols-2">
        <BrandsSection key={`b-${model.brandIds.join()}`} model={model} />
        <VoiceSection key={`v-${model.updatedAt}`} model={model} />
      </div>
      <DetailsSection key={`d-${model.updatedAt}`} model={model} />
    </div>
  );
}
