"use client";

import { Skeleton, Tooltip } from "@fastgram/ui";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { useShellActions } from "@/components/shell/ShellActions";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, SettingsIcon } from "@/icons";
import type { ProfileStatus } from "@/lib/brands/workspaces";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

export const PROFILE_STATUS_KEYS: Readonly<Record<ProfileStatus, CopyKey>> = {
  pending: "brands.status.pending",
  ready: "brands.status.ready",
  failed: "brands.status.failed",
  partial: "brands.status.partial",
};

/**
 * El selector de marca: **el primer elemento del sidebar** (PLAN §7, D-07).
 *
 * Es un menú (`role="menu"` + `menuitemradio`), no un `<select>`: además de
 * elegir marca tiene acciones ("New brand", "Manage brands"), y un `<select>`
 * no puede llevarlas. Teclado: flechas, Home/End, Escape (devuelve el foco al
 * disparador) y Tab (cierra y sigue).
 *
 * Fuera del modo personal no hay marcas que elegir: se dibuja el logotipo de
 * siempre, que lleva a Home.
 */
export function BrandSwitcher({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { mode, isPersonal, workspaces, active, switchTo } = useWorkspace();
  const { openNewBrand } = useShellActions();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Click fuera cierra. `mousedown` y no `click`: si no, el mismo click que
  // abre en el disparador llega al documento y lo cierra en el acto.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  // Al abrir, el foco va a la marca activa (o al primer item).
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (menu === null) return;
      const checked = menu.querySelector<HTMLElement>('[aria-checked="true"]');
      (checked ?? menu.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (menu === null) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      const count = items.length;
      if (count === 0) return;
      items[((next % count) + count) % count]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(items.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  };

  if (mode === null || (isPersonal && workspaces.isPending)) {
    return (
      <div className="fgw-brand-switcher" aria-busy="true">
        <span className="fgw-brand-switcher__trigger" aria-hidden="true">
          <Skeleton className="fgw-brand-switcher__skeleton-avatar" />
          {!collapsed && <Skeleton className="fgw-brand-switcher__skeleton-name" />}
        </span>
        <span className="fg-visually-hidden">{tw("brands.loading")}</span>
      </div>
    );
  }

  if (!isPersonal) {
    return (
      <Link
        href={ROUTES.home}
        className="fgw-brand fg-focusable"
        {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
      >
        <span className="fgw-brand__mark" aria-hidden="true">
          FG
        </span>
        <span className={collapsed ? "fg-visually-hidden" : "fgw-brand__name"}>
          FastGram
        </span>
      </Link>
    );
  }

  const list = workspaces.data ?? [];
  const title =
    active?.name ?? (workspaces.isError ? tw("brands.loadError") : "FastGram");
  const subtitle =
    active === null
      ? tw("brands.switcherLabel")
      : tw(PROFILE_STATUS_KEYS[active.profileStatus]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className="fgw-brand-switcher__trigger fg-focusable"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={collapsed ? `${tw("brands.switcherLabel")}: ${title}` : undefined}
      onClick={() => {
        setOpen((current) => !current);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && !open) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      {active === null ? (
        <span className="fgw-brand__mark" aria-hidden="true">
          FG
        </span>
      ) : (
        <BrandAvatar
          id={active.id}
          name={active.name}
          logoUrl={active.logoUrl}
          size="md"
        />
      )}
      {!collapsed && (
        <>
          <span className="fgw-brand-switcher__text">
            <span className="fgw-brand-switcher__name">{title}</span>
            <span className="fgw-brand-switcher__meta">{subtitle}</span>
          </span>
          <ChevronsUpDownIcon size={16} className="fgw-brand-switcher__chevron" />
        </>
      )}
    </button>
  );

  return (
    <div ref={rootRef} className="fgw-brand-switcher">
      {collapsed ? (
        <Tooltip content={title} side="right">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={tw("brands.menuLabel")}
            className="fgw-brand-menu"
            data-collapsed={collapsed ? "true" : "false"}
            onKeyDown={onMenuKeyDown}
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -2 }}
            transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.7 }}
          >
            {workspaces.isError && (
              <div className="fgw-brand-menu__notice" role="status">
                <span>{tw("brands.loadError")}</span>
                <button
                  type="button"
                  role="menuitem"
                  className="fgw-brand-menu__retry fg-focusable"
                  onClick={() => {
                    void workspaces.refetch();
                  }}
                >
                  {tw("common.tryAgain")}
                </button>
              </div>
            )}
            {workspaces.isSuccess && list.length === 0 && (
              <p className="fgw-brand-menu__notice">{tw("brands.empty")}</p>
            )}
            {list.length > 0 && (
              <div className="fgw-brand-menu__group" role="group">
                {list.map((workspace) => {
                  const checked = workspace.id === active?.id;
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      tabIndex={-1}
                      className="fgw-brand-menu__item fg-focusable"
                      onClick={() => {
                        switchTo(workspace);
                        close(true);
                        onNavigate?.();
                      }}
                    >
                      <BrandAvatar
                        id={workspace.id}
                        name={workspace.name}
                        logoUrl={workspace.logoUrl}
                        size="sm"
                      />
                      <span className="fgw-brand-menu__label">{workspace.name}</span>
                      {checked && (
                        <CheckIcon size={16} className="fgw-brand-menu__check" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {/* ERR-E10 (PRD §19.1, literal): con una sola marca no hay a cuál
                cambiar; la salida es "New brand", justo debajo. */}
            {workspaces.isSuccess && list.length === 1 && (
              <p className="fgw-brand-menu__notice">{tw("empty.workspaces.title")}</p>
            )}
            <hr className="fgw-brand-menu__separator" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="fgw-brand-menu__item fg-focusable"
              onClick={() => {
                close(false);
                openNewBrand();
              }}
            >
              <span className="fgw-brand-menu__icon">
                <PlusIcon size={16} />
              </span>
              <span className="fgw-brand-menu__label">{tw("brands.new")}</span>
            </button>
            <Link
              href={ROUTES.settingsBrands}
              role="menuitem"
              tabIndex={-1}
              className="fgw-brand-menu__item fg-focusable"
              onClick={() => {
                close(false);
                onNavigate?.();
              }}
            >
              <span className="fgw-brand-menu__icon">
                <SettingsIcon size={16} />
              </span>
              <span className="fgw-brand-menu__label">{tw("brands.manage")}</span>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
