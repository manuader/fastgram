"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@fastgram/ui";
import type { ActivationPreview } from "@fastgram/contracts";
import { useEffect, useState } from "react";
import { tw } from "@/lib/i18n/t";
import { reasonOf, useActivationPreview } from "./api";
import { formatMinor } from "./money";
import { reasonKey } from "./present";

export interface ConfirmSpendDialogProps {
  readonly campaignId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  /** `activate`: prender; `budget_increase`: subir topes a `caps`. */
  readonly action: "activate" | "budget_increase";
  readonly caps?: { readonly dailyCapMinor: number; readonly totalCapMinor: number };
  /** Con el token del preview: activa o guarda el presupuesto. */
  readonly onConfirm: (token: string) => Promise<unknown>;
}

/**
 * `D-21`: la confirmación **con el gasto máximo posible**. Al abrir pide un
 * preview a la API (que emite un token de 5 minutos); "Confirm" manda ese
 * token. La regla está en la API: saltearse este diálogo da 409.
 */
export function ConfirmSpendDialog(props: ConfirmSpendDialogProps) {
  const { campaignId, open, onClose, action, caps, onConfirm } = props;
  const preview = useActivationPreview(campaignId);
  const [data, setData] = useState<ActivationPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setError(null);
    preview.mutate(
      { action, ...(caps === undefined ? {} : caps) },
      { onSuccess: setData, onError: setError },
    );
    // El preview es por apertura; `preview` cambia de identidad en cada render.
  }, [open]);

  async function confirm() {
    if (data === null) return;
    setConfirming(true);
    setError(null);
    try {
      await onConfirm(data.token);
      onClose();
    } catch (e: unknown) {
      setError(e);
    } finally {
      setConfirming(false);
    }
  }

  const key = error === null ? null : (reasonKey(reasonOf(error)) ?? "ads.error.generic");
  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>
          {tw(
            action === "activate"
              ? "ads.confirm.titleActivate"
              : "ads.confirm.titleBudget",
          )}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        {preview.isPending && (
          <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
            <Spinner size="sm" aria-hidden="true" />
            {tw("ads.confirm.calculating")}
          </p>
        )}
        {data !== null && (
          <>
            <p className="text-sm text-text-muted">{tw("ads.confirm.maxLabel")}</p>
            <p className="text-3xl font-semibold" data-testid="max-spend">
              {formatMinor(data.maxSpendMinor, data.currency)}
            </p>
            <ul className="flex flex-col gap-1 text-sm text-text-muted">
              <li>
                {tw("ads.confirm.caps", {
                  daily: formatMinor(data.dailyCapMinor, data.currency),
                  total: formatMinor(data.totalCapMinor, data.currency),
                })}
              </li>
              <li>
                {tw("ads.confirm.spent", {
                  spent: formatMinor(data.spentTotalMinor, data.currency),
                })}
              </li>
              {data.daysLeft !== null && (
                <li>{tw("ads.confirm.daysLeft", { days: String(data.daysLeft) })}</li>
              )}
              <li>
                {tw("ads.confirm.guard", { minutes: String(data.guardIntervalMinutes) })}
              </li>
            </ul>
            {data.demo && <p className="text-sm text-accent">{tw("ads.confirm.demo")}</p>}
          </>
        )}
        {key !== null && (
          <p role="alert" className="text-sm text-danger">
            {tw(key)}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {tw("common.cancel")}
        </Button>
        <Button onClick={() => void confirm()} disabled={data === null || confirming}>
          {confirming ? <Spinner size="sm" aria-hidden="true" /> : null}
          {data === null
            ? tw("ads.confirm.cta")
            : tw("ads.confirm.ctaWithMax", {
                max: formatMinor(data.maxSpendMinor, data.currency),
              })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
