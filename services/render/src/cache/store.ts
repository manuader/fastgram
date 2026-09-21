/**
 * `P2-RENDER-010` — Cache de artefactos direccionada por contenido.
 *
 * El servicio es SIN ESTADO: esta cache es un acelerador local, no una fuente
 * de verdad. Puede estar vacía, puede borrarse entera, y el render tiene que
 * dar el mismo resultado igual. Por eso no hay índice ni metadatos: la clave ES
 * el nombre del archivo.
 *
 * La escritura es atómica (archivo temporal + `rename`) porque hay varios
 * workers sobre el mismo volumen y un lector no puede encontrarse con un MP4 a
 * medio escribir.
 */
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface CacheEntry {
  readonly key: string;
  readonly path: string;
  readonly bytes: number;
}

export interface CacheStore {
  pathFor(key: string, extension: string): string;
  get(key: string, extension: string): Promise<CacheEntry | null>;
  /** Mueve `sourcePath` dentro de la cache. Devuelve la entrada final. */
  adopt(key: string, extension: string, sourcePath: string): Promise<CacheEntry>;
  putBuffer(key: string, extension: string, data: Buffer): Promise<CacheEntry>;
}

export class FileCacheStore implements CacheStore {
  constructor(private readonly rootDir: string) {}

  pathFor(key: string, extension: string): string {
    // Dos niveles de shard: 65 536 directorios, ninguno con millones de entradas.
    const a = key.slice(0, 2);
    const b = key.slice(2, 4);
    return path.join(this.rootDir, a, b, `${key}.${extension}`);
  }

  async get(key: string, extension: string): Promise<CacheEntry | null> {
    const target = this.pathFor(key, extension);
    if (!existsSync(target)) return null;
    const stats = await stat(target);
    // Un archivo de 0 bytes en la cache es basura de una corrida interrumpida.
    if (stats.size <= 0) return null;
    return { key, path: target, bytes: stats.size };
  }

  async adopt(key: string, extension: string, sourcePath: string): Promise<CacheEntry> {
    const target = this.pathFor(key, extension);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(sourcePath, target);
    const stats = await stat(target);
    return { key, path: target, bytes: stats.size };
  }

  async putBuffer(key: string, extension: string, data: Buffer): Promise<CacheEntry> {
    const target = this.pathFor(key, extension);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, target);
    return { key, path: target, bytes: data.byteLength };
  }
}

/** Cache que nunca acierta. Sirve para tests y para desactivarla por configuración. */
export class NullCacheStore implements CacheStore {
  constructor(private readonly rootDir: string) {}

  pathFor(key: string, extension: string): string {
    return path.join(this.rootDir, `${key}.${extension}`);
  }

  async get(_key: string, _extension: string): Promise<CacheEntry | null> {
    return null;
  }

  async adopt(key: string, _extension: string, sourcePath: string): Promise<CacheEntry> {
    const stats = await stat(sourcePath);
    return { key, path: sourcePath, bytes: stats.size };
  }

  async putBuffer(key: string, extension: string, data: Buffer): Promise<CacheEntry> {
    const target = this.pathFor(key, extension);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    return { key, path: target, bytes: data.byteLength };
  }
}
