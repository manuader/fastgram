"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Select,
  Spinner,
} from "@fastgram/ui";
import type { AdConnection } from "@fastgram/contracts";
import { useState } from "react";
import { tw } from "@/lib/i18n/t";
import {
  reasonOf,
  useAdConnectionOptions,
  useConnectAdsDemo,
  useDisconnectAds,
  useSelectAdAccount,
  useStartAdsLogin,
} from "./api";
import { reasonKey } from "./present";

function ErrorLine({ error }: { readonly error: unknown }) {
  if (error === null || error === undefined) return null;
  const key = reasonKey(reasonOf(error));
  return (
    <p role="alert" className="text-sm text-danger">
      {tw(key ?? "ads.error.generic")}
    </p>
  );
}

/**
 * Sin cuenta publicitaria (o vencida): qué hay que conectar y por qué, con la
 * URL de redirect que hay que cargar en la app de Meta. Y el modo demo.
 */
export function ConnectAds({ connection }: { readonly connection: AdConnection }) {
  const login = useStartAdsLogin();
  const demo = useConnectAdsDemo();
  const expired = connection.status === "expired";
  return (
    <EmptyState
      bordered
      title={tw(expired ? "ads.connect.expiredTitle" : "ads.connect.title")}
      description={tw("ads.connect.description")}
      action={
        <Button
          onClick={() => login.mutate()}
          disabled={!connection.appConfigured || login.isPending}
        >
          {login.isPending ? <Spinner size="sm" aria-hidden="true" /> : null}
          {tw("ads.connect.cta")}
        </Button>
      }
      secondaryAction={
        <Button
          variant="secondary"
          onClick={() => demo.mutate()}
          disabled={demo.isPending}
        >
          {tw("ads.connect.demo")}
        </Button>
      }
    >
      <div className="mt-3 flex flex-col gap-2 text-left text-sm text-text-muted">
        {!connection.appConfigured && (
          <p className="text-warning">{tw("ads.connect.noApp")}</p>
        )}
        <p>{tw("ads.connect.redirect")}</p>
        <code className="break-all rounded bg-surface-sunken px-2 py-1 text-xs">
          {connection.redirectUri}
        </code>
        <p>{tw("ads.connect.permissions")}</p>
        <p>{tw("ads.connect.demoNote")}</p>
        <ErrorLine error={login.error ?? demo.error} />
      </div>
    </EmptyState>
  );
}

/** Después del login: elegir cuenta publicitaria y Página (con su IG). */
export function PickAdAccount() {
  const options = useAdConnectionOptions(true);
  const select = useSelectAdAccount();
  const [account, setAccount] = useState("");
  const [page, setPage] = useState("");

  if (options.isPending)
    return (
      <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
        <Spinner size="sm" aria-hidden="true" />
        {tw("ads.pick.loading")}
      </p>
    );
  if (options.isError)
    return (
      <div className="flex flex-col gap-2">
        <ErrorLine error={options.error} />
        <Button variant="secondary" onClick={() => void options.refetch()}>
          {tw("ads.retry")}
        </Button>
      </div>
    );
  const { adAccounts, pages } = options.data;
  if (adAccounts.length === 0 || pages.length === 0)
    return (
      <EmptyState
        bordered
        title={tw("ads.pick.noneTitle")}
        description={tw("ads.pick.noneDescription")}
      />
    );
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">{tw("ads.pick.title")}</h2>
        <label className="flex flex-col gap-1 text-sm">
          {tw("ads.pick.account")}
          <Select
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder={tw("ads.pick.accountPlaceholder")}
            options={adAccounts.map((a) => ({
              value: a.id,
              label: `${a.name} · ${a.currency}${a.accountStatus === 1 ? "" : ` · ${tw("ads.pick.inactive")}`}`,
            }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {tw("ads.pick.page")}
          <Select
            value={page}
            onChange={(e) => setPage(e.target.value)}
            placeholder={tw("ads.pick.pagePlaceholder")}
            options={pages.map((p) => ({
              value: p.id,
              label:
                p.instagramUsername === null
                  ? p.name
                  : `${p.name} · @${p.instagramUsername}`,
            }))}
          />
        </label>
        <ErrorLine error={select.error} />
        <div>
          <Button
            disabled={account === "" || page === "" || select.isPending}
            onClick={() => select.mutate({ adAccountId: account, pageId: page })}
          >
            {tw("ads.pick.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Cuenta conectada: qué es, y desconectar. */
export function ConnectedAccount({ connection }: { readonly connection: AdConnection }) {
  const disconnect = useDisconnectAds();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
      {connection.demo && <Badge tone="info">{tw("ads.demo.badge")}</Badge>}
      <span>
        {connection.adAccount?.name} · {connection.adAccount?.currency}
        {connection.page === null ? "" : ` · ${connection.page.name}`}
        {connection.instagram?.username == null
          ? ""
          : ` · @${connection.instagram.username}`}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => disconnect.mutate()}
        disabled={disconnect.isPending}
      >
        {tw("ads.connect.disconnect")}
      </Button>
      <ErrorLine error={disconnect.error} />
    </div>
  );
}
