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
import { dialogVariants, type DialogVariants } from "./dialog.variants";
import { useModal } from "./use-modal";

interface DialogContextValue {
  titleId: string;
  descriptionId: string;
  onClose: () => void;
  /**
   * `<DialogDescription>` avisa que está montada (y con qué id), para que el
   * modal la enlace con `aria-describedby`. Sin esto el lector de pantalla
   * anunciaba el título y se salteaba la descripción (`P5-A11Y-001`).
   */
  setDescribedBy: (id: string | null) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext(component: string): DialogContextValue {
  const context = useContext(DialogContext);
  if (context === null) {
    throw new Error(`<${component}> tiene que estar dentro de <Dialog>.`);
  }
  return context;
}

export interface DialogProps extends DialogVariants {
  open: boolean;
  onClose: () => void;
  /**
   * El diálogo necesita nombre accesible. Lo normal es renderizar un
   * `<DialogTitle>` (el modal lo enlaza solo). Si no hay título visible,
   * pasá `aria-label`.
   */
  "aria-label"?: string;
  /** Un click fuera cierra. Apagalo en flujos de varios pasos (`Step 1 of 3`). */
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  /** Elemento que recibe el foco al abrir, en vez del primero enfocable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  overlayClassName?: string;
  children?: ReactNode;
}

/**
 * Diálogo modal (los M-01…M-08 del PRD §3.4).
 *
 * Escrito a mano porque Radix no está instalado. Lo que implementa, que es lo
 * que hace que un modal sea usable sin mouse: `role="dialog"` + `aria-modal`,
 * foco que entra al abrir y **vuelve al disparador al cerrar**, Tab atrapado
 * dentro, Escape para salir y scroll de fondo bloqueado.
 *
 * Lo que NO implementa y Radix sí — anotado en el reporte: `inert` sobre el
 * resto del documento (un lector de pantalla en modo lectura puede salirse del
 * modal) y el apilado de varios modales abiertos a la vez.
 */
export function Dialog({
  open,
  onClose,
  size,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  initialFocusRef,
  className,
  overlayClassName,
  children,
  ...props
}: DialogProps) {
  const reactId = useId();
  const [mounted, setMounted] = useState(false);
  const [describedBy, setDescribedBy] = useState<string | null>(null);
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
    <DialogContext.Provider value={{ titleId, descriptionId, onClose, setDescribedBy }}>
      <div
        className={cn("fg-overlay", overlayClassName)}
        onMouseDown={(event) => {
          if (!closeOnOverlayClick) return;
          // Sólo el click que empieza *y* termina en el fondo cierra: arrastrar
          // texto desde dentro del modal y soltar fuera no debe cerrarlo.
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={label === undefined ? titleId : undefined}
          aria-describedby={describedBy ?? undefined}
          tabIndex={-1}
          className={cn(dialogVariants({ size }), className)}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      </div>
    </DialogContext.Provider>,
    document.body,
  );
}

export function DialogHeader({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-dialog__header", className)} />;
}

export function DialogTitle({ className, id, ...props }: ComponentPropsWithRef<"h2">) {
  const { titleId } = useDialogContext("DialogTitle");
  return (
    <h2 {...props} id={id ?? titleId} className={cn("fg-dialog__title", className)} />
  );
}

export function DialogDescription({
  className,
  id,
  ...props
}: ComponentPropsWithRef<"p">) {
  const { descriptionId, setDescribedBy } = useDialogContext("DialogDescription");
  const finalId = id ?? descriptionId;
  useEffect(() => {
    setDescribedBy(finalId);
    return () => {
      setDescribedBy(null);
    };
  }, [finalId, setDescribedBy]);
  return (
    <p {...props} id={finalId} className={cn("fg-dialog__description", className)} />
  );
}

export function DialogBody({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-dialog__body", className)} />;
}

export function DialogFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div {...props} className={cn("fg-dialog__footer", className)} />;
}

export interface DialogCloseProps extends ComponentPropsWithRef<"button"> {
  label?: string;
}

/** Botón `×` de la esquina. Su nombre accesible es texto, no el glifo. */
export function DialogClose({ label, className, onClick, ...props }: DialogCloseProps) {
  const { onClose } = useDialogContext("DialogClose");
  return (
    <button
      {...props}
      type="button"
      className={cn(
        "fg-dialog__close",
        "fg-btn",
        "fg-btn--ghost",
        "fg-btn--icon",
        className,
      )}
      aria-label={label ?? t("dialog.close")}
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
