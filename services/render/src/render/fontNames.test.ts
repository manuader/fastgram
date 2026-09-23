/**
 * La familia se lee del archivo. Los casos son los dos esquemas que publica
 * Google Fonts para pesos estáticos (medidos en los archivos reales el
 * 2026-09-23): con `nameID 16` (Montserrat) y sin él (Poppins).
 *
 * Las fuentes no se versionan, así que el `.ttf` se arma acá: una tabla
 * `name` alcanza, que es lo único que el lector mira.
 */
import { describe, expect, it } from "vitest";
import { readFontNames } from "./fontNames.js";

interface Rec {
  readonly platformId: number;
  readonly encodingId: number;
  readonly languageId: number;
  readonly nameId: number;
  readonly value: string;
}

function utf16be(value: string): Buffer {
  const out = Buffer.alloc(value.length * 2);
  for (let i = 0; i < value.length; i += 1) out.writeUInt16BE(value.charCodeAt(i), i * 2);
  return out;
}

function sfntWithNames(records: readonly Rec[]): Buffer {
  const strings = records.map((r) =>
    r.platformId === 1 ? Buffer.from(r.value, "latin1") : utf16be(r.value),
  );
  const nameHeader = Buffer.alloc(6 + records.length * 12);
  nameHeader.writeUInt16BE(0, 0);
  nameHeader.writeUInt16BE(records.length, 2);
  nameHeader.writeUInt16BE(nameHeader.length, 4);
  let offset = 0;
  records.forEach((r, i) => {
    const at = 6 + i * 12;
    nameHeader.writeUInt16BE(r.platformId, at);
    nameHeader.writeUInt16BE(r.encodingId, at + 2);
    nameHeader.writeUInt16BE(r.languageId, at + 4);
    nameHeader.writeUInt16BE(r.nameId, at + 6);
    nameHeader.writeUInt16BE(strings[i]?.length ?? 0, at + 8);
    nameHeader.writeUInt16BE(offset, at + 10);
    offset += strings[i]?.length ?? 0;
  });
  const nameTable = Buffer.concat([nameHeader, ...strings]);

  const header = Buffer.alloc(12 + 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4);
  header.write("name", 12, "latin1");
  header.writeUInt32BE(0, 16);
  header.writeUInt32BE(header.length, 20);
  header.writeUInt32BE(nameTable.length, 24);
  return Buffer.concat([header, nameTable]);
}

const win = (nameId: number, value: string): Rec => ({
  platformId: 3,
  encodingId: 1,
  languageId: 0x409,
  nameId,
  value,
});

describe("readFontNames", () => {
  it("con nameID 16 la familia es la tipográfica (Montserrat 600)", () => {
    const font = sfntWithNames([
      win(1, "Montserrat SemiBold"),
      win(2, "Regular"),
      win(16, "Montserrat"),
      win(17, "SemiBold"),
    ]);
    expect(readFontNames(font)).toEqual({
      family: "Montserrat",
      legacyFamily: "Montserrat SemiBold",
    });
  });

  it("sin nameID 16 el peso es OTRA familia (Poppins 600)", () => {
    const font = sfntWithNames([win(1, "Poppins SemiBold"), win(2, "Regular")]);
    expect(readFontNames(font)?.family).toBe("Poppins SemiBold");
  });

  it("prefiere Windows/en-US sobre Mac Roman", () => {
    const font = sfntWithNames([
      { platformId: 1, encodingId: 0, languageId: 0, nameId: 1, value: "Mac Name" },
      win(1, "Anton"),
    ]);
    expect(readFontNames(font)?.family).toBe("Anton");
  });

  it("un archivo que no es una fuente da null, no lanza", () => {
    expect(readFontNames(Buffer.from("no soy una fuente, soy un html"))).toBeNull();
    expect(readFontNames(Buffer.alloc(0))).toBeNull();
  });
});
