"use client";

import type { AppNotification } from "@fastgram/contracts";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  Skeleton,
} from "@fastgram/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { ROUTES } from "@/lib/nav/routes";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from "./api";
import { BellIcon } from "./BellIcon";
import { NOTIFICATIONS_COPY as C, relativeTime } from "./copy";

const SEVERITY_DOT: Readonly<Record<AppNotification["severity"], string>> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-danger",
};

/** "9+" a partir de 10: el número exacto está en el `aria-label`. */
export function badgeText(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 9 ? "9+" : String(unread);
}

/**
 * La campana del shell — `P5-NOTIF-001` (sprint 7). Botón con contador de no
 * leídas y un panel lateral con los avisos de **todas** las marcas del dueño.
 *
 * Tocar un aviso lo marca leído, cambia a su marca si es otra (los links son
 * de la marca activa: `/home`, `/settings/connections`) y navega.
 */
export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const list = useNotifications();
  const unread = list.data?.unreadCount ?? 0;
  const badge = badgeText(unread);

  return (
    <>
      <button
        type="button"
        className={`relative fg-focusable ${className ?? ""}`}
        onClick={() => setOpen(true)}
        aria-label={unread > 0 ? C.bellLabelUnread(unread) : C.bellLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={C.bellLabel}
      >
        <BellIcon size={18} />
        {badge !== null && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 min-w-[1rem] rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-bg"
          >
            {badge}
          </span>
        )}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} side="right" size="sm">
        <DrawerHeader>
          <DrawerTitle>{C.panelTitle}</DrawerTitle>
          <DrawerClose label={C.dismiss} />
        </DrawerHeader>
        <DrawerBody>
          <NotificationPanel list={list} onNavigate={() => setOpen(false)} />
        </DrawerBody>
        <DrawerFooter>
          <Link
            href={ROUTES.settingsNotifications}
            className="text-sm text-accent underline-offset-2 hover:underline"
            onClick={() => setOpen(false)}
          >
            {C.settingsLink}
          </Link>
        </DrawerFooter>
      </Drawer>
    </>
  );
}

function NotificationPanel({
  list,
  onNavigate,
}: {
  list: ReturnType<typeof useNotifications>;
  onNavigate: () => void;
}) {
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const router = useRouter();
  const { workspaces, active, switchTo } = useWorkspace();
  const nowMs = Date.now();

  if (list.isError) {
    return (
      <ApiErrorState
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
      />
    );
  }
  if (list.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton height={56} />
        <Skeleton height={56} />
        <Skeleton height={56} />
      </div>
    );
  }
  const items = list.data.items;
  if (items.length === 0) {
    return <EmptyState size="sm" title={C.emptyTitle} description={C.emptyBody} />;
  }
  const multiBrand = new Set(items.map((i) => i.workspaceId)).size > 1;

  const open = (item: AppNotification) => {
    if (!item.read) markRead.mutate(item.id);
    if (item.link === null) return;
    if (active !== null && item.workspaceId !== active.id) {
      const target = workspaces.data?.find((w) => w.id === item.workspaceId);
      if (target !== undefined) switchTo(target, { silent: true });
    }
    onNavigate();
    router.push(item.link);
  };

  return (
    <div className="flex flex-col gap-3">
      {list.data.unreadCount > 0 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            {C.markAll}
          </Button>
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={C.panelTitle}>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => open(item)}
              className={`fg-focusable flex w-full gap-3 rounded-md p-3 text-left hover:bg-surface ${
                item.read ? "opacity-70" : ""
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-text">
                  {item.title}
                  {!item.read && <span className="sr-only"> · {C.unreadDot}</span>}
                </span>
                {item.body !== "" && (
                  <span className="text-sm text-text-muted">{item.body}</span>
                )}
                <span className="text-xs text-text-muted">
                  {multiBrand ? `${item.workspaceName} · ` : ""}
                  <time dateTime={item.createdAt}>
                    {relativeTime(item.createdAt, nowMs)}
                  </time>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
