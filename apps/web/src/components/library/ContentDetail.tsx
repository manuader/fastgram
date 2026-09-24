"use client";

import {
  Badge,
  Card,
  EmptyState,
  Skeleton,
  SkeletonText,
  Spinner,
  buttonVariants,
} from "@fastgram/ui";
import { editorHref } from "@/components/editor/ContentEditor";
import Link from "next/link";
import { ApiErrorState } from "./ApiErrorState";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { isApiRequestError } from "@/lib/api/errors";
import {
  CONTENT_STATUS_COPY,
  CONTENT_TYPE_COPY,
  fileKind,
  useContentItem,
  type LibraryContent,
} from "@/lib/library/content";

export interface ContentDetailProps {
  readonly contentId: string;
}

/**
 * El detalle de una pieza · `GET /content/:id` (§9.3), DATA-008.
 *
 * Mismos cuatro estados que la grid, y uno más que sólo existe acá: el **404**.
 * §9.2 hace indistinguibles "no existe" y "es de otro workspace" —los dos son
 * 404 con el mismo mensaje— así que la pantalla no puede decir cuál de los dos
 * es, y no lo intenta. Eso no es una limitación: es el requisito.
 *
 * Una pieza en `BUILDING` no tiene archivos todavía. El hook sigue preguntando
 * cada 10 s (ADR-014) y la pantalla pasa sola a `CREATED` sin que nadie
 * recargue — que es, literalmente, el producto funcionando.
 */
export function ContentDetail({ contentId }: ContentDetailProps) {
  const query = useContentItem(contentId);

  const back = (
    <Link href={ROUTES.library} className="fgw-detail__back fg-focusable">
      ← {tw("library.backToLibrary")}
    </Link>
  );

  if (query.isPending) {
    return (
      <div className="fgw-detail" aria-busy="true">
        {back}
        <Skeleton className="fgw-detail__media" />
        <SkeletonText lines={2} />
      </div>
    );
  }

  if (query.isError) {
    const notFound = isApiRequestError(query.error) && query.error.code === "not_found";
    return (
      <div className="fgw-detail">
        {back}
        {notFound ? (
          <EmptyState bordered title={tw("library.detail.notFound")} />
        ) : (
          <ApiErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="fgw-detail">
      <div className="flex items-center justify-between gap-3">
        {back}
        {query.data.status !== "FAILED" && (
          <Link
            href={editorHref(contentId)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            {tw("library.detail.edit")}
          </Link>
        )}
      </div>
      <ContentBody item={query.data} />
    </div>
  );
}

function ContentBody({ item }: { readonly item: LibraryContent }) {
  const isBuilding = item.status === "BUILDING";

  return (
    <>
      <div className="fgw-detail__meta">
        <Badge
          tone={item.status === "FAILED" ? "danger" : isBuilding ? "warning" : "success"}
        >
          {tw(CONTENT_STATUS_COPY[item.status])}
        </Badge>
        <Badge tone="neutral">{tw(CONTENT_TYPE_COPY[item.type])}</Badge>
        <span className="fgw-detail__revision">
          {tw("library.detail.revision", { revision: item.revision })}
        </span>
      </div>

      {/* El bloque que se mueve solo. `aria-live` porque el cambio de
          `BUILDING` a `CREATED` no lo dispara ninguna acción del usuario. */}
      <div className="fgw-detail__media" aria-live="polite" aria-busy={isBuilding}>
        {isBuilding ? (
          <div className="fgw-detail__building">
            <Spinner aria-hidden />
            <p className="fgw-detail__building-title">{tw("library.building")}</p>
            <p className="fgw-detail__building-hint">{tw("library.buildingHint")}</p>
          </div>
        ) : item.files.length === 0 ? (
          <p className="fgw-detail__empty">{tw("library.detail.noFiles")}</p>
        ) : (
          <ul className="fgw-detail__files">
            {item.files.map((file, index) => (
              <li key={file} className="fgw-detail__file">
                {/* Sin `next/image`: los dominios de los archivos no están
                    declarados y esta tarea no sabe cuáles son. */}
                {fileKind(file, item.type) === "video" ? (
                  <video src={file} controls preload="metadata" />
                ) : (
                  <img src={file} alt="" loading="lazy" />
                )}
                <a
                  href={file}
                  className="fgw-detail__file-link fg-focusable"
                  target="_blank"
                  rel="noreferrer"
                >
                  {tw("library.detail.openFile", { index: index + 1 })}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Card padding="md">
        <h2 className="fgw-detail__section">{tw("library.detail.caption")}</h2>
        <p className="fgw-detail__caption">
          {item.generatedText === undefined || item.generatedText === null
            ? tw("library.detail.noCaption")
            : item.generatedText}
        </p>
        {item.remixSourceUrl !== undefined && item.remixSourceUrl !== null && (
          <p className="fgw-detail__remix">
            {tw("library.detail.remixSource")}{" "}
            <a
              href={item.remixSourceUrl}
              className="fg-focusable"
              target="_blank"
              rel="noreferrer"
            >
              {item.remixSourceUrl}
            </a>
          </p>
        )}
      </Card>
    </>
  );
}
