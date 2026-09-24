"use client";

import type { InfluencerSetup } from "@fastgram/contracts";
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
  Textarea,
  cn,
} from "@fastgram/ui";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { BudgetMeter } from "@/components/ai-studio/BudgetMeter";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { useCreateInfluencer } from "@/lib/influencers/api";
import {
  INITIAL_WIZARD,
  canLeaveStep,
  clampAge,
  toggleReference,
  type WizardForm,
  type WizardStep,
} from "@/lib/influencers/form";
import { ROUTES } from "@/lib/nav/routes";
import { ReferencePicker } from "./ReferencePicker";

export interface NewInfluencerWizardProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly setup: InfluencerSetup;
}

/**
 * `New influencer (1/3)` — FR-080 adaptado al plan de uso personal
 * (`PU-LATER-004`): (1) nombre y rasgos opcionales, (2) 4–20 fotos del Media
 * Bank, (3) confirmar. El costo de crear el personaje **no se conoce**
 * (Higgsfield no lo publica) y se dice así, junto al presupuesto del mes.
 */
export function NewInfluencerWizard({ open, onClose, setup }: NewInfluencerWizardProps) {
  const ids = {
    name: useId(),
    gender: useId(),
    age: useId(),
    eth: useId(),
    det: useId(),
  };
  const [step, setStep] = useState<WizardStep>(1);
  const [form, setForm] = useState<WizardForm>(INITIAL_WIZARD);
  // Una clave por intento de creación: un doble click replica, no duplica.
  const keyRef = useRef<string>(crypto.randomUUID());
  const create = useCreateInfluencer();
  const router = useRouter();

  const close = () => {
    setStep(1);
    setForm(INITIAL_WIZARD);
    create.reset();
    keyRef.current = crypto.randomUUID();
    onClose();
  };

  const submit = () => {
    create.mutate(
      { form, idempotencyKey: keyRef.current },
      {
        onSuccess: (created) => {
          close();
          router.push(`${ROUTES.influencers}/${created._id}`);
        },
      },
    );
  };

  const error = create.error;
  const errorText = isApiRequestError(error)
    ? error.details?.["reason"] === "budget_exceeded"
      ? tw("influencers.budget.exhausted")
      : error.details?.["reason"] === "not_configured"
        ? tw("influencers.setup.body")
        : (error.serverMessage ?? tw("influencers.wizard.error"))
    : error !== null
      ? tw("influencers.wizard.error")
      : null;

  return (
    <Dialog open={open} onClose={close} size="lg" closeOnOverlayClick={false}>
      <DialogHeader>
        <DialogTitle>{tw("influencers.wizard.title", { step })}</DialogTitle>
        <DialogClose label={tw("influencers.wizard.cancel")} />
      </DialogHeader>
      <div className="flex gap-1 px-6" aria-hidden="true">
        {[1, 2, 3].map((s) => (
          <span
            key={s}
            className={cn(
              "h-1 flex-1 rounded-full",
              s <= step ? "bg-accent" : "bg-surface-sunken",
            )}
          />
        ))}
      </div>
      <DialogBody>
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.name} className="text-sm font-medium text-text">
                {tw("influencers.wizard.name")}
              </label>
              <Input
                id={ids.name}
                maxLength={100}
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                }}
              />
            </div>
            <p className="m-0 text-xs text-text-subtle">
              {tw("influencers.wizard.traitsHint")}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor={ids.gender} className="text-sm font-medium text-text">
                  {tw("influencers.wizard.gender")}
                </label>
                <Select
                  id={ids.gender}
                  value={form.gender}
                  options={[
                    { value: "", label: tw("influencers.wizard.gender.none") },
                    { value: "female", label: tw("influencers.wizard.gender.female") },
                    { value: "male", label: tw("influencers.wizard.gender.male") },
                    { value: "other", label: tw("influencers.wizard.gender.other") },
                  ]}
                  onChange={(e) => {
                    setForm({ ...form, gender: e.target.value as WizardForm["gender"] });
                  }}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor={ids.age} className="text-sm font-medium text-text">
                  {tw("influencers.wizard.age")}
                  {form.age !== null && ` · ${String(form.age)}`}
                </label>
                {form.age === null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    onClick={() => {
                      setForm({ ...form, age: 25 });
                    }}
                  >
                    {tw("influencers.wizard.age.set")}
                  </Button>
                ) : (
                  <input
                    id={ids.age}
                    type="range"
                    min={18}
                    max={60}
                    value={form.age}
                    onChange={(e) => {
                      setForm({ ...form, age: clampAge(Number(e.target.value)) });
                    }}
                  />
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.eth} className="text-sm font-medium text-text">
                {tw("influencers.wizard.ethnicity")}
              </label>
              <Input
                id={ids.eth}
                maxLength={60}
                value={form.ethnicity}
                onChange={(e) => {
                  setForm({ ...form, ethnicity: e.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.det} className="text-sm font-medium text-text">
                {tw("influencers.wizard.details")}
              </label>
              <Textarea
                id={ids.det}
                rows={2}
                maxLength={500}
                placeholder={tw("influencers.wizard.detailsPlaceholder")}
                value={form.details}
                onChange={(e) => {
                  setForm({ ...form, details: e.target.value });
                }}
              />
            </div>
          </div>
        )}
        {step === 2 && (
          <ReferencePicker
            selected={form.referenceMediaIds}
            onToggle={(id) => {
              setForm(toggleReference(form, id));
            }}
          />
        )}
        {step === 3 && (
          <div className="flex flex-col gap-4">
            <p className="m-0 text-sm text-text">
              {tw("influencers.wizard.confirm.body", {
                name: form.name.trim(),
                count: form.referenceMediaIds.length,
              })}
            </p>
            <div className="flex flex-col gap-3 rounded-xl bg-surface-sunken p-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  {tw("influencers.wizard.confirm.cost")}
                </span>
                <span className="text-sm text-text">
                  {tw("influencers.wizard.confirm.costUnknown")}
                </span>
              </div>
              <BudgetMeter summary={setup.budget} />
            </div>
            {!setup.canCreate && (
              <p className="m-0 text-sm text-danger" role="alert">
                {tw("influencers.budget.exhausted")}
              </p>
            )}
            {errorText !== null && (
              <p className="m-0 text-sm text-danger" role="alert">
                {errorText}
              </p>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {step > 1 ? (
          <Button
            variant="ghost"
            onClick={() => {
              setStep((step - 1) as WizardStep);
            }}
          >
            {tw("influencers.wizard.back")}
          </Button>
        ) : (
          <Button variant="ghost" onClick={close}>
            {tw("influencers.wizard.cancel")}
          </Button>
        )}
        {step < 3 ? (
          <Button
            disabled={!canLeaveStep(form, step)}
            onClick={() => {
              setStep((step + 1) as WizardStep);
            }}
          >
            {tw("influencers.wizard.next")}
          </Button>
        ) : (
          <Button
            loading={create.isPending}
            disabled={!setup.canCreate || create.isPending}
            onClick={submit}
          >
            {create.isPending
              ? tw("influencers.wizard.creating")
              : tw("influencers.wizard.create")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
