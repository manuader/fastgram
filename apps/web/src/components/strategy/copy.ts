/**
 * Copy de Settings → Strategy (`PU-BRAND-002`). Todo `nuevo`: el PRD no tiene
 * esta pantalla (nace de `docs/PLAN-USO-PERSONAL.md` §2 paso 2 y §5). Vive
 * junto al componente, como `lib/models/copy.ts` para Models, para no tocar el
 * catálogo compartido con decenas de claves de una sola pantalla.
 */
export const STRATEGY_COPY = {
  pageTitle: "Strategy",
  pageDescription:
    "Where this brand posts, how often, and when. Approved pieces land in the next free time on its calendar.",
  defaultsNote: "These are the defaults. Save to make them this brand's strategy.",

  networksTitle: "Networks",
  networksHint:
    "Pieces per day is what the calendar aims for. The daily cap is a hard ceiling for anything posted on that network.",
  perDay: "Pieces per day",
  dailyCap: "Daily cap",
  later: "Later",
  laterHint: "Publishing to this network arrives later. You can plan for it now.",
  capWarning: (cap: number) =>
    `Above the anti-bot default of ${String(cap)} a day. No platform publishes a safe rate, and more posts look more automated.`,
  perDayOverCap: "Pieces per day can't be more than the daily cap.",

  windowsTitle: "Posting times",
  windowsHint:
    "Local times for each day. The calendar fills the earliest free time that still has room that day.",
  addTime: (day: string) => `Add a time on ${day}`,
  addTimeButton: "Add",
  removeTime: (time: string, day: string) => `Remove ${time} on ${day}`,
  noTimes: "No posts this day",
  days: {
    sun: "Sunday",
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
  },

  autonomyTitle: "Autonomy",
  autonomyManual: "Manual",
  autonomyManualHint: "You approve every piece in Blitz.",
  autonomyAutopilot: "Autopilot",
  autonomyAutopilotHint:
    "Pieces approve themselves after a pre-check. Not running yet: this setting is saved for when it ships.",

  localeTitle: "Time zone and language",
  timezone: "Time zone",
  timezoneHint: "The brand's time zone. Posting times are in this zone.",
  language: "Content language",
  languageHint: "A language tag, like es, en or pt-BR.",

  pacingTitle: "Pacing",
  jitter: "Random shift (± minutes)",
  jitterHint:
    "Each post moves a little from its posting time so the brand doesn't post like clockwork.",
  brandGap: "Minutes between brands",
  brandGapHint: "Minimum gap between posts of different brands.",

  save: "Save strategy",
  saving: "Saving…",
  saved: "Strategy saved.",
  saveFailed: "The strategy couldn't be saved.",
} as const;
