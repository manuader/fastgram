"use client";

import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Select,
  buttonVariants,
  useToast,
} from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import { PostEditDialog } from "@/components/schedule/PostEditDialog";
import { presentError } from "@/lib/api/error-presentation";
import { useRequestSync } from "@/lib/analytics/data";
import {
  UNCERTAIN_FAILURE_CODES,
  useCancelPosts,
  useDeletePosts,
  useRetryPost,
} from "@/lib/posts/schedule";
import { ApiErrorState } from "./ApiErrorState";
import { PostCard } from "./PostCard";
import { PostGridSkeleton } from "./PostGridSkeleton";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import {
  flattenPostPages,
  hasBuildingPost,
  POST_STATUS_COPY,
  POST_STATUS_FILTERS,
  usePostsList,
} from "@/lib/library/posts";
import type { PostStatusFilter } from "@fastgram/contracts";

/** `""` es "sin filtro": un `<select>` no puede tener valor `undefined`. */
const ANY = "";

function isPostStatusFilter(value: string): value is PostStatusFilter {
  return (POST_STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * `Library → My Posts` · F-120 (PRD:592), FR-100 (PRD:1603-1611).
 *
 * Los cuatro estados de §19, con el **mismo orden de ramas** que `MyContentTab`
 * y `MyMediaBankTab`, y por la misma razón:
 *
 * · **error de la primera carga** va primero y **reemplaza** la grid. Es el
 *   caso que importa: una lista vacía por fallo de red y un workspace sin posts
 *   se dibujan igual —una grid sin tarjetas— y significan lo contrario. Quien
 *   vea `No posts` después de un timeout cree que se perdió lo que tenía
 *   programado, y en esta tab eso incluye publicaciones futuras.
 * · **loading** — skeleton con la forma de la grid.
 * · **empty** — `No posts` (literal §12, PRD:2729), con su salida. Y el vacío
 *   **con el filtro puesto** no es el mismo vacío: ahí la salida es quitarlo.
 * · **datos** — la grid, con `Load more` contra el cursor.
 *
 * El error de un `Load more` **no** reemplaza la grid: ahí ya hay posts en
 * pantalla y borrarlos por un fallo de la página siguiente castiga al usuario
 * por algo que no hizo.
 *
 * ## Acciones (sprint 7)
 *
 * - **`Refresh metrics`** (PRD:1605): `POST /analytics/sync` encola el sync de
 *   la marca activa; las métricas llegan solas cuando termina (la lista se
 *   vuelve a pedir al rato).
 * - **`Select`** (PRD:1605, 1611): casillas y acciones en lote
 *   `POST /posts/cancel` / `POST /posts/delete`, que son **todo o nada**: si un
 *   id no se puede, no se aplica ninguno y se dice.
 * - Por tarjeta: `Retry` (fallido), `Edit`/`Reschedule` (abre el diálogo del
 *   post) y `Cancel`.
 *
 * ## Lo que esta tab no hace, y por qué no se inventa
 *
 * - **No hay filtro por plataforma.** `listPostsQuerySchema` es `.strict()` y
 *   sólo contrata `status`: mandar `platform=` sería un `400`.
 * - **No se puede filtrar por `CANCELLED`.** El contrato copia la lista de §12,
 *   que lo omite aunque sea un estado válido. Los posts cancelados sí aparecen
 *   en la lista sin filtrar.
 */
export function MyPostsTab() {
  const [status, setStatus] = useState<PostStatusFilter | "">(ANY);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const { toast } = useToast();
  const cancel = useCancelPosts();
  const remove = useDeletePosts();
  const retry = useRetryPost();
  const sync = useRequestSync();

  const query = usePostsList(status === ANY ? {} : { status });

  const fail = (error: unknown) => {
    const p = presentError(error);
    const failures = batchFailureCount(error);
    toast({
      title:
        failures === null
          ? tw(p.titleKey, p.titleVars)
          : tw("posts.select.batchFailed", { count: failures }),
      tone: "danger",
    });
  };
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const items = flattenPostPages(query.data);
  const filtered = status !== ANY;
  const building = hasBuildingPost(items);

  const filters = (
    <div className="fgw-library-filters">
      <label className="fgw-library-filters__field">
        <span className="fgw-library-filters__label">
          {tw("posts.filter.statusLabel")}
        </span>
        <Select
          value={status}
          onChange={(event) => {
            const next = event.target.value;
            setStatus(isPostStatusFilter(next) ? next : ANY);
          }}
          options={[
            { value: ANY, label: tw("posts.filter.allStatuses") },
            ...POST_STATUS_FILTERS.map((value) => ({
              value,
              label: tw(POST_STATUS_COPY[value]),
            })),
          ]}
        />
      </label>
      <Button
        variant="ghost"
        size="sm"
        loading={sync.isPending}
        onClick={() => {
          sync.mutate(undefined, {
            onSuccess: () => {
              toast({ title: tw("posts.refreshQueued"), tone: "success" });
              // El sync corre en el worker: se vuelve a pedir la lista en un rato.
              setTimeout(() => {
                void query.refetch();
              }, 15_000);
            },
            onError: fail,
          });
        }}
      >
        {tw("posts.refreshMetrics")}
      </Button>
      <Button
        variant={selecting ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={selecting}
        onClick={() => {
          if (selecting) exitSelect();
          else setSelecting(true);
        }}
      >
        {tw(selecting ? "posts.select.done" : "posts.select.start")}
      </Button>
      <span className="fgw-library-filters__count">
        {query.isSuccess
          ? items.length === 1 && !query.hasNextPage
            ? tw("posts.countOne")
            : tw(query.hasNextPage ? "posts.countPartial" : "posts.count", {
                count: items.length,
              })
          : null}
      </span>
    </div>
  );

  if (query.isError && items.length === 0) {
    return (
      <div className="fgw-library-panel">
        {filters}
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="fgw-library-panel" aria-busy="true">
        {filters}
        <PostGridSkeleton />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="fgw-library-panel">
        {filters}
        <EmptyState
          bordered
          title={tw("posts.empty.title")}
          description={
            filtered
              ? tw("posts.empty.filteredDescription")
              : tw("posts.empty.description")
          }
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setStatus(ANY);
                }}
              >
                {tw("posts.empty.clearFilter")}
              </Button>
            ) : (
              // Un post nace al programar una pieza de contenido (FR-060,
              // PRD:1377), así que la salida de un workspace sin posts es ir a
              // crear contenido, no a una pantalla de "nuevo post" que no
              // existe.
              <Link href={ROUTES.content} className={buttonVariants()}>
                {tw("posts.empty.action")}
              </Link>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="fgw-library-panel">
      {filters}
      <p className="fgw-library-note">{tw("posts.noContentFields")}</p>
      {selecting && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="toolbar"
          aria-label={tw("posts.select.toolbar")}
        >
          <span className="text-sm text-text-muted">
            {tw("posts.select.count", { count: selected.size })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSelected(new Set(items.map((i) => i._id)));
            }}
          >
            {tw("posts.select.all")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={selected.size === 0 || cancel.isPending}
            loading={cancel.isPending}
            onClick={() => {
              cancel.mutate([...selected], {
                onSuccess: (rows) => {
                  toast({
                    title: tw("posts.select.cancelled", { count: rows.length }),
                    tone: "success",
                  });
                  exitSelect();
                },
                onError: fail,
              });
            }}
          >
            {tw("posts.select.cancel")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={selected.size === 0 || remove.isPending}
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            {tw("posts.select.delete")}
          </Button>
        </div>
      )}
      <ul
        className="fgw-post-grid"
        // Mientras algo se construye, la lista cambia sola cada 10 s. Sin esto,
        // ese cambio no existe para quien usa un lector de pantalla.
        aria-live={building ? "polite" : "off"}
      >
        {items.map((item) => (
          <PostCard
            key={item._id}
            item={item}
            selecting={selecting}
            selected={selected.has(item._id)}
            onToggle={() => {
              toggle(item._id);
            }}
            onOpen={() => {
              setEditing(item._id);
            }}
            busy={acting === item._id}
            onRetry={() => {
              // Entrega incierta: el diálogo pide confirmar antes (NFR-015).
              if (
                item.errorCode !== undefined &&
                UNCERTAIN_FAILURE_CODES.has(item.errorCode)
              ) {
                setEditing(item._id);
                return;
              }
              setActing(item._id);
              retry.mutate(
                { postId: item._id },
                {
                  onSuccess: () => {
                    toast({ title: tw("postEdit.toast.retried"), tone: "success" });
                  },
                  onError: fail,
                  onSettled: () => {
                    setActing(null);
                  },
                },
              );
            }}
            onCancel={() => {
              setActing(item._id);
              cancel.mutate([item._id], {
                onSuccess: () => {
                  toast({ title: tw("postEdit.toast.cancelled"), tone: "success" });
                },
                onError: fail,
                onSettled: () => {
                  setActing(null);
                },
              });
            }}
          />
        ))}
      </ul>

      <PostEditDialog
        open={editing !== null}
        postId={editing}
        timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        onClose={() => {
          setEditing(null);
        }}
      />

      <Dialog
        open={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
        }}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>
            {tw("posts.select.deleteTitle", { count: selected.size })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-text-muted">{tw("posts.select.deleteBody")}</p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setConfirmDelete(false);
            }}
          >
            {tw("schedule.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              remove.mutate([...selected], {
                onSuccess: () => {
                  toast({
                    title: tw("posts.select.deleted", { count: selected.size }),
                    tone: "success",
                  });
                  setConfirmDelete(false);
                  exitSelect();
                },
                onError: (error) => {
                  setConfirmDelete(false);
                  fail(error);
                },
              });
            }}
          >
            {tw("posts.select.delete")}
          </Button>
        </DialogFooter>
      </Dialog>

      {query.isError && (
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.hasNextPage && (
        <div className="fgw-library-more">
          <Button
            variant="secondary"
            loading={query.isFetchingNextPage}
            onClick={() => {
              void query.fetchNextPage();
            }}
          >
            {tw(query.isFetchingNextPage ? "posts.loadingMore" : "posts.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** `details.failures` de un lote todo-o-nada (ERR-F01), o `null`. */
function batchFailureCount(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const failures = (error as { details?: Record<string, unknown> }).details?.["failures"];
  return Array.isArray(failures) ? failures.length : null;
}
