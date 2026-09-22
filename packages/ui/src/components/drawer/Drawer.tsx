"use client";

import { X } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../cn";
import { t } from "../../i18n/t";
import { useModal } from "../dialog/use-modal";
import { drawerVariants, type DrawerVariants } from "./drawer.variants";

interface DrawerContextValue {
  titleId: string;
  descriptionId: string;
  onClose: () => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

function useDrawerContext(component: string): DrawerContextValue {
  const context = useContext(DrawerContext);
  if (context === null) {
    throw new Error(`<${component}> tiene que estar dentro de <Drawer>.`);
  }
  return context;
}

export interface DrawerProps extends DrawerVariants {
  open: boolean;
  onClose: () => void;
  "aria-label"?: string;
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  overlayClassName?: string;
  children?: ReactNode;
}

/**
 * Panel lateral (los D-01…D-06 del PRD §3.4: `Preferences` de Blitz, el
 * inspector de edición, el detalle de una imagen generada).
 *
 * Comparte comportamiento con `Dialog` —mismo `useModal`— porque para el
 * teclado y el lector de pantalla **es** un diálogo modal: sólo cambia de dónde
 * entra. Un drawer no modal (que deje interactuar con el fondo) es otro
 * componente y hoy no existe.
 */
export function Drawer({
  open,
  onClose,
  side,
  size,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  initialFocusRef,
  className,
  overlayClassName,
  children,
  ...props
}: DrawerProps) {
  const reactId = useId();
  const [mounted, setMounted] = useState(false);
  const modalOptions =
    initialFocusRef === undefined
      ? { open, onClose, closeOnEscape }
      : { open, onClose, closeOnEscape, initialFocusRef };
  const { containerRef, onKeyDown } = useModal(modalOptions);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!open || !mounted) return null;

  const titleId = `${reactId}-title`;
  const descriptionId = `${reactId}-description`;
  const label = props["aria-label"];

  return createPortal(
    <DrawerContext.Provider value={{ titleId, descriptionId, onClose }}>
      <div
        className={cn("fg-overlay", "fg-overlay--drawer", overlayClassName)}
        onMouseDown={(event) => {
          if (!closeOnOverlayClick) return;
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={label === undefined ? titleId : undefined}
          tabIndex={-1}
          className={cn(drawerVariants({ side, size }), className)}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      </div>
    </DrawerContext.Provider>,
    document.body,
  );
}

export function DrawerHeader({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-drawer__header", className)} />;
}

export function DrawerTitle({ className, id, ...props }: ComponentPropsWithRef<"h2">) {
  const { titleId } = useDrawerContext("DrawerTitle");
  return (
    <h2 {...props} id={id ?? titleId} className={cn("fg-drawer__title", className)} />
  );
}

export function DrawerDescription({
  className,
  id,
  ...props
}: ComponentPropsWithRef<"p">) {
  const { descriptionId } = useDrawerContext("DrawerDescription");
  return (
    <p
      {...props}
      id={id ?? descriptionId}
      className={cn("fg-drawer__description", className)}
    />
  );
}

export function DrawerBody({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-drawer__body", className)} />;
}

export function DrawerFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-drawer__footer", className)} />;
}

export interface DrawerCloseProps extends ComponentPropsWithRef<"button"> {
  label?: string;
}

export function DrawerClose({ label, className, onClick, ...props }: DrawerCloseProps) {
  const { onClose } = useDrawerContext("DrawerClose");
  return (
    <button
      {...props}
      type="button"
      className={cn(
        "fg-drawer__close",
        "fg-btn",
        "fg-btn--ghost",
        "fg-btn--icon",
        className,
      )}
      aria-label={label ?? t("drawer.close")}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        onClose();
      }}
    >
      <X aria-hidden="true" />
    </button>
  );
}
