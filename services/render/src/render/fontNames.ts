/**
 * Lee los nombres de familia de un `.ttf`/`.otf` (tabla `name`), para pedirle a
 * Pango la familia **que el archivo declara** y no la que el registro supone.
 *
 * ── Por qué hace falta (medido el 2026-09-23) ────────────────────────────────
 * Google Fonts no publica los pesos estáticos con el mismo esquema de nombres
 * en todas las familias:
 *
 *     montserrat-600.ttf  nameID1 "Montserrat SemiBold"  nameID16 "Montserrat"
 *     poppins-600.ttf     nameID1 "Poppins SemiBold"     (sin nameID16)
 *
 * Con Montserrat, la familia tipográfica es "Montserrat" y el peso se elige
 * dentro de ella. Con Poppins no hay familia tipográfica: el 600 es **otra
 * familia**, "Poppins SemiBold". Pedir "Poppins, Semi-Bold" daba el Bold (700)
 * sintetizando la elección más cercana — distinto del centinela, así que la
 * verificación de siempre lo daba por bueno, con el peso equivocado.
 *
 * Así que la familia sale del archivo: `nameID 16` si está, si no `nameID 1`.
 */

export interface FontNames {
  /** `nameID 16` (familia tipográfica) o, si falta, `nameID 1`. */
  readonly family: string;
  /** `nameID 1` tal cual (la familia «legacy», RIBBI). */
  readonly legacyFamily: string;
}

const TYPOGRAPHIC_FAMILY = 16;
const LEGACY_FAMILY = 1;

interface NameRecord {
  readonly platformId: number;
  readonly languageId: number;
  readonly nameId: number;
  readonly value: string;
}

function decodeUtf16be(bytes: Buffer): string {
  let out = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    out += String.fromCharCode(bytes.readUInt16BE(index));
  }
  return out;
}

function readNameRecords(font: Buffer): NameRecord[] | null {
  if (font.length < 12) return null;
  const numTables = font.readUInt16BE(4);
  for (let table = 0; table < numTables; table += 1) {
    const entry = 12 + table * 16;
    if (entry + 16 > font.length) return null;
    if (font.toString("latin1", entry, entry + 4) !== "name") continue;
    const offset = font.readUInt32BE(entry + 8);
    if (offset + 6 > font.length) return null;
    const count = font.readUInt16BE(offset + 2);
    const stringsStart = offset + font.readUInt16BE(offset + 4);
    const records: NameRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      const record = offset + 6 + index * 12;
      if (record + 12 > font.length) return null;
      const platformId = font.readUInt16BE(record);
      const languageId = font.readUInt16BE(record + 4);
      const nameId = font.readUInt16BE(record + 6);
      const length = font.readUInt16BE(record + 8);
      const start = stringsStart + font.readUInt16BE(record + 10);
      if (start + length > font.length) continue;
      const raw = font.subarray(start, start + length);
      // Plataforma 3 (Windows) y 0 (Unicode) van en UTF-16BE; 1 (Mac) en Mac
      // Roman, que para nombres de familia ASCII coincide con latin1.
      const value = platformId === 1 ? raw.toString("latin1") : decodeUtf16be(raw);
      records.push({ platformId, languageId, nameId, value });
    }
    return records;
  }
  return null;
}

function pick(records: readonly NameRecord[], nameId: number): string | null {
  const candidates = records.filter((r) => r.nameId === nameId && r.value.trim() !== "");
  const preferred =
    candidates.find((r) => r.platformId === 3 && r.languageId === 0x409) ??
    candidates.find((r) => r.platformId === 3) ??
    candidates[0];
  return preferred === undefined ? null : preferred.value.trim();
}

/** `null` si el archivo no es una fuente sfnt legible o no trae `nameID 1`. */
export function readFontNames(font: Buffer): FontNames | null {
  const records = readNameRecords(font);
  if (records === null) return null;
  const legacyFamily = pick(records, LEGACY_FAMILY);
  if (legacyFamily === null) return null;
  return {
    family: pick(records, TYPOGRAPHIC_FAMILY) ?? legacyFamily,
    legacyFamily,
  };
}
