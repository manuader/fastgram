"use client";

import {
  Button,
  EmptyState,
  Skeleton,
  Spinner,
  Tooltip,
  buttonVariants,
  useToast,
} from "@fastgram/ui";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { ROUTES } from "@/lib/nav/routes";
import { tw } from "@/lib/i18n/t";
import {
  blitzQueueKey,
  useAcceptSuggestion,
  useBlitzQueue,
  useDiscardSuggestion,
} from "@/lib/blitz/deck/api";
import { td } from "@/lib/blitz/deck/copy";
import { keyToDecision, type Decision } from "@/lib/blitz/deck/gestures";
import {
  deckViewFor,
  isEmptyQueue,
  isProfileNotReady,
  isUnbuildable,
  type DeckView,
} from "@/lib/blitz/deck/state";
import {
  BLITZ_TYPE_COPY,
  needsRefill,
  pendingSuggestions,
  type DeckCard,
  type DeckSuggestion,
} from "@/lib/blitz/deck/suggestion";
import { autoscheduleResultSchema, type AutoscheduleResult } from "@fastgram/contracts";
import { apiRequest } from "@/lib/api/client";
import { autoschedulePath, describeAutoschedule } from "@/lib/calendar/autoschedule";
import { editorHref } from "@/components/editor/ContentEditor";
import { AcceptDialog } from "./AcceptDialog";
import { BuildTray } from "./BuildTray";
import { CardChips, RemixedFromPanel, WhyPanel, WhyToggle } from "./CardDetails";
import { CardFace } from "./CardFace";
import { AutopilotBanner } from "./AutopilotBanner";
import { CreatePromptBar } from "./CreatePromptBar";
import { CheckIcon, GearIcon, PencilIcon, XIcon } from "./icons";
import { SwipeCard, type ExitCustom } from "./SwipeCard";

/**
 * Ruta de la pantalla de modelos de IA. La construye otro frente de este mismo
 * sprint y todavía no está en `ROUTES`; cuando esté, esto pasa a ser
 * `ROUTES.settingsModels`.
 */
export const SETTINGS_MODELS_HREF = "/settings/models";

/** Cuántas piezas recientes muestra el tracker. Más es ruido: están en la Library. */
const MAX_TRACKED_BUILDS = 5;

/**
 * Ancho de la tarjeta: 360 px —la escala del editor—, o lo que entre en un móvil,
 * o lo que deje el **alto** de la ventana para que los botones de decidir se vean
 * sin scrollear (una 9:16 de 360 mide 640 px: en una laptop de 800 px de alto,
 * con el encabezado y la barra de prompt, los botones quedaban abajo del pliegue).
 */
const CARD_BOX =
  "relative mx-auto aspect-[9/16] w-[min(360px,82vw,max(220px,calc((100dvh-330px)*9/16)))]";

/**
 * `/blitz` · FR-050, `PU-BLITZ-001` y `PU-BLITZ-002`.
 *
 * Toda la decisión de *qué* pantalla dibujar está en `deckViewFor`
 * (`lib/blitz/deck/state.ts`), y toda la traducción de gesto/tecla a decisión
 * en `gestures.ts`. Este componente sólo cablea: las tres formas de decidir
 * —arrastre, botón, flecha— terminan en el mismo `decide()` (FR-050 criterio 1).
 */
export function BlitzDeck() {
  const queue = useBlitzQueue();
  const accept = useAcceptSuggestion();
  const discard = useDiscardSuggestion();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const router = useRouter();
  const reducedMotion = useReducedMotion() ?? false;
  const whyPanelId = useId();

  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  const [blindRound, setBlindRound] = useState(0);
  const [blindEmpty, setBlindEmpty] = useState(false);
  const [profileBlocked, setProfileBlocked] = useState(false);
  const [pending, setPending] = useState<DeckCard | null>(null);
  const [attemptKey, setAttemptKey] = useState("");
  const [exitDir, setExitDir] = useState(0);
  const [whyOpen, setWhyOpen] = useState(false);
  const [builds, setBuilds] = useState<readonly string[]>([]);
  /**
   * Qué hacer después de aceptar (PU-CAL-001, PU-EDIT-003): guardar sólo,
   * mandarla al próximo horario libre de la estrategia, o abrir el editor.
   * Las tres pasan por el mismo `POST /blitz` —un solo cobro, una sola key—.
   */
  const [intent, setIntent] = useState<"library" | "schedule" | "edit">("library");
  const [editRequested, setEditRequested] = useState(false);

  const items = pendingSuggestions(queue.data ?? [], decided);
  const view = deckViewFor({
    queueStatus: queue.status,
    queueError: queue.error,
    pending: items,
    blindEmpty,
    profileBlocked,
  });
  const top = topCard(view, blindRound);

  const markDecided = useCallback(
    (id: string) => {
      setDecided((prev) => new Set(prev).add(id));
      // Quedan pocas: se pide más ya, sin esperar al intervalo (F-050).
      if (needsRefill(items.length - 1)) {
        void queryClient.invalidateQueries({ queryKey: blitzQueueKey() });
      }
    },
    [items.length, queryClient],
  );

  const decide = useCallback(
    (decision: Decision) => {
      if (top === null || pending !== null) return;
      if (decision === "accept") {
        accept.reset();
        setAttemptKey(newIdempotencyKey());
        setPending(top);
        return;
      }
      // Rechazar: sólo con la cola visible. En modo blind no hay qué descartar.
      if (top.kind !== "preview") return;
      const id = top.suggestion.id;
      setExitDir(-1);
      setWhyOpen(false);
      markDecided(id);
      discard.mutate(id, {
        onError: () => {
          // Vuelve al deck: si el servidor no la descartó, sigue en la cola.
          setDecided((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          toast({ title: td("deck.skipFailed"), tone: "danger" });
        },
      });
    },
    [accept, discard, markDecided, pending, toast, top],
  );

  const save = useCallback(
    (next: "library" | "schedule" | "edit" = "library") => {
      const card = pending;
      if (card === null) return;
      setIntent(next);
      const suggestionId = card.kind === "preview" ? card.suggestion.id : undefined;
      accept.mutate(
        { suggestionId, idempotencyKey: attemptKey },
        {
          onSuccess: (content) => {
            setExitDir(1);
            setWhyOpen(false);
            if (suggestionId === undefined) setBlindRound((n) => n + 1);
            else markDecided(suggestionId);
            setBuilds((prev) =>
              [content._id, ...prev.filter((id) => id !== content._id)].slice(
                0,
                MAX_TRACKED_BUILDS,
              ),
            );
            setPending(null);
            if (next === "edit") {
              router.push(editorHref(content._id));
              return;
            }
            if (next === "schedule") {
              // Se puede programar mientras construye: la API sólo rechaza FAILED.
              apiRequest<AutoscheduleResult>(autoschedulePath(content._id), {
                method: "POST",
                body: {},
                schema: autoscheduleResultSchema,
              })
                .then((result) => {
                  void queryClient.invalidateQueries({ queryKey: ["posts"] });
                  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                  toast({
                    title: describeAutoschedule(result, tz) ?? tw("toast.contentSaved"),
                    tone: "success",
                    action: {
                      label: td("deck.viewCalendar"),
                      onClick: () => {
                        router.push(ROUTES.calendar);
                      },
                    },
                  });
                })
                .catch(() => {
                  toast({ title: td("deck.scheduleFailed"), tone: "danger" });
                });
              return;
            }
            // FR-050 *User flow* 6 — literal: `Content saved!` + `View in Library`.
            toast({
              title: tw("toast.contentSaved"),
              tone: "success",
              action: {
                label: tw("toast.viewInLibrary"),
                onClick: () => {
                  router.push(ROUTES.library);
                },
              },
            });
          },
          onError: (error) => {
            if (isProfileNotReady(error)) {
              setPending(null);
              setProfileBlocked(true);
              return;
            }
            if (isEmptyQueue(error)) {
              setPending(null);
              if (suggestionId === undefined) setBlindEmpty(true);
              else markDecided(suggestionId);
              void queryClient.invalidateQueries({ queryKey: blitzQueueKey() });
              return;
            }
            if (isUnbuildable(error)) {
              // La API ya la descartó y no cobró (ver la ruta): se va del deck.
              setPending(null);
              setExitDir(-1);
              if (suggestionId === undefined) setBlindRound((n) => n + 1);
              else markDecided(suggestionId);
              toast({ title: td("deck.unbuildable"), tone: "warning" });
              return;
            }
            // Cualquier otro fallo queda dentro del diálogo, con la misma key:
            // reintentar este intento no cobra dos veces.
          },
        },
      );
    },
    [accept, attemptKey, markDecided, pending, queryClient, router, toast],
  );

  // "Edit" en la barra: acepta la de arriba y abre el editor, sin pasar por el
  // diálogo. Se dispara cuando `pending` ya quedó puesto.
  useEffect(() => {
    if (editRequested && pending !== null && !accept.isPending) {
      setEditRequested(false);
      save("edit");
    }
  }, [accept.isPending, editRequested, pending, save]);

  // F-052: ← / → en toda la pantalla. El listener lee el `decide` vigente por
  // ref para no re-suscribirse en cada render.
  const decideRef = useRef(decide);
  useEffect(() => {
    decideRef.current = decide;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.repeat) return;
      const decision = keyToDecision(event);
      if (decision === null) return;
      event.preventDefault();
      decideRef.current(decision);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const topSuggestion = top?.kind === "preview" ? top.suggestion : null;
  const canSkip = top?.kind === "preview";

  return (
    <div className="fgw-page">
      <header className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-text">{td("deck.title")}</h1>
        <Link
          href={ROUTES.blitzSettings}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <GearIcon size={16} aria-hidden="true" />
          <span className="ml-1.5">{td("deck.configure")}</span>
        </Link>
      </header>

      {/* `PU-AUTO-002`: sólo con la marca en piloto. */}
      <AutopilotBanner />

      {/* `PU-BLITZ-003`: lo que se pide acá entra primero en la cola. */}
      <CreatePromptBar />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <aside className="order-2 space-y-4 lg:order-1 lg:max-w-xs lg:justify-self-end">
          {topSuggestion !== null && whyOpen && (
            <WhyPanel id={whyPanelId} explanation={topSuggestion.aiExplanation} />
          )}
          {topSuggestion?.remixSource != null && (
            <RemixedFromPanel source={topSuggestion.remixSource} />
          )}
        </aside>

        <section
          className="order-1 flex flex-col items-center gap-4 lg:order-2"
          aria-live="polite"
        >
          <DeckBody
            view={view}
            top={top}
            items={items}
            refetching={queue.isFetching}
            reducedMotion={reducedMotion}
            exitDir={exitDir}
            leaning={pending !== null}
            canSkip={canSkip}
            whyOpen={whyOpen}
            whyPanelId={whyPanelId}
            onToggleWhy={() => {
              setWhyOpen((open) => !open);
            }}
            onDecide={decide}
            onEdit={() => {
              if (top === null || pending !== null) return;
              accept.reset();
              setAttemptKey(newIdempotencyKey());
              setPending(top);
              setEditRequested(true);
            }}
            editDisabled={top === null || pending !== null}
            onRetry={() => {
              setBlindEmpty(false);
              void queue.refetch();
            }}
          />
        </section>

        <aside className="order-3 lg:max-w-xs">
          <BuildTray contentIds={builds} />
        </aside>
      </div>

      <AcceptDialog
        open={pending !== null && !editRequested && intent !== "edit"}
        saving={accept.isPending}
        scheduling={accept.isPending && intent === "schedule"}
        error={accept.error}
        onSave={() => {
          save("library");
        }}
        onSchedule={() => {
          save("schedule");
        }}
        onCancel={() => {
          setPending(null);
        }}
      />
    </div>
  );
}

function topCard(view: DeckView, blindRound: number): DeckCard | null {
  if (view.kind !== "deck") return null;
  if (view.mode === "blind") return { kind: "blind", key: `blind-${String(blindRound)}` };
  const first = view.items[0];
  return first === undefined
    ? null
    : { kind: "preview", key: first.id, suggestion: first };
}

interface DeckBodyProps {
  readonly view: DeckView;
  readonly top: DeckCard | null;
  readonly items: readonly DeckSuggestion[];
  readonly refetching: boolean;
  readonly reducedMotion: boolean;
  readonly exitDir: number;
  readonly leaning: boolean;
  readonly canSkip: boolean;
  readonly whyOpen: boolean;
  readonly whyPanelId: string;
  readonly onToggleWhy: () => void;
  readonly onDecide: (decision: Decision) => void;
  /** Acepta la de arriba y abre el editor (PU-EDIT-003). */
  readonly onEdit: () => void;
  readonly editDisabled: boolean;
  readonly onRetry: () => void;
}

function DeckBody(props: DeckBodyProps) {
  const { view } = props;
  switch (view.kind) {
    case "loading":
      return <DeckSkeleton />;
    case "error":
      return (
        <div className={CARD_BOX}>
          <ApiErrorState error={view.error} onRetry={props.onRetry} className="h-full" />
        </div>
      );
    case "profile":
      return (
        <EmptyState
          bordered
          title={td("deck.profile.title")}
          description={td("deck.profile.description")}
          action={
            <Link href={ROUTES.brand} className={buttonVariants({ variant: "primary" })}>
              {tw("action.goToBrand")}
            </Link>
          }
        />
      );
    case "empty":
      return (
        <EmptyQueue
          mode={view.mode}
          refetching={props.refetching}
          onRetry={props.onRetry}
        />
      );
    case "deck":
      return <Deck {...props} />;
  }
}

function Deck({
  onEdit,
  editDisabled,
  view,
  top,
  items,
  reducedMotion,
  exitDir,
  leaning,
  canSkip,
  whyOpen,
  whyPanelId,
  onToggleWhy,
  onDecide,
}: DeckBodyProps) {
  if (top === null) return null;
  const suggestion = top.kind === "preview" ? top.suggestion : null;
  // Detrás se ven 2 tarjetas (FR-050 *Centro*: "2–3 tarjetas apiladas").
  const behind: DeckCard[] =
    view.kind === "deck" && view.mode === "preview"
      ? items.slice(1, 3).map((s) => ({ kind: "preview", key: s.id, suggestion: s }))
      : [
          { kind: "blind", key: "blind-behind-1" },
          { kind: "blind", key: "blind-behind-2" },
        ];
  const label =
    suggestion === null
      ? td("deck.blind.title")
      : td("deck.cardLabel", { type: tw(BLITZ_TYPE_COPY[suggestion.contentType]) });

  return (
    <>
      <div className="flex min-h-[2rem] flex-col items-center gap-2">
        {suggestion !== null && <CardChips suggestion={suggestion} />}
        {suggestion !== null && (
          <WhyToggle open={whyOpen} panelId={whyPanelId} onToggle={onToggleWhy} />
        )}
      </div>

      <div className={CARD_BOX}>
        {behind
          .map((card, i) => (
            <div
              key={card.key}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl border border-border shadow-md"
              style={{
                transform: `translateY(${String((i + 1) * 12)}px) scale(${String(1 - (i + 1) * 0.05)})`,
                opacity: 1 - (i + 1) * 0.25,
              }}
            >
              <CardFace card={card} interactive={false} />
            </div>
          ))
          .reverse()}
        <AnimatePresence
          initial={false}
          custom={{ dir: exitDir, reduced: reducedMotion } satisfies ExitCustom}
        >
          <SwipeCard
            key={top.key}
            card={top}
            label={label}
            reducedMotion={reducedMotion}
            leaning={leaning}
            canSkip={canSkip}
            onDecide={onDecide}
          />
        </AnimatePresence>
      </div>

      <p className="sr-only">{td("deck.cardHelp")}</p>

      <div className="mt-6 flex items-center justify-center gap-5">
        <DecisionButton
          kind="skip"
          disabled={!canSkip}
          disabledReason={td("deck.blind.skipUnavailable")}
          onClick={() => {
            onDecide("skip");
          }}
        />
        <Button
          variant="secondary"
          disabled={editDisabled}
          leadingIcon={<PencilIcon size={16} />}
          onClick={onEdit}
        >
          {td("deck.edit")}
        </Button>
        <DecisionButton
          kind="accept"
          disabled={false}
          onClick={() => {
            onDecide("accept");
          }}
        />
      </div>

      <p className="text-xs text-text-subtle">
        {td("deck.keyHint")}
        {view.kind === "deck" && view.mode === "preview" && (
          <>
            {" · "}
            {items.length === 1
              ? td("deck.remainingOne")
              : td("deck.remaining", { count: items.length })}
          </>
        )}
      </p>
    </>
  );
}

function DecisionButton({
  kind,
  disabled,
  disabledReason,
  onClick,
}: {
  kind: Decision;
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  const isAccept = kind === "accept";
  const label = isAccept ? td("deck.accept") : td("deck.skip");
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={isAccept ? "ArrowRight" : "ArrowLeft"}
      aria-disabled={disabled || undefined}
      className="fg-focusable flex h-16 w-16 items-center justify-center rounded-full border-2 bg-surface shadow-md transition-transform hover:scale-105 active:scale-95 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:scale-100"
      style={{
        color: isAccept ? "var(--fg-color-success)" : "var(--fg-color-danger)",
        borderColor: isAccept ? "var(--fg-color-success)" : "var(--fg-color-danger)",
      }}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {isAccept ? <CheckIcon size={28} /> : <XIcon size={28} />}
    </button>
  );
  return (
    <div className="flex flex-col items-center gap-1">
      {disabled && disabledReason !== undefined ? (
        <Tooltip content={disabledReason}>{button}</Tooltip>
      ) : (
        button
      )}
      <kbd
        className="rounded border border-border px-1.5 text-xs text-text-subtle"
        aria-hidden="true"
      >
        {isAccept ? "→" : "←"}
      </kbd>
    </div>
  );
}

function DeckSkeleton() {
  return (
    <div
      className="flex flex-col items-center gap-4"
      aria-busy="true"
      data-testid="deck-loading"
    >
      <Skeleton width={180} height={24} />
      <div className={CARD_BOX}>
        <Skeleton className="h-full w-full rounded-2xl" />
      </div>
      <div className="mt-6 flex gap-5">
        <Skeleton shape="circle" width={64} height={64} />
        <Skeleton width={88} height={40} />
        <Skeleton shape="circle" width={64} height={64} />
      </div>
    </div>
  );
}

/**
 * Cola vacía (ERR-E11, FR-050 `empty`).
 *
 * Con la cola visible la pantalla **reintenta sola** (criterio 4): el polling de
 * `useBlitzQueue` sigue corriendo. En modo blind no puede: la única forma de
 * preguntar es `POST /blitz`, que acepta y cobra, y nunca se dispara solo
 * (NFR-005). Ahí el reintento es un botón.
 *
 * El aviso del LLM va siempre, como pista secundaria: la API no dice *por qué*
 * la cola está vacía, y la causa número uno en uso personal es no tener un
 * modelo configurado (PLAN-USO-PERSONAL §8).
 */
function EmptyQueue({
  mode,
  refetching,
  onRetry,
}: {
  mode: "preview" | "blind";
  refetching: boolean;
  onRetry: () => void;
}) {
  return (
    <EmptyState
      bordered
      title={td("deck.empty.title")}
      description={
        mode === "blind"
          ? td("deck.empty.blindDescription")
          : td("deck.empty.description")
      }
      action={
        mode === "blind" ? (
          <Button variant="primary" onClick={onRetry}>
            {tw("common.tryAgain")}
          </Button>
        ) : refetching ? (
          <span className="inline-flex items-center gap-2 text-sm text-text-muted">
            <Spinner size="sm" aria-hidden />
            {td("deck.refilling")}
          </span>
        ) : undefined
      }
      secondaryAction={
        <p className="text-sm text-text-muted">
          {td("deck.empty.llmHint")}{" "}
          <Link
            href={SETTINGS_MODELS_HREF}
            className="font-medium text-accent hover:underline"
          >
            {td("deck.empty.llmLink")}
          </Link>
        </p>
      }
    />
  );
}
