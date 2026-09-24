"use client";

import { Badge } from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import { td } from "@/lib/blitz/deck/copy";
import {
  BLITZ_TYPE_COPY,
  compactNumber,
  explanationBullets,
  type DeckSuggestion,
} from "@/lib/blitz/deck/suggestion";
import { EyeIcon, HeartIcon, InfoIcon } from "./icons";

/**
 * Cabecera de la tarjeta (FR-050 *UI*): chip de tipo (F-053) y, **sólo si
 * aplican**, influencer y ángulo (F-054). Un chip vacío o con un id crudo es
 * peor que ninguno.
 */
export function CardChips({ suggestion }: { suggestion: DeckSuggestion }) {
  return (
    <ul
      className="flex flex-wrap items-center justify-center gap-2"
      aria-label={td("deck.tags")}
    >
      {suggestion.promptRequestId != null && (
        <li>
          <Badge tone="success">{td("deck.fromPrompt")}</Badge>
        </li>
      )}
      {suggestion.autoFoundMeme != null && (
        <li>
          <a
            href={suggestion.autoFoundMeme.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={td("deck.autoFoundMemeSource")}
            className="fg-focusable rounded-full"
          >
            <Badge tone="warning">{td("deck.autoFoundMeme")}</Badge>
          </a>
        </li>
      )}
      <li>
        <Badge tone="accent">{tw(BLITZ_TYPE_COPY[suggestion.contentType])}</Badge>
      </li>
      {suggestion.influencer != null && (
        <li>
          <Badge tone="neutral">
            {td("deck.influencer", { name: suggestion.influencer.name })}
          </Badge>
        </li>
      )}
      {suggestion.angle != null && (
        <li>
          <Badge tone="outline">{suggestion.angle.title}</Badge>
        </li>
      )}
    </ul>
  );
}

/** La pill `ⓘ Why This Content?` (F-055). Controla el panel por `aria-controls`. */
export function WhyToggle({
  open,
  panelId,
  onToggle,
}: {
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="fg-focusable inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-sm text-text-muted hover:text-text"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
    >
      <InfoIcon size={14} />
      {td("deck.why")}
    </button>
  );
}

/**
 * Panel `ⓘ Why This Content` (F-055). Muestra **el racional almacenado** con la
 * sugerencia —FR-050 criterio 3: *"nunca uno generado al vuelo"*—, así que si
 * no hay, lo dice; no pide uno.
 */
export function WhyPanel({
  id,
  explanation,
}: {
  id: string;
  explanation: string | null | undefined;
}) {
  const bullets = explanationBullets(explanation);
  return (
    <section
      id={id}
      aria-label={td("deck.why.title")}
      className="rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text">
        <InfoIcon size={16} />
        {td("deck.why.title")}
      </h2>
      {bullets.length === 0 ? (
        <p className="text-sm text-text-muted">{td("deck.why.empty")}</p>
      ) : (
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-muted">
          {bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * `Remixed From` (F-056): la fuente original con likes y views. Sólo existe para
 * remixes —quien lo monta ya comprobó que hay `remixSource`— y cada métrica se
 * muestra sólo si llegó: un `0` inventado sería un dato falso.
 */
export function RemixedFromPanel({
  source,
}: {
  source: NonNullable<DeckSuggestion["remixSource"]>;
}) {
  return (
    <section
      aria-label={td("deck.remixedFrom")}
      className="rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <h2 className="mb-3 text-sm font-semibold text-text">{td("deck.remixedFrom")}</h2>
      {source.thumbnailUrl != null && (
        // `<img>`: mismo motivo que `ContentCard` (hosts no declarados en Next).
        <img
          src={source.thumbnailUrl}
          alt=""
          loading="lazy"
          className="mb-3 aspect-[9/16] w-full max-w-[160px] rounded-lg object-cover"
        />
      )}
      <div className="mb-3 flex gap-4 text-sm text-text-muted">
        {source.likes != null && (
          <span
            className="inline-flex items-center gap-1"
            title={td("deck.remix.likes", { count: source.likes })}
          >
            <HeartIcon size={14} />
            <span aria-hidden="true">{compactNumber(source.likes)}</span>
            <span className="sr-only">
              {td("deck.remix.likes", { count: source.likes })}
            </span>
          </span>
        )}
        {source.views != null && (
          <span
            className="inline-flex items-center gap-1"
            title={td("deck.remix.views", { count: source.views })}
          >
            <EyeIcon size={14} />
            <span aria-hidden="true">{compactNumber(source.views)}</span>
            <span className="sr-only">
              {td("deck.remix.views", { count: source.views })}
            </span>
          </span>
        )}
      </div>
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        className="fg-focusable text-sm font-medium text-accent underline-offset-2 hover:underline"
      >
        {td("deck.remix.open")}
      </a>
    </section>
  );
}
