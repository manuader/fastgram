/**
 * Extractores de perfiles sociales **sin login** — `PU-SCRAPE-001`,
 * `PU-SCRAPE-002`, PRD `FR-011`, `D-13`.
 *
 * Se importan como `@fastgram/adapters/social-readers` (el `exports` del
 * paquete publica `./*`), no desde la raíz: así el índice de `adapters` no
 * cambia y nadie paga por ellos si no los monta.
 *
 * | Plataforma | Adaptador | Herramienta | Tier |
 * |---|---|---|---|
 * | Instagram | {@link InstagramBusinessDiscoveryReader} | Graph API oficial (Facebook Login) | B |
 * | Instagram | {@link InstagramVisionReader} | instaloader anónimo en `services/vision` | C |
 * | TikTok | {@link TikTokDtkReader} | contenedor Evil0ctal v5.1.1 | C |
 * | X | {@link XFxTwitterReader} | api.fxtwitter.com | C |
 *
 * Todo lo que devuelven es **dato de un tercero**: el sintetizador lo contiene
 * (§9.14, `P1-BRAND-019`); ninguno lo interpreta.
 */
export { BundleSocialReader, type Bundle, type BundleOutcome } from "./bundle-reader.js";
export { handleFrom, type ScrapedPlatform } from "./handles.js";
export type { SocialFetch } from "./http.js";
export {
  InstagramVisionReader,
  INSTAGRAM_FIRST_PAGE,
  parseInstagramProfileResponse,
  type InstagramVisionReaderConfig,
} from "./instagram-vision-reader.js";
export {
  InstagramBusinessDiscoveryReader,
  businessDiscoveryFields,
  parseBusinessDiscovery,
  type BusinessDiscoveryCredentials,
  type InstagramBusinessDiscoveryReaderConfig,
} from "./instagram-business-discovery-reader.js";
export {
  TikTokDtkReader,
  TIKTOK_MAX_PAGE,
  parseTikTokAuthor,
  parseTikTokPosts,
  type TikTokDtkReaderConfig,
} from "./tiktok-dtk-reader.js";
export {
  XFxTwitterReader,
  parseFxStatuses,
  parseFxUser,
  type XFxTwitterReaderConfig,
} from "./x-fxtwitter-reader.js";
export { LadderSocialReader } from "./ladder-reader.js";
