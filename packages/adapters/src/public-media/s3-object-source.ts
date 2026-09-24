/**
 * Lectura por rangos del bucket, para el servidor de media pública.
 *
 * No es un puerto: el puerto `Storage` no tiene lectura parcial (§9.8 no la
 * pide) y agregarla ahí la obligaría en cada adaptador. Es una pieza chica que
 * sólo usa `apps/api/src/public-media`, que necesita `Range` porque Instagram
 * y TikTok pueden pedir un video por pedazos.
 *
 * Los errores del SDK no salen de acá tal cual: `null` si no existe, y un
 * `PortError` neutral para el resto.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { PortError } from "@fastgram/ports";
import type { S3StorageConfig } from "../storage/s3-storage.js";

const SOURCE = "PublicMediaSource/s3";

export interface PublicMediaObjectInfo {
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly etag?: string;
  readonly lastModified?: Date;
}

/** Rango inclusivo, ya validado contra el tamaño. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

export interface PublicMediaObjectSource {
  head(objectKey: string): Promise<PublicMediaObjectInfo | null>;
  /** Sin `range`, el objeto entero. */
  read(objectKey: string, range?: ByteRange): Promise<AsyncIterable<Uint8Array>>;
}

type SourceConfig = Pick<
  S3StorageConfig,
  "bucket" | "endpoint" | "region" | "accessKeyId" | "secretAccessKey" | "forcePathStyle"
> & { readonly client?: S3Client };

export class S3PublicMediaSource implements PublicMediaObjectSource {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: SourceConfig) {
    this.#bucket = config.bucket;
    const clientConfig: S3ClientConfig = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.forcePathStyle === undefined
        ? {}
        : { forcePathStyle: config.forcePathStyle }),
    };
    this.#client = config.client ?? new S3Client(clientConfig);
  }

  async head(objectKey: string): Promise<PublicMediaObjectInfo | null> {
    try {
      const r = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
      );
      return {
        sizeBytes: r.ContentLength ?? 0,
        contentType: r.ContentType ?? "application/octet-stream",
        ...(r.ETag === undefined ? {} : { etag: r.ETag }),
        ...(r.LastModified === undefined ? {} : { lastModified: r.LastModified }),
      };
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw new PortError("provider_unavailable", "Object storage is unavailable", {
        source: SOURCE,
        cause: error,
      });
    }
  }

  async read(objectKey: string, range?: ByteRange): Promise<AsyncIterable<Uint8Array>> {
    try {
      const r = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          ...(range === undefined ? {} : { Range: `bytes=${range.start}-${range.end}` }),
        }),
      );
      const body: unknown = r.Body;
      if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
        return body as AsyncIterable<Uint8Array>;
      }
      throw new PortError(
        "provider_contract_violation",
        "The object storage returned a body this adapter cannot read",
        { source: SOURCE },
      );
    } catch (error: unknown) {
      if (error instanceof PortError) throw error;
      if (isNotFound(error)) {
        throw new PortError("not_found", "Object not found", {
          source: SOURCE,
          cause: error,
        });
      }
      throw new PortError("provider_unavailable", "Object storage is unavailable", {
        source: SOURCE,
        cause: error,
      });
    }
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  if (e === null || typeof e !== "object") return false;
  const names = new Set(["NotFound", "NoSuchKey", "NoSuchBucket"]);
  if (e.name !== undefined && names.has(e.name)) return true;
  if (e.Code !== undefined && names.has(e.Code)) return true;
  return e.$metadata?.httpStatusCode === 404;
}
