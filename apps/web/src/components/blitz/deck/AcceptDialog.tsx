"use client";

import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  Spinner,
} from "@fastgram/ui";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import { td } from "@/lib/blitz/deck/copy";
import { CalendarIcon, LibraryIcon } from "./icons";

/**
 * M-04 `What would you like to do?` — `Step 1 of 3` (FR-050 *User flow* 5,
 * F-064/F-065).
 *
 * **Aceptar no cobra hasta elegir.** El swipe a la derecha abre esto; el
 * `POST /blitz` —que descuenta y construye— sale recién con `Save to Library`.
 * `Cancel` devuelve la tarjeta al centro sin haber tocado el backend. Es la
 * lectura del PRD que hace de `Cancel` algo que cancela.
 *
 * `Schedule Post` (F-065) guarda y manda la pieza al próximo horario libre de
 * la estrategia de la marca (`POST /content/:id/autoschedule`, PU-CAL-001). El
 * paso a paso de FR-060 (elegir redes y hora a mano) vive en el calendario.
 */
export interface AcceptDialogProps {
  readonly open: boolean;
  readonly saving: boolean;
  /** El fallo del último intento, si lo hubo. Se muestra dentro del diálogo. */
  readonly error: unknown;
  readonly onSave: () => void;
  /** Guardar y mandar al próximo horario libre de la estrategia (PU-CAL-001). */
  readonly onSchedule: () => void;
  readonly scheduling?: boolean;
  readonly onCancel: () => void;
}

export function AcceptDialog({
  open,
  saving,
  error,
  onSave,
  onSchedule,
  scheduling = false,
  onCancel,
}: AcceptDialogProps) {
  const failure = error === null || error === undefined ? null : presentError(error);
  return (
    <Dialog
      open={open}
      onClose={() => {
        // Mientras el POST está en vuelo no se cierra: cerrar no lo cancela, y
        // el usuario creería que no se guardó algo que sí se guardó.
        if (!saving) onCancel();
      }}
      closeOnOverlayClick={!saving}
      closeOnEscape={!saving}
      size="sm"
    >
      <DialogHeader>
        <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          {td("deck.accept.step")}
        </p>
        <DialogTitle>{td("deck.accept.title")}</DialogTitle>
        <DialogDescription className="sr-only">{td("deck.cardHelp")}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-3">
          <button
            type="button"
            className="fg-focusable flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-left hover:border-border-strong disabled:opacity-60"
            onClick={onSave}
            disabled={saving}
            aria-busy={saving || undefined}
          >
            <span className="mt-0.5 text-accent">
              {saving ? <Spinner size="sm" aria-hidden /> : <LibraryIcon size={20} />}
            </span>
            <span>
              <span className="block font-semibold text-text">
                {saving ? td("deck.accept.saving") : td("deck.accept.save")}
              </span>
              <span className="block text-sm text-text-muted">
                {td("deck.accept.saveDescription")}
              </span>
            </span>
          </button>

          <button
            type="button"
            className="fg-focusable flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-left hover:border-border-strong disabled:opacity-60"
            onClick={onSchedule}
            disabled={saving}
            aria-busy={scheduling || undefined}
          >
            <span className="mt-0.5 text-accent">
              {scheduling ? (
                <Spinner size="sm" aria-hidden />
              ) : (
                <CalendarIcon size={20} />
              )}
            </span>
            <span>
              <span className="block font-semibold text-text">
                {td("deck.accept.schedule")}
              </span>
              <span className="block text-sm text-text-muted">
                {td("deck.accept.scheduleAuto")}
              </span>
            </span>
          </button>

          {failure !== null && (
            <p role="alert" className="text-sm text-danger">
              {tw(failure.titleKey, failure.titleVars)}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {td("deck.accept.cancel")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
