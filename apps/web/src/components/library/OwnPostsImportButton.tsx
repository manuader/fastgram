"use client";

import {
  OWN_POST_IMPORT_DEFAULT_LIMIT,
  OWN_POST_IMPORT_MAX_LIMIT,
  type OwnPostImport,
  type OwnPostImportRequest,
} from "@fastgram/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Spinner,
} from "@fastgram/ui";
import { useId, useState } from "react";
import { presentError } from "@/lib/api/error-presentation";
import { useConnectionAccounts } from "@/lib/connections/api";
import { tw, type CopyKey } from "@/lib/i18n/t";
import {
  OWN_POST_CONNECTION_PLATFORMS,
  isOwnImportSettled,
  useOwnPostImportStatus,
  useStartOwnPostImport,
} from "@/lib/media/own-posts";

const ERROR_COPY: Readonly<Record<NonNullable<OwnPostImport["error"]>, CopyKey>> = {
  unsupported_platform: "ownPosts.error.unsupportedPlatform",
  unsupported_url: "ownPosts.error.unsupportedUrl",
  connection_unavailable: "ownPosts.error.connectionUnavailable",
  listing_failed: "ownPosts.error.listingFailed",
  nothing_found: "ownPosts.error.nothingFound",
};

/**
 * «Import my posts» del Media Bank · `FR-011.5.1`, D-04, `P1-ONB-008`.
 *
 * **Opt-in, desmarcado por defecto**: el checkbox de consentimiento arranca
 * sin marcar y `Import` queda deshabilitado hasta marcarlo. Dos fuentes: una
 * cuenta conectada de la marca (Instagram, YouTube) o un link de perfil
 * público (TikTok, YouTube), leído sin login.
 */
export function OwnPostsImportButton({ size = "sm" }: { readonly size?: "sm" | "lg" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size={size} onClick={() => setOpen(true)}>
        {tw("ownPosts.open")}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm">
        {open && <ImportBody onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function ImportBody({ onClose }: { readonly onClose: () => void }) {
  const [source, setSource] = useState<"connection" | "profile">("connection");
  const [connectionId, setConnectionId] = useState("");
  const [url, setUrl] = useState("");
  const [limit, setLimit] = useState(OWN_POST_IMPORT_DEFAULT_LIMIT);
  const [consent, setConsent] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const accounts = useConnectionAccounts();
  const start = useStartOwnPostImport();
  const status = useOwnPostImportStatus(importId);
  const ids = { source: useId(), account: useId(), url: useId(), limit: useId() };

  const eligible = (accounts.data ?? []).filter(
    (a) => OWN_POST_CONNECTION_PLATFORMS.includes(a.platform) && a.status === "active",
  );
  const chosenConnection = connectionId === "" ? eligible[0]?._id : connectionId;

  const request: OwnPostImportRequest | null =
    source === "connection"
      ? chosenConnection === undefined
        ? null
        : { source: "connection", connectionId: chosenConnection, limit }
      : url.trim() === ""
        ? null
        : { source: "profile", url: url.trim(), limit };

  if (importId !== null) {
    const data = status.data;
    return (
      <>
        <DialogHeader>
          <DialogTitle>{tw("ownPosts.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {data === undefined || !isOwnImportSettled(data) ? (
            <p className="flex items-center gap-2 text-sm" aria-live="polite">
              <Spinner size="sm" aria-hidden="true" /> {tw("ownPosts.running")}
            </p>
          ) : data.state === "failed" ? (
            <p role="alert" className="text-sm text-danger">
              {tw(
                data.error === undefined
                  ? "ownPosts.error.generic"
                  : ERROR_COPY[data.error],
              )}
            </p>
          ) : (
            <p className="text-sm" aria-live="polite">
              {tw("ownPosts.done", {
                imported: data.imported,
                skipped: data.skipped,
                failed: data.failed,
              })}
            </p>
          )}
          {status.isError && (
            <p role="alert" className="text-sm text-danger">
              {tw(presentError(status.error).titleKey)}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{tw("ownPosts.close")}</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tw("ownPosts.title")}</DialogTitle>
        <DialogDescription>{tw("ownPosts.description")}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-3 text-sm">
          <label htmlFor={ids.source} className="flex flex-col gap-1">
            <span className="font-medium">{tw("ownPosts.source")}</span>
            <Select
              id={ids.source}
              value={source}
              onChange={(e) =>
                setSource(e.target.value === "profile" ? "profile" : "connection")
              }
              options={[
                { value: "connection", label: tw("ownPosts.source.connection") },
                { value: "profile", label: tw("ownPosts.source.profile") },
              ]}
            />
          </label>

          {source === "connection" ? (
            accounts.isPending ? (
              <Spinner size="sm" />
            ) : accounts.isError ? (
              <p role="alert" className="text-danger">
                {tw("ownPosts.accountsError")}
              </p>
            ) : eligible.length === 0 ? (
              <p className="text-text-muted">{tw("ownPosts.noAccounts")}</p>
            ) : (
              <label htmlFor={ids.account} className="flex flex-col gap-1">
                <span className="font-medium">{tw("ownPosts.account")}</span>
                <Select
                  id={ids.account}
                  value={chosenConnection ?? ""}
                  onChange={(e) => setConnectionId(e.target.value)}
                  options={eligible.map((a) => ({
                    value: a._id,
                    label: `${a.platform} · @${a.username}`,
                  }))}
                />
              </label>
            )
          ) : (
            <label htmlFor={ids.url} className="flex flex-col gap-1">
              <span className="font-medium">{tw("ownPosts.profileUrl")}</span>
              <Input
                id={ids.url}
                type="url"
                value={url}
                placeholder="https://www.tiktok.com/@yourbrand"
                onChange={(e) => setUrl(e.target.value)}
              />
              <span className="text-xs text-text-muted">
                {tw("ownPosts.profileHint")}
              </span>
            </label>
          )}

          <label htmlFor={ids.limit} className="flex flex-col gap-1">
            <span className="font-medium">{tw("ownPosts.limit")}</span>
            <Input
              id={ids.limit}
              type="number"
              min={1}
              max={OWN_POST_IMPORT_MAX_LIMIT}
              value={limit}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n))
                  setLimit(Math.min(OWN_POST_IMPORT_MAX_LIMIT, Math.max(1, n)));
              }}
            />
          </label>

          <Checkbox
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            label={tw("ownPosts.consent")}
          />

          {start.isError && (
            <p role="alert" className="text-danger">
              {tw(presentError(start.error).titleKey)}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {tw("common.cancel")}
        </Button>
        <Button
          disabled={!consent || request === null}
          loading={start.isPending}
          onClick={() => {
            if (request === null) return;
            start.mutate(request, { onSuccess: (created) => setImportId(created.id) });
          }}
        >
          {tw("ownPosts.start")}
        </Button>
      </DialogFooter>
    </>
  );
}
