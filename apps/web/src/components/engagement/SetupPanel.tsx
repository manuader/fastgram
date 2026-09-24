"use client";

import type { EngagementOverview, EngagementSettings } from "@fastgram/contracts";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Switch,
  Textarea,
  useToast,
} from "@fastgram/ui";
import { useState, type FormEvent } from "react";
import { tw } from "@/lib/i18n/t";
import {
  useConnectReddit,
  useDisconnectReddit,
  useSaveRedditApp,
  useSaveSettings,
} from "@/lib/engagement/api";
import { reasonKey, reasonOf, splitList } from "@/lib/engagement/present";
import { isApiRequestError } from "@/lib/api/errors";

export interface SetupPanelProps {
  readonly overview: EngagementOverview;
}

/**
 * Configuración de Engagement: la app de Reddit (credenciales de la
 * instalación), la cuenta de la marca (`F-190`), subreddits y palabras clave
 * (`F-192`) y reglas de respuesta (`F-196`).
 */
export function SetupPanel({ overview }: SetupPanelProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <PolicyNotice url={overview.redditApp.policyUrl} />
        <RedditAppForm overview={overview} />
        <AccountRow overview={overview} />
      </div>
      <SettingsForm settings={overview.settings} />
    </div>
  );
}

function PolicyNotice({ url }: { readonly url: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 text-sm" role="note">
      <p className="m-0 font-medium text-text">{tw("engagement.policy.title")}</p>
      <p className="m-0 mt-1 text-text-muted">{tw("engagement.policy.body")}</p>
      <a
        className="mt-1 inline-block text-sm"
        href={url}
        target="_blank"
        rel="noreferrer noopener"
      >
        {tw("engagement.policy.link")}
      </a>
    </div>
  );
}

function RedditAppForm({ overview }: SetupPanelProps) {
  const app = overview.redditApp;
  const save = useSaveRedditApp();
  const { toast } = useToast();
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState(app.developerUsername ?? "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        clientId: clientId.trim(),
        developerUsername: username.trim(),
        ...(secret.trim() === "" ? {} : { clientSecret: secret.trim() }),
      },
      {
        onSuccess: () => {
          setSecret("");
          toast({ title: tw("engagement.app.saved"), tone: "success" });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tw("engagement.app.title")}</CardTitle>
        <CardDescription>
          {tw("engagement.app.hint")} <code className="break-all">{app.redirectUri}</code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <label className="flex flex-col gap-1 text-sm">
            {tw("engagement.app.clientId")}
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {tw("engagement.app.clientSecret")}
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={app.hasSecret ? tw("engagement.app.secretSaved") : ""}
              required={!app.hasSecret}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {tw("engagement.app.username")}
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <p className="m-0 text-xs text-text-muted">
            {tw("engagement.app.scopes", { scopes: app.scopes.join(", ") })}
          </p>
          {save.isError ? (
            <p className="m-0 text-sm text-danger" role="alert">
              {isApiRequestError(save.error) && save.error.serverMessage !== undefined
                ? save.error.serverMessage
                : tw("engagement.error.generic")}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="secondary" disabled={save.isPending}>
              {tw("engagement.app.save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AccountRow({ overview }: SetupPanelProps) {
  const connect = useConnectReddit();
  const disconnect = useDisconnectReddit();
  const account = overview.account;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-text">
          {account === null
            ? tw("engagement.noConnection")
            : tw("engagement.connectedAs", { username: account.username })}
        </span>
        {account?.status === "expired" ? (
          <span className="text-xs text-warning">{tw("engagement.expired")}</span>
        ) : null}
        {connect.isError ? (
          <span className="text-xs text-danger" role="alert">
            {tw(reasonKey(reasonOf(connect.error)))}
          </span>
        ) : null}
      </div>
      <div className="flex gap-2">
        {account === null || account.status !== "active" ? (
          <Button
            onClick={() => connect.mutate()}
            disabled={!overview.redditApp.configured || connect.isPending}
          >
            {account === null ? tw("engagement.connect") : tw("engagement.reconnect")}
          </Button>
        ) : null}
        {account !== null ? (
          <Button
            variant="ghost"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            {tw("engagement.disconnect")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SettingsForm({ settings }: { readonly settings: EngagementSettings }) {
  const save = useSaveSettings();
  const { toast } = useToast();
  const [subreddits, setSubreddits] = useState(settings.subreddits.join("\n"));
  const [keywords, setKeywords] = useState(settings.keywords.join("\n"));
  const [tone, setTone] = useState(settings.replyTone);
  const [customRules, setCustomRules] = useState(settings.customRules);
  const [allowLinks, setAllowLinks] = useState(settings.allowLinks);
  const [discoveryEnabled, setDiscoveryEnabled] = useState(settings.discoveryEnabled);

  const invalid = (() => {
    if (!save.isError) return null;
    const reason = reasonOf(save.error);
    const names = isApiRequestError(save.error)
      ? save.error.details?.["invalid"]
      : undefined;
    const list = Array.isArray(names) ? names.join(", ") : "";
    if (reason === "invalid_subreddits")
      return tw("engagement.settings.invalidSubreddits", { names: list });
    if (reason === "invalid_keywords")
      return tw("engagement.settings.invalidKeywords", { names: list });
    return tw("engagement.error.generic");
  })();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      {
        subreddits: splitList(subreddits),
        keywords: splitList(keywords),
        replyTone: tone,
        customRules,
        allowLinks,
        discoveryEnabled,
      },
      {
        onSuccess: () =>
          toast({ title: tw("engagement.settings.saved"), tone: "success" }),
      },
    );
  };

  return (
    <Card>
      <CardContent className="pt-4">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <section className="flex flex-col gap-2" aria-labelledby="eng-subreddits">
            <h3 id="eng-subreddits" className="m-0 text-base font-semibold text-text">
              {tw("engagement.settings.subredditsTitle")}
            </h3>
            <label className="flex flex-col gap-1 text-sm">
              {tw("engagement.settings.subreddits")}
              <Textarea
                rows={3}
                value={subreddits}
                onChange={(e) => setSubreddits(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {tw("engagement.settings.keywords")}
              <Textarea
                rows={3}
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={discoveryEnabled} onCheckedChange={setDiscoveryEnabled} />
              {tw("engagement.settings.discoveryEnabled")}
            </label>
          </section>
          <section className="flex flex-col gap-2" aria-labelledby="eng-reply">
            <h3 id="eng-reply" className="m-0 text-base font-semibold text-text">
              {tw("engagement.settings.replyTitle")}
            </h3>
            <label className="flex flex-col gap-1 text-sm">
              {tw("engagement.settings.tone")}
              <Select
                value={tone}
                onChange={(e) =>
                  setTone(e.target.value as EngagementSettings["replyTone"])
                }
                options={[
                  { value: "casual", label: tw("engagement.settings.tone.casual") },
                  {
                    value: "professional",
                    label: tw("engagement.settings.tone.professional"),
                  },
                  {
                    value: "friendly_expert",
                    label: tw("engagement.settings.tone.friendly_expert"),
                  },
                ]}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {tw("engagement.settings.customRules")}
              <Textarea
                rows={3}
                maxLength={2000}
                value={customRules}
                placeholder={tw("engagement.settings.customRulesPlaceholder")}
                onChange={(e) => setCustomRules(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={allowLinks} onCheckedChange={setAllowLinks} />
              {tw("engagement.settings.allowLinks")}
            </label>
          </section>
          {invalid === null ? null : (
            <p className="m-0 text-sm text-danger" role="alert">
              {invalid}
            </p>
          )}
          <div>
            <Button type="submit" disabled={save.isPending}>
              {tw("engagement.settings.save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
