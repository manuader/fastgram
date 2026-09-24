"use client";

import type { InfluencerTemplate } from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Skeleton,
  Textarea,
} from "@fastgram/ui";
import { useEffect, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { PencilIcon, PlusIcon, TrashIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { useInfluencerTemplates, useSaveTemplates } from "./api";

/** `{subject}` → her / him / them, igual que `applyTemplate` de `core`. */
export function fillTemplate(prompt: string, gender: string | undefined): string {
  const g = (gender ?? "").toLowerCase();
  const who = g === "female" ? "her" : g === "male" ? "him" : "them";
  return prompt.replace(/\{subject\}/g, who);
}

/** Un id de template a partir del nombre, único en la lista. */
export function templateId(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "template";
  let id = base;
  for (let i = 2; taken.has(id); i += 1) id = `${base}-${String(i)}`;
  return id;
}

/**
 * El select `✨ Template` de la barra de generación (`FR-081`) y el botón para
 * editar la lista. Elegir uno **reemplaza** el prompt: es un punto de partida.
 */
export function TemplateSelect({
  gender,
  onApply,
}: {
  readonly gender: string | undefined;
  readonly onApply: (prompt: string) => void;
}) {
  const templates = useInfluencerTemplates();
  const [editing, setEditing] = useState(false);
  const list = templates.data?.templates ?? [];
  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-text-muted">
          {tw("influencers.templates.label")}
        </span>
        <Select
          aria-label={tw("influencers.templates.label")}
          value=""
          disabled={templates.isPending || list.length === 0}
          options={[
            {
              value: "",
              label: templates.isError
                ? tw("influencers.templates.error")
                : tw("influencers.templates.placeholder"),
            },
            ...list.map((t) => ({ value: t.id, label: t.label })),
          ]}
          onChange={(e) => {
            const t = list.find((x) => x.id === e.target.value);
            if (t !== undefined) onApply(fillTemplate(t.prompt, gender));
          }}
        />
      </div>
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<PencilIcon size={14} />}
        onClick={() => {
          setEditing(true);
        }}
      >
        {tw("influencers.templates.edit")}
      </Button>
      <TemplatesDialog
        open={editing}
        onClose={() => {
          setEditing(false);
        }}
      />
    </div>
  );
}

export function TemplatesDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const templates = useInfluencerTemplates();
  const save = useSaveTemplates();
  const [draft, setDraft] = useState<InfluencerTemplate[] | null>(null);

  useEffect(() => {
    if (open && draft === null && templates.data !== undefined) {
      setDraft(templates.data.templates.map((t) => ({ ...t })));
    }
  }, [open, draft, templates.data]);

  const close = () => {
    setDraft(null);
    save.reset();
    onClose();
  };

  const valid =
    draft !== null &&
    draft.every(
      (t) =>
        t.label.trim().length > 0 &&
        t.label.trim().length <= 40 &&
        t.prompt.trim().length > 0 &&
        t.prompt.trim().length <= 500,
    );

  return (
    <Dialog open={open} onClose={close} size="lg">
      <DialogHeader>
        <DialogTitle>{tw("influencers.templates.title")}</DialogTitle>
        <DialogClose label={tw("influencers.wizard.cancel")} />
      </DialogHeader>
      <DialogBody>
        <p className="m-0 mb-4 text-xs text-text-subtle">
          {tw("influencers.templates.hint")}
        </p>
        {templates.isError ? (
          <ApiErrorState
            error={templates.error}
            onRetry={() => {
              void templates.refetch();
            }}
          />
        ) : draft === null ? (
          <Skeleton height={160} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {draft.map((t, i) => (
              <li
                key={t.id}
                className="flex flex-col gap-2 rounded-xl border border-border p-3"
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={tw("influencers.templates.name")}
                    maxLength={40}
                    value={t.label}
                    onChange={(e) => {
                      setDraft(
                        draft.map((x, j) =>
                          j === i ? { ...x, label: e.target.value } : x,
                        ),
                      );
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={tw("influencers.templates.remove")}
                    leadingIcon={<TrashIcon size={14} />}
                    onClick={() => {
                      setDraft(draft.filter((_, j) => j !== i));
                    }}
                  />
                </div>
                <Textarea
                  aria-label={tw("influencers.templates.prompt")}
                  rows={2}
                  maxLength={500}
                  value={t.prompt}
                  onChange={(e) => {
                    setDraft(
                      draft.map((x, j) =>
                        j === i ? { ...x, prompt: e.target.value } : x,
                      ),
                    );
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {draft !== null && draft.length < 30 && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            leadingIcon={<PlusIcon size={14} />}
            onClick={() => {
              const label = tw("influencers.templates.new");
              setDraft([
                ...draft,
                {
                  id: templateId(label, new Set(draft.map((t) => t.id))),
                  label,
                  prompt: "{subject} ",
                },
              ]);
            }}
          >
            {tw("influencers.templates.add")}
          </Button>
        )}
        {save.isError && (
          <p className="m-0 mt-3 text-sm text-danger" role="alert">
            {save.error.serverMessage ?? tw("influencers.templates.saveError")}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={save.isPending}
          onClick={() => {
            save.mutate(null, { onSuccess: close });
          }}
        >
          {tw("influencers.templates.reset")}
        </Button>
        <Button
          loading={save.isPending}
          disabled={!valid || save.isPending}
          onClick={() => {
            if (draft === null) return;
            save.mutate(
              draft.map((t) => ({
                ...t,
                label: t.label.trim(),
                prompt: t.prompt.trim(),
              })),
              { onSuccess: close },
            );
          }}
        >
          {tw("influencers.templates.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
