/**
 * Claves de caché de TanStack Query.
 *
 * Centralizadas para que invalidar sea posible: con las claves escritas a mano
 * en cada hook, `invalidateQueries` acaba errando por una letra y el bug —una
 * lista que no se refresca tras crear algo— se manifiesta lejos de la causa.
 */
import type { QueryParams } from "./client";

export const queryKeys = {
  posts: (filters?: QueryParams) => ["posts", filters ?? {}] as const,
  post: (postId: string) => ["posts", postId] as const,
  /**
   * El listado del Calendar (`P2-CAL-001`). Cuelga de `posts` para que
   * invalidar los posts —programar, cancelar— también refresque la vista mes.
   * Clave propia y no `posts({})` porque pide páginas de 100 y la Library de
   * 20: compartir la clave mezclaría en la misma caché páginas de dos tamaños.
   */
  calendarPosts: () => ["posts", "calendar"] as const,
  content: (filters?: QueryParams) => ["content", filters ?? {}] as const,
  contentItem: (contentId: string) => ["content", contentId] as const,
  /** El tipo de cada pieza, para el chip del Calendar (`P2-CAL-002`). */
  calendarContent: () => ["content", "calendar"] as const,
  media: (filters?: QueryParams) => ["media", filters ?? {}] as const,
  blitzPreferences: () => ["blitz", "preferences"] as const,
  influencers: () => ["influencers"] as const,
  influencer: (influencerId: string) => ["influencers", influencerId] as const,
  connections: () => ["connections"] as const,
  warmedAccounts: () => ["warmed-accounts"] as const,
  homeKpis: () => ["home", "kpis"] as const,
  /** `GET /onboarding` — trae las fuentes, así que el alta de una la invalida. */
  onboarding: () => ["onboarding"] as const,
  /**
   * `POST /brand/sources/resolve` por texto. Cuelga de `brand-sources` para que
   * invalidar las fuentes (un alta, un borrado) también olvide los `available`.
   * La pista del chip `Website` es parte de la pregunta: sin ella en la clave,
   * activar el chip sobre un texto ya resuelto serviría el `other_url` viejo.
   */
  brandSourceResolve: (input: string, hint?: string) =>
    ["brand-sources", "resolve", input, hint ?? null] as const,
  /**
   * `GET /brand/sources` en `/brand` (`P1-BRANDPG-002`). Cuelga de
   * `brand-sources` por lo mismo que `brandSourceResolve`: el alta que
   * comparte con el onboarding (`useCreateBrandSource`) invalida ese prefijo, y
   * así la tarjeta ve la fuente nueva sin que el hook del alta sepa de ella.
   */
  brandSources: () => ["brand-sources", "list"] as const,
  /** `GET /brand/profile` (`P1-BRANDPG-001`). */
  brandProfile: () => ["brand", "profile"] as const,
  /**
   * El estado del servicio (`F-255`). No cuelga de ningún recurso del API v1 a
   * propósito: no lleva workspace ni sesión, así que invalidar "todo lo del
   * workspace" no debe tocarlo.
   */
  serviceStatus: () => ["service-status"] as const,
} as const;
