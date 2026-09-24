"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  useToast,
} from "@fastgram/ui";
import type { Automation, LaunchValidation } from "@fastgram/contracts";
import { useEffect, useState } from "react";
import { copyKeyForError, isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { useAutomationAction, useLaunchValidation } from "@/lib/automations/api";
import { GATE_COPY } from "@/lib/automations/present";

export interface LaunchDialogProps {
  readonly automation: Automation;
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * `Continue to launch` — `F-216`, `F-217`. Al abrir consulta
 * `launchValidation` (`Validating your campaign against your plan and
 * accounts.`) y enumera **todos** los gates incumplidos; si no hay ninguno,
 * `Ready to launch` y `Launch campaign`. Si el launch vuelve con `409`, se
 * muestran los gates que devolvió.
 */
export function LaunchDialog({ automation, open, onClose }: LaunchDialogProps) {
  const validate = useLaunchValidation(automation.id);
  const launch = useAutomationAction(automation.id, "launch");
  const [validation, setValidation] = useState<LaunchValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setValidation(null);
    setError(null);
    validate.mutate(undefined, {
      onSuccess: setValidation,
      onError: () => {
        setError(tw("automations.launch.checkFailed"));
      },
    });
    // `validate` cambia de identidad en cada render: la consulta es por apertura.
  }, [open]);

  const checking = validate.isPending;
  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>
          {validation?.ok === true
            ? tw("automations.launch.ready")
            : tw("automations.launch.title")}
        </DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        {checking && (
          <p className="flex items-center gap-2 text-sm text-text-muted" role="status">
            <Spinner size="sm" aria-hidden="true" />
            {tw("automations.launch.validating")}
          </p>
        )}
        {error !== null && (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-danger">{error}</p>
            <p className="text-sm text-text-muted">
              {tw("automations.launch.checkFailed.body")}
            </p>
          </div>
        )}
        {validation !== null && validation.ok && (
          <>
            <p className="text-sm text-text">{tw("automations.launch.allGood")}</p>
            <p className="text-sm text-text-muted">
              {tw("automations.launch.summary", {
                pieces: validation.summary.readySlots,
                posts: validation.summary.posts,
              })}
            </p>
          </>
        )}
        {validation !== null && !validation.ok && (
          <ul
            className="flex flex-col gap-2"
            aria-label={tw("automations.launch.blockers")}
          >
            {validation.gates.map((g) => (
              <li
                key={g.code}
                className="rounded-lg border border-danger/40 bg-surface p-3"
              >
                <p className="text-sm font-semibold text-text">
                  {tw(GATE_COPY[g.code].title)}
                </p>
                <p className="text-sm text-text-muted">{tw(GATE_COPY[g.code].body)}</p>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tw("common.cancel")}
        </Button>
        {validation !== null && !validation.ok && (
          <Button
            variant="ghost"
            onClick={() => {
              validate.mutate(undefined, { onSuccess: setValidation });
            }}
          >
            {tw("common.tryAgain")}
          </Button>
        )}
        <Button
          disabled={validation?.ok !== true}
          loading={launch.isPending}
          onClick={() => {
            launch
              .mutateAsync()
              .then(() => {
                toast({ title: tw("automations.launch.done"), tone: "success" });
                onClose();
              })
              .catch((e: unknown) => {
                const gates = isApiRequestError(e) ? e.details?.["gates"] : undefined;
                if (Array.isArray(gates) && validation !== null) {
                  setValidation({
                    ...validation,
                    ok: false,
                    gates: gates as LaunchValidation["gates"],
                  });
                  return;
                }
                setError(tw(copyKeyForError(e)));
              });
          }}
        >
          {tw("automations.launch.launch")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
