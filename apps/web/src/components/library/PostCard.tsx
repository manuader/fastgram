"use client";

import { Badge } from "@fastgram/ui";
import { EyeIcon, HeartIcon, MessageCircleIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import {
  formatMetric,
  formatPostDate,
  formatPostTime,
  postNoticeKey,
  POST_PLATFORM_COPY,
  POST_STATUS_COPY,
  POST_STATUS_TONE,
} from "@/lib/library/posts";
import type { Post } from "@fastgram/contracts";

export interface PostCardProps {
  readonly item: Post;
}

/**
 * Una tarjeta de `My Posts` (PRD:1607-1610).
 *
 * ## Lo que no está, y no es un olvido
 *
 * **No hay thumbnail ni badge de tipo.** PRD:1607-1608 los dibuja y
 * `GET /posts` no los sirve: un `Post` lleva `contentId` y ningún dato de la
 * pieza. Sacarlos costaría una petición por post. El porqué completo —y la
 * tabla de qué pide F-120 contra qué existe— está en `lib/library/posts.ts`.
 *
 * **No hay `Reschedule` ni `Cancel` en hover** (PRD:1611). Son mutaciones y
 * hoy el puente del navegador hacia la API es de **sólo lectura**: el route
 * handler de `app/api/fastgram/v1` no exporta `POST` porque no hay anti-CSRF.
 * Un botón que parece cancelar y no cancela es peor que su ausencia.
 *
 * ## La fecha que se enseña depende del estado, no del campo
 *
 * `scheduledAtUtc` está **siempre** —también en un post ya publicado, donde es
 * historia— y `postedAt` sólo cuando salió. Enseñar el programado de un post
 * publicado hace creer que todavía no salió; enseñar los dos es ruido. Así que
 * manda `postedAt` cuando existe.
 */
export function PostCard({ item }: PostCardProps) {
  const noticeKey = postNoticeKey(item);
  const publishedAt = item.postedAt;

  return (
    <li className="fgw-post-card" data-status={item.status}>
      <div className="fgw-post-card__head">
        <Badge className="fgw-post-card__platform" tone={item.platform} size="sm">
          {tw(POST_PLATFORM_COPY[item.platform])}
        </Badge>
        <span className="fgw-post-card__account" title={accountLabel(item)}>
          {accountLabel(item)}
        </span>
      </div>

      <div className="fgw-post-card__state">
        {/* La clase propia no es decorativa: el mismo texto de estado está
            además en los `<option>` del filtro, así que sin una señal que sea
            sólo de la tarjeta, cualquier comprobación de "¿qué estado se ve?"
            encuentra el `<option>` y da verde pase lo que pase. */}
        <Badge
          className="fgw-post-card__status"
          tone={POST_STATUS_TONE[item.status]}
          size="sm"
          dot
        >
          {tw(POST_STATUS_COPY[item.status])}
        </Badge>
        <span className="fgw-post-card__when">
          {publishedAt === undefined
            ? tw("posts.scheduledAt", {
                time: formatPostTime(item.scheduledAtUtc),
                date: formatPostDate(item.scheduledAtUtc),
              })
            : tw("posts.postedAt", { date: formatPostDate(publishedAt) })}
        </span>
      </div>

      {/* `views N · likes N · comments N` con iconos (PRD:1610). Los iconos son
          decorativos: la palabra va en el texto, así que el número nunca queda
          sin nombre para quien no ve el icono. */}
      <ul className="fgw-post-card__metrics">
        <li className="fgw-post-card__metric">
          <EyeIcon size={14} />
          {tw("posts.metric.views", { count: formatMetric(item.views) })}
        </li>
        <li className="fgw-post-card__metric">
          <HeartIcon size={14} />
          {tw("posts.metric.likes", { count: formatMetric(item.likes) })}
        </li>
        <li className="fgw-post-card__metric">
          <MessageCircleIcon size={14} />
          {tw("posts.metric.comments", { count: formatMetric(item.comments) })}
        </li>
      </ul>

      {noticeKey !== null && <p className="fgw-post-card__notice">{tw(noticeKey)}</p>}

      {/* El único texto de servidor que esta shell enseña crudo, y con permiso
          explícito: FR-060 (PRD:1394) dice que `errorMessage` es *"siempre
          seguro de mostrar"* y viene junto a un `errorCode` neutral respecto al
          proveedor. Sin él, un post fallido no dice por qué falló y el usuario
          sólo puede volver a intentarlo a ciegas. */}
      {item.status === "FAILED" && item.errorMessage !== undefined && (
        <p className="fgw-post-card__error">{item.errorMessage}</p>
      )}

      {item.postUrl !== undefined && (
        <a
          className="fgw-post-card__link fg-focusable"
          href={item.postUrl}
          target="_blank"
          // `noopener` sin `noreferrer` sería suficiente para la seguridad, pero
          // el destino es la propia cuenta del usuario en la plataforma: no hay
          // nada que ocultar y sí una estadística que el usuario quiere ver.
          rel="noopener"
        >
          {tw("posts.viewOnPlatform", {
            platform: tw(POST_PLATFORM_COPY[item.platform]),
          })}
        </a>
      )}
    </li>
  );
}

/**
 * Qué cuenta publicó esto.
 *
 * `connectionUsername` sólo lo rellena el camino OAuth; en un post warmed queda
 * nulo a propósito y el username vive en `GET /warmed-accounts` (otra petición,
 * otra tarea). Sin username se dice el **tipo** de cuenta, que es lo que el
 * post sí sabe de sí mismo, en vez de dejar el hueco en blanco — que se lee
 * como "no hay cuenta".
 */
function accountLabel(item: Post): string {
  if (item.connectionUsername !== undefined) return `@${item.connectionUsername}`;
  return tw(
    item.accountType === "warmed" ? "posts.account.warmed" : "posts.account.oauth",
  );
}
