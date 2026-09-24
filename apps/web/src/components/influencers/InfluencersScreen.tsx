"use client";

import { Button, EmptyState, Skeleton, buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { CpuIcon, PlusIcon, UserIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { useInfluencerSetup, useInfluencers } from "@/lib/influencers/api";
import { ROUTES } from "@/lib/nav/routes";
import { InfluencerCard } from "./InfluencerCard";
import { NewInfluencerWizard } from "./NewInfluencerWizard";

/**
 * `/influencers` — F-090 y FR-080 adaptados (`PU-LATER-004`): la grilla de
 * personajes con su estado y avance, y el wizard para crear uno. Estados:
 * sin Higgsfield (lleva a Settings → Models), cargando, error y vacío.
 */
export function InfluencersScreen() {
  const setup = useInfluencerSetup();
  const list = useInfluencers();
  const [wizardOpen, setWizardOpen] = useState(false);

  const header = (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-3xl font-semibold tracking-tight text-text">
          {tw("influencers.title")}
        </h1>
        <p className="m-0 max-w-2xl text-sm text-text-muted">
          {tw("influencers.subtitle")}
        </p>
      </div>
      {setup.data?.configured === true && (
        <Button
          leadingIcon={<PlusIcon size={16} />}
          onClick={() => {
            setWizardOpen(true);
          }}
        >
          {tw("influencers.new")}
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
            title={tw("influencers.setup.title")}
            description={tw("influencers.setup.body")}
            action={
              <Link
                href={ROUTES.settingsModels}
                className={buttonVariants({ variant: "primary", size: "md" })}
              >
                {tw("influencers.setup.action")}
              </Link>
            }
          />
        </div>
      )}
      {setup.data?.configured === true && !setup.data.canCreate && (
        <p className="mb-4 text-sm text-warning" role="status">
          {tw("influencers.budget.exhausted")}
        </p>
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
            title={tw("influencers.empty.title")}
            description={tw("influencers.empty.body")}
          />
        )
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
          {items.map((inf) => (
            <InfluencerCard key={inf._id} influencer={inf} />
          ))}
        </div>
      )}
      {setup.data !== undefined && (
        <NewInfluencerWizard
          open={wizardOpen}
          onClose={() => {
            setWizardOpen(false);
          }}
          setup={setup.data}
        />
      )}
    </div>
  );
}
