"use client";

import {
  Button,
  Card,
  Checkbox,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Switch,
  cn,
  useToast,
} from "@fastgram/ui";
import type {
  Automation,
  AutomationAccount,
  CreateAutomationRequest,
  StrategyNetwork,
} from "@fastgram/contracts";
import { motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type ReactNode } from "react";
import { WeightSlider } from "@/components/blitz/WeightSlider";
import { useStrategy } from "@/components/strategy/api";
import { apiRequest } from "@/lib/api/client";
import { copyKeyForError } from "@/lib/api/errors";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { browserTimeZone } from "@/lib/calendar/calendar";
import { useConnectionAccounts } from "@/lib/connections/api";
import { setWeight } from "@/lib/blitz/weights";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { useCreateAutomation, useUpdateAutomation } from "@/lib/automations/api";
import { generationBlockedCopy, todayIn } from "@/lib/automations/present";
import { automationSchema } from "@fastgram/contracts";
import { automationHref } from "./AutomationsList";

/** Las redes en el orden de la estrategia (`D-09`). */
export const WIZARD_PLATFORMS: readonly StrategyNetwork[] = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
];

type MixKey =
  "slideshowWeight" | "wallOfTextWeight" | "greenScreenWeight" | "videoHookWeight";
const MIX: readonly { key: MixKey; label: CopyKey }[] = [
  { key: "slideshowWeight", label: "library.type.slideshow" },
  { key: "wallOfTextWeight", label: "library.type.wallOfText" },
  { key: "greenScreenWeight", label: "library.type.greenScreen" },
  { key: "videoHookWeight", label: "library.type.videoHook" },
];

const STEPS: readonly CopyKey[] = [
  "automations.wizard.step.basics",
  "automations.wizard.step.accounts",
  "automations.wizard.step.content",
  "automations.wizard.step.review",
];

/** Lo que el formulario guarda por red: apagada, planificada o una conexión. */
type Destination = "off" | "planned" | string;

export interface WizardState {
  readonly name: string;
  readonly startDate: string;
  readonly timezone: string;
  readonly durationWeeks: number;
  readonly perAccountPerDay: number;
  readonly useStrategyTimes: boolean;
  readonly postingTimes: readonly string[];
  readonly destinations: Readonly<Partial<Record<StrategyNetwork, Destination>>>;
  readonly mix: Readonly<Record<MixKey, number>>;
  readonly remixPercentage: number;
  readonly ownMediaPercentage: number;
  readonly influencerChance: number;
  readonly topics: string;
  readonly postingMode: "inbox" | "direct";
  readonly youtubePrivacyStatus: "public" | "private" | "unlisted";
  readonly aiContentDisclaimer: boolean;
  readonly discloseAsAds: boolean;
}

const DEFAULT_TIMES = ["09:00", "13:00", "18:00"];

export function initialWizardState(timezone: string, from?: Automation): WizardState {
  if (from !== undefined) {
    const destinations: Partial<Record<StrategyNetwork, Destination>> = {};
    for (const a of from.accounts)
      destinations[a.platform] = a.accountType === "oauth" ? a.connectionId : "planned";
    return {
      name: from.name,
      startDate: from.startDate,
      timezone: from.timezone,
      durationWeeks: from.durationWeeks,
      perAccountPerDay: from.perAccountPerDay,
      useStrategyTimes: from.postingTimes === null,
      postingTimes: from.postingTimes ?? DEFAULT_TIMES.slice(0, from.perAccountPerDay),
      destinations,
      mix: {
        slideshowWeight: from.prefsSnapshot.slideshowWeight,
        wallOfTextWeight: from.prefsSnapshot.wallOfTextWeight,
        greenScreenWeight: from.prefsSnapshot.greenScreenWeight,
        videoHookWeight: from.prefsSnapshot.videoHookWeight,
      },
      remixPercentage: from.prefsSnapshot.remixPercentage,
      ownMediaPercentage: from.prefsSnapshot.ownMediaPercentage,
      influencerChance: from.prefsSnapshot.influencerChance,
      topics: from.prefsSnapshot.topics.join("\n"),
      postingMode: from.postingMode ?? "inbox",
      youtubePrivacyStatus: from.youtubePrivacyStatus ?? "public",
      aiContentDisclaimer: from.aiContentDisclaimer,
      discloseAsAds: from.discloseAsAds,
    };
  }
  const tomorrow = new Date(Date.parse(`${todayIn(timezone)}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    name: "",
    startDate: tomorrow,
    timezone,
    durationWeeks: 1,
    perAccountPerDay: 1,
    useStrategyTimes: true,
    postingTimes: DEFAULT_TIMES.slice(0, 1),
    destinations: {},
    mix: {
      slideshowWeight: 25,
      wallOfTextWeight: 25,
      greenScreenWeight: 25,
      videoHookWeight: 25,
    },
    remixPercentage: 0,
    ownMediaPercentage: 100,
    influencerChance: 50,
    topics: "",
    postingMode: "inbox",
    youtubePrivacyStatus: "public",
    aiContentDisclaimer: false,
    discloseAsAds: false,
  };
}

export function accountsOf(state: WizardState): AutomationAccount[] {
  const out: AutomationAccount[] = [];
  for (const platform of WIZARD_PLATFORMS) {
    const d = state.destinations[platform];
    if (d === undefined || d === "off") continue;
    out.push(
      d === "planned"
        ? { platform, accountType: "planned" }
        : { platform, accountType: "oauth", connectionId: d },
    );
  }
  return out;
}

/** El cuerpo de `POST /automations` (y, sin `name` vacío, del `PATCH`). */
export function requestOf(state: WizardState): CreateAutomationRequest {
  const topics = state.topics
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .slice(0, 10);
  return {
    name: state.name.trim(),
    accounts: accountsOf(state),
    perAccountPerDay: state.perAccountPerDay,
    durationWeeks: state.durationWeeks,
    startDate: state.startDate,
    timezone: state.timezone,
    postingTimes: state.useStrategyTimes
      ? null
      : state.postingTimes.slice(0, state.perAccountPerDay),
    postingMode: state.postingMode,
    youtubePrivacyStatus: state.youtubePrivacyStatus,
    aiContentDisclaimer: state.aiContentDisclaimer,
    discloseAsAds: state.discloseAsAds,
    prefs: {
      ...state.mix,
      remixPercentage: state.remixPercentage,
      ownMediaPercentage: state.ownMediaPercentage,
      influencerChance: state.influencerChance,
      topics,
    },
  };
}

/** Lo que falta para poder avanzar de cada paso. `null` = se puede. */
export function stepProblem(state: WizardState, step: number): CopyKey | null {
  if (step === 0) {
    if (state.name.trim() === "") return "automations.wizard.problem.name";
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(state.startDate))
      return "automations.wizard.problem.start";
  }
  if (step === 1 && accountsOf(state).length === 0)
    return "automations.wizard.problem.accounts";
  if (step === 2) {
    const sum = Object.values(state.mix).reduce((a, b) => a + b, 0);
    if (sum === 0) return "automations.wizard.problem.mix";
    if (
      state.destinations.youtube !== undefined &&
      state.destinations.youtube !== "off" &&
      state.mix.slideshowWeight > 0
    )
      return "automations.wizard.problem.youtube";
  }
  return null;
}

export interface AutomationWizardProps {
  /** Editar un borrador (`/automations/:id/edit`). Ausente = crear. */
  readonly automation?: Automation;
}

/**
 * El wizard de configuración — `F-211`, `F-212`, `FR-150` (UI del wizard).
 *
 * Cuatro pasos con su barra (`Automation setup progress`): lo básico (nombre,
 * inicio, semanas, posts por día, horarios), las cuentas destino por red, el
 * contenido (mix de formatos con la regla de YouTube, remix, media propia,
 * influencers, temas) y el resumen con las opciones de TikTok, YouTube y la
 * etiqueta IA. Se guarda como borrador o se genera directamente.
 */
export function AutomationWizard({ automation }: AutomationWizardProps) {
  const strategy = useStrategy();
  const connections = useConnectionAccounts();
  if (automation === undefined && strategy.isPending) {
    return (
      <Skeleton className="h-96 w-full rounded-xl" aria-label={tw("common.loading")} />
    );
  }
  const timezone = strategy.data?.timezone ?? browserTimeZone();
  return (
    <WizardForm
      initial={initialWizardState(timezone, automation)}
      automation={automation}
      connections={(connections.data ?? []).filter((c) => c.status === "active")}
      connectionsError={connections.isError}
    />
  );
}

function WizardForm({
  initial,
  automation,
  connections,
  connectionsError,
}: {
  readonly initial: WizardState;
  readonly automation: Automation | undefined;
  readonly connections: readonly { _id: string; platform: string; username: string }[];
  readonly connectionsError: boolean;
}) {
  const [state, setState] = useState<WizardState>(initial);
  const [step, setStep] = useState(0);
  const [problem, setProblem] = useState<CopyKey | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"draft" | "generate" | null>(null);
  const create = useCreateAutomation();
  const update = useUpdateAutomation(automation?.id ?? "");
  const router = useRouter();
  const { toast } = useToast();
  const reduce = useReducedMotion();
  const ids = { name: useId(), start: useId(), tz: useId(), topics: useId() };

  const set = (patch: Partial<WizardState>) => {
    setState((s) => ({ ...s, ...patch }));
  };
  const hasYouTube =
    state.destinations.youtube !== undefined && state.destinations.youtube !== "off";
  const totalPosts = state.perAccountPerDay * 7 * state.durationWeeks;

  const next = () => {
    const p = stepProblem(state, step);
    setProblem(p);
    if (p === null) setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  async function submit(mode: "draft" | "generate") {
    for (let s = 0; s < STEPS.length; s += 1) {
      const p = stepProblem(state, s);
      if (p !== null) {
        setStep(s);
        setProblem(p);
        return;
      }
    }
    setSubmitError(null);
    setSubmitting(mode);
    try {
      const body = requestOf(state);
      const saved =
        automation === undefined
          ? await create.mutateAsync(body)
          : await update.mutateAsync(body);
      if (mode === "generate") {
        try {
          await apiRequest(`/automations/${encodeURIComponent(saved.id)}/generate`, {
            method: "POST",
            schema: automationSchema,
          });
          toast({ title: tw("automations.toast.generating"), tone: "success" });
        } catch (error: unknown) {
          // El borrador ya existe: no se vuelve a crear. Se va al detalle con
          // el motivo (ahí se corrige y se genera de nuevo).
          toast({
            title: generationBlockedCopy(error) ?? tw(copyKeyForError(error)),
            tone: "danger",
          });
        }
      } else {
        toast({ title: tw("automations.toast.saved"), tone: "success" });
      }
      router.push(automationHref(saved.id));
    } catch (error: unknown) {
      setSubmitError(generationBlockedCopy(error) ?? tw(copyKeyForError(error)));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label={tw("automations.wizard.progress")}>
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => {
                  if (i <= step) setStep(i);
                }}
                aria-current={i === step ? "step" : undefined}
                className={cn(
                  "fg-focusable flex items-center gap-2 rounded-full border px-3 py-1 text-sm",
                  i === step
                    ? "border-accent bg-accent text-accent-contrast"
                    : i < step
                      ? "border-border bg-surface text-text"
                      : "border-border bg-surface text-text-muted",
                )}
              >
                <span aria-hidden="true">{i + 1}</span>
                {tw(label)}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {/* Sin `AnimatePresence`: un paso que sale no convive con el que entra
          (dos botones `Continue` a la vez responderían con el paso viejo). */}
      <motion.div
        key={step}
        initial={reduce === true ? false : { opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.18 }}
      >
        <Card padding="lg" className="flex flex-col gap-5">
          {step === 0 && (
            <>
              <Field id={ids.name} label={tw("automations.wizard.name")}>
                <Input
                  id={ids.name}
                  value={state.name}
                  maxLength={100}
                  placeholder={tw("automations.wizard.namePlaceholder")}
                  onChange={(e) => {
                    set({ name: e.target.value });
                  }}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={ids.start} label={tw("automations.wizard.start")}>
                  <Input
                    id={ids.start}
                    type="date"
                    value={state.startDate}
                    onChange={(e) => {
                      set({ startDate: e.target.value });
                    }}
                  />
                </Field>
                <Field id={ids.tz} label={tw("automations.wizard.timezone")}>
                  <Input
                    id={ids.tz}
                    value={state.timezone}
                    onChange={(e) => {
                      set({ timezone: e.target.value });
                    }}
                  />
                </Field>
              </div>
              <Stepper
                label={tw("automations.wizard.weeks")}
                value={state.durationWeeks}
                min={1}
                max={4}
                onChange={(v) => {
                  set({ durationWeeks: v });
                }}
              />
              <Stepper
                label={tw("automations.wizard.perDay")}
                value={state.perAccountPerDay}
                min={1}
                max={3}
                onChange={(v) => {
                  set({
                    perAccountPerDay: v,
                    postingTimes: [...state.postingTimes, ...DEFAULT_TIMES]
                      .filter((t, i, all) => all.indexOf(t) === i)
                      .slice(0, v),
                  });
                }}
              />
              <div className="flex flex-col gap-3">
                <Checkbox
                  label={tw("automations.wizard.strategyTimes")}
                  checked={state.useStrategyTimes}
                  onChange={(e) => {
                    set({ useStrategyTimes: e.currentTarget.checked });
                  }}
                />
                {!state.useStrategyTimes && (
                  <div className="flex flex-wrap gap-3">
                    {state.postingTimes.map((time, i) => (
                      <Input
                        key={i}
                        type="time"
                        aria-label={tw("automations.wizard.time", { n: i + 1 })}
                        className="w-32"
                        value={time}
                        onChange={(e) => {
                          const times = [...state.postingTimes];
                          times[i] = e.target.value;
                          set({ postingTimes: times });
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">
                {tw("automations.wizard.accountsHint")}
              </p>
              {connectionsError && (
                <p role="alert" className="text-sm text-danger">
                  {tw("automations.wizard.connectionsError")}
                </p>
              )}
              <ul className="flex flex-col gap-2">
                {WIZARD_PLATFORMS.map((platform) => {
                  const own = connections.filter((c) => c.platform === platform);
                  const value = state.destinations[platform] ?? "off";
                  return (
                    <li
                      key={platform}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <span className="font-medium text-text">
                        {NETWORK_LABEL[platform]}
                      </span>
                      <Select
                        aria-label={tw("automations.wizard.destinationFor", {
                          network: NETWORK_LABEL[platform],
                        })}
                        value={value}
                        wrapperClassName="min-w-[220px]"
                        onChange={(e) => {
                          set({
                            destinations: {
                              ...state.destinations,
                              [platform]: e.target.value,
                            },
                          });
                        }}
                        options={[
                          { value: "off", label: tw("automations.wizard.dontPost") },
                          ...own.map((c) => ({ value: c._id, label: `@${c.username}` })),
                          { value: "planned", label: tw("automations.wizard.planned") },
                        ]}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col gap-5">
              <section
                className="flex flex-col gap-3"
                aria-label={tw("automations.wizard.mix")}
              >
                <h2 className="text-sm font-semibold text-text">
                  {tw("automations.wizard.mix")}
                </h2>
                {MIX.map(({ key, label }) => (
                  <WeightSlider
                    key={key}
                    label={tw(label)}
                    value={state.mix[key]}
                    hint={
                      key === "slideshowWeight" && hasYouTube
                        ? tw("automations.wizard.youtubeSlideshow")
                        : key === "videoHookWeight"
                          ? tw("automations.wizard.videoHookHint")
                          : undefined
                    }
                    onChange={(v) => {
                      const nextMix = setWeight(state.mix, key, v) as Record<
                        MixKey,
                        number
                      >;
                      set({ mix: nextMix });
                    }}
                  />
                ))}
                {hasYouTube && state.mix.slideshowWeight > 0 && (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-warning">
                      {tw("automations.wizard.youtubeSlideshow")}
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        set({
                          mix: setWeight(state.mix, "slideshowWeight", 0) as Record<
                            MixKey,
                            number
                          >,
                        });
                      }}
                    >
                      {tw("automations.wizard.removeSlideshow")}
                    </Button>
                  </div>
                )}
                <p className="text-xs text-text-muted">
                  {tw("automations.wizard.zeroExcluded")}
                </p>
              </section>
              <WeightSlider
                label={tw("automations.wizard.remix")}
                value={state.remixPercentage}
                onChange={(v) => {
                  set({ remixPercentage: v });
                }}
              />
              <WeightSlider
                label={tw("automations.wizard.ownMedia")}
                value={state.ownMediaPercentage}
                onChange={(v) => {
                  set({ ownMediaPercentage: v });
                }}
              />
              <WeightSlider
                label={tw("automations.wizard.influencer")}
                value={state.influencerChance}
                onChange={(v) => {
                  set({ influencerChance: v });
                }}
              />
              <Field id={ids.topics} label={tw("automations.wizard.topics")}>
                <textarea
                  id={ids.topics}
                  className="fg-input min-h-[96px] w-full"
                  placeholder={tw("automations.wizard.topicsPlaceholder")}
                  value={state.topics}
                  onChange={(e) => {
                    set({ topics: e.target.value });
                  }}
                />
              </Field>
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col gap-4">
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Summary label={tw("automations.wizard.name")} value={state.name} />
                <Summary
                  label={tw("automations.wizard.summary.schedule")}
                  value={tw("automations.wizard.summary.scheduleValue", {
                    weeks: state.durationWeeks,
                    perDay: state.perAccountPerDay,
                    start: state.startDate,
                  })}
                />
                <Summary
                  label={tw("automations.wizard.summary.accounts")}
                  value={accountsOf(state)
                    .map((a) => NETWORK_LABEL[a.platform])
                    .join(", ")}
                />
                <Summary
                  label={tw("automations.wizard.summary.posts")}
                  value={tw("automations.wizard.summary.postsValue", {
                    pieces: totalPosts,
                    posts: totalPosts * accountsOf(state).length,
                  })}
                />
              </dl>
              {state.destinations.tiktok !== undefined &&
                state.destinations.tiktok !== "off" && (
                  <Select
                    aria-label={tw("automations.wizard.tiktokMode")}
                    value={state.postingMode}
                    onChange={(e) => {
                      set({
                        postingMode: e.target.value === "direct" ? "direct" : "inbox",
                      });
                    }}
                    options={[
                      { value: "inbox", label: tw("automations.wizard.tiktokInbox") },
                      { value: "direct", label: tw("automations.wizard.tiktokDirect") },
                    ]}
                  />
                )}
              {hasYouTube && (
                <Select
                  aria-label={tw("automations.wizard.youtubePrivacy")}
                  value={state.youtubePrivacyStatus}
                  onChange={(e) => {
                    const v = e.target.value;
                    set({
                      youtubePrivacyStatus:
                        v === "private" || v === "unlisted" ? v : "public",
                    });
                  }}
                  options={[
                    { value: "public", label: tw("automations.wizard.ytPublic") },
                    { value: "unlisted", label: tw("automations.wizard.ytUnlisted") },
                    { value: "private", label: tw("automations.wizard.ytPrivate") },
                  ]}
                />
              )}
              <label className="flex items-start gap-3 text-sm text-text">
                <Switch
                  checked={state.aiContentDisclaimer}
                  onCheckedChange={(v) => {
                    set({ aiContentDisclaimer: v });
                  }}
                  aria-label={tw("automations.wizard.aiLabel")}
                />
                <span className="flex flex-col">
                  <span>{tw("automations.wizard.aiLabel")}</span>
                  <span className="text-xs text-text-muted">
                    {tw("automations.wizard.aiLabelHint")}
                  </span>
                </span>
              </label>
            </div>
          )}

          {problem !== null && (
            <p role="alert" className="text-sm text-danger">
              {tw(problem)}
            </p>
          )}
          {submitError !== null && (
            <p role="alert" className="text-sm text-danger">
              {submitError}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              disabled={step === 0}
              onClick={() => {
                setProblem(null);
                setStep((s) => Math.max(0, s - 1));
              }}
            >
              {tw("automations.wizard.back")}
            </Button>
            <div className="flex gap-2">
              {step < STEPS.length - 1 ? (
                <Button onClick={next}>{tw("automations.wizard.next")}</Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    loading={submitting === "draft"}
                    disabled={submitting !== null}
                    onClick={() => {
                      void submit("draft");
                    }}
                  >
                    {tw("automations.wizard.saveDraft")}
                  </Button>
                  <Button
                    loading={submitting === "generate"}
                    disabled={submitting !== null}
                    onClick={() => {
                      void submit("generate");
                    }}
                  >
                    {tw("automations.wizard.generate")}
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (v: number) => void;
}) {
  const options = useMemo(
    () => Array.from({ length: max - min + 1 }, (_, i) => min + i),
    [min, max],
  );
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-text">{label}</span>
      <div className="flex gap-2">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === value}
            onClick={() => {
              onChange(o);
            }}
            className={cn(
              "fg-focusable h-9 min-w-9 rounded-lg border px-3 text-sm font-medium",
              o === value
                ? "border-accent bg-accent text-accent-contrast"
                : "border-border bg-surface text-text hover:bg-surface-sunken",
            )}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Summary({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col rounded-lg bg-surface-sunken p-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="font-medium text-text">{value === "" ? "—" : value}</dd>
    </div>
  );
}

/** Error de carga del borrador a editar. */
export function WizardLoadError({ onRetry }: { readonly onRetry: () => void }) {
  return <ErrorState title={tw("automations.detail.error")} onRetry={onRetry} />;
}
