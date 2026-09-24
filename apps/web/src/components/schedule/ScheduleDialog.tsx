"use client";

import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "@fastgram/ui";
import type { CaptionFieldName, Post, ScheduleOptions } from "@fastgram/contracts";
import { useEffect, useId, useMemo, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { presentError } from "@/lib/api/error-presentation";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { tw } from "@/lib/i18n/t";
import {
  PLATFORM_LIMITS,
  codePoints,
  defaultScheduleMs,
  draftProblems,
  initialDrafts,
  isOverLimit,
  supportsCaptionAi,
  targetsOf,
  useGenerateCaption,
  useSchedulePost,
  useScheduleOptions,
  utcToZoned,
  zonedToUtc,
  type NetworkDraft,
} from "@/lib/posts/schedule";

export interface ScheduleDialogProps {
  readonly open: boolean;
  readonly contentId: string;
  readonly onClose: () => void;
  /** Después de programar (el diálogo ya muestra el toast). */
  readonly onScheduled?: (posts: readonly Post[]) => void;
}

/**
 * Programar una pieza a mano — sprint 7 (publish-flow), FR-060 / F-157.
 *
 * Una sola vuelta a la API para armarse (`GET /content/:id/schedule-options`):
 * redes con su conexión, las de la estrategia sin conexión (marcadas, no
 * seleccionables), la caption **derivada de la pieza** por red, y el próximo
 * horario libre de la estrategia en la zona horaria de la marca.
 *
 * Por red: caption con contador contra el tope (por code point, como el
 * publicador), Improve / Regenerate con el modelo `text`, Reel o carrusel
 * para un slideshow en Instagram, etiqueta IA donde la ruta la soporta
 * (YouTube). TikTok va siempre como **borrador al inbox** (D-10): la
 * privacidad se elige al terminarlo en la app, porque la ruta no publica
 * directo.
 *
 * `Post now` programa a ahora + un margen (`postNow` del contrato); no es una
 * hora pasada disfrazada.
 */
export function ScheduleDialog({
  open,
  contentId,
  onClose,
  onScheduled,
}: ScheduleDialogProps) {
  const options = useScheduleOptions(contentId, open);
  return (
    <Dialog open={open} onClose={onClose} size="lg">
      <DialogHeader>
        <DialogTitle>{tw("schedule.title")}</DialogTitle>
        <DialogDescription>{tw("schedule.description")}</DialogDescription>
      </DialogHeader>
      {options.isPending ? (
        <DialogBody>
          <div aria-busy="true" className="flex flex-col gap-3">
            <Skeleton height={48} />
            <Skeleton height={120} />
            <Skeleton height={48} />
          </div>
        </DialogBody>
      ) : options.isError ? (
        <DialogBody>
          <ApiErrorState
            error={options.error}
            onRetry={() => {
              void options.refetch();
            }}
          />
        </DialogBody>
      ) : (
        <ScheduleForm
          key={contentId}
          contentId={contentId}
          options={options.data}
          onClose={onClose}
          {...(onScheduled === undefined ? {} : { onScheduled })}
        />
      )}
    </Dialog>
  );
}

interface ScheduleFormProps {
  readonly contentId: string;
  readonly options: ScheduleOptions;
  readonly onClose: () => void;
  readonly onScheduled?: (posts: readonly Post[]) => void;
}

function ScheduleForm({ contentId, options, onClose, onScheduled }: ScheduleFormProps) {
  const { toast } = useToast();
  const inPastId = useId();
  const schedule = useSchedulePost(contentId);
  const [drafts, setDrafts] = useState<NetworkDraft[]>(() => initialDrafts(options));
  const initial = useMemo(
    () => utcToZoned(defaultScheduleMs(options, Date.now()), options.timezone),
    [options],
  );
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const atMs = zonedToUtc(date, time, options.timezone);
  const inPast = atMs === null || atMs <= nowMs;
  const problems = draftProblems(drafts);
  const blocked = problems.length > 0;

  const update = (network: string, patch: Partial<NetworkDraft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.network === network ? { ...d, ...patch } : d)),
    );
  };

  const submit = (postNow: boolean) => {
    if (blocked || (!postNow && inPast)) return;
    schedule.mutate(
      {
        targets: targetsOf(drafts, options.contentType),
        scheduledAtUtc: postNow ? null : atMs,
      },
      {
        onSuccess: (posts) => {
          toast({
            title: postNow
              ? tw("schedule.toast.postingNow", { count: posts.length })
              : tw("schedule.toast.scheduled", {
                  count: posts.length,
                  when: `${date} ${time}`,
                }),
            tone: "success",
          });
          onScheduled?.(posts);
          onClose();
        },
      },
    );
  };

  const failure = schedule.error === null ? null : presentError(schedule.error);
  const unconnected = options.networks.filter(
    (n) => n.inStrategy && n.connections.length === 0,
  );

  return (
    <>
      <DialogBody>
        <div className="flex flex-col gap-4">
          {drafts.length === 0 ? (
            <p className="text-sm text-text-muted">{tw("schedule.noNetworks")}</p>
          ) : (
            <ul className="flex flex-col gap-3" aria-label={tw("schedule.networks")}>
              {drafts.map((draft) => (
                <NetworkRow
                  key={draft.network}
                  contentId={contentId}
                  draft={draft}
                  options={options}
                  onChange={(patch) => {
                    update(draft.network, patch);
                  }}
                />
              ))}
            </ul>
          )}

          {unconnected.length > 0 && (
            <p className="text-xs text-text-muted">
              {tw("schedule.unconnectedHint", {
                networks: unconnected.map((n) => NETWORK_LABEL[n.network]).join(", "),
              })}
            </p>
          )}

          <fieldset className="flex flex-wrap items-end gap-3">
            <legend className="mb-1 text-sm font-medium text-text">
              {tw("schedule.when", { timezone: options.timezone })}
            </legend>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              {tw("schedule.date")}
              <Input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                }}
                invalid={inPast}
                aria-describedby={inPast ? inPastId : undefined}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              {tw("schedule.time")}
              <Input
                type="time"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                }}
                invalid={inPast}
                aria-describedby={inPast ? inPastId : undefined}
              />
            </label>
            {options.suggestedAtUtc !== null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = utcToZoned(
                    defaultScheduleMs(options, Date.now()),
                    options.timezone,
                  );
                  setDate(next.date);
                  setTime(next.time);
                }}
              >
                {tw("schedule.useSuggested")}
              </Button>
            )}
          </fieldset>
          {inPast && (
            <p id={inPastId} role="status" className="text-xs text-danger">
              {tw("schedule.inPast")}
            </p>
          )}

          {/* Región viva siempre montada (P5-A11Y-001): lo que bloquea el envío
              se anuncia al aparecer, no sólo se pinta en rojo. */}
          <div aria-live="polite" className="flex flex-col gap-1">
            {problems.map((p) => (
              <p
                key={`${p.kind}:${"network" in p ? p.network : ""}:${"field" in p ? p.field : ""}`}
                className="text-xs text-danger"
              >
                {p.kind === "none_selected"
                  ? tw("schedule.problem.noneSelected")
                  : p.kind === "no_connection"
                    ? tw("schedule.problem.noConnection", {
                        network: NETWORK_LABEL[p.network],
                      })
                    : tw("schedule.problem.tooLong", {
                        network: NETWORK_LABEL[p.network],
                      })}
              </p>
            ))}
          </div>

          {failure !== null && (
            <p role="alert" className="text-sm text-danger">
              {tw(failure.titleKey, failure.titleVars)}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={schedule.isPending}>
          {tw("schedule.cancel")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            submit(true);
          }}
          disabled={blocked || schedule.isPending}
        >
          {tw("schedule.postNow")}
        </Button>
        <Button
          onClick={() => {
            submit(false);
          }}
          loading={schedule.isPending}
          disabled={blocked || inPast}
        >
          {tw("schedule.submit")}
        </Button>
      </DialogFooter>
    </>
  );
}

interface NetworkRowProps {
  readonly contentId: string;
  readonly draft: NetworkDraft;
  readonly options: ScheduleOptions;
  readonly onChange: (patch: Partial<NetworkDraft>) => void;
}

function NetworkRow({ contentId, draft, options, onChange }: NetworkRowProps) {
  const info = options.networks.find((n) => n.network === draft.network);
  const connections = info?.connections ?? [];
  const connected = connections.length > 0;
  const limits = PLATFORM_LIMITS[draft.network];
  const titled = limits.description !== null;
  const label = NETWORK_LABEL[draft.network];

  return (
    <li
      className="rounded-xl border border-border p-3"
      data-testid={`schedule-network-${draft.network}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          label={label}
          checked={draft.selected}
          disabled={!connected}
          onChange={(e) => {
            onChange({ selected: e.target.checked });
          }}
        />
        {!connected && <Badge tone="warning">{tw("schedule.notConnected")}</Badge>}
        {info?.alreadyScheduled === true && (
          <Badge tone="info">{tw("schedule.alreadyScheduled")}</Badge>
        )}
        {connections.length === 1 && (
          <span className="text-xs text-text-muted">@{connections[0]?.username}</span>
        )}
        {connections.length > 1 && (
          <Select
            aria-label={tw("schedule.account", { network: label })}
            value={draft.connectionId ?? ""}
            onChange={(e) => {
              onChange({ connectionId: e.target.value });
            }}
            options={connections.map((c) => ({
              value: c.connectionId,
              label: `@${c.username}`,
            }))}
          />
        )}
      </div>

      {draft.selected && (
        <div className="mt-3 flex flex-col gap-3">
          <CaptionField
            contentId={contentId}
            network={draft.network}
            field="caption"
            label={titled ? tw("schedule.titleField") : tw("schedule.captionField")}
            value={draft.caption}
            max={limits.caption}
            singleLine={titled}
            onChange={(caption) => {
              onChange({ caption });
            }}
          />
          {titled && (
            <CaptionField
              contentId={contentId}
              network={draft.network}
              field="description"
              label={tw("schedule.descriptionField")}
              value={draft.description}
              max={limits.description}
              singleLine={false}
              onChange={(description) => {
                onChange({ description });
              }}
            />
          )}
          {draft.network === "instagram" && options.contentType === "slideshow" && (
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              {tw("schedule.igFormat")}
              <Select
                value={draft.instagramSlideshowFormat}
                onChange={(e) => {
                  onChange({
                    instagramSlideshowFormat:
                      e.target.value === "reel" ? "reel" : "carousel",
                  });
                }}
                options={[
                  { value: "carousel", label: tw("schedule.igFormat.carousel") },
                  { value: "reel", label: tw("schedule.igFormat.reel") },
                ]}
              />
            </label>
          )}
          {draft.network === "youtube" && (
            <Checkbox
              label={tw("schedule.aiLabel")}
              checked={draft.aiContentDisclaimer}
              onChange={(e) => {
                onChange({ aiContentDisclaimer: e.target.checked });
              }}
            />
          )}
          {draft.network === "tiktok" && (
            <p className="text-xs text-text-muted">{tw("schedule.tiktokInbox")}</p>
          )}
          {draft.network === "x" && !options.xAllowLinks && (
            <p className="text-xs text-text-muted">{tw("schedule.xNoLinks")}</p>
          )}
        </div>
      )}
    </li>
  );
}

export interface CaptionFieldProps {
  readonly contentId: string;
  readonly network: NetworkDraft["network"];
  readonly field: CaptionFieldName;
  readonly label: string;
  readonly value: string;
  readonly max: number | null;
  readonly singleLine: boolean;
  readonly onChange: (value: string) => void;
}

export function CaptionField({
  contentId,
  network,
  field,
  label,
  value,
  max,
  singleLine,
  onChange,
}: CaptionFieldProps) {
  const id = useId();
  const counterId = `${id}-counter`;
  const generate = useGenerateCaption(contentId);
  const [pendingMode, setPendingMode] = useState<"improve" | "regenerate" | null>(null);
  const over = isOverLimit(value, max);
  const failure = generate.error === null ? null : aiFailureKey(generate.error);

  const run = (mode: "improve" | "regenerate") => {
    setPendingMode(mode);
    generate.mutate(
      { platform: network, field, mode, text: value },
      {
        onSuccess: (result) => {
          onChange(result.text);
        },
        onSettled: () => {
          setPendingMode(null);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-text">
          {label}
        </label>
        <span
          id={counterId}
          className={over ? "text-xs text-danger" : "text-xs text-text-muted"}
        >
          {max === null
            ? String(codePoints(value))
            : tw("schedule.counter", { count: codePoints(value), max })}
        </span>
      </div>
      {singleLine ? (
        <Input
          id={id}
          value={value}
          invalid={over}
          aria-describedby={counterId}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <Textarea
          id={id}
          value={value}
          rows={4}
          invalid={over}
          aria-describedby={counterId}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      )}
      {supportsCaptionAi(network) && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            loading={pendingMode === "improve"}
            disabled={generate.isPending || value.trim() === ""}
            onClick={() => {
              run("improve");
            }}
          >
            {tw("schedule.improve")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={pendingMode === "regenerate"}
            disabled={generate.isPending}
            onClick={() => {
              run("regenerate");
            }}
          >
            {tw("schedule.regenerate")}
          </Button>
        </div>
      )}
      {/* El contador ya no es región viva: leía el número en cada tecla. Cruzar
          el tope lo anuncia quien usa el campo, una sola vez (P5-A11Y-001). */}
      {value === "" && (
        <p className="text-xs text-text-muted">{tw("schedule.emptyCaption")}</p>
      )}
      {failure !== null && (
        <p role="alert" className="text-xs text-danger">
          {tw(failure)}
        </p>
      )}
    </div>
  );
}

/** El motivo del `503` de la caption con IA (`details.reason`), a copy. */
function aiFailureKey(
  error: unknown,
): "schedule.ai.notConfigured" | "schedule.ai.failed" | "schedule.ai.rejected" {
  const reason =
    typeof error === "object" && error !== null
      ? (error as { details?: Record<string, unknown> }).details?.["reason"]
      : undefined;
  if (reason === "llm_not_configured") return "schedule.ai.notConfigured";
  if (reason === "caption_rejected") return "schedule.ai.rejected";
  return "schedule.ai.failed";
}
