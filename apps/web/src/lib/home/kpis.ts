"use client";

/**
 * KPIs del Home · FR-030 (PRD:1034).
 *
 * **Un hueco del contrato, dicho en voz alta.** El PRD pide cinco tiles:
 * `Engaged Leads`, `Content Posted`, `Total Views`, `Total Likes`,
 * `Total Comments`. La API v1 (`packages/contracts`, PRD §9.3) **no tiene un
 * endpoint de agregados**. Lo que sí tiene es `GET /posts`, y `postSchema` trae
 * `views`, `likes` y `comments` por post. Así que cuatro de los cinco se pueden
 * calcular en el cliente sumando la primera página de posts publicados.
 *
 * Dos consecuencias que no hay que barrer bajo la alfombra:
 *
 * 1. **El número es parcial.** `limit` máximo del contrato = 100 (PRD:2345).
 *    Con más de 100 posts publicados, el total se queda corto. El criterio de
 *    aceptación de FR-030 ("los 5 KPI coinciden con la suma de posts
 *    publicados del workspace") **no se cumple** con esto. Hace falta un
 *    endpoint de agregados; `partial` lo señala para que la UI lo diga.
 * 2. **`Engaged Leads` no se puede calcular.** Es de Engagement (Reddit leads),
 *    que no está en la superficie v1. Se devuelve `null`, no un cero: un cero
 *    es un dato y esto es la ausencia de uno.
 */
import { PAGINATION_LIMIT_MAX, postSchema, type Post } from "@fastgram/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiList } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { queryKeys } from "../api/keys";

export interface HomeKpis {
  /** `null` = no hay endpoint que lo responda, no "cero". */
  readonly engagedLeads: number | null;
  readonly contentPosted: number;
  readonly totalViews: number;
  readonly totalLikes: number;
  readonly totalComments: number;
  /** `true` si hay más posts de los que cupieron en una página. */
  readonly partial: boolean;
}

function aggregate(posts: readonly Post[], hasMore: boolean): HomeKpis {
  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  for (const post of posts) {
    totalViews += post.views;
    totalLikes += post.likes;
    totalComments += post.comments;
  }
  return {
    engagedLeads: null,
    contentPosted: posts.length,
    totalViews,
    totalLikes,
    totalComments,
    partial: hasMore,
  };
}

export function useHomeKpis(): UseQueryResult<HomeKpis, ApiRequestError> {
  return useQuery<HomeKpis, ApiRequestError>({
    queryKey: queryKeys.homeKpis(),
    queryFn: async ({ signal }) => {
      const page = await apiList<Post>("/posts", {
        signal,
        itemSchema: postSchema,
        limit: PAGINATION_LIMIT_MAX,
        query: { status: "POSTED" },
      });
      return aggregate(page.items, page.hasMore);
    },
  });
}
