/**
 * Un MP4 mínimo para los tests: `ftyp` + `moov{mvhd, trak{tkhd}}` + `mdat`
 * con relleno. Sólo lo que `probeMp4` lee (ISO/IEC 14496-12: `mvhd` versión 0
 * con `timescale`/`duration` en los bytes 12–19 del contenido; `tkhd` con
 * ancho y alto 16.16 en sus últimos 8 bytes). No es un video reproducible.
 */
function box(type: string, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + content.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(content, 8);
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export function mp4Fixture(opts: {
  readonly seconds: number;
  readonly width: number;
  readonly height: number;
  /** Bytes de `mdat`, para llegar a un tamaño. Default 1024. */
  readonly padding?: number;
}): Uint8Array {
  const timescale = 1000;
  const mvhd = new Uint8Array(100);
  const mv = new DataView(mvhd.buffer);
  mv.setUint32(12, timescale);
  mv.setUint32(16, Math.round(opts.seconds * timescale));

  // Pista de audio primero (ancho/alto en cero), después la de video.
  const audioTkhd = new Uint8Array(84);
  const videoTkhd = new Uint8Array(84);
  const tv = new DataView(videoTkhd.buffer);
  tv.setUint32(76, opts.width * 65536);
  tv.setUint32(80, opts.height * 65536);

  return concat(
    box("ftyp", new TextEncoder().encode("isom\0\0\0\0isomiso2mp41")),
    box(
      "moov",
      concat(
        box("mvhd", mvhd),
        box("trak", box("tkhd", audioTkhd)),
        box("trak", box("tkhd", videoTkhd)),
      ),
    ),
    box("mdat", new Uint8Array(opts.padding ?? 1024).fill(7)),
  );
}
