/**
 * `@fastgram/adapters/ads` — sprint 9 (R). Adaptadores de `AdsPlatform`:
 * la Marketing API de Meta y el doble en memoria.
 *
 * Se importa por subpath (como `@fastgram/adapters/metrics`) para no tocar el
 * índice del paquete.
 */
export {
  MetaAdsPlatform,
  META_ADS_DEFAULT_GRAPH_VERSION,
  isMetaAdsError,
  type MetaAdsConfig,
} from "./meta/meta-ads-platform.js";
export { classifyAdsError, regainSecondsOf } from "./meta/meta-ads-errors.js";
export {
  metaAdsAuthorizeUrl,
  exchangeMetaAdsCode,
  META_ADS_SCOPES,
} from "./meta/meta-ads-oauth.js";
export {
  FakeAdsPlatform,
  FAKE_AD_ACCOUNT,
  FAKE_AD_PAGE,
  type FakeAdObject,
  type FakeAdsCall,
  type FakeAdsMethod,
} from "./fake/fake-ads-platform.js";
