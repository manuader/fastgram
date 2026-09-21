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
  content: (filters?: QueryParams) => ["content", filters ?? {}] as const,
  contentItem: (contentId: string) => ["content", contentId] as const,
  media: (filters?: QueryParams) => ["media", filters ?? {}] as const,
  influencers: () => ["influencers"] as const,
  influencer: (influencerId: string) => ["influencers", influencerId] as const,
  connections: () => ["connections"] as const,
  warmedAccounts: () => ["warmed-accounts"] as const,
  homeKpis: () => ["home", "kpis"] as const,
} as const;
