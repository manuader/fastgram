"use client";

import type { CharacterModel } from "@fastgram/contracts";
import { Badge, Button, EmptyState, Skeleton, buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { CpuIcon, PlusIcon, UserIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { FAILURE_COPY, STATUS_COPY } from "@/lib/influencers/form";
import { ROUTES } from "@/lib/nav/routes";
import { isTraining, useCharacterModelSetup, useCharacterModels } from "./api";
import { ImportModelDialog } from "./ImportModelDialog";

/** Nombres de las marcas asignadas, en el orden del selector. */
export function brandNames(
  brandIds: readonly string[],
  workspaces: readonly { readonly id: string; readonly name: string }[],
): string[] {
  return workspaces.filter((w) => brandIds.includes(w.id)).map((w) => w.name);
}

function ModelCard({
  model,
  workspaces,
}: {
  readonly model: CharacterModel;
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
}) {
  const names = brandNames(model.brandIds, workspaces);
  const tone =
    model.status === "ready" ? "success" : model.status === "failed" ? "danger" : "info";
  return (
    <Link
      href={`${ROUTES.models}/${model.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:border-border-strong"
      data-testid="model-card"
    >
      <div className="relative aspect-[3/4] w-full bg-surface-sunken">
        {model.portraitUrl === "" ? (
          <div className="flex h-full items-center justify-center text-text-subtle">
            <UserIcon size={32} />
          </div>
        ) : (
          <img
            src={model.portraitUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        )}
        {isTraining(model) && (
          <div
            className="absolute inset-x-0 bottom-0 h-1.5 bg-surface/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={model.progress}
            aria-label={tw(STATUS_COPY.training)}
          >
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${String(model.progress)}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold text-text">{model.name}</span>
          <Badge tone={tone} size="sm">
            {tw(STATUS_COPY[model.status])}
          </Badge>
        </div>
        <span className="truncate text-xs text-text-muted">
          {names.length === 0
            ? tw("charModels.brands.none")
            : tw("charModels.brands.list", { brands: names.join(", ") })}
        </span>
        {model.voice !== null && (
          <span className="truncate text-xs text-text-subtle">
            {tw("charModels.voice.short", { voice: model.voice.voiceId })}
          </span>
        )}
        {model.failure !== null && (
          <span className="text-xs text-danger">
            {tw(FAILURE_COPY[model.failure.code])}
          </span>
        )}
      </div>
    </Link>
  );
}

/**
 * `/models` — la biblioteca de modelos del dueño (sprint 8, K). Se ve igual
 * en cualquier marca: los modelos son del dueño y se asignan a marcas.
 * Estados: sin Higgsfield (lleva a Settings → Models), cargando, error y vacío.
 */
export function ModelsScreen() {
  const router = useRouter();
  const setup = useCharacterModelSetup();
  const list = useCharacterModels();
  const { workspaces } = useWorkspace();
  const [importOpen, setImportOpen] = useState(false);

  const header = (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-3xl font-semibold tracking-tight text-text">
          {tw("charModels.title")}
        </h1>
        <p className="m-0 max-w-2xl text-sm text-text-muted">
          {tw("charModels.subtitle")}
        </p>
      </div>
      {setup.data?.configured === true && (
        <Button
          leadingIcon={<PlusIcon size={16} />}
          onClick={() => {
            setImportOpen(true);
          }}
        >
          {tw("charModels.import.open")}
        </Button>
      )}
    </header>
  );

  const error = setup.error ?? list.error;
  if (error !== null) {
    return (
      <div className="fgw-page">
        {header}
        <ApiErrorState
          error={error}
          onRetry={() => {
            void setup.refetch();
            void list.refetch();
          }}
        />
      </div>
    );
  }

  const items = list.data ?? [];
  const notConfigured = setup.data !== undefined && !setup.data.configured;

  return (
    <div className="fgw-page">
      {header}
      {notConfigured && (
        <div className="mb-6">
          <EmptyState
            icon={<CpuIcon size={20} />}
            title={tw("charModels.setup.title")}
            description={tw("charModels.setup.body")}
            action={
              <Link
                href={ROUTES.settingsModels}
                className={buttonVariants({ variant: "primary", size: "md" })}
              >
                {tw("charModels.setup.action")}
              </Link>
            }
          />
        </div>
      )}
      {list.isPending || setup.isPending ? (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5"
          aria-busy="true"
        >
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4] rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        notConfigured ? null : (
          <EmptyState
            icon={<UserIcon size={20} />}
            title={tw("charModels.empty.title")}
            description={tw("charModels.empty.body")}
          />
        )
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {items.map((m) => (
            <ModelCard key={m.id} model={m} workspaces={workspaces.data ?? []} />
          ))}
        </div>
      )}
      {setup.data !== undefined && (
        <ImportModelDialog
          open={importOpen}
          setup={setup.data}
          onClose={() => {
            setImportOpen(false);
          }}
          onImported={(model) => {
            router.push(`${ROUTES.models}/${model.id}`);
          }}
        />
      )}
    </div>
  );
}
