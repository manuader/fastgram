/**
 * Puerto `IntegrationStore` — credenciales de las apps de desarrollador
 * (client id / secret de Meta, TikTok y X). `PU-PUB-002`,
 * `docs/PLAN-USO-PERSONAL.md` §9.
 *
 * Mismo patrón que `ModelRegistry` (`model-registry.ts`): es de la
 * **instalación**, no de una marca — la misma app de Meta sirve a todas las
 * cuentas del dueño —, y vive en un archivo local fuera del repo
 * (`${FASTGRAM_HOME:-~/.fastgram}/integrations.json`, `0600`).
 *
 * Este puerto devuelve el secret en claro porque el intercambio del `code` lo
 * necesita. **Nunca cruza hacia afuera**: la API lo reemplaza por `hasSecret`
 * y los últimos cuatro (`packages/core/src/connections/integrations.ts`).
 *
 * Una entrada por plataforma y no una por «app de Meta»: Instagram con
 * Instagram Login y Threads tienen **su propio** app id y secret en el panel
 * de la app de Meta (Instagram: *"Your app's Instagram App ID"*,
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login ;
 * Threads: *"Threads App ID"* en *App settings > Basic*,
 * https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions ),
 * distintos del App ID de Facebook Login.
 */
import type { OAuthPlatform } from "./oauth.js";

export interface IntegrationAppConfig {
  readonly clientId: string;
  /** En claro. Ausente = todavía no se cargó. */
  readonly clientSecret?: string;
  /** ISO-8601. La pone el adaptador al escribir. */
  readonly updatedAt?: string;
  /**
   * Pedir también los scopes **opcionales** de la plataforma
   * (`OAuthPlatformSpec.optionalScopes`). Hoy sólo LinkedIn los tiene: los de
   * Páginas (`w_organization_social`, `r_organization_admin`) sólo existen si
   * la app tiene aprobado el producto Community Management API, y pedirlos sin
   * tenerlo hace fallar el login entero. Ausente = `false`.
   */
  readonly optionalScopes?: boolean;
}

export interface IntegrationsSnapshot {
  readonly apps: Readonly<Partial<Record<OAuthPlatform, IntegrationAppConfig>>>;
}

export interface IntegrationStore {
  /**
   * Un archivo que no existe es `{ apps: {} }`. Uno que no parsea es
   * `provider_contract_violation` y **no se pisa** (puede tener secretos que
   * el usuario no tiene en otro lado).
   */
  read(): Promise<IntegrationsSnapshot>;
  /** Reemplaza la entrada de una plataforma; `null` la borra. Atómico. */
  write(platform: OAuthPlatform, config: IntegrationAppConfig | null): Promise<void>;
}
