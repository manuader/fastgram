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
    "Pieces that pass a pre-check approve and schedule themselves. You get a daily summary on Today.",

  // `PU-AUTO-002`: qué hace el piloto y con qué umbrales (sólo lectura).
  autopilotHowTitle: "How autopilot decides",
  autopilotHowSteps: [
    "Every 15 minutes it tops up this brand's Blitz queue to cover the next days of your plan: pieces per day × active networks × the horizon.",
    "It takes the oldest ideas first (not the ones you asked for with a prompt) and asks the pre-check model a few closed questions about each one.",
    "If it passes, the piece is built and lands in the next free posting time. If not, it's discarded and the reason shows up on Today.",
    "If the pre-check doesn't answer in time, nothing is approved: the idea stays in Blitz for you.",
    "It never approves more than your posting times can take in the horizon.",
  ],
  autopilotHorizon: (days: number) => `Horizon: ${String(days)} days`,
  autopilotQueue: (min: number, max: number) =>
    `Queue size: between ${String(min)} and ${String(max)} ideas`,
  autopilotPerRun: (n: number) => `Up to ${String(n)} decisions per run`,
  autopilotTimeout: (seconds: number) => `Pre-check timeout: ${String(seconds)} s`,
  autopilotThresholdsTitle: "Pre-check thresholds",
  autopilotThresholds: {
    onBrandMin: (p: string) => `On-topic for the brand: at least ${p}`,
    riskyClaimMaxMass: (p: string) =>
      `Health, money or legal claims: rejected from ${p} likely`,
    thirdPartyMax: (p: string) => `Mentions another brand: rejected from ${p} likely`,
    coherentMin: (p: string) => `Reads well: at least ${p}`,
    inLanguageMin: (p: string) => `In the strategy's language: at least ${p}`,
  },
  autopilotModelHint:
    "The pre-check uses the Judgment model from Settings → Models (the text model if Judgment has none).",
  autopilotPolicyError: "Couldn't load how autopilot decides.",

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
