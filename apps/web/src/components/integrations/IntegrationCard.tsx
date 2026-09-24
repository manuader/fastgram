"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  useToast,
} from "@fastgram/ui";
import { useEffect, useId, useState } from "react";
import type { IntegrationApp } from "@fastgram/contracts";
import { copyKeyForError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { useRemoveIntegration, useSaveIntegration } from "@/lib/integrations/api";
import { INTEGRATIONS_COPY as C } from "@/lib/integrations/copy";

export interface IntegrationCardProps {
  readonly app: IntegrationApp;
}

/**
 * Una app de desarrollador — `PU-PUB-002`.
 *
 * Client id + secret (el secret nunca vuelve: sólo sus últimos cuatro), la
 * redirect URI exacta para copiar a la consola, los permisos que se piden y
 * el aviso de https donde la plataforma lo exige.
 */
export function IntegrationCard({ app }: IntegrationCardProps) {
  const ids = { clientId: useId(), secret: useId() };
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const save = useSaveIntegration(app.platform);
  const remove = useRemoveIntegration(app.platform);
  const { toast } = useToast();

  // Lo guardado cambió (este guardado u otra pestaña): se vuelve a sembrar.
  useEffect(() => {
    setClientId(app.clientId ?? "");
  }, [app.clientId]);

  const clientIdError = touched && clientId.trim() === "" ? C.errorClientId : undefined;
  const dirty = clientId.trim() !== (app.clientId ?? "") || secret.trim() !== "";

  const onSave = () => {
    setTouched(true);
    if (clientId.trim() === "") return;
    save.mutate(
      {
        clientId: clientId.trim(),
        ...(secret.trim() === "" ? {} : { clientSecret: secret.trim() }),
      },
      {
        onSuccess: () => {
          // El secret tipeado se olvida: el servidor no lo devuelve y acá no se guarda.
          setSecret("");
          setTouched(false);
          toast({ title: `${app.label}: ${C.saved}`, tone: "success", duration: 2500 });
        },
        onError: (error) => {
          toast({
            title: app.label,
            description: tw(copyKeyForError(error)),
            tone: "danger",
          });
        },
      },
    );
  };

  const onCopy = () => {
    void navigator.clipboard?.writeText(app.redirectUri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card data-testid={`integration-${app.platform}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{app.label}</CardTitle>
          <Badge tone={app.configured ? "success" : "neutral"} size="sm">
            {app.configured ? C.configured : C.notConfigured}
          </Badge>
        </div>
        <CardDescription>{app.setupNote}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.clientId} className="text-sm font-medium text-text">
            {app.platform === "tiktok" ? C.clientIdTiktok : C.clientId}
          </label>
          <Input
            id={ids.clientId}
            value={clientId}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={clientIdError !== undefined}
            aria-describedby={
              clientIdError === undefined ? undefined : `${ids.clientId}-error`
            }
            onChange={(e) => setClientId(e.target.value)}
          />
          {clientIdError !== undefined && (
            <p id={`${ids.clientId}-error`} className="m-0 text-xs text-danger">
              {clientIdError}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.secret} className="text-sm font-medium text-text">
            {C.clientSecret}
          </label>
          <Input
            id={ids.secret}
            type="password"
            value={secret}
            autoComplete="new-password"
            placeholder={
              app.hasSecret ? C.secretSaved(app.secretLast4) : C.secretPlaceholder
            }
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">{C.redirectLabel}</span>
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-surface px-2 py-1 text-xs"
              data-testid={`redirect-${app.platform}`}
            >
              {app.redirectUri}
            </code>
            <Button variant="secondary" size="sm" onClick={onCopy}>
              {copied ? C.copied : C.copy}
            </Button>
          </div>
          {!app.redirectAllowed ? (
            <p className="m-0 text-xs text-danger" role="alert">
              {C.httpsRequired}
            </p>
          ) : app.https === "recommended" && !app.redirectUri.startsWith("https://") ? (
            <p className="m-0 text-xs text-text-muted">{C.httpsRecommended}</p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">{C.scopesLabel}</span>
          <p className="m-0 text-xs text-text-muted">{app.scopes.join(", ")}</p>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-2">
        <Button
          onClick={onSave}
          disabled={save.isPending || !dirty}
          aria-busy={save.isPending}
        >
          {save.isPending ? C.saving : C.save}
        </Button>
        {app.clientId !== null && (
          <Button
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(C.removeConfirm)) remove.mutate();
            }}
          >
            {C.remove}
          </Button>
        )}
        <a
          className="text-sm"
          href={app.consoleUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {C.openConsole}
        </a>
        <a
          className="text-sm"
          href={app.docsUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          {C.openDocs}
        </a>
      </CardFooter>
    </Card>
  );
}
