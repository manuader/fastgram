/**
 * Duración y tamaño de un MP4 leyendo sus cajas, sin FFmpeg — para validar un
 * Short **antes** de gastar una subida de la cuota diaria (`PU-LATER-001`).
 *
 * El worker ya pasa ancho y alto del render (`PublishMedia.width/height`, el
 * `canvas` del payload de build), pero la duración no se guarda en ningún
 * lado: el render la conoce y no la persiste. Como el publicador de YouTube
 * igual baja los bytes para subirlos, se lee de ahí.
 *
 * Qué se lee (ISO/IEC 14496-12, la estructura de cajas de ISO BMFF):
 *  - `moov/mvhd`: `timescale` y `duration` (versión 0: 32 bits; versión 1:
 *    64 bits) → segundos.
 *  - `moov/trak/tkhd`: ancho y alto en punto fijo 16.16 (los últimos 8 bytes
 *    de la caja). Las pistas de audio los tienen en cero; se toma la primera
 *    con los dos distintos de cero.
 *
 * Lo que **no** hace: aplicar la matriz de rotación de `tkhd` (un video de
 * celular girado por metadata). Los renders de FastGram salen de FFmpeg sin
 * rotación; un archivo con rotación se mediría con el ancho y alto crudos. Un
 * MP4 fragmentado con `mvhd.duration = 0` da duración `null` (no se sabe), y
 * quien llama decide.
 */

export interface Mp4Probe {
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

interface Box {
  readonly type: string;
  /** Inicio del contenido (después del encabezado). */
  readonly start: number;
  /** Fin exclusivo de la caja. */
  readonly end: number;
}

function* boxes(view: DataView, from: number, to: number): Generator<Box> {
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) return;
      const big = view.getBigUint64(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) return;
    yield { type, start: offset + header, end: offset + size };
    offset += size;
  }
}

function find(view: DataView, parent: { start: number; end: number }, type: string) {
  for (const b of boxes(view, parent.start, parent.end)) if (b.type === type) return b;
  return undefined;
}

export function probeMp4(bytes: Uint8Array): Mp4Probe {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const none: Mp4Probe = { durationSeconds: null, width: null, height: null };
  try {
    const moov = find(view, { start: 0, end: bytes.byteLength }, "moov");
    if (moov === undefined) return none;

    let durationSeconds: number | null = null;
    const mvhd = find(view, moov, "mvhd");
    if (mvhd !== undefined && mvhd.end - mvhd.start >= 20) {
      const version = view.getUint8(mvhd.start);
      let timescale: number;
      let duration: number;
      if (version === 1) {
        if (mvhd.end - mvhd.start < 32) return none;
        timescale = view.getUint32(mvhd.start + 20);
        duration = Number(view.getBigUint64(mvhd.start + 24));
      } else {
        timescale = view.getUint32(mvhd.start + 12);
        duration = view.getUint32(mvhd.start + 16);
      }
      if (timescale > 0 && duration > 0 && duration !== 0xffffffff) {
        durationSeconds = duration / timescale;
      }
    }

    let width: number | null = null;
    let height: number | null = null;
    for (const trak of boxes(view, moov.start, moov.end)) {
      if (trak.type !== "trak") continue;
      const tkhd = find(view, trak, "tkhd");
      if (tkhd === undefined || tkhd.end - tkhd.start < 8) continue;
      const w = view.getUint32(tkhd.end - 8) / 65536;
      const h = view.getUint32(tkhd.end - 4) / 65536;
      if (w > 0 && h > 0) {
        width = Math.round(w);
        height = Math.round(h);
        break;
      }
    }
    return { durationSeconds, width, height };
  } catch {
    // Un archivo truncado o que no es MP4: no se sabe nada.
    return none;
  }
}
