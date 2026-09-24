"use client";

import type { InfluencerConfig, InfluencerConfigView } from "@fastgram/contracts";
import { INFLUENCER_MAX_ANGLES } from "@fastgram/contracts";
import { Checkbox, Skeleton } from "@fastgram/ui";
import type { ReactNode } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { CheckIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { useInfluencerConfig, useSaveInfluencerConfig } from "./api";

/** Marca o desmarca un id en una lista (sin repetir). */
export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Activa o apaga una cuenta; una cuenta que no estaba entra activa. */
export function toggleAccount(
  accounts: InfluencerConfig["publishingAccounts"],
  account: { readonly connectionId: string; readonly platform: string },
): InfluencerConfig["publishingAccounts"] {
  const found = accounts.find((a) => a.connectionId === account.connectionId);
  if (found === undefined) return [...accounts, { ...account, enabled: true }];
  return accounts.map((a) =>
    a.connectionId === account.connectionId ? { ...a, enabled: !a.enabled } : a,
  );
}

function Section({
  title,
  hint,
  empty,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly empty: string | null;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-base font-semibold text-text">{title}</h3>
        <p className="m-0 text-xs text-text-subtle">{hint}</p>
      </div>
      {empty !== null ? <p className="m-0 text-sm text-text-muted">{empty}</p> : children}
    </section>
  );
}

/**
 * Tab `Configuration` — `FR-083` (F-101…F-103): ángulos, cuentas por
 * plataforma y sets de imagen y video. Auto-guardado: cada cambio es un `PUT`
 * con lo que cambió, y el banner dice cuándo quedó guardado.
 */
export function ConfigurationPanel({ influencerId }: { readonly influencerId: string }) {
  const query = useInfluencerConfig(influencerId);
  const save = useSaveInfluencerConfig(influencerId);

  if (query.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={160} className="rounded-2xl" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <ApiErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const view: InfluencerConfigView = query.data;
  const { config, options } = view;
  const put = (patch: Partial<InfluencerConfig>) => {
    save.mutate(patch);
  };
  const byPlatform = new Map<string, typeof options.accounts>();
  for (const a of options.accounts) {
    byPlatform.set(a.platform, [...(byPlatform.get(a.platform) ?? []), a]);
  }
  const slideshowSets = options.sets.filter((s) => s.kind !== "VIDEO");
  const videoSets = options.sets.filter((s) => s.kind !== "SLIDESHOW");
  const anglesFull = config.angleIds.length >= INFLUENCER_MAX_ANGLES;

  return (
    <div className="flex flex-col gap-4">
      <p
        className="m-0 flex items-center gap-1 text-sm"
        aria-live="polite"
        data-testid="influencer-config-status"
      >
        {save.isPending ? (
          <span className="text-text-muted">{tw("influencers.config.saving")}</span>
        ) : save.isError ? (
          <span className="text-danger" role="alert">
            {save.error.serverMessage ?? tw("influencers.config.saveError")}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-success">
            <CheckIcon size={14} />
            {tw("influencers.config.saved")}
          </span>
        )}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title={tw("influencers.config.angles")}
          hint={tw("influencers.config.anglesHint", { max: INFLUENCER_MAX_ANGLES })}
          empty={
            options.angles.length === 0 ? tw("influencers.config.anglesEmpty") : null
          }
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {options.angles.map((a) => {
              const on = config.angleIds.includes(a.id);
              return (
                <li key={a.id}>
                  <Checkbox
                    checked={on}
                    disabled={save.isPending || (!on && anglesFull)}
                    label={a.title}
                    onChange={() => {
                      put({ angleIds: toggleId(config.angleIds, a.id) });
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </Section>
        <Section
          title={tw("influencers.config.accounts")}
          hint={tw("influencers.config.accountsHint")}
          empty={
            options.accounts.length === 0 ? tw("influencers.config.accountsEmpty") : null
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {[...byPlatform.entries()].map(([platform, accounts]) => (
              <div key={platform} className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {platform}
                </span>
                {accounts.map((a) => (
                  <Checkbox
                    key={a.connectionId}
                    checked={
                      config.publishingAccounts.find(
                        (x) => x.connectionId === a.connectionId,
                      )?.enabled ?? false
                    }
                    disabled={save.isPending}
                    label={a.displayName ?? a.username ?? a.connectionId.slice(0, 8)}
                    onChange={() => {
                      put({
                        publishingAccounts: toggleAccount(config.publishingAccounts, a),
                      });
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </Section>
        <Section
          title={tw("influencers.config.slideshowSets")}
          hint={tw("influencers.config.slideshowSetsHint")}
          empty={slideshowSets.length === 0 ? tw("influencers.config.setsEmpty") : null}
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {slideshowSets.map((s) => (
              <li key={s.id}>
                <Checkbox
                  checked={config.slideshowSetIds.includes(s.id)}
                  disabled={save.isPending}
                  label={tw("influencers.config.set", {
                    name: s.name,
                    count: s.mediaCount,
                  })}
                  onChange={() => {
                    put({ slideshowSetIds: toggleId(config.slideshowSetIds, s.id) });
                  }}
                />
              </li>
            ))}
          </ul>
        </Section>
        <Section
          title={tw("influencers.config.videoSets")}
          hint={tw("influencers.config.videoSetsHint")}
          empty={videoSets.length === 0 ? tw("influencers.config.setsEmpty") : null}
        >
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {videoSets.map((s) => (
              <li key={s.id}>
                <Checkbox
                  checked={config.videoSetIds.includes(s.id)}
                  disabled={save.isPending}
                  label={tw("influencers.config.set", {
                    name: s.name,
                    count: s.mediaCount,
                  })}
                  onChange={() => {
                    put({ videoSetIds: toggleId(config.videoSetIds, s.id) });
                  }}
                />
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
