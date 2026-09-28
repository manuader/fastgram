"use client";

import {
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Spinner,
  Textarea,
} from "@fastgram/ui";
import type { AdObjectiveId, CreateAdCampaignRequest } from "@fastgram/contracts";
import { AD_OBJECTIVE_VALUES } from "@fastgram/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { flattenPages, useContentList } from "@/lib/library/content";
import { reasonOf, useAdsConnection, useCreateAdCampaign } from "./api";
import { adCampaignHref } from "./CampaignList";
import { parseMajorToMinor } from "./money";
import { reasonKey } from "./present";

const OBJECTIVE_KEY: Readonly<Record<AdObjectiveId, CopyKey>> = {
  OUTCOME_AWARENESS: "ads.objective.awareness",
  OUTCOME_TRAFFIC: "ads.objective.traffic",
  OUTCOME_ENGAGEMENT: "ads.objective.engagement",
};

export const MAX_AD_PIECES = 5;

export interface WizardDraft {
  readonly name: string;
  readonly objective: AdObjectiveId;
  readonly contentIds: readonly string[];
  readonly message: string;
  readonly destinationUrl: string;
  readonly countries: string;
  readonly ageMin: string;
  readonly ageMax: string;
  readonly daily: string;
  readonly total: string;
  readonly endDate: string;
  readonly abTest: boolean;
  readonly abMetric: "ctr" | "cvr";
  readonly isTest: boolean;
}

export type DraftProblem =
  | "name"
  | "pieces"
  | "countries"
  | "caps"
  | "daily_exceeds_total"
  | "destination"
  | "ab_two_pieces"
  | "age";

/** El borrador del formulario → el cuerpo de `POST /ads/campaigns`, o el primer problema. */
export function draftToRequest(
  d: WizardDraft,
  currency: string,
): { ok: true; body: CreateAdCampaignRequest } | { ok: false; problem: DraftProblem } {
  if (d.name.trim() === "") return { ok: false, problem: "name" };
  if (d.contentIds.length === 0) return { ok: false, problem: "pieces" };
  if (d.abTest && d.contentIds.length < 2) return { ok: false, problem: "ab_two_pieces" };
  const countries = d.countries
    .split(/[\s,]+/u)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c !== "");
  if (countries.length === 0 || countries.some((c) => !/^[A-Z]{2}$/u.test(c)))
    return { ok: false, problem: "countries" };
  const daily = parseMajorToMinor(d.daily, currency);
  const total = parseMajorToMinor(d.total, currency);
  if (daily === null || total === null) return { ok: false, problem: "caps" };
  if (daily > total) return { ok: false, problem: "daily_exceeds_total" };
  if (d.objective === "OUTCOME_TRAFFIC" && d.destinationUrl.trim() === "")
    return { ok: false, problem: "destination" };
  const ageMin = d.ageMin.trim() === "" ? undefined : Number(d.ageMin);
  const ageMax = d.ageMax.trim() === "" ? undefined : Number(d.ageMax);
  const ageOk = (a: number | undefined) =>
    a === undefined || (Number.isInteger(a) && a >= 18 && a <= 65);
  if (
    !ageOk(ageMin) ||
    !ageOk(ageMax) ||
    (ageMin !== undefined && ageMax !== undefined && ageMin > ageMax)
  )
    return { ok: false, problem: "age" };
  const end = d.endDate === "" ? undefined : new Date(`${d.endDate}T23:59:59`).getTime();
  return {
    ok: true,
    body: {
      name: d.name.trim(),
      objective: d.objective,
      contentIds: [...d.contentIds],
      message: d.message,
      ...(d.destinationUrl.trim() === ""
        ? {}
        : { destinationUrl: d.destinationUrl.trim() }),
      targeting: {
        countries,
        ...(ageMin === undefined ? {} : { ageMin }),
        ...(ageMax === undefined ? {} : { ageMax }),
      },
      dailyCapMinor: daily,
      totalCapMinor: total,
      ...(end === undefined || Number.isNaN(end) ? {} : { endTime: end }),
      ...(d.abTest ? { abTest: { metric: d.abMetric } } : {}),
      isTest: d.isTest,
    },
  };
}

const PROBLEM_KEY: Readonly<Record<DraftProblem, CopyKey>> = {
  name: "ads.wizard.problem.name",
  pieces: "ads.wizard.problem.pieces",
  countries: "ads.wizard.problem.countries",
  caps: "ads.wizard.problem.caps",
  daily_exceeds_total: "ads.reason.dailyExceedsTotal",
  destination: "ads.reason.destinationRequired",
  ab_two_pieces: "ads.reason.abTwoPieces",
  age: "ads.wizard.problem.age",
};

const EMPTY: WizardDraft = {
  name: "",
  objective: "OUTCOME_TRAFFIC",
  contentIds: [],
  message: "",
  destinationUrl: "",
  countries: "",
  ageMin: "",
  ageMax: "",
  daily: "",
  total: "",
  endDate: "",
  abTest: false,
  abMetric: "ctr",
  isTest: true,
};

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
    </label>
  );
}

/**
 * `/ads/new`: objetivo, piezas de la Library, A/B opcional, audiencia básica
 * (países y edad: lo que la doc de Ad Set muestra sin audiencias propias),
 * topes y fin. Todo se crea **pausado**; activar es otro paso con confirmación.
 */
export function CampaignWizard() {
  const router = useRouter();
  const connection = useAdsConnection();
  const pieces = useContentList({ status: "CREATED" });
  const create = useCreateAdCampaign();
  const [draft, setDraft] = useState<WizardDraft>(EMPTY);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const set = <K extends keyof WizardDraft>(k: K, v: WizardDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const items = useMemo(() => flattenPages(pieces.data), [pieces.data]);

  if (connection.isPending || pieces.isPending)
    return (
      <Skeleton className="h-96 w-full rounded-xl" aria-label={tw("common.loading")} />
    );
  if (connection.isError || pieces.isError)
    return (
      <ErrorState
        title={tw("ads.wizard.loadError")}
        onRetry={() => {
          void connection.refetch();
          void pieces.refetch();
        }}
      />
    );
  if (connection.data.status !== "active")
    return (
      <EmptyState
        bordered
        title={tw("ads.connect.title")}
        description={tw("ads.wizard.needsConnection")}
      />
    );
  const currency = connection.data.adAccount?.currency ?? "USD";

  function toggle(id: string) {
    setDraft((d) => {
      const has = d.contentIds.includes(id);
      if (!has && d.contentIds.length >= MAX_AD_PIECES) return d;
      return {
        ...d,
        contentIds: has ? d.contentIds.filter((x) => x !== id) : [...d.contentIds, id],
      };
    });
  }

  function submit() {
    const out = draftToRequest(draft, currency);
    if (!out.ok) {
      setProblem(out.problem);
      return;
    }
    setProblem(null);
    create.mutate(out.body, {
      onSuccess: (detail) => router.push(adCampaignHref(detail.campaign.id)),
    });
  }

  const serverKey =
    create.error === null
      ? null
      : (reasonKey(reasonOf(create.error)) ?? "ads.error.generic");
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <Field label={tw("ads.wizard.name")}>
            <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label={tw("ads.wizard.objective")}>
            <Select
              value={draft.objective}
              onChange={(e) => set("objective", e.target.value as AdObjectiveId)}
              options={AD_OBJECTIVE_VALUES.map((o) => ({
                value: o,
                label: tw(OBJECTIVE_KEY[o]),
              }))}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.isTest}
              onChange={(e) => set("isTest", e.target.checked)}
            />
            {tw("ads.wizard.isTest")}
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-base font-semibold">{tw("ads.wizard.pieces")}</h2>
          <p className="text-xs text-text-muted">
            {tw("ads.wizard.piecesHint", { max: String(MAX_AD_PIECES) })}
          </p>
          {items.length === 0 ? (
            <p className="text-sm text-text-muted">{tw("ads.wizard.noPieces")}</p>
          ) : (
            <ul
              className="grid grid-cols-3 gap-2 sm:grid-cols-5"
              aria-label={tw("ads.wizard.pieces")}
            >
              {items.map((p) => {
                const selected = draft.contentIds.includes(p._id);
                return (
                  <li key={p._id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggle(p._id)}
                      className={`flex w-full flex-col items-center gap-1 rounded-lg border p-1 text-xs ${selected ? "border-accent" : "border-border"}`}
                    >
                      {p.thumbnailUrl === undefined ? (
                        <span className="flex h-24 w-full items-center justify-center bg-surface-sunken">
                          {p.type}
                        </span>
                      ) : (
                        <img
                          src={p.thumbnailUrl}
                          alt=""
                          className="h-24 w-full rounded object-cover"
                        />
                      )}
                      <span>{p.type}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.abTest}
              onChange={(e) => set("abTest", e.target.checked)}
            />
            {tw("ads.wizard.abTest")}
          </label>
          {draft.abTest && (
            <Field label={tw("ads.wizard.abMetric")}>
              <Select
                value={draft.abMetric}
                onChange={(e) => set("abMetric", e.target.value as "ctr" | "cvr")}
                options={[
                  { value: "ctr", label: tw("ads.wizard.abMetric.ctr") },
                  { value: "cvr", label: tw("ads.wizard.abMetric.cvr") },
                ]}
              />
            </Field>
          )}
          <Field label={tw("ads.wizard.message")}>
            <Textarea
              value={draft.message}
              onChange={(e) => set("message", e.target.value)}
              rows={3}
            />
          </Field>
          <Field label={tw("ads.wizard.destination")}>
            <Input
              value={draft.destinationUrl}
              onChange={(e) => set("destinationUrl", e.target.value)}
              placeholder="https://"
              inputMode="url"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-base font-semibold">{tw("ads.wizard.audience")}</h2>
          <Field label={tw("ads.wizard.countries")}>
            <Input
              value={draft.countries}
              onChange={(e) => set("countries", e.target.value)}
              placeholder="AR, UY"
            />
          </Field>
          <div className="flex gap-3">
            <Field label={tw("ads.wizard.ageMin")}>
              <Input
                value={draft.ageMin}
                onChange={(e) => set("ageMin", e.target.value)}
                inputMode="numeric"
              />
            </Field>
            <Field label={tw("ads.wizard.ageMax")}>
              <Input
                value={draft.ageMax}
                onChange={(e) => set("ageMax", e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
          <p className="text-xs text-text-muted">{tw("ads.wizard.interestsNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-base font-semibold">{tw("ads.wizard.budget")}</h2>
          <div className="flex flex-wrap gap-3">
            <Field label={tw("ads.budget.daily", { currency })}>
              <Input
                value={draft.daily}
                onChange={(e) => set("daily", e.target.value)}
                inputMode="decimal"
              />
            </Field>
            <Field label={tw("ads.budget.total", { currency })}>
              <Input
                value={draft.total}
                onChange={(e) => set("total", e.target.value)}
                inputMode="decimal"
              />
            </Field>
            <Field label={tw("ads.wizard.endDate")}>
              <Input
                type="date"
                value={draft.endDate}
                onChange={(e) => set("endDate", e.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-text-muted">{tw("ads.wizard.budgetNote")}</p>
        </CardContent>
      </Card>

      {problem !== null && (
        <p role="alert" className="text-sm text-danger">
          {tw(PROBLEM_KEY[problem])}
        </p>
      )}
      {serverKey !== null && (
        <p role="alert" className="text-sm text-danger">
          {tw(serverKey)}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? <Spinner size="sm" aria-hidden="true" /> : null}
          {tw("ads.wizard.create")}
        </Button>
        <span className="text-xs text-text-muted">{tw("ads.wizard.createNote")}</span>
      </div>
    </form>
  );
}
