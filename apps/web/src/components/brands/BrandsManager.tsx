"use client";

import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  useToast,
} from "@fastgram/ui";
import { useId, useRef, useState, type FormEvent } from "react";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { PROFILE_STATUS_KEYS } from "@/components/brands/BrandSwitcher";
import { NAME_PROBLEM_KEYS } from "@/components/brands/NewBrandDialog";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import {
  useDeleteWorkspace,
  useRenameWorkspace,
} from "@/components/brands/use-brand-mutations";
import { useShellActions } from "@/components/shell/ShellActions";
import { LayersIcon, PencilIcon, PlusIcon, TrashIcon } from "@/icons";
import { copyKeyForError, type ApiRequestError } from "@/lib/api/errors";
import {
  validateWorkspaceName,
  WORKSPACE_NAME_MAX,
  type NameProblem,
  type ProfileStatus,
  type Workspace,
} from "@/lib/brands/workspaces";
import { tw } from "@/lib/i18n/t";

const STATUS_TONE: Readonly<
  Record<ProfileStatus, "neutral" | "success" | "danger" | "warning">
> = {
  pending: "neutral",
  ready: "success",
  failed: "danger",
  partial: "warning",
};

/** `409 conflict` en `DELETE /workspaces/:id` = era la última marca (contrato). */
export function isLastBrandError(error: ApiRequestError | null): boolean {
  return error !== null && error.status === 409;
}

/**
 * `/settings/brands` · `PU-BRAND-001`: crear, renombrar, borrar y cambiar.
 *
 * Crear abre el mismo diálogo que el selector y la paleta (`ShellActions`).
 */
export function BrandsManager() {
  const { mode, isPersonal, workspaces, active, switchTo } = useWorkspace();
  const { openNewBrand } = useShellActions();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);

  const newButton = (
    <Button leadingIcon={<PlusIcon size={16} />} onClick={openNewBrand}>
      {tw("brands.new")}
    </Button>
  );

  if (mode === null || (isPersonal && workspaces.isPending)) {
    return (
      <div className="fgw-brand-list" aria-busy="true">
        <span className="fg-visually-hidden">{tw("brands.loading")}</span>
        {[0, 1, 2].map((row) => (
          <div key={row} className="fgw-brand-row" aria-hidden="true">
            <Skeleton className="fgw-brand-row__skeleton-avatar" />
            <Skeleton className="fgw-brand-row__skeleton-name" />
          </div>
        ))}
      </div>
    );
  }

  if (!isPersonal) {
    return (
      <EmptyState
        icon={<LayersIcon size={24} />}
        title={tw("brands.page.standardMode")}
      />
    );
  }

  if (workspaces.isError) {
    return (
      <ErrorState
        title={tw("brands.loadError")}
        description={tw(copyKeyForError(workspaces.error))}
        onRetry={() => {
          void workspaces.refetch();
        }}
      />
    );
  }

  const list = workspaces.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        icon={<LayersIcon size={24} />}
        title={tw("brands.empty")}
        action={newButton}
      />
    );
  }

  return (
    <div className="fgw-brands">
      <div className="fgw-brands__toolbar">{newButton}</div>
      <ul className="fgw-brand-list">
        {list.map((workspace) => {
          const isActive = workspace.id === active?.id;
          return (
            <li
              key={workspace.id}
              className="fgw-brand-row"
              data-active={isActive ? "true" : undefined}
            >
              <BrandAvatar id={workspace.id} name={workspace.name} size="md" />
              {renamingId === workspace.id ? (
                <RenameForm
                  workspace={workspace}
                  onDone={() => {
                    setRenamingId(null);
                  }}
                />
              ) : (
                <>
                  <div className="fgw-brand-row__text">
                    <span className="fgw-brand-row__name">{workspace.name}</span>
                    <span className="fgw-brand-row__badges">
                      <Badge tone={STATUS_TONE[workspace.profileStatus]} size="sm">
                        {tw(PROFILE_STATUS_KEYS[workspace.profileStatus])}
                      </Badge>
                      {isActive && (
                        <Badge tone="accent" size="sm">
                          {tw("brands.active")}
                        </Badge>
                      )}
                    </span>
                  </div>
                  <div className="fgw-brand-row__actions">
                    {!isActive && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          switchTo(workspace);
                        }}
                      >
                        {tw("brands.switch")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<PencilIcon size={14} />}
                      onClick={() => {
                        setRenamingId(workspace.id);
                      }}
                    >
                      {tw("brands.rename")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<TrashIcon size={14} />}
                      onClick={() => {
                        setDeleting(workspace);
                      }}
                    >
                      {tw("brands.delete")}
                    </Button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <DeleteBrandDialog
        workspace={deleting}
        isOnlyBrand={list.length <= 1}
        onClose={() => {
          setDeleting(null);
        }}
      />
    </div>
  );
}

function RenameForm({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const rename = useRenameWorkspace();
  const { toast } = useToast();
  const [name, setName] = useState(workspace.name);
  const [problem, setProblem] = useState<NameProblem | null>(null);
  const errorId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (rename.isPending) return;
    const found = validateWorkspaceName(name);
    setProblem(found);
    if (found !== null) return;
    if (name.trim() === workspace.name) {
      onDone();
      return;
    }
    rename.mutate(
      { id: workspace.id, name },
      {
        onSuccess: () => {
          toast({ title: tw("brands.renamed"), tone: "success", duration: 2500 });
          onDone();
        },
      },
    );
  };

  const errorText =
    problem !== null
      ? tw(NAME_PROBLEM_KEYS[problem])
      : rename.isError
        ? tw(copyKeyForError(rename.error))
        : null;

  return (
    <form className="fgw-brand-row__rename" onSubmit={submit} noValidate>
      <Input
        value={name}
        autoFocus
        maxLength={WORKSPACE_NAME_MAX + 20}
        aria-label={tw("brands.rename.label", { name: workspace.name })}
        invalid={errorText !== null}
        aria-describedby={errorText === null ? undefined : errorId}
        onChange={(event) => {
          setName(event.target.value);
          if (problem !== null) setProblem(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
      />
      <Button type="submit" size="sm" loading={rename.isPending}>
        {tw("brands.rename.save")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        {tw("common.cancel")}
      </Button>
      {errorText !== null && (
        <p id={errorId} className="fgw-field__error" role="alert">
          {errorText}
        </p>
      )}
    </form>
  );
}

function DeleteBrandDialog({
  workspace,
  isOnlyBrand,
  onClose,
}: {
  workspace: Workspace | null;
  isOnlyBrand: boolean;
  onClose: () => void;
}) {
  const remove = useDeleteWorkspace();
  const { forget } = useWorkspace();
  const { toast } = useToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { reset } = remove;

  const close = () => {
    reset();
    onClose();
  };

  const lastBrand = isOnlyBrand || isLastBrandError(remove.error);
  const errorText =
    remove.isError && !isLastBrandError(remove.error)
      ? tw(copyKeyForError(remove.error))
      : null;

  return (
    <Dialog
      open={workspace !== null}
      onClose={close}
      size="sm"
      initialFocusRef={cancelRef}
    >
      {workspace !== null && (
        <>
          <DialogHeader>
            <DialogTitle>
              {tw("brands.delete.title", { name: workspace.name })}
            </DialogTitle>
            <DialogDescription>{tw("brands.delete.body")}</DialogDescription>
            <DialogClose label={tw("common.close")} />
          </DialogHeader>
          {(lastBrand || errorText !== null) && (
            <DialogBody>
              <p className="fgw-field__error" role="alert">
                {lastBrand ? tw("brands.delete.lastBrand") : errorText}
              </p>
            </DialogBody>
          )}
          <DialogFooter>
            <Button ref={cancelRef} type="button" variant="ghost" onClick={close}>
              {tw("common.cancel")}
            </Button>
            {!lastBrand && (
              <Button
                type="button"
                variant="danger"
                loading={remove.isPending}
                onClick={() => {
                  remove.mutate(workspace.id, {
                    onSuccess: () => {
                      forget(workspace.id);
                      toast({
                        title: tw("brands.deleted"),
                        tone: "success",
                        duration: 2500,
                      });
                      close();
                    },
                  });
                }}
              >
                {tw("brands.delete.confirm")}
              </Button>
            )}
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
