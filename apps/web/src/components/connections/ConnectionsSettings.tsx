"use client";

import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  useToast,
} from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import type { ConnectionAccount, IntegrationApp } from "@fastgram/contracts";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { isApiRequestError } from "@/lib/api/errors";
import {
  useConnectionAccounts,
  useDisconnect,
  useRefreshConnection,
  useStartConnection,
} from "@/lib/connections/api";
import {
  OAUTH_PLATFORM_IDS,
  isOAuthPlatformId,
  type OAuthPlatformId,
} from "@/lib/connections/callback";
import {
  CONNECTIONS_COPY as C,
  PLATFORM_HINT,
  PLATFORM_LABEL,
  STATUS_COPY,
  YOUTUBE_AUDIT_WARNING,
  reasonCopy,
} from "@/lib/connections/copy";
import { useIntegrations } from "@/lib/integrations/api";
import { FacebookPagePicker } from "./FacebookPagePicker";

/** Lo que trae la query tras volver del callback (`lib/connections/callback.ts`). */
export interface CallbackNotice {
  readonly connected?: string | undefined;
  readonly select?: string | undefined;
  readonly error?: string | undefined;
  readonly platform?: string | undefined;
}

export interface ConnectionsSettingsProps {
  readonly notice?: CallbackNotice;
}

function reasonOf(error: unknown): string | null {
  if (!isApiRequestError(error)) return null;
  const r = error.details?.["reason"];
  return typeof r === "string" ? r : null;
}

function handleOf(a: ConnectionAccount): string {
  // Páginas y perfiles de LinkedIn se muestran por nombre, no por @handle.
  return a.platform === "facebook" || a.platform === "linkedin"
    ? a.username
    : `@${a.username}`;
}

function AccountRow({ account }: { account: ConnectionAccount }) {
  const start = useStartConnection();
  const disconnect = useDisconnect();
  const refresh = useRefreshConnection();
  const { toast } = useToast();
  const status = STATUS_COPY[account.status];
  const label = isOAuthPlatformId(account.platform)
    ? PLATFORM_LABEL[account.platform]
    : account.platform;
  const needsReconnect = account.status === "expired" || account.status === "paused";
  const permissionsMissing = account.status === "active" && !account.publishable;
  const canReconnect = isOAuthPlatformId(account.platform);

  return (
    <li
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3"
      data-testid={`account-${account._id}`}
    >
      <Avatar
        name={account.displayName ?? account.username}
        {...(account.avatarUrl === null ? {} : { src: account.avatarUrl })}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-text">
          {account.displayName ?? account.username}
        </span>
        <span className="truncate text-sm text-text-muted">
          {label} · {handleOf(account)}
        </span>
        {permissionsMissing && (
          <span className="text-xs text-warning">{C.permissionsMissing}</span>
        )}
        {account.platform === "youtube" && account.status === "active" && (
          <span className="text-xs text-warning" data-testid="youtube-audit-warning">
            {YOUTUBE_AUDIT_WARNING}
          </span>
        )}
        {account.status === "active" && (
          <span className="text-xs text-text-muted">
            {account.tokenExpiresAt === null
              ? C.noExpiry
              : C.expiresOn(new Date(account.tokenExpiresAt).toLocaleDateString())}
          </span>
        )}
      </div>
      <Badge tone={status.tone} size="sm">
        {status.label}
      </Badge>
      <div className="flex flex-wrap gap-2">
        {canReconnect &&
          (needsReconnect || permissionsMissing || account.status === "revoked") && (
            <Button
              size="sm"
              disabled={start.isPending}
              onClick={() => {
                if (isOAuthPlatformId(account.platform)) start.mutate(account.platform);
              }}
            >
              {C.reconnect}
            </Button>
          )}
        {account.status === "active" && (
          <Button
            size="sm"
            variant="secondary"
            disabled={refresh.isPending}
            aria-busy={refresh.isPending}
            onClick={() =>
              refresh.mutate(account._id, {
                onSuccess: () =>
                  toast({ title: C.refreshed, tone: "success", duration: 2500 }),
                onError: (e) =>
                  toast({
                    title: label,
                    description: reasonCopy(reasonOf(e)),
                    tone: "danger",
                  }),
              })
            }
          >
            {C.refresh}
          </Button>
        )}
        {account.status !== "revoked" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disconnect.isPending}
            onClick={() => {
              if (!window.confirm(C.disconnectConfirm(handleOf(account)))) return;
              disconnect.mutate(account._id, {
                onSuccess: () =>
                  toast({ title: C.disconnected, tone: "success", duration: 2500 }),
              });
            }}
          >
            {C.disconnect}
          </Button>
        )}
      </div>
    </li>
  );
}

function ConnectButtons({ apps }: { apps: readonly IntegrationApp[] | undefined }) {
  const start = useStartConnection();
  const [pending, setPending] = useState<OAuthPlatformId | null>(null);
  const failedReason = start.isError ? reasonOf(start.error) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {OAUTH_PLATFORM_IDS.map((platform) => {
          const app = apps?.find((a) => a.platform === platform);
          const ready = app?.configured === true && app.redirectAllowed;
          return (
            <Card key={platform} data-testid={`connect-${platform}`}>
              <CardHeader>
                <CardTitle>{PLATFORM_LABEL[platform]}</CardTitle>
                <CardDescription>{PLATFORM_HINT[platform]}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <Button
                  disabled={!ready || start.isPending}
                  aria-busy={pending === platform && start.isPending}
                  onClick={() => {
                    setPending(platform);
                    start.mutate(platform);
                  }}
                >
                  {pending === platform && start.isPending
                    ? C.connecting
                    : C.connect(PLATFORM_LABEL[platform])}
                </Button>
                {apps !== undefined && !ready && (
                  <p className="m-0 text-xs text-text-muted">
                    {app?.configured === true
                      ? reasonCopy("https_redirect_required")
                      : C.setupFirst}{" "}
                    <Link href="/settings/integrations">{C.setupLink}</Link>
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      {start.isError && (
        <p className="m-0 text-sm text-danger" role="alert">
          {reasonCopy(failedReason)}
        </p>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton height={56} />
      <Skeleton height={56} />
    </div>
  );
}

/**
 * Settings → Connections — `PU-PUB-002`, `P3-OAUTH-008`, PRD §19.5.
 *
 * Las cuentas **de la marca activa**: conectar (un botón por red, deshabilitado
 * hasta que la app esté cargada en Integrations), estado con el copy de
 * §19.5, reconectar, comprobar (fuerza un refresco) y desconectar. Al volver
 * del callback muestra el resultado (o el selector de Página de Facebook).
 */
export function ConnectionsSettings({ notice = {} }: ConnectionsSettingsProps) {
  const accounts = useConnectionAccounts();
  const integrations = useIntegrations();
  const [dismissed, setDismissed] = useState(false);
  const selecting = !dismissed && notice.select !== undefined ? notice.select : null;

  const banner =
    notice.connected !== undefined && isOAuthPlatformId(notice.connected) ? (
      <p className="m-0 rounded-md bg-surface p-3 text-sm text-success" role="status">
        {C.connectedBanner(PLATFORM_LABEL[notice.connected])}
      </p>
    ) : notice.error !== undefined ? (
      <p className="m-0 rounded-md bg-surface p-3 text-sm text-danger" role="alert">
        {notice.platform !== undefined && isOAuthPlatformId(notice.platform)
          ? `${PLATFORM_LABEL[notice.platform]}: `
          : ""}
        {reasonCopy(notice.error)}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-8">
      {banner}
      {selecting !== null && (
        <FacebookPagePicker
          selectionId={selecting}
          platform={notice.platform === "linkedin" ? "linkedin" : "facebook"}
          onDone={() => setDismissed(true)}
        />
      )}

      <section aria-labelledby="connections-accounts" className="flex flex-col gap-3">
        <h2 id="connections-accounts" className="m-0 text-lg font-semibold text-text">
          {C.connectedSection}
        </h2>
        {accounts.isError ? (
          <ApiErrorState
            error={accounts.error}
            onRetry={() => {
              void accounts.refetch();
            }}
          />
        ) : accounts.isPending ? (
          <ListSkeleton />
        ) : accounts.data.length === 0 ? (
          <EmptyState size="sm" title={C.emptyTitle} description={C.emptyBody} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {accounts.data.map((a) => (
              <AccountRow key={a._id} account={a} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="connections-connect" className="flex flex-col gap-3">
        <h2 id="connections-connect" className="m-0 text-lg font-semibold text-text">
          {C.connectSection}
        </h2>
        {integrations.isError ? (
          <ApiErrorState
            error={integrations.error}
            onRetry={() => {
              void integrations.refetch();
            }}
          />
        ) : (
          <ConnectButtons apps={integrations.data?.apps} />
        )}
      </section>
    </div>
  );
}
