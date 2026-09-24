"use client";

import {
  CHARACTER_UGC_PRODUCTS_MAX,
  INFLUENCER_VIDEO_PROMPT_MAX,
  type CharacterModel,
  type CharacterUgcAnimateRequest,
  type CharacterUgcImageRequest,
  type GenModelSpec,
} from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Skeleton,
  Textarea,
  cn,
} from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { isApiRequestError } from "@/lib/api/errors";
import { tw } from "@/lib/i18n/t";
import { useInfluencerSetup } from "@/lib/influencers/api";
import { formatUsd } from "@/lib/models/budget";
import { ROUTES } from "@/lib/nav/routes";
import {
  useAnimateEstimate,
  useAnimateUgc,
  useCreateUgcPiece,
  useGenerateUgc,
  useModelUgc,
  useUgcEstimate,
} from "./api";
import { BrandImagePicker } from "./BrandImagePicker";

const ESTIMATE_DEBOUNCE_MS = 600;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return debounced;
}

/** El pedido de imagen, o `null` si falta algo. */
export function ugcImageRequest(
  brandId: string | null,
  prompt: string,
  count: 1 | 4,
): CharacterUgcImageRequest | null {
  const p = prompt.trim();
  if (brandId === null || p === "") return null;
  return { brandId, prompt: p, aspectRatio: "9:16", count };
}

/** Un texto por slide: la imagen del modelo y después cada producto. */
export function slideCount(kind: "image" | "video", products: number): number {
  return kind === "video" ? 1 : 1 + products;
}

interface Selected {
  readonly mediaId: string;
  readonly url: string;
  readonly kind: "image" | "video";
}

/**
 * «Generate UGC for <marca>» (sprint 8, K): la imagen del modelo con su Soul
 * ID en una marca asignada, «Animate» a video, y la pieza en la Library de
 * esa marca (slideshow con el producto, o wall of text sobre el video).
 *
 * El producto no entra en la foto del modelo: SOUL V2 no acepta imágenes de
 * referencia además del personaje. Por eso se describe en el prompt y se
 * suma como slide al armar la pieza.
 */
export function UgcPanel({ model }: { readonly model: CharacterModel }) {
  const ids = { brand: useId(), prompt: useId(), count: useId() };
  const { workspaces } = useWorkspace();
  const assigned = (workspaces.data ?? []).filter((w) => model.brandIds.includes(w.id));
  const [brandId, setBrandId] = useState<string | null>(model.brandIds[0] ?? null);
  const brand = assigned.find((w) => w.id === brandId) ?? null;
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState<1 | 4>(1);
  const debounced = useDebounced(prompt, ESTIMATE_DEBOUNCE_MS);
  const request = useMemo(
    () => ugcImageRequest(brand?.id ?? null, debounced, count),
    [brand, debounced, count],
  );
  const estimate = useUgcEstimate(model.id, request);
  const generate = useGenerateUgc(model.id);
  const list = useModelUgc(model.id, brand?.id ?? null);
  const [piece, setPiece] = useState<Selected | null>(null);
  const [animate, setAnimate] = useState<Selected | null>(null);
  const [created, setCreated] = useState(false);

  if (model.status !== "ready") return null;
  if (assigned.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-lg font-semibold text-text">
          {tw("charModels.ugc.title")}
        </h2>
        <p className="m-0 text-sm text-text-muted">{tw("charModels.ugc.assignFirst")}</p>
      </section>
    );
  }

  const ready = ugcImageRequest(brand?.id ?? null, prompt, count);
  const typing = prompt !== debounced;
  const cost = estimate.data?.estimate;
  const overBudget = estimate.data !== undefined && !estimate.data.fits;
  const budgetRejected =
    isApiRequestError(generate.error) &&
    generate.error.details?.["reason"] === "budget_exceeded";
  const media = (list.data ?? []).flatMap((g) =>
    g.status === "ready" ? g.media.map((m) => ({ ...m, generationId: g.id })) : [],
  );
  const pending = (list.data ?? []).filter(
    (g) => g.status === "queued" || g.status === "generating",
  ).length;

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${ids.brand}-h`}>
      <h2 id={`${ids.brand}-h`} className="m-0 text-lg font-semibold text-text">
        {brand === null
          ? tw("charModels.ugc.title")
          : tw("charModels.ugc.titleFor", { brand: brand.name })}
      </h2>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.brand} className="text-sm font-medium text-text">
            {tw("charModels.ugc.brand")}
          </label>
          <Select
            id={ids.brand}
            value={brandId ?? ""}
            options={assigned.map((w) => ({ value: w.id, label: w.name }))}
            onChange={(e) => {
              setBrandId(e.target.value);
              setCreated(false);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.count} className="text-sm font-medium text-text">
            {tw("charModels.ugc.count")}
          </label>
          <Select
            id={ids.count}
            value={String(count)}
            options={[
              { value: "1", label: "1" },
              { value: "4", label: "4" },
            ]}
            onChange={(e) => {
              setCount(e.target.value === "4" ? 4 : 1);
            }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.prompt} className="text-sm font-medium text-text">
          {tw("charModels.ugc.prompt")}
        </label>
        <Textarea
          id={ids.prompt}
          rows={3}
          maxLength={2000}
          value={prompt}
          placeholder={tw("charModels.ugc.promptPlaceholder")}
          onChange={(e) => {
            setPrompt(e.target.value);
          }}
        />
        <p className="m-0 text-xs text-text-subtle">{tw("charModels.ugc.productNote")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          loading={generate.isPending}
          disabled={ready === null || overBudget || generate.isPending}
          onClick={() => {
            if (ready !== null) generate.mutate(ready);
          }}
        >
          {tw("charModels.ugc.generate")}
        </Button>
        <span className="text-sm text-text-muted" aria-live="polite">
          {ready === null
            ? " "
            : estimate.isFetching || typing
              ? tw("influencers.images.estimating")
              : estimate.isError
                ? (estimate.error.serverMessage ?? tw("charModels.ugc.estimateFailed"))
                : overBudget
                  ? tw("influencers.images.overBudget", {
                      remaining: formatUsd(estimate.data?.budget.remainingUsd ?? 0),
                    })
                  : cost === undefined
                    ? " "
                    : tw("charModels.ugc.cost", { cost: formatUsd(cost.usd) })}
        </span>
      </div>
      {generate.isError && (
        <p className="m-0 text-sm text-danger" role="alert">
          {budgetRejected
            ? tw("influencers.images.budgetExceeded")
            : (generate.error.serverMessage ?? tw("charModels.ugc.failedToStart"))}
        </p>
      )}
      {created && brand !== null && (
        <p className="m-0 text-sm text-success" role="status">
          {tw("charModels.ugc.pieceCreated", { brand: brand.name })}{" "}
          <Link href={ROUTES.library} className="underline">
            {tw("charModels.ugc.openLibrary")}
          </Link>
        </p>
      )}

      <h3 className="m-0 text-base font-semibold text-text">
        {tw("charModels.ugc.results")}
      </h3>
      {list.isError ? (
        <ApiErrorState
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : list.isPending ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="aspect-[9/16] rounded-lg" />
          ))}
        </div>
      ) : media.length === 0 && pending === 0 ? (
        <p className="m-0 text-sm text-text-muted">{tw("charModels.ugc.empty")}</p>
      ) : (
        <>
          {pending > 0 && (
            <p className="m-0 text-sm text-text-muted" role="status">
              {tw("charModels.ugc.pending", { count: pending })}
            </p>
          )}
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
            {media.map((m) => (
              <li
                key={m.mediaId}
                className="flex flex-col gap-2 rounded-xl border border-border p-2"
              >
                {m.mediaType === "video" ? (
                  <video
                    src={m.url}
                    muted
                    playsInline
                    controls
                    className="aspect-[9/16] w-full rounded-lg object-cover"
                  />
                ) : (
                  <img
                    src={m.url}
                    alt=""
                    loading="lazy"
                    className="aspect-[9/16] w-full rounded-lg object-cover"
                  />
                )}
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setPiece({ mediaId: m.mediaId, url: m.url, kind: m.mediaType });
                    }}
                  >
                    {tw("charModels.ugc.createPiece")}
                  </Button>
                  {m.mediaType === "image" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAnimate({ mediaId: m.mediaId, url: m.url, kind: "image" });
                      }}
                    >
                      {tw("charModels.ugc.animate")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {brand !== null && (
        <PieceDialog
          modelId={model.id}
          brandId={brand.id}
          source={piece}
          onClose={() => {
            setPiece(null);
          }}
          onCreated={() => {
            setPiece(null);
            setCreated(true);
          }}
        />
      )}
      {brand !== null && (
        <ModelAnimateDialog
          modelId={model.id}
          brandId={brand.id}
          source={animate}
          onClose={() => {
            setAnimate(null);
          }}
        />
      )}
    </section>
  );
}

function PieceDialog({
  modelId,
  brandId,
  source,
  onClose,
  onCreated,
}: {
  readonly modelId: string;
  readonly brandId: string;
  readonly source: Selected | null;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [products, setProducts] = useState<string[]>([]);
  const [texts, setTexts] = useState<string[]>([""]);
  const create = useCreateUgcPiece(modelId);
  const key = useRef(newIdempotencyKey());
  const kind = source?.kind ?? "image";
  const slides = slideCount(kind, products.length);
  const shown = Array.from({ length: slides }, (_, i) => texts[i] ?? "");
  const ok = source !== null && shown.every((t) => t.trim() !== "");

  const close = () => {
    setProducts([]);
    setTexts([""]);
    create.reset();
    key.current = newIdempotencyKey();
    onClose();
  };

  return (
    <Dialog open={source !== null} onClose={close} size="lg">
      <DialogHeader>
        <DialogTitle>{tw("charModels.piece.title")}</DialogTitle>
        <DialogClose label={tw("charModels.cancel")} />
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm text-text-muted">
            {kind === "image"
              ? tw("charModels.piece.bodyImage")
              : tw("charModels.piece.bodyVideo")}
          </p>
          {kind === "image" && (
            <BrandImagePicker
              brandId={brandId}
              selected={products}
              onChange={setProducts}
              max={CHARACTER_UGC_PRODUCTS_MAX}
              label={tw("charModels.piece.products")}
              exclude={source === null ? [] : [source.mediaId]}
            />
          )}
          <div className="flex flex-col gap-2">
            {shown.map((t, i) => (
              <div key={i} className="flex flex-col gap-1">
                <label
                  className="text-sm font-medium text-text"
                  htmlFor={`piece-text-${String(i)}`}
                >
                  {i === 0
                    ? tw("charModels.piece.textModel")
                    : tw("charModels.piece.textProduct", { n: i })}
                </label>
                <Input
                  id={`piece-text-${String(i)}`}
                  value={t}
                  maxLength={500}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTexts((prev) => {
                      const next = Array.from(
                        { length: slides },
                        (_, j) => prev[j] ?? "",
                      );
                      next[i] = v;
                      return next;
                    });
                  }}
                />
              </div>
            ))}
          </div>
          {create.isError && (
            <p className="m-0 text-sm text-danger" role="alert">
              {create.error.serverMessage ?? tw("charModels.piece.failed")}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {tw("charModels.cancel")}
        </Button>
        <Button
          loading={create.isPending}
          disabled={!ok || create.isPending}
          onClick={() => {
            if (source === null) return;
            create.mutate(
              {
                body: {
                  brandId,
                  kind: source.kind,
                  sourceMediaId: source.mediaId,
                  productMediaIds: source.kind === "image" ? products : [],
                  texts: shown.map((t) => t.trim()),
                },
                idempotencyKey: key.current,
              },
              {
                onSuccess: () => {
                  close();
                  onCreated();
                },
              },
            );
          }}
        >
          {tw("charModels.piece.create")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** «Animate» con el modelo, en la marca: el image-to-video de Higgsfield. */
function ModelAnimateDialog({
  modelId,
  brandId,
  source,
  onClose,
}: {
  readonly modelId: string;
  readonly brandId: string;
  readonly source: Selected | null;
  readonly onClose: () => void;
}) {
  const ids = { prompt: useId(), model: useId(), duration: useId() };
  const setup = useInfluencerSetup();
  const models: readonly GenModelSpec[] = setup.data?.videoModels ?? [];
  const [modelIdSel, setModelIdSel] = useState("");
  const spec = models.find((m) => m.id === modelIdSel) ?? models[0];
  const [duration, setDuration] = useState<number | null>(null);
  const seconds = duration ?? spec?.durationsSeconds[0] ?? null;
  const [prompt, setPrompt] = useState("");
  const debounced = useDebounced(prompt, ESTIMATE_DEBOUNCE_MS);
  const build = (p: string): CharacterUgcAnimateRequest | null =>
    source === null || spec === undefined || seconds === null
      ? null
      : {
          brandId,
          sourceMediaId: source.mediaId,
          model: spec.id,
          durationSeconds: seconds,
          prompt: p.trim(),
        };
  // TanStack compara la clave por valor: un objeto nuevo por render no refetchea.
  const request = build(debounced);
  const estimate = useAnimateEstimate(modelId, request);
  const animate = useAnimateUgc(modelId);
  const ready = build(prompt);
  const overBudget = estimate.data !== undefined && !estimate.data.fits;

  const close = () => {
    setPrompt("");
    setDuration(null);
    animate.reset();
    onClose();
  };

  return (
    <Dialog open={source !== null} onClose={close} size="md">
      <DialogHeader>
        <DialogTitle>{tw("influencers.animate.title")}</DialogTitle>
        <DialogClose label={tw("charModels.cancel")} />
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          {source !== null && (
            <img
              src={source.url}
              alt=""
              className="aspect-[9/16] max-h-56 self-start rounded-xl object-cover"
            />
          )}
          {setup.isPending ? (
            <p className="m-0 text-sm text-text-muted">{tw("charModels.loading")}</p>
          ) : models.length === 0 ? (
            <p className="m-0 text-sm text-text-muted">
              {tw("influencers.animate.noModels")}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.prompt} className="text-sm font-medium text-text">
                  {tw("influencers.animate.prompt")}
                </label>
                <Textarea
                  id={ids.prompt}
                  rows={2}
                  maxLength={INFLUENCER_VIDEO_PROMPT_MAX}
                  placeholder={tw("influencers.animate.placeholder")}
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                  }}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.model} className="text-sm font-medium text-text">
                    {tw("aiStudio.model.label")}
                  </label>
                  <Select
                    id={ids.model}
                    value={spec?.id ?? ""}
                    options={models.map((m) => ({ value: m.id, label: m.label }))}
                    onChange={(e) => {
                      setModelIdSel(e.target.value);
                      setDuration(null);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.duration} className="text-sm font-medium text-text">
                    {tw("aiStudio.duration.label")}
                  </label>
                  <Select
                    id={ids.duration}
                    value={seconds === null ? "" : String(seconds)}
                    options={(spec?.durationsSeconds ?? []).map((s) => ({
                      value: String(s),
                      label: tw("aiStudio.duration.value", { seconds: s }),
                    }))}
                    onChange={(e) => {
                      setDuration(Number(e.target.value));
                    }}
                  />
                </div>
              </div>
              <p
                className={cn(
                  "m-0 text-sm",
                  overBudget || estimate.isError ? "text-danger" : "text-text-muted",
                )}
                aria-live="polite"
              >
                {estimate.isFetching
                  ? tw("influencers.images.estimating")
                  : estimate.isError
                    ? (estimate.error.serverMessage ??
                      tw("charModels.ugc.estimateFailed"))
                    : estimate.data === undefined
                      ? " "
                      : overBudget
                        ? tw("influencers.images.overBudget", {
                            remaining: formatUsd(estimate.data.budget.remainingUsd),
                          })
                        : tw("charModels.ugc.cost", {
                            cost: formatUsd(estimate.data.estimate.usd),
                          })}
              </p>
              {animate.isError && (
                <p className="m-0 text-sm text-danger" role="alert">
                  {animate.error.serverMessage ?? tw("charModels.ugc.failedToStart")}
                </p>
              )}
            </>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {tw("charModels.cancel")}
        </Button>
        <Button
          loading={animate.isPending}
          disabled={ready === null || overBudget || animate.isPending}
          onClick={() => {
            if (ready !== null) animate.mutate(ready, { onSuccess: close });
          }}
        >
          {tw("influencers.animate.generate")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
