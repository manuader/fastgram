/**
 * Respuesta sugerida a un lead — `F-195`, `F-196`, `P4-ENGAGE-008`, y el
 * `Why this lead?` de `F-194` (`P4-ENGAGE-007`).
 *
 * Los dos son **texto**, así que van por el puerto `Llm` y no por `Judgment`
 * (§25.2: *"el puerto no genera texto"*). Acá se arma el pedido (puro) y se
 * revisa lo que vuelve con reglas determinísticas ({@link lintReply}).
 *
 * ## Las reglas de la respuesta (del brief del dueño, `D-11`)
 *
 * 1. **Útil primero**: responder lo que la persona pregunta antes que nada.
 * 2. **Sin link por defecto** (`allowLinks: false`). Un link en un comentario
 *    es la señal de spam más obvia; se permite sólo si la marca lo habilita.
 * 3. **Divulgación de afiliación** cuando se menciona la marca. No es
 *    cortesía: la Responsible Builder Policy exige no enmascarar el propósito
 *    y las comunidades castigan la promoción encubierta.
 * 4. Las **reglas propias** de la marca (`Save Custom Rules`) van al final y
 *    ganan sobre el estilo, nunca sobre 1–3.
 *
 * El texto del post es de terceros: entra en un bloque `untrusted` (el
 * adaptador lo delimita con `containUntrusted`), nunca en el prompt del
 * sistema.
 *
 * ## Qué bloquea "Send" y qué sólo avisa ({@link lintReply})
 *
 * - `brand_without_disclosure` **bloquea**: nombra la marca sin decir la
 *   relación. Se arregla escribiendo una línea; publicar sin ella es el caso
 *   que el dueño pidió evitar.
 * - `empty` y `too_long` bloquean (Reddit no es el problema: es que no es una
 *   respuesta).
 * - `contains_link` con links deshabilitados **avisa**: si el humano lo
 *   escribió a mano, es su decisión y confirma igual antes de enviar.
 */
import type { LlmMessage, UntrustedBlock } from "@fastgram/ports";

export const REPLY_TONE_STYLES = ["casual", "professional", "friendly_expert"] as const;
export type ReplyToneStyle = (typeof REPLY_TONE_STYLES)[number];

const STYLE_TEXT: Readonly<Record<ReplyToneStyle, string>> = {
  casual: "Casual Reddit voice: lowercase is fine, short sentences, no corporate words.",
  // El texto de la opción de Fastlane, literal (FR-140).
  professional: "Proper capitalization, polished, business-appropriate.",
  friendly_expert:
    "Friendly and knowledgeable, like an experienced practitioner helping a peer.",
};

/** Topes del texto de una respuesta. Reddit no es un blog. */
export const REPLY_LIMITS = {
  maxChars: 2_500,
  targetWords: 150,
  customRules: 2_000,
} as const;

export interface ReplyBrand {
  readonly name: string;
  readonly productOffering?: string | null | undefined;
  readonly targetAudience?: string | null | undefined;
}

export interface ReplySettings {
  readonly tone: ReplyToneStyle;
  readonly customRules: string;
  readonly allowLinks: boolean;
  /** URL que se puede usar si `allowLinks`. */
  readonly websiteUrl?: string | null | undefined;
}

export interface ReplyThread {
  readonly subreddit: string;
  readonly title: string;
  readonly body: string | null;
  readonly topComments: readonly string[];
}

export interface ReplyPrompt {
  readonly messages: readonly LlmMessage[];
  readonly untrusted: readonly UntrustedBlock[];
}

/**
 * El pedido al LLM. `previousDraft` presente = `Regenerate reply`: se pide
 * otra versión distinta, no la misma con sinónimos.
 */
export function buildReplyPrompt(input: {
  readonly brand: ReplyBrand;
  readonly settings: ReplySettings;
  readonly thread: ReplyThread;
  readonly previousDraft?: string | null | undefined;
}): ReplyPrompt {
  const { brand, settings, thread } = input;
  const rules = [
    "You write one Reddit comment replying to the post in the DATA block.",
    "Rule 1 — Help first: answer what the author actually asks, with concrete, specific advice. The comment must be useful even for someone who never uses the product.",
    settings.allowLinks && settings.websiteUrl
      ? `Rule 2 — Links: at most one link, only if it genuinely helps, and only this one: ${settings.websiteUrl}.`
      : "Rule 2 — No links of any kind. Do not write URLs or domain names.",
    `Rule 3 — Disclosure: mentioning ${brand.name} is optional. If you mention it, say plainly in the same comment that you are affiliated with it (for example: "full disclosure, I work on ${brand.name}"). Never pretend to be an unaffiliated customer.`,
    "Rule 4 — Mention the product at most once, only if it fits the question, and never as the main point.",
    `Style: ${STYLE_TEXT[settings.tone]} Match the language of the post. About ${REPLY_LIMITS.targetWords} words or fewer. Plain text or light Reddit markdown. No hashtags, no emojis, no sign-off.`,
    "Output only the comment text, nothing else.",
  ];
  const custom = settings.customRules.trim().slice(0, REPLY_LIMITS.customRules);
  if (custom.length > 0) {
    rules.push(
      "The brand added these extra rules. Follow them unless they contradict Rules 1–4:",
      custom,
    );
  }
  const brandLines = [
    `Brand: ${brand.name}`,
    brand.productOffering ? `What it offers: ${brand.productOffering}` : null,
    brand.targetAudience ? `Who it is for: ${brand.targetAudience}` : null,
  ].filter((l): l is string => l !== null);

  const user = [
    ...brandLines,
    `Subreddit: r/${thread.subreddit}`,
    input.previousDraft
      ? "Write a clearly different version from the previous draft below (different angle and wording), following the same rules.\nPrevious draft:\n" +
        input.previousDraft.slice(0, REPLY_LIMITS.maxChars)
      : "Write the comment.",
  ].join("\n");

  const untrusted: UntrustedBlock[] = [
    { label: "reddit_post", content: `${thread.title}\n\n${thread.body ?? ""}`.trim() },
    ...thread.topComments
      .slice(0, 5)
      .map((c) => ({ label: "reddit_comment", content: c })),
  ];
  return {
    messages: [
      { role: "system", content: rules.join("\n") },
      { role: "user", content: user },
    ],
    untrusted,
  };
}

/** El `Why this lead?` (F-194): 1–2 frases, sin prometer nada. */
export function buildWhyThisLeadPrompt(input: {
  readonly brand: ReplyBrand;
  readonly thread: ReplyThread;
  /** Los componentes del score, para que la explicación no contradiga al número. */
  readonly signals: readonly string[];
}): ReplyPrompt {
  const system = [
    "In one or two short sentences, explain to the brand owner why this Reddit post is a good place to help.",
    "Base it only on what the post says. Do not invent facts about the author. No preamble.",
  ].join("\n");
  const user = [
    `Brand: ${input.brand.name}`,
    input.brand.productOffering ? `What it offers: ${input.brand.productOffering}` : null,
    input.signals.length > 0 ? `Signals found: ${input.signals.join(", ")}` : null,
    `Subreddit: r/${input.thread.subreddit}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    untrusted: [
      {
        label: "reddit_post",
        content: `${input.thread.title}\n\n${input.thread.body ?? ""}`.trim(),
      },
    ],
  };
}

/** Lo que devolvió el LLM → texto de respuesta. Saca comillas y prefacios obvios. */
export function cleanGeneratedReply(text: string): string {
  let t = text.trim();
  t = t.replace(/^(here'?s|here is)[^\n]*:\s*\n/i, "");
  if (t.length >= 2 && /^["“]/.test(t) && /["”]$/.test(t)) t = t.slice(1, -1).trim();
  return t.slice(0, REPLY_LIMITS.maxChars);
}

/* ------------------------------------------------------------------------ *
 * Revisión determinística
 * ------------------------------------------------------------------------ */

export const REPLY_ISSUES = [
  "empty",
  "too_long",
  "brand_without_disclosure",
  "contains_link",
] as const;
export type ReplyIssue = (typeof REPLY_ISSUES)[number];

/** Los que impiden "Send". El resto avisa. */
export const BLOCKING_REPLY_ISSUES: readonly ReplyIssue[] = [
  "empty",
  "too_long",
  "brand_without_disclosure",
];

const LINK =
  /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(com|io|ai|app|co|net|org|dev)\b/i;

/**
 * Frases de divulgación, en inglés y castellano. Una lista, no un modelo: el
 * criterio tiene que ser predecible para quien edita el borrador — si la
 * marca aparece, escribir cualquiera de estas lo destraba.
 */
const DISCLOSURE = new RegExp(
  [
    "disclosure",
    "disclaimer",
    "affiliated",
    "i work (at|on|for|with)",
    "i('| a)?m (the |a |one of the )?(founder|co-?founder|maker|creator|developer|dev|owner|ceo|team)",
    "i (built|made|created|run|own)",
    "(my|our) (company|startup|product|app|tool|team|business)",
    "we (built|made|make|created|run)",
    "trabajo (en|para|con)",
    "soy (el|la|uno de los|una de las) (fundador|fundadora|cofundador|cofundadora|creador|creadora|dueño|dueña|desarrollador|desarrolladora)",
    "(lo|la) (hice|creé|cree|armé|arme)",
    "(mi|nuestra|nuestro) (empresa|app|aplicación|herramienta|producto|equipo|negocio)",
    "aclaración",
  ].join("|"),
  "i",
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsBrand(text: string, brandName: string): boolean {
  const name = brandName.trim();
  if (name.length < 2) return false;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}

export function lintReply(
  text: string,
  opts: { readonly brandName: string; readonly allowLinks: boolean },
): ReplyIssue[] {
  const issues: ReplyIssue[] = [];
  const t = text.trim();
  if (t.length === 0) return ["empty"];
  if (t.length > REPLY_LIMITS.maxChars) issues.push("too_long");
  if (mentionsBrand(t, opts.brandName) && !DISCLOSURE.test(t)) {
    issues.push("brand_without_disclosure");
  }
  if (!opts.allowLinks && LINK.test(t)) issues.push("contains_link");
  return issues;
}

export function blockingIssues(issues: readonly ReplyIssue[]): ReplyIssue[] {
  return issues.filter((i) => BLOCKING_REPLY_ISSUES.includes(i));
}
