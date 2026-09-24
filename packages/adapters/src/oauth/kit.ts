/**
 * Todo lo que el OAuth necesita de la máquina local, armado de una vez —
 * para `apps/api` (rutas de conexión) y `apps/worker` (el publisher, vía
 * `resolveAccessToken` / `createConnectionTokens` de `@fastgram/core`).
 *
 * Lee `FASTGRAM_HOME` del entorno que recibe: la clave (`secret.key`) y las
 * credenciales (`integrations.json`) viven ahí. Y `PUBLISH_LINKEDIN_VERSION`
 * (la `LinkedIn-Version` de las APIs versionadas, la misma que usa el
 * publicador), si `config` no trae una.
 */
import type { IntegrationStore, OAuthClient, OAuthPlatform } from "@fastgram/ports";

import {
  LocalKeyring,
  LocalStateSigner,
  LocalTokenCipher,
  localKeyPath,
} from "../crypto/local-keyring.js";
import {
  FileIntegrationStore,
  integrationsPath,
} from "../integrations/file-integration-store.js";
import { createOAuthClients, type OAuthClientsConfig } from "./index.js";

export interface LocalOAuthKit {
  readonly cipher: LocalTokenCipher;
  readonly signer: LocalStateSigner;
  readonly integrations: IntegrationStore;
  readonly clients: Readonly<Record<OAuthPlatform, OAuthClient>>;
}

export function createLocalOAuthKit(
  env: Readonly<Record<string, string | undefined>>,
  config: OAuthClientsConfig = {},
): LocalOAuthKit {
  const keyring = new LocalKeyring({ path: localKeyPath(env) });
  const linkedinVersion = config.linkedinVersion ?? linkedinVersionFrom(env);
  return {
    cipher: new LocalTokenCipher(keyring),
    signer: new LocalStateSigner(keyring),
    integrations: new FileIntegrationStore({ path: integrationsPath(env) }),
    clients: createOAuthClients(
      linkedinVersion === undefined ? config : { ...config, linkedinVersion },
    ),
  };
}

function linkedinVersionFrom(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const v = env["PUBLISH_LINKEDIN_VERSION"]?.trim();
  return v === undefined || !/^\d{6}$/.test(v) ? undefined : v;
}
