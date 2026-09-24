"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@fastgram/ui";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { useCreateWorkspace } from "@/components/brands/use-brand-mutations";
import { copyKeyForError } from "@/lib/api/errors";
import {
  validateWorkspaceName,
  WORKSPACE_NAME_MAX,
  type NameProblem,
  type Workspace,
} from "@/lib/brands/workspaces";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

export const NAME_PROBLEM_KEYS: Readonly<Record<NameProblem, CopyKey>> = {
  required: "brands.name.required",
  too_long: "brands.name.tooLong",
};

/**
 * "New brand" · `PU-BRAND-001`.
 *
 * Sólo pide el nombre (el contrato no lleva más). Después de crear **no**
 * cambia de marca sola: ofrece "cambiar y analizar", que lleva a `/brand`
 * —donde se cargan las fuentes y se dispara el análisis— ya con la marca
 * nueva activa. `/onboarding` no sirve para esto: la guard lo manda a `/home`
 * a quien ya completó el alta (`lib/auth/route-policy.ts`).
 */
export function NewBrandDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { switchTo } = useWorkspace();
  const create = useCreateWorkspace();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<NameProblem | null>(null);
  const [created, setCreated] = useState<Workspace | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const inputId = useId();

  // Cada apertura empieza de cero: reabrir y encontrar el nombre de la marca
  // anterior invita a crear un duplicado.
  const { reset } = create;
  useEffect(() => {
    if (!open) return;
    setName("");
    setProblem(null);
    setCreated(null);
    reset();
  }, [open, reset]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateWorkspaceName(name);
    setProblem(found);
    if (found !== null) {
      inputRef.current?.focus();
      return;
    }
    create.mutate(name, {
      onSuccess: (workspace) => {
        setCreated(workspace);
      },
    });
  };

  const errorText =
    problem !== null
      ? tw(NAME_PROBLEM_KEYS[problem])
      : create.isError
        ? tw(copyKeyForError(create.error))
        : null;

  return (
    <Dialog open={open} onClose={onClose} size="sm" initialFocusRef={inputRef}>
      {created === null ? (
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{tw("brands.create.title")}</DialogTitle>
            <DialogDescription>{tw("brands.create.description")}</DialogDescription>
            <DialogClose label={tw("common.close")} />
          </DialogHeader>
          <DialogBody>
            <label className="fgw-field" htmlFor={inputId}>
              <span className="fgw-field__label">{tw("brands.create.nameLabel")}</span>
              <Input
                ref={inputRef}
                id={inputId}
                value={name}
                maxLength={WORKSPACE_NAME_MAX + 20}
                placeholder={tw("brands.create.namePlaceholder")}
                autoComplete="off"
                invalid={errorText !== null}
                aria-describedby={errorText === null ? undefined : errorId}
                onChange={(event) => {
                  setName(event.target.value);
                  if (problem !== null) setProblem(null);
                }}
              />
            </label>
            {errorText !== null && (
              <p id={errorId} className="fgw-field__error" role="alert">
                {errorText}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {tw("common.cancel")}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {tw("brands.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>{tw("brands.created.title")}</DialogTitle>
            <DialogDescription>
              {tw("brands.created.description", { name: created.name })}
            </DialogDescription>
            <DialogClose label={tw("common.close")} />
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {tw("brands.created.later")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                switchTo(created);
                onClose();
                router.push(ROUTES.brand);
              }}
            >
              {tw("brands.created.setUp")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
