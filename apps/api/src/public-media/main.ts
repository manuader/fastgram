/**
 * Proceso de media pública — `PU-RUN-005`. Lo arranca `pnpm start --tunnel`
 * (`scripts/start.mjs`) y el túnel de Cloudflare apunta **sólo** acá.
 *
 * Escucha en 127.0.0.1: desde la red local no se llega; desde internet, sólo a
 * través del túnel. Ver `handler.ts` para qué sirve y por qué es un proceso
 * aparte de la API.
 *
 * Entorno: `S3_*` (los mismos que la API), `PUBLIC_MEDIA_PORT` (default 3003),
 * `FASTGRAM_HOME` (donde está `secret.key`).
 */

import { createServer } from "node:http";
import { z } from "zod";
import {
  S3PublicMediaSource,
  deriveSigningKey,
  loadOrCreateSecretKey,
} from "@fastgram/adapters/public-media";
import { createPublicMediaHandler } from "./handler.js";
import { createOAuthCallbackProxy, isOAuthCallbackPath } from "./oauth-callback-proxy.js";

const envSchema = z.object({
  PUBLIC_MEDIA_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  /** La web local, destino del único reenvío: el callback de OAuth. */
  WEB_ORIGIN: z.string().url().default("http://127.0.0.1:3000"),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  process.stderr.write(`public-media: entorno inválido o incompleto: ${names}\n`);
  process.exit(1);
}
const env = parsed.data;

const signingKey = deriveSigningKey(await loadOrCreateSecretKey(process.env));
const source = new S3PublicMediaSource({
  bucket: env.S3_BUCKET,
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

const handler = createPublicMediaHandler({
  source,
  signingKey,
  log: (line) => process.stdout.write(`${line}\n`),
});

const oauthCallback = createOAuthCallbackProxy({
  webOrigin: env.WEB_ORIGIN,
  log: (line) => process.stdout.write(`${line}\n`),
});

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://public-media.invalid").pathname;
  if (isOAuthCallbackPath(path)) {
    void oauthCallback(req, res);
    return;
  }
  void handler(req, res);
});
// Un cliente que abre y no pide nada no tiene que retener un socket para siempre.
server.headersTimeout = 15_000;
server.requestTimeout = 0; // un video grande por un túnel lento puede tardar
server.keepAliveTimeout = 5_000;

server.listen(env.PUBLIC_MEDIA_PORT, "127.0.0.1", () => {
  process.stdout.write(`public-media arriba en 127.0.0.1:${env.PUBLIC_MEDIA_PORT}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
