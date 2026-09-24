"use client";

import type {
  NotificationCategoryId,
  NotificationChannel,
  NotificationSettingsView,
  UpdateNotificationSettingsRequest,
} from "@fastgram/contracts";
import { Button, Input, Select, Skeleton, Switch } from "@fastgram/ui";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { ApiRequestError } from "@/lib/api/errors";
import {
  useNotificationSettings,
  useSendTestNotification,
  useUpdateNotificationSettings,
} from "./api";
import { CATEGORY_LABEL, NOTIFICATIONS_COPY as C, TEST_ERROR_COPY } from "./copy";

/**
 * Settings → Notifications — `P5-NOTIF-002/003` (sprint 7).
 *
 * Preferencias por categoría (campana y push) y los dos canales de push. Los
 * secretos nunca vuelven de la API: un campo de token vacío **conserva** el
 * guardado; para borrarlo está "Remove".
 */
export function NotificationSettings() {
  const settings = useNotificationSettings();
  if (settings.isError) {
    return (
      <ApiErrorState
        error={settings.error}
        onRetry={() => {
          void settings.refetch();
        }}
      />
    );
  }
  if (settings.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton height={220} />
        <Skeleton height={160} />
      </div>
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <CategoriesSection view={settings.data} />
      <section aria-labelledby="notif-channels" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="notif-channels" className="m-0 text-lg font-semibold text-text">
            {C.channelsTitle}
          </h2>
          <p className="m-0 text-sm text-text-muted">{C.channelsHint}</p>
        </div>
        <NtfyCard view={settings.data} />
        <TelegramCard view={settings.data} />
      </section>
    </div>
  );
}

/** El 400 de la API trae un mensaje accionable ("The chat id is a number…"). */
function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 400 && error.serverMessage) {
    return error.serverMessage;
  }
  return C.saveError;
}

function CategoriesSection({ view }: { view: NotificationSettingsView }) {
  const update = useUpdateNotificationSettings();
  const hourId = useId();

  const toggle = (
    category: NotificationCategoryId,
    field: "inApp" | "push",
    value: boolean,
  ) => {
    update.mutate({ categories: [{ category, [field]: value }] });
  };

  return (
    <section aria-labelledby="notif-categories" className="flex flex-col gap-3">
      <h2 id="notif-categories" className="m-0 text-lg font-semibold text-text">
        {C.categoriesTitle}
      </h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-text-muted">
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">{C.categoriesTitle}</span>
            </th>
            <th scope="col" className="w-24 py-2 font-medium">
              {C.columnInApp}
            </th>
            <th scope="col" className="w-24 py-2 font-medium">
              {C.columnPush}
            </th>
          </tr>
        </thead>
        <tbody>
          {view.categories.map((c) => (
            <tr key={c.category} className="border-t border-border">
              <th scope="row" className="py-2 text-left font-normal text-text">
                {CATEGORY_LABEL[c.category]}
              </th>
              <td className="py-2">
                <Switch
                  checked={c.inApp}
                  aria-label={`${CATEGORY_LABEL[c.category]} — ${C.columnInApp}`}
                  disabled={update.isPending}
                  onCheckedChange={(v) => toggle(c.category, "inApp", v)}
                />
              </td>
              <td className="py-2">
                <Switch
                  checked={c.push}
                  aria-label={`${CATEGORY_LABEL[c.category]} — ${C.columnPush}`}
                  disabled={update.isPending}
                  onCheckedChange={(v) => toggle(c.category, "push", v)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3">
        <label htmlFor={hourId} className="text-sm text-text">
          {C.dailyHour}
        </label>
        <Select
          id={hourId}
          className="w-28"
          value={String(view.dailySummaryHour)}
          disabled={update.isPending}
          options={Array.from({ length: 24 }, (_, h) => ({
            value: String(h),
            label: `${String(h).padStart(2, "0")}:00`,
          }))}
          onChange={(e) => update.mutate({ dailySummaryHour: Number(e.target.value) })}
        />
      </div>
      {update.isError && (
        <p role="alert" className="m-0 text-sm text-danger">
          {errorMessage(update.error)}
        </p>
      )}
    </section>
  );
}

function TestButton({
  channel,
  disabled,
}: {
  channel: NotificationChannel;
  disabled: boolean;
}) {
  const test = useSendTestNotification();
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        loading={test.isPending}
        onClick={() => test.mutate(channel)}
      >
        {C.sendTest}
      </Button>
      {test.data !== undefined && (
        <p
          role="status"
          className={`m-0 text-sm ${test.data.ok ? "text-success" : "text-danger"}`}
        >
          {test.data.ok ? C.testOk : TEST_ERROR_COPY[test.data.error ?? "unavailable"]}
        </p>
      )}
      {test.isError && (
        <p role="alert" className="m-0 text-sm text-danger">
          {errorMessage(test.error)}
        </p>
      )}
    </div>
  );
}

function ChannelCard({
  title,
  hint,
  configured,
  enabled,
  children,
  onSubmit,
  onToggle,
  onRemove,
  saving,
  channel,
  savedNote,
  error,
}: {
  title: string;
  hint: string;
  configured: boolean;
  enabled: boolean;
  children: ReactNode;
  onSubmit: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  saving: boolean;
  channel: NotificationChannel;
  savedNote: string | null;
  error: string | null;
}) {
  const headingId = useId();
  return (
    <form
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="m-0 text-base font-semibold text-text">
          {title}
        </h3>
        {configured && (
          <label className="flex items-center gap-2 text-sm text-text-muted">
            {C.enabled}
            <Switch checked={enabled} disabled={saving} onCheckedChange={onToggle} />
          </label>
        )}
      </div>
      <p className="m-0 text-sm text-text-muted">{hint}</p>
      {children}
      <div className="flex flex-wrap items-start gap-2">
        <Button type="submit" size="sm" loading={saving}>
          {C.save}
        </Button>
        <TestButton channel={channel} disabled={!configured || saving} />
        {configured && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={onRemove}
          >
            {C.remove}
          </Button>
        )}
      </div>
      {savedNote !== null && (
        <p role="status" className="m-0 text-sm text-success">
          {savedNote}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function useChannelSave() {
  const update = useUpdateNotificationSettings();
  const [saved, setSaved] = useState(false);
  const save = (body: UpdateNotificationSettingsRequest, after?: () => void) => {
    setSaved(false);
    update.mutate(body, {
      onSuccess: () => {
        setSaved(true);
        after?.();
      },
    });
  };
  return {
    save,
    saving: update.isPending,
    savedNote: saved && !update.isPending ? C.saved : null,
    error: update.isError ? errorMessage(update.error) : null,
  };
}

function NtfyCard({ view }: { view: NotificationSettingsView }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const { save, saving, savedNote, error } = useChannelSave();
  const urlId = useId();
  const tokenId = useId();
  const clear = () => {
    setUrl("");
    setToken("");
  };
  return (
    <ChannelCard
      title={C.ntfyTitle}
      hint={C.ntfyHint}
      configured={view.ntfy.configured}
      enabled={view.ntfy.enabled}
      channel="ntfy"
      saving={saving}
      savedNote={savedNote}
      error={error}
      onToggle={(enabled) => save({ ntfy: { enabled } })}
      onRemove={() => save({ ntfy: null }, clear)}
      onSubmit={() =>
        save(
          {
            ntfy: {
              ...(url.trim() === "" ? {} : { url: url.trim() }),
              ...(token.trim() === "" ? {} : { token: token.trim() }),
            },
          },
          clear,
        )
      }
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={urlId} className="text-sm text-text">
          {C.ntfyUrl}
        </label>
        <Input
          id={urlId}
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={url}
          placeholder={view.ntfy.urlMasked ?? "https://ntfy.sh/your-long-random-topic"}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={tokenId} className="text-sm text-text">
          {C.ntfyToken}
        </label>
        <Input
          id={tokenId}
          type="password"
          autoComplete="off"
          value={token}
          placeholder={view.ntfy.tokenSet ? C.keepSecret : "tk_…"}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
    </ChannelCard>
  );
}

function TelegramCard({ view }: { view: NotificationSettingsView }) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const { save, saving, savedNote, error } = useChannelSave();
  const tokenId = useId();
  const chatIdId = useId();
  const clear = () => {
    setBotToken("");
    setChatId("");
  };
  return (
    <ChannelCard
      title={C.telegramTitle}
      hint={C.telegramHint}
      configured={view.telegram.configured}
      enabled={view.telegram.enabled}
      channel="telegram"
      saving={saving}
      savedNote={savedNote}
      error={error}
      onToggle={(enabled) => save({ telegram: { enabled } })}
      onRemove={() => save({ telegram: null }, clear)}
      onSubmit={() =>
        save(
          {
            telegram: {
              ...(botToken.trim() === "" ? {} : { botToken: botToken.trim() }),
              ...(chatId.trim() === "" ? {} : { chatId: chatId.trim() }),
            },
          },
          clear,
        )
      }
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={tokenId} className="text-sm text-text">
          {C.telegramToken}
        </label>
        <Input
          id={tokenId}
          type="password"
          autoComplete="off"
          value={botToken}
          placeholder={
            view.telegram.botTokenHint === null
              ? "123456789:AA…"
              : `${C.keepSecret} (${view.telegram.botTokenHint})`
          }
          onChange={(e) => setBotToken(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={chatIdId} className="text-sm text-text">
          {C.telegramChat}
        </label>
        <Input
          id={chatIdId}
          autoComplete="off"
          value={chatId}
          placeholder={view.telegram.chatId ?? "123456789"}
          onChange={(e) => setChatId(e.target.value)}
        />
      </div>
    </ChannelCard>
  );
}
