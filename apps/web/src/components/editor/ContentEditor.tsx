"use client";

import type { AudioLibrary, EditableContent, MediaElement } from "@fastgram/contracts";
import { fontFamilySchema } from "@fastgram/contracts";
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  SkeletonText,
  Spinner,
  cn,
} from "@fastgram/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { isApiRequestError, type ApiRequestError } from "@/lib/api/errors";
import { presentError } from "@/lib/api/error-presentation";
import { fileKind, useContentItem, type LibraryContent } from "@/lib/library/content";
import {
  useEditableContent,
  useRegenerateText,
  useSaveContentEdit,
} from "@/lib/editor/api";
import { useEditorFonts, useElementWidth } from "@/lib/editor/dom";
import {
  editFailureOf,
  failureReasonKey,
  needsModelSetup,
  type EditFailure,
} from "@/lib/editor/failure";
import { EDITOR_REFERENCE_WIDTH, zoomPercentOf, zoomRect } from "@/lib/editor/geometry";
import {
  buildPatchBody,
  editorReducer,
  initialEditorState,
  isDirty,
  selectedBox,
  slideCount,
  type EditorAction,
  type EditorState,
} from "@/lib/editor/state";
import { AssetsPanel, type SwapTarget } from "./AssetsPanel";
import { AudioPickerDialog } from "./AudioPickerDialog";
import { EditorCanvas } from "./EditorCanvas";
import { MediaPickerDialog } from "./MediaPickerDialog";
import { Slider, TextInspector } from "./TextInspector";

export interface ContentEditorProps {
  readonly contentId: string;
  /**
   * `Done Editing` y la flecha de volver. Sin él, el editor enlaza a
   * `/library/<id>`; como panel (desde Blitz), quien lo abre lo cierra.
   */
  readonly onClose?: () => void;
  readonly className?: string;
}

/** `/library/<contentId>/edit` — la URL del editor como página. */
export const editorHref = (contentId: string): string =>
  `${ROUTES.library}/${encodeURIComponent(contentId)}/edit`;

/**
 * El editor de una pieza · `PU-EDIT-003` / `PU-EDIT-004`, FR-051…053, FR-071.
 *
 * Es un componente y no una página para que Blitz lo pueda abrir como panel
 * (`<ContentEditor contentId onClose />`). Lo que hace, en orden:
 *
 * 1. Lee la pieza (`GET /content/:id`, con el polling de ADR-014) y su
 *    representación editable (`GET /content/:id/editable`).
 * 2. Todo lo que el usuario toca va a un reducer (`lib/editor/state.ts`); el
 *    lienzo dibuja el borrador con la misma geometría que el render.
 * 3. `Save` manda `PATCH` con la `revision` que el usuario está viendo. La
 *    pieza pasa a `BUILDING`; el polling la sigue hasta `CREATED` y entonces
 *    se muestra el render real (`Rendered`) — o el fallo de `lastEdit`, con
 *    la versión anterior todavía disponible (FR-051).
 */
export function ContentEditor({ contentId, onClose, className }: ContentEditorProps) {
  const content = useContentItem(contentId);
  const editable = useEditableContent(contentId);

  const back = onClose ? (
    <Button variant="ghost" size="sm" onClick={onClose}>
      ← {tw("editor.back")}
    </Button>
  ) : (
    <Link
      href={`${ROUTES.library}/${encodeURIComponent(contentId)}`}
      className="fg-focusable text-sm text-text-muted hover:text-text"
    >
      ← {tw("editor.back")}
    </Link>
  );

  if (content.isPending || (editable.isPending && !editable.isError)) {
    return (
      <div className={cn("grid gap-4", className)} aria-busy="true">
        {back}
        <p className="sr-only">{tw("editor.loading")}</p>
        <div className="grid gap-4 lg:grid-cols-[260px_1fr_300px]">
          <SkeletonText lines={6} />
          <Skeleton className="mx-auto aspect-[9/16] w-[360px] max-w-full" />
          <SkeletonText lines={8} />
        </div>
      </div>
    );
  }

  if (content.isError) {
    return (
      <div className={cn("grid gap-4", className)}>
        {back}
        <LoadError error={content.error} onRetry={() => void content.refetch()} />
      </div>
    );
  }

  if (content.data.status === "FAILED") {
    return (
      <div className={cn("grid gap-4", className)}>
        {back}
        <EmptyState bordered title={tw("editor.failedBlocked")} />
      </div>
    );
  }

  if (editable.isError) {
    return (
      <div className={cn("grid gap-4", className)}>
        {back}
        <LoadError error={editable.error} onRetry={() => void editable.refetch()} />
      </div>
    );
  }

  if (editable.data === undefined) return null;

  if (editable.data.textBoxes.length === 0) {
    return (
      <div className={cn("grid gap-4", className)}>
        {back}
        <EmptyState bordered title={tw("editor.noBoxes")} />
      </div>
    );
  }

  return (
    <LoadedEditor
      className={className}
      back={back}
      content={content.data}
      editable={editable.data}
      refetchEditable={() => void editable.refetch()}
      refetchContent={() => void content.refetch()}
      {...(onClose === undefined ? {} : { onClose })}
    />
  );
}

function LoadError({
  error,
  onRetry,
}: {
  readonly error: ApiRequestError;
  readonly onRetry: () => void;
}) {
  if (isApiRequestError(error) && error.code === "not_found") {
    return <EmptyState bordered title={tw("editor.notFound")} />;
  }
  if (isApiRequestError(error) && error.code === "content_not_editable") {
    return <EmptyState bordered title={tw("editor.notEditable")} />;
  }
  return <ApiErrorState error={error} onRetry={onRetry} />;
}

type Banner =
  | { readonly tone: "info" | "success" | "danger"; readonly key: CopyKey }
  | { readonly tone: "stale" }
  /** La última edición o el Regenerate falló: titular + el porqué. */
  | { readonly tone: "failed"; readonly failure: EditFailure };

type PickerState =
  | {
      readonly kind: "media";
      readonly target: SwapTarget;
      readonly type: "image" | "video";
    }
  | { readonly kind: "audio" }
  | null;

function LoadedEditor({
  content,
  editable,
  back,
  onClose,
  className,
  refetchEditable,
  refetchContent,
}: {
  readonly content: LibraryContent;
  readonly editable: EditableContent;
  readonly back: ReactNode;
  readonly onClose?: () => void;
  readonly className?: string | undefined;
  readonly refetchEditable: () => void;
  readonly refetchContent: () => void;
}) {
  const [state, dispatch] = useReducer(editorReducer, editable, initialEditorState);
  const [view, setView] = useState<"preview" | "rendered">("preview");
  // Al abrir, si la última edición falló se dice —y por qué—: la pieza que se
  // ve es la versión anterior, y sin esto el usuario no sabe que su cambio no
  // llegó.
  const [banner, setBanner] = useState<Banner | null>(() => {
    const failure = editFailureOf(content.lastEdit);
    return failure === null ? null : { tone: "failed", failure };
  });
  const [picker, setPicker] = useState<PickerState>(null);
  const [prompt, setPrompt] = useState("");
  const [mention, setMention] = useState<boolean | null>(null);
  /** La revisión que este editor mandó a construir, hasta que termine. */
  const [pending, setPending] = useState<{
    readonly revision: number;
    readonly kind: "edit" | "regenerate";
  } | null>(null);
  const baseVideoRect = useRef<MediaElement | null>(editable.assets?.video ?? null);

  const save = useSaveContentEdit(content._id);
  const regenerate = useRegenerateText(content._id);
  const dirty = isDirty(state);
  const building = content.status === "BUILDING";
  const busy = save.isPending || regenerate.isPending;

  useEditorFonts(fontFamilySchema.options);

  // Editable nuevo del servidor (tras un rebuild, o un reload): se adopta si
  // no hay nada sin guardar. Con cambios locales no se pisa el trabajo.
  const lastEditable = useRef(editable);
  useEffect(() => {
    if (editable === lastEditable.current) return;
    lastEditable.current = editable;
    if (!dirty) {
      dispatch({ type: "load", editable });
      baseVideoRect.current = editable.assets?.video ?? null;
    }
  }, [editable, dirty]);

  // Seguimiento del rebuild: la pieza vuelve a `CREATED` con la revisión que
  // mandamos (o una posterior) y `lastEdit` dice cómo salió.
  useEffect(() => {
    if (pending === null || content.status === "BUILDING") return;
    if (content.revision < pending.revision) return;
    const failure = editFailureOf(content.lastEdit);
    if (failure !== null) {
      // El titular es el de lo que **este** editor mandó; el porqué, del worker.
      setBanner({ tone: "failed", failure: { ...failure, kind: pending.kind } });
    } else {
      setBanner({ tone: "success", key: "editor.rebuilt" });
      setView("rendered");
    }
    setPending(null);
    refetchEditable();
  }, [content.status, content.revision, content.lastEdit, pending, refetchEditable]);

  const router = useRouter();
  const close =
    onClose ??
    (() => router.push(`${ROUTES.library}/${encodeURIComponent(content._id)}`));

  const onError = (error: ApiRequestError) => {
    if (error.code === "stale_revision") {
      setBanner({ tone: "stale" });
      return;
    }
    const invalid =
      error.code === "bad_request" &&
      error.details !== undefined &&
      "invalidAssets" in error.details;
    setBanner({
      tone: "danger",
      key: invalid ? "editor.invalidMedia" : presentError(error).titleKey,
    });
  };

  const doSave = (then?: "close") => {
    setBanner(null);
    save.mutate(buildPatchBody(content.revision, state), {
      onSuccess: (updated) => {
        dispatch({ type: "commit" });
        setPending({ revision: updated.revision, kind: "edit" });
        setBanner({ tone: "info", key: "editor.rebuilding" });
        if (then === "close") close();
      },
      onError,
    });
  };

  const doRegenerate = () => {
    setBanner(null);
    const trimmed = prompt.trim();
    regenerate.mutate(
      {
        ...(trimmed === "" ? {} : { prompt: trimmed }),
        ...(mention === null ? {} : { mentionBusiness: mention }),
      },
      {
        onSuccess: (updated) => {
          setPending({ revision: updated.revision, kind: "regenerate" });
          setBanner({ tone: "info", key: "editor.rebuilding" });
        },
        onError,
      },
    );
  };

  const reload = () => {
    setBanner(null);
    dispatch({ type: "load", editable });
    // Con el borrador descartado, el efecto de arriba adopta lo que vuelva.
    refetchContent();
    refetchEditable();
  };

  const box = selectedBox(state);
  const total = slideCount(state);
  const isSlideshow = content.type === "slideshow";
  const locked = building || busy;

  const pick = (url: string | null) => {
    if (picker === null) return;
    if (picker.kind === "audio") dispatch({ type: "audio", url });
    else if (url !== null && picker.target.kind === "slide")
      dispatch({ type: "swapSlide", index: picker.target.index, url });
    else if (url !== null && picker.target.kind === "slot")
      dispatch({ type: "swapMedia", slot: picker.target.slot, url });
    setPicker(null);
  };

  return (
    <div className={cn("grid gap-4", className)}>
      <header className="flex flex-wrap items-center gap-3">
        {back}
        <h1 className="text-lg font-semibold">{tw("editor.title")}</h1>
        {dirty && <Badge tone="warning">{tw("editor.unsaved")}</Badge>}
        {building && (
          <Badge tone="info">
            <Spinner size="sm" aria-hidden /> {tw("library.status.building")}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={!dirty || busy}
            onClick={() => dispatch({ type: "discard" })}
          >
            {tw("editor.discard")}
          </Button>
          <Button
            variant="secondary"
            loading={save.isPending}
            disabled={!dirty || locked}
            onClick={() => doSave()}
          >
            {save.isPending ? tw("editor.saving") : tw("editor.save")}
          </Button>
          <Button
            disabled={busy || (dirty && building)}
            onClick={() => {
              if (dirty) doSave("close");
              else close();
            }}
          >
            ✓ {tw("editor.done")}
          </Button>
        </div>
      </header>

      <div aria-live="polite">
        {banner !== null && <BannerView banner={banner} onReload={reload} />}
        {banner === null && building && pending === null && (
          <BannerView
            banner={{ tone: "info", key: "editor.buildingBlocked" }}
            onReload={reload}
          />
        )}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
        <aside>
          <AssetsPanel
            contentType={content.type}
            assets={state.draft.assets}
            baseAssets={state.base.assets}
            slide={state.slide}
            disabled={locked}
            onSwap={(target) => {
              if (target.kind === "audio") setPicker({ kind: "audio" });
              else
                setPicker({
                  kind: "media",
                  target,
                  type:
                    target.kind === "slide" || target.slot === "image"
                      ? "image"
                      : "video",
                });
            }}
            prompt={prompt}
            onPromptChange={setPrompt}
            mentionBusiness={mention}
            onMentionChange={setMention}
            onRegenerate={doRegenerate}
            regenerating={regenerate.isPending}
            regenerateBlockedBy={dirty ? "editor.regenerate.dirty" : null}
          />
          <section className="mt-5 rounded-lg border border-border p-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
              {tw("editor.caption.title")}
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              {tw("editor.caption.unavailable")}
            </p>
          </section>
        </aside>

        <main className="grid justify-items-center gap-3">
          <ViewToggle view={view} onChange={setView} />
          {view === "preview" ? (
            <PreviewPane
              canvas={editable.canvas}
              content={content}
              state={state}
              dispatch={dispatch}
              readOnly={locked}
              onDeleteAttempt={() =>
                setBanner({ tone: "info", key: "editor.deleteNotAllowed" })
              }
            />
          ) : (
            <RenderedPane content={content} slide={state.slide} stale={building} />
          )}
          {total > 1 && (
            <SlideStrip
              total={total}
              current={state.slide}
              onChange={(index) => dispatch({ type: "slide", index })}
            />
          )}
          <p className="text-xs text-text-subtle">{tw("editor.keyboardHint")}</p>
        </main>

        <aside className="grid gap-6">
          {content.type === "green-screen" && state.draft.assets.video !== undefined && (
            <VideoControls
              base={baseVideoRect.current ?? state.draft.assets.video}
              current={state.draft.assets.video}
              dispatch={dispatch}
              disabled={locked}
            />
          )}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-subtle">
              {tw("editor.text.title")}
            </h2>
            <TextInspector
              box={box}
              canApplyToAll={isSlideshow}
              disabled={locked}
              onChange={(patch, all) => {
                if (box === null) return;
                dispatch({ type: "update", id: box.id, patch, all });
              }}
            />
          </section>
        </aside>
      </div>

      {picker?.kind === "media" && (
        <MediaPickerDialog
          open
          type={picker.type}
          title={
            picker.target.kind === "slide"
              ? tw("editor.picker.swapImage", { n: picker.target.index + 1 })
              : picker.type === "video"
                ? tw("editor.picker.selectVideo")
                : tw("editor.picker.selectImage")
          }
          currentUrl={
            picker.target.kind === "slide"
              ? state.draft.assets.slides?.[picker.target.index]?.url
              : picker.target.kind === "slot"
                ? state.draft.assets[picker.target.slot]?.url
                : undefined
          }
          onCancel={() => setPicker(null)}
          onPick={pick}
        />
      )}
      {picker?.kind === "audio" && (
        <AudioPickerDialog
          open
          library={content.type as AudioLibrary}
          currentUrl={state.draft.assets.audio?.url ?? null}
          onCancel={() => setPicker(null)}
          onPick={pick}
        />
      )}
    </div>
  );
}

function BannerView({
  banner,
  onReload,
}: {
  readonly banner: Banner;
  readonly onReload: () => void;
}) {
  if (banner.tone === "failed") return <FailureBanner failure={banner.failure} />;
  if (banner.tone === "stale") {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-warning bg-surface p-3 text-sm"
      >
        <span className="flex-1">{tw("editor.stale")}</span>
        <Button size="sm" variant="secondary" onClick={onReload}>
          {tw("editor.reload")}
        </Button>
      </div>
    );
  }
  return (
    <div
      role={banner.tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-surface p-3 text-sm",
        banner.tone === "danger" && "border-danger",
        banner.tone === "success" && "border-success",
        banner.tone === "info" && "border-border",
      )}
    >
      {banner.tone === "info" && banner.key === "editor.rebuilding" && (
        <Spinner size="sm" aria-hidden />
      )}
      {tw(banner.key)}
    </div>
  );
}

/**
 * Una edición o un Regenerate que no llegó: qué pasó, por qué (si el código es
 * conocido) y, cuando falta el modelo, adónde ir a configurarlo.
 */
function FailureBanner({ failure }: { readonly failure: EditFailure }) {
  const reasonKey = failureReasonKey(failure.reason);
  return (
    <div
      role="alert"
      data-testid="editor-failure"
      data-reason={failure.reason ?? undefined}
      className="flex flex-col gap-1 rounded-lg border border-danger bg-surface p-3 text-sm"
    >
      <span className="font-medium text-text">
        {tw(
          failure.kind === "regenerate"
            ? "editor.regenerate.failed"
            : "editor.editFailed",
        )}
      </span>
      {reasonKey !== null && <span className="text-text-muted">{tw(reasonKey)}</span>}
      {needsModelSetup(failure.reason) && (
        <Link
          href={ROUTES.settingsModels}
          className="fg-focusable w-fit font-medium text-accent hover:underline"
        >
          {tw("editor.failure.llmLink")}
        </Link>
      )}
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  readonly view: "preview" | "rendered";
  readonly onChange: (v: "preview" | "rendered") => void;
}) {
  return (
    <div
      role="group"
      aria-label={tw("editor.view.label")}
      className="inline-flex rounded-md border border-border p-0.5"
    >
      {(["preview", "rendered"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          className={cn(
            "fg-focusable rounded px-3 py-1 text-xs",
            view === v ? "bg-accent-subtle text-text" : "text-text-muted",
          )}
          onClick={() => onChange(v)}
        >
          {tw(v === "preview" ? "editor.view.preview" : "editor.view.rendered")}
        </button>
      ))}
    </div>
  );
}

function PreviewPane({
  canvas,
  content,
  state,
  dispatch,
  readOnly,
  onDeleteAttempt,
}: {
  readonly canvas: EditableContent["canvas"];
  readonly content: LibraryContent;
  readonly state: EditorState;
  readonly dispatch: Dispatch<EditorAction>;
  readonly readOnly: boolean;
  readonly onDeleteAttempt: () => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const available = useElementWidth(wrapper, EDITOR_REFERENCE_WIDTH);
  // 360 es la escala de las unidades de editor; más chico sólo si no entra.
  const width = Math.min(EDITOR_REFERENCE_WIDTH, available);
  return (
    <div ref={wrapper} className="flex w-full justify-center">
      <EditorCanvas
        canvas={canvas}
        contentType={content.type}
        state={state}
        dispatch={dispatch}
        previewWidth={width}
        readOnly={readOnly}
        onDeleteAttempt={onDeleteAttempt}
      />
    </div>
  );
}

function RenderedPane({
  content,
  slide,
  stale,
}: {
  readonly content: LibraryContent;
  readonly slide: number;
  readonly stale: boolean;
}) {
  const file = content.type === "slideshow" ? content.files[slide] : content.files[0];
  return (
    <div className="grid w-[360px] max-w-full gap-2">
      {stale && <p className="text-xs text-text-muted">{tw("editor.rendered.stale")}</p>}
      {file === undefined ? (
        <EmptyState bordered title={tw("editor.rendered.empty")} />
      ) : fileKind(file, content.type) === "video" ? (
        <video
          key={file}
          src={file}
          controls
          playsInline
          className="w-full rounded-lg bg-black"
          data-testid="rendered-file"
        />
      ) : (
        <img
          key={file}
          src={file}
          alt=""
          className="w-full rounded-lg"
          data-testid="rendered-file"
        />
      )}
    </div>
  );
}

function SlideStrip({
  total,
  current,
  onChange,
}: {
  readonly total: number;
  readonly current: number;
  readonly onChange: (index: number) => void;
}) {
  return (
    <nav aria-label={tw("editor.slides.label")} className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        aria-label={tw("editor.slides.previous")}
        disabled={current === 0}
        onClick={() => onChange(current - 1)}
      >
        ‹
      </Button>
      <ol className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <li key={i}>
            <button
              type="button"
              aria-current={i === current ? "step" : undefined}
              aria-label={tw("editor.slides.item", { n: i + 1 })}
              className={cn(
                "fg-focusable h-2.5 w-2.5 rounded-full",
                i === current ? "bg-accent" : "bg-border-strong",
              )}
              onClick={() => onChange(i)}
            />
          </li>
        ))}
      </ol>
      <span className="text-xs text-text-muted">
        {tw("editor.slides.counter", { current: current + 1, total })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-label={tw("editor.slides.next")}
        disabled={current >= total - 1}
        onClick={() => onChange(current + 1)}
      >
        ›
      </Button>
    </nav>
  );
}

/** `Video` (sólo green-screen): `Zoom`, `Reset Position`, hint de arrastre (FR-051). */
function VideoControls({
  base,
  current,
  dispatch,
  disabled,
}: {
  readonly base: MediaElement;
  readonly current: MediaElement;
  readonly dispatch: Dispatch<EditorAction>;
  readonly disabled: boolean;
}) {
  const zoom = zoomPercentOf(base, current);
  return (
    <section className="grid gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        {tw("editor.video.title")}
      </h2>
      <Slider
        id="editor-video-zoom"
        label={tw("editor.video.zoom", { zoom })}
        min={50}
        max={300}
        step={5}
        value={zoom}
        disabled={disabled}
        onChange={(pct) =>
          dispatch({
            type: "mediaRect",
            slot: "video",
            rect: zoomRect(base, current, pct / 100),
          })
        }
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() =>
          dispatch({
            type: "mediaRect",
            slot: "video",
            rect: {
              drawX: base.drawX,
              drawY: base.drawY,
              drawW: base.drawW,
              drawH: base.drawH,
            },
          })
        }
      >
        {tw("editor.video.reset")}
      </Button>
      <p className="text-xs text-text-muted">{tw("editor.video.dragHint")}</p>
    </section>
  );
}
