/**
 * `NFR-014` / `ERR-P11` — ¿El archivo tiene el `moov` adelante?
 *
 * El puerto `MediaRenderer` pide `MediaProbe.isFastStart`, y **ffprobe no lo
 * dice**: ni `-show_format` ni `-show_streams` traen la posición del `moov`.
 * La única forma de saberlo sin parsear el `-v trace` de ffmpeg —salida de
 * diagnóstico, no contrato— es mirar el orden de los átomos de primer nivel, que
 * es exactamente lo que hace `+faststart` al mover el `moov` al principio.
 *
 * Verificado con ffmpeg 9.0.1 el 2026-09-22:
 *
 *     real.mov  (sin faststart) → ftyp, wide, mdat, moov
 *     plain.mp4 (sin faststart) → ftyp, free, mdat, moov
 *     fast.mp4  (con faststart) → ftyp, moov, free, mdat
 *
 * Se leen sólo las cabeceras de 8/16 bytes de cada átomo y se saltea el
 * contenido: un MP4 de 50 MB se resuelve con un puñado de lecturas, sin cargar
 * el archivo en memoria.
 *
 * ── Qué se responde para lo que no es ISOBMFF ────────────────────────────────
 * `false`. No es "no sé" disfrazado: el puerto define `false` como «el archivo
 * necesita `faststart` para streaming progresivo», y un WebM o un MOV con
 * ProRes van a pasar igual por `normalize`, que los remuxea a MP4 con
 * `+faststart`. Decir `true` para un contenedor donde el concepto no existe
 * sería decirle al llamador que no hace falta normalizar.
 */
import { open } from "node:fs/promises";

/** Tamaño que un átomo declara cuando el real viene en 64 bits, detrás del tipo. */
const LARGE_SIZE_MARKER = 1;
/** Cabecera mínima: 4 bytes de tamaño + 4 de tipo. */
const HEADER_BYTES = 8;
/** Con `largesize` la cabecera son 16. */
const LARGE_HEADER_BYTES = 16;
/**
 * Tope de átomos de primer nivel. Un archivo sano tiene menos de diez; esto está
 * para que un archivo adversario con miles de átomos de 8 bytes no convierta un
 * probe en un bucle largo.
 */
const MAX_TOP_LEVEL_ATOMS = 64;

/** Los átomos de primer nivel, en orden. Vacío si el archivo no es ISOBMFF. */
export async function readTopLevelAtoms(path: string): Promise<readonly string[]> {
  const handle = await open(path, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(LARGE_HEADER_BYTES);
    const atoms: string[] = [];
    let offset = 0;

    while (offset + HEADER_BYTES <= fileSize && atoms.length < MAX_TOP_LEVEL_ATOMS) {
      const { bytesRead } = await handle.read(header, 0, LARGE_HEADER_BYTES, offset);
      if (bytesRead < HEADER_BYTES) break;

      const declared = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      // Los tipos de átomo son cuatro caracteres imprimibles. Si no lo son, esto
      // no es ISOBMFF y seguir leyendo sería inventar estructura.
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      atoms.push(type);

      let atomSize: number;
      if (declared === LARGE_SIZE_MARKER) {
        if (bytesRead < LARGE_HEADER_BYTES) break;
        // `readBigUInt64BE` y no `readUInt32BE(12)`: un `mdat` puede pasar los
        // 4 GB y el tamaño quedaría partido al medio.
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
        atomSize = Number(large);
      } else if (declared === 0) {
        // 0 = "hasta el final del archivo". Es el último átomo por definición,
        // y ya quedó anotado arriba: no hay nada más que recorrer.
        break;
      } else {
        atomSize = declared;
      }

      if (atomSize < HEADER_BYTES) break; // tamaño imposible: no se avanza, se corta.
      offset += atomSize;
    }
    return atoms;
  } finally {
    await handle.close();
  }
}

/**
 * `true` si el `moov` aparece antes que el `mdat`. Un archivo sin `mdat` (por
 * ejemplo sólo metadatos) con `moov` cuenta como faststart: no hay media que
 * quede adelante.
 */
export function atomsAreFastStart(atoms: readonly string[]): boolean {
  const moov = atoms.indexOf("moov");
  if (moov === -1) return false;
  const mdat = atoms.indexOf("mdat");
  return mdat === -1 || moov < mdat;
}

export async function isFastStart(path: string): Promise<boolean> {
  return atomsAreFastStart(await readTopLevelAtoms(path));
}
