/**
 * Montaje de `ads-sync` — sprint 9 (R). Se monta siempre: sin marcas con
 * cuenta publicitaria activa la vuelta no hace nada (una consulta).
 *
 * | Variable | Default | Qué |
 * |---|---|---|
 * | `ADS_META_GRAPH_VERSION` | `v25.0` | versión de la Graph API para la Marketing API |
 *
 * El doble del modo demo vive **por proceso**: el del worker no conoce los
 * objetos que creó la API. Es a propósito tolerante con ids desconocidos
 * (`FakeAdsPlatform`), así que la guardia puede "pausar" una campaña demo y
 * el sync devuelve cero insights (nada gastó).
 */
import { createLocalOAuthKit } from "@fastgram/adapters";
import { FakeAdsPlatform, MetaAdsPlatform } from "@fastgram/adapters/ads";
import type { NotificationDraft } from "@fastgram/core";
import type { Database } from "@fastgram/db";
import type { Clock, JobHandler } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { createAdsSyncHandler } from "./sync-handler.js";

export function mountAdsSync(deps: {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly clock: Clock;
  readonly logger: BuildLogger;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly notify: (companyId: string, draft: NotificationDraft) => Promise<boolean>;
}): JobHandler<unknown> {
  const version = deps.env["ADS_META_GRAPH_VERSION"]?.trim();
  return createAdsSyncHandler({
    db: deps.db,
    appRole: deps.appRole,
    clock: deps.clock,
    logger: deps.logger,
    cipher: createLocalOAuthKit(deps.env).cipher,
    platforms: {
      meta: new MetaAdsPlatform(
        version === undefined || version === "" ? {} : { graphVersion: version },
      ),
      fake: new FakeAdsPlatform(),
    },
    notify: deps.notify,
  });
}
