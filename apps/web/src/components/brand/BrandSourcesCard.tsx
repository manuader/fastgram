"use client";

import { MAX_BRAND_SOURCES_PER_WORKSPACE, type BrandSource } from "@fastgram/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  Spinner,
  type BadgeProps,
} from "@fastgram/ui";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import {
  SOURCE_STATUS_COPY,
  SOURCE_TYPE_COPY,
  sourceLabel,
} from "@/lib/brand/source-types";
import {
  presentSourceActionError,
  useReanalyseSource,
  useRemoveSource,
  useSetPrimarySource,
  type SourceAction,
} from "@/lib/brand/sources";
import {
  BRAND_ANALYSIS_POLL_INTERVAL_MS,
  isInProgress,
  sourceNotice,
} from "@/lib/onboarding/processing";
import { useNow } from "@/lib/onboarding/use-now";
import type { ApiRequestError } from "@/lib/api/errors";
import type { UseQueryResult } from "@tanstack/react-query";
import { canAssist } from "@/lib/brand/assist";
import { AddSourceForm } from "./AddSourceForm";
import { AnalysisSteps } from "./AnalysisSteps";
import { AssistedSourcePanel } from "./AssistedSourcePanel";

const STATUS_TONE: Readonly<
  Record<BrandSource["status"], NonNullable<BadgeProps["tone"]>>
> = {
  pending: "neutral",
  analyzing: "info",
  ready: "success",
  partial: "warning",
  failed: "danger",
  stale: "warning",
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** El nombre de la fuente en una línea: `@mimarca`, `miproducto.com`, o la plataforma. */
function nameOf(source: BrandSource): string {
  const label = sourceLabel(source.sourceType, source.handle);
  return label === "" ? tw(SOURCE_TYPE_COPY[source.sourceType]) : label;
}

/** La acción que falló y en qué fila, para pintar el error debajo de esa fila. */
interface Failure {
  readonly action: SourceAction;
  readonly sourceId: string;
  readonly error: ApiRequestError;
}

function ActionProblem({ failure }: { readonly failure: Failure }) {
  const presented = presentSourceActionError(failure.action, failure.error);
  return (
    <div className="fgw-brand-source__problem" role="alert">
      <p>{tw(presented.titleKey, presented.titleVars)}</p>
      {presented.descriptionKey !== undefined && (
        <p>{tw(presented.descriptionKey, presented.vars)}</p>
      )}
    </div>
  );
}

/**
 * El `⋯` de cada fila (PRD:844): `Re-analyse` · `Set as primary` · `Remove`.
 *
 * Es un **disclosure** (botón con `aria-expanded` que muestra una lista de
 * botones), no un `role="menu"`: un menú ARIA promete navegación con flechas y
 * `typeahead`, y prometerlo sin implementarlo es peor que el patrón simple, que
 * con `Tab` ya se usa entero. Escape cierra y devuelve el foco al `⋯`.
 */
function RowMenu({
  source,
  busy,
  onAction,
}: {
  readonly source: BrandSource;
  readonly busy: boolean;
  readonly onAction: (action: SourceAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) firstItem.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function pick(action: SourceAction) {
    setOpen(false);
    onAction(action);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      close();
    }
  }

  // Re-analizar una fuente que ya está en curso es un `409` seguro.
  const canReanalyse = !isInProgress(source.status);

  return (
    <div className="fgw-brand-source__menu" onKeyDown={onKeyDown}>
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={tw("brand.sources.menu", { source: nameOf(source) })}
        disabled={busy}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span aria-hidden="true">⋯</span>
      </Button>
      {open && (
        <ul id={listId} className="fgw-brand-source__actions">
          <li>
            <Button
              ref={firstItem}
              variant="ghost"
              size="sm"
              disabled={!canReanalyse}
              onClick={() => {
                pick("reanalyse");
              }}
            >
              {tw("brand.sources.reanalyse")}
            </Button>
          </li>
          {!source.isPrimary && (
            <li>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  pick("setPrimary");
                }}
              >
                {tw("brand.sources.setPrimary")}
              </Button>
            </li>
          )}
          <li>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                pick("remove");
              }}
            >
              {tw("brand.sources.remove")}
            </Button>
          </li>
        </ul>
      )}
    </div>
  );
}

function SourceRow({
  source,
  now,
  busy,
  failure,
  onAction,
}: {
  readonly source: BrandSource;
  readonly now: number;
  readonly busy: boolean;
  readonly failure: Failure | null;
  readonly onAction: (action: SourceAction) => void;
}) {
  const assist = canAssist(source) && !busy;
  const notice = sourceNotice(source, now, { assistOffered: assist });
  return (
    <li className="fgw-brand-source" data-status={source.status}>
      <div className="fgw-brand-source__head">
        <span className="fgw-brand-source__platform">
          {tw(SOURCE_TYPE_COPY[source.sourceType])}
        </span>
        <span className="fgw-brand-source__name">{nameOf(source)}</span>
        {source.isPrimary && (
          <Badge tone="accent" size="sm">
            {tw("brand.sources.primary")}
          </Badge>
        )}
        <Badge tone={STATUS_TONE[source.status]} size="sm" dot>
          {tw(SOURCE_STATUS_COPY[source.status])}
        </Badge>
        {(isInProgress(source.status) || busy) && (
          <Spinner size="sm" aria-hidden="true" />
        )}
        <RowMenu source={source} busy={busy} onAction={onAction} />
      </div>
      <p className="fgw-brand-source__date">
        {source.lastAnalysedAt === null
          ? tw("brand.sources.neverAnalysed")
          : tw("brand.sources.lastAnalysed", {
              date: dateFormat.format(new Date(source.lastAnalysedAt)),
            })}
      </p>
      {/* P1-ONB-005: la etapa real del worker, mientras analiza. */}
      <AnalysisSteps source={source} />
      {busy && (
        <p className="fg-visually-hidden" role="status">
          {tw("brand.sources.working")}
        </p>
      )}
      {source.status === "stale" && (
        // FR-011.8: `stale` *"se ofrece `Re-analyse`"* — a la vista, no sólo
        // dentro del `⋯`.
        <div className="fgw-brand-source__stale">
          <p>{tw("brand.sources.staleOffer")}</p>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              onAction("reanalyse");
            }}
          >
            {tw("brand.sources.reanalyse")}
          </Button>
        </div>
      )}
      {notice !== null && (
        <p
          className="fgw-onb-source__notice"
          data-problem={notice.problem ? "true" : "false"}
        >
          {tw(notice.key, notice.vars)}
        </p>
      )}
      {failure !== null && <ActionProblem failure={failure} />}
      {assist && (
        // P1-BRAND-014 / FR-011.4: degradada a D, se pide la ayuda concreta.
        <AssistedSourcePanel source={source} />
      )}
    </li>
  );
}

export interface BrandSourcesCardProps {
  readonly query: UseQueryResult<BrandSource[], ApiRequestError>;
  /** Hay campos editados a mano: se dice qué hace con ellos un re-análisis. */
  readonly hasEditedFields: boolean;
}

/**
 * La tarjeta `Brand sources` · `F-024`, `FR-020` (PRD:1007), `P1-BRANDPG-002`.
 *
 * Estados: cargando (skeleton con `aria-busy`), error (`ApiErrorState` con su
 * salida), vacío (`ERR-E12` literal con `+ Add source`), y la lista.
 *
 * Quitar pide confirmación: el borrado es real (DATA-031 no tiene soft-delete).
 * Lo que la API rechace —la única fuente (`ERR-B01`), la primaria sin ser owner
 * (`403`)— se dice debajo de la fila; la pantalla no lo decide antes, porque la
 * regla ("el perfil quedaría sin origen") mira el estado del perfil en el
 * servidor y replicarla acá sería una segunda definición que se desincroniza.
 */
export function BrandSourcesCard({ query, hasEditedFields }: BrandSourcesCardProps) {
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<BrandSource | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reanalyse = useReanalyseSource();
  const setPrimary = useSetPrimarySource();
  const remove = useRemoveSource();

  const sources = query.data;
  const active = sources?.some((s) => isInProgress(s.status)) ?? false;
  const now = useNow(active, BRAND_ANALYSIS_POLL_INTERVAL_MS);

  function run(action: SourceAction, source: BrandSource) {
    setFailure(null);
    if (action === "remove") {
      setConfirmRemove(source);
      return;
    }
    const mutation = action === "reanalyse" ? reanalyse : setPrimary;
    setBusyId(source._id);
    mutation.mutate(source._id, {
      onError: (error) => {
        setFailure({ action, sourceId: source._id, error });
      },
      onSettled: () => {
        setBusyId(null);
      },
    });
  }

  function confirmRemoval() {
    const source = confirmRemove;
    if (source === null) return;
    setConfirmRemove(null);
    setBusyId(source._id);
    remove.mutate(source._id, {
      onError: (error) => {
        setFailure({ action: "remove", sourceId: source._id, error });
      },
      onSettled: () => {
        setBusyId(null);
      },
    });
  }

  let body;
  if (query.isError) {
    body = (
      <ApiErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (query.isPending || sources === undefined) {
    body = (
      <div aria-busy="true">
        <Skeleton shape="text" width="60%" />
        <Skeleton shape="text" width="45%" />
      </div>
    );
  } else if (sources.length === 0 && !adding) {
    body = (
      <EmptyState
        preset="ERR-E12"
        action={
          <Button
            onClick={() => {
              setAdding(true);
            }}
          >
            {tw("empty.brandSources.action")}
          </Button>
        }
      />
    );
  } else {
    const atCap = sources.length >= MAX_BRAND_SOURCES_PER_WORKSPACE;
    body = (
      <>
        {sources.length > 0 && (
          <ul className="fgw-brand-sources__list" aria-live={active ? "polite" : "off"}>
            {sources.map((source) => (
              <SourceRow
                key={source._id}
                source={source}
                now={now}
                busy={busyId === source._id}
                failure={failure?.sourceId === source._id ? failure : null}
                onAction={(action) => {
                  run(action, source);
                }}
              />
            ))}
          </ul>
        )}
        {/* Un fallo sobre una fila que ya no está (un 404 que el refetch quitó). */}
        {failure !== null && !sources.some((s) => s._id === failure.sourceId) && (
          <ActionProblem failure={failure} />
        )}
        {hasEditedFields && (
          <p className="fgw-brand__note">
            {tw("brand.editedKept")} {tw("brand.proposalsUnavailable")}
          </p>
        )}
        {adding ? (
          <AddSourceForm
            onDone={() => {
              setAdding(false);
            }}
          />
        ) : atCap ? (
          <p className="fgw-brand__note">{tw("error.brand.sourceLimit.title")}</p>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              setFailure(null);
              setAdding(true);
            }}
          >
            {tw("empty.brandSources.action")}
          </Button>
        )}
      </>
    );
  }

  return (
    <section className="fgw-brand-sources" aria-labelledby={headingId}>
      <h2 id={headingId} className="fgw-brand-section__title">
        {tw("brand.sources.title")}
      </h2>
      {body}

      <Dialog
        open={confirmRemove !== null}
        onClose={() => {
          setConfirmRemove(null);
        }}
      >
        {confirmRemove !== null && (
          <>
            <DialogHeader>
              <DialogTitle>
                {tw("brand.sources.removeTitle", { source: nameOf(confirmRemove) })}
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogDescription>{tw("brand.sources.removeBody")}</DialogDescription>
              {confirmRemove.isPrimary && <p>{tw("brand.sources.removePrimaryBody")}</p>}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmRemove(null);
                }}
              >
                {tw("common.cancel")}
              </Button>
              <Button variant="danger" onClick={confirmRemoval}>
                {tw("brand.sources.remove")}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </section>
  );
}
