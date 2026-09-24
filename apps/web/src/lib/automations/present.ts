/**
 * Cómo se ve una campaña — `FR-150`, `F-218`, `F-220`. Puro: sin React ni
 * red, para poder probarlo sin montar nada.
 */
import type {
  Automation,
  AutomationSlot,
  AutomationStatus,
  AutomationSlotStatus,
  BlitzContentType,
  LaunchGateCode,
} from "@fastgram/contracts";
import { tw, type CopyKey } from "../i18n/t";
import { isApiRequestError } from "../api/errors";
import { dayKeyOf, formatChipTime, formatDayLabel } from "../calendar/calendar";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export const AUTOMATION_STATUS_COPY: Readonly<Record<AutomationStatus, CopyKey>> = {
  DRAFT: "automations.status.draft",
  GENERATING: "automations.status.generating",
  REVIEW: "automations.status.review",
  BUILDING: "automations.status.building",
  ACTIVE: "automations.status.active",
  COMPLETED: "automations.status.completed",
  CANCELLED: "automations.status.cancelled",
  FAILED: "automations.status.failed",
};

export const AUTOMATION_STATUS_TONE: Readonly<Record<AutomationStatus, Tone>> = {
  DRAFT: "neutral",
  GENERATING: "info",
  REVIEW: "warning",
  BUILDING: "info",
  ACTIVE: "success",
  COMPLETED: "accent",
  CANCELLED: "neutral",
  FAILED: "danger",
};

export const SLOT_STATUS_COPY: Readonly<Record<AutomationSlotStatus, CopyKey>> = {
  PENDING_GEN: "automations.slot.pending",
  GENERATING: "automations.slot.generating",
  READY: "automations.slot.ready",
  REROLLING: "automations.slot.rerolling",
  FAILED_GEN: "automations.slot.failedGen",
  QUEUED_BUILD: "automations.slot.queuedBuild",
  BUILDING: "automations.slot.building",
  SCHEDULED: "automations.slot.scheduled",
  FAILED: "automations.slot.failed",
  CANCELLED: "automations.slot.wontPost",
};

export const SLOT_STATUS_TONE: Readonly<Record<AutomationSlotStatus, Tone>> = {
  PENDING_GEN: "neutral",
  GENERATING: "info",
  READY: "success",
  REROLLING: "info",
  FAILED_GEN: "danger",
  QUEUED_BUILD: "info",
  BUILDING: "info",
  SCHEDULED: "accent",
  FAILED: "danger",
  CANCELLED: "neutral",
};

export const CONTENT_TYPE_COPY: Readonly<Record<BlitzContentType, CopyKey>> = {
  slideshow: "library.type.slideshow",
  "wall-of-text": "library.type.wallOfText",
  "green-screen": "library.type.greenScreen",
  "video-hook": "library.type.videoHook",
};

/** Por qué falló un slot, en palabras. `null` si no falló. */
export function slotFailureCopy(slot: AutomationSlot): CopyKey | null {
  if (slot.status !== "FAILED_GEN" && slot.status !== "FAILED") return null;
  if (slot.failureReason === "no_unique_content")
    return "automations.failure.noUniqueContent";
  if (slot.failureReason === "no_demo_video") return "automations.failure.noDemoVideo";
  switch (slot.errorCode) {
    case "no_media":
      return "automations.failure.noMedia";
    case "llm_not_configured":
      return "automations.failure.noLlm";
    case "llm_failed":
    case "copy_rejected":
      return "automations.failure.copy";
    case "generation_quota_exhausted":
      return "automations.failure.quota";
    case "media_unavailable":
      return "automations.failure.mediaGone";
    case "build_failed":
      return "automations.failure.build";
    default:
      return "automations.failure.generic";
  }
}

/** `launchValidation`: el título y la salida de cada gate (copy del PRD donde lo hay). */
export const GATE_COPY: Readonly<
  Record<LaunchGateCode, { title: CopyKey; body: CopyKey }>
> = {
  not_in_review: {
    title: "automations.gate.notInReview",
    body: "automations.gate.notInReview.body",
  },
  content_generating: {
    title: "automations.gate.generating",
    body: "automations.gate.generating.body",
  },
  no_ready_slots: {
    title: "automations.gate.noReady",
    body: "automations.gate.noReady.body",
  },
  no_destinations: {
    title: "automations.gate.noDestinations",
    body: "automations.gate.noDestinations.body",
  },
  destination_unavailable: {
    title: "automations.gate.destination",
    body: "automations.gate.destination.body",
  },
  schedule_in_past: {
    title: "automations.gate.past",
    body: "automations.gate.past.body",
  },
  posting_limit_conflicts: {
    title: "automations.gate.limits",
    body: "automations.gate.limits.body",
  },
  youtube_slideshow: {
    title: "automations.gate.youtube",
    body: "automations.gate.youtube.body",
  },
  content_budget: {
    title: "automations.gate.budget",
    body: "automations.gate.budget.body",
  },
  ai_label_unsupported: {
    title: "automations.gate.aiLabel",
    body: "automations.gate.aiLabel.body",
  },
};

/** El progreso que se muestra en la lista y el detalle. */
export function progressOf(a: Automation): {
  readonly done: number;
  readonly total: number;
  readonly percent: number;
  readonly label: CopyKey;
} {
  const by = a.progress.byStatus;
  const n = (...s: AutomationSlotStatus[]) => s.reduce((sum, k) => sum + (by[k] ?? 0), 0);
  const total = a.progress.total - n("CANCELLED");
  let done = 0;
  let label: CopyKey = "automations.progress.slots";
  if (a.status === "GENERATING") {
    done = n("READY", "FAILED_GEN");
    label = "automations.progress.generated";
  } else if (a.status === "REVIEW" || a.status === "DRAFT") {
    done = n("READY");
    label = "automations.progress.ready";
  } else {
    done = n("SCHEDULED");
    label = "automations.progress.scheduled";
  }
  const percent = total <= 0 ? 0 : Math.round((done / total) * 100);
  return { done, total: Math.max(0, total), percent, label };
}

/** Los días de la campaña (`YYYY-MM-DD`), semana a semana. */
export function campaignWeeks(startDate: string, durationWeeks: number): string[][] {
  const [y, m, d] = startDate.split("-").map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const weeks: string[][] = [];
  for (let w = 0; w < durationWeeks; w += 1) {
    const days: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      days.push(new Date(base + (w * 7 + i) * 86_400_000).toISOString().slice(0, 10));
    }
    weeks.push(days);
  }
  return weeks;
}

/** Los slots de cada día (en la zona de la campaña), ordenados por hora. */
export function slotsByDay(
  slots: readonly AutomationSlot[],
  timezone: string,
): ReadonlyMap<string, AutomationSlot[]> {
  const out = new Map<string, AutomationSlot[]>();
  const sorted = [...slots].sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  for (const slot of sorted) {
    if (slot.scheduledAt === null) continue;
    const key = dayKeyOf(slot.scheduledAt, timezone);
    const list = out.get(key) ?? [];
    list.push(slot);
    out.set(key, list);
  }
  return out;
}

export function slotTime(slot: AutomationSlot, timezone: string): string {
  return slot.scheduledAt === null ? "—" : formatChipTime(slot.scheduledAt, timezone);
}

export function dayLabel(key: string): string {
  return formatDayLabel(key);
}

/** Un día `YYYY-MM-DD` → `Mon 28`. */
export function shortDayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

function offsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Un instante → el valor de un `<input type="datetime-local">` en esa zona. */
export function toLocalInput(ms: number, timeZone: string): string {
  return new Date(ms + offsetMs(ms, timeZone)).toISOString().slice(0, 16);
}

/** El valor de un `datetime-local` (hora de pared en `timeZone`) → instante. */
export function fromLocalInput(value: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (m === null) return null;
  const wall = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
  let guess = wall - offsetMs(wall, timeZone);
  // Una segunda pasada corrige el cruce de un cambio de horario.
  guess = wall - offsetMs(guess, timeZone);
  return guess;
}

/** `YYYY-MM-DD` de hoy en una zona. */
export function todayIn(timeZone: string, nowMs: number = Date.now()): string {
  return dayKeyOf(nowMs, timeZone);
}

/**
 * El motivo de un `generate` rechazado (`FR-150`), en palabras: los dos
 * códigos literales del PRD (`422`) y los nuestros (`400` con
 * `details.reason`). `null` si el error no es uno de ésos.
 */
export function generationBlockedCopy(error: unknown): string | null {
  if (!isApiRequestError(error)) return null;
  if (error.code === "AUTOMATION_NO_CONTENT_TYPE_SELECTED")
    return tw("automations.blocked.noContentType");
  if (error.code === "AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO")
    return tw("automations.blocked.demoVideo");
  const reason = error.details?.["reason"];
  switch (reason) {
    case "AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW":
      return tw("automations.blocked.youtube");
    case "AUTOMATION_NO_DESTINATIONS":
      return tw("automations.blocked.noDestinations");
    case "AUTOMATION_CONTENT_TYPE_NEEDS_MEDIA":
      return tw("automations.blocked.noMedia");
    case "schedule_in_past":
      return tw("automations.blocked.past");
    case "config_locked":
      return tw("automations.blocked.locked");
    case "excluded_type":
      return tw("automations.blocked.excludedType");
    case "youtube_slideshow":
      return tw("automations.blocked.youtube");
    case "generation_quota_exhausted":
      return tw("automations.failure.quota");
    case "media_unavailable":
      return tw("automations.failure.mediaGone");
    case "edit_in_editor":
      return tw("automations.blocked.editInEditor");
    default:
      return null;
  }
}
