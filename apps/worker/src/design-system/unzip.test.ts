import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { listZipEntries, openDesignSystemZip } from "./unzip.js";

/** Busca todas las firmas de 4 bytes (little endian) en el buffer. */
function offsetsOf(buf: Uint8Array, signature: number): number[] {
  const out: number[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (view.getUint32(i, true) === signature) out.push(i);
  }
  return out;
}

describe("abrir el zip de un design system", () => {
  it("extrae lo planificado, decodifica texto y hashea", () => {
    const zip = zipSync({
      "FOCUS/readme.md": strToU8("# FOCUS\n"),
      "FOCUS/tokens/colors.css": strToU8(":root{--a:#FF00FF;}"),
      "FOCUS/scraps/p1.png": new Uint8Array([1, 2, 3]),
      "FOCUS/_ds_bundle.js": strToU8("alert(1)"),
    });
    const opened = openDesignSystemZip(zip);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.entries.map((e) => e.path).sort()).toEqual([
      "readme.md",
      "tokens/colors.css",
    ]);
    expect(opened.entries.find((e) => e.path === "readme.md")?.text).toBe("# FOCUS\n");
    expect(opened.entries.every((e) => /^[0-9a-f]{64}$/u.test(e.sha256))).toBe(true);
    expect(opened.skipped).toBe(2);
  });

  it("no es un zip → not_a_zip", () => {
    expect(openDesignSystemZip(strToU8("hola, no soy un zip"))).toMatchObject({
      ok: false,
      code: "not_a_zip",
    });
  });

  it("path traversal en el directorio central → unsafe_path, sin inflar nada", () => {
    const zip = zipSync({
      "readme.md": strToU8("# x"),
      "../../etc/evil.css": strToU8("x"),
    });
    expect(openDesignSystemZip(zip)).toMatchObject({ ok: false, code: "unsafe_path" });
  });

  it("bomba real: 50 MB de ceros comprimidos a ~50 KB → zip_bomb", () => {
    const zeros = new Uint8Array(50 * 1024 * 1024);
    const zip = zipSync(
      { "readme.md": strToU8("# x"), "assets/imagery/bomb.jpg": zeros },
      { level: 9 },
    );
    expect(zip.byteLength).toBeLessThan(200 * 1024);
    expect(openDesignSystemZip(zip)).toMatchObject({ ok: false, code: "zip_bomb" });
  });

  it("un zip que miente el tamaño inflado no escribe más de lo declarado", () => {
    // 2 MB de ceros que declaran 1 000 bytes: la salida queda acotada a 1 000.
    const zip = zipSync(
      { "assets/imagery/liar.jpg": new Uint8Array(2 * 1024 * 1024) },
      { level: 9 },
    );
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Tamaño sin comprimir: +22 en el header local, +24 en el central.
    for (const at of offsetsOf(zip, 0x04034b50)) view.setUint32(at + 22, 1_000, true);
    for (const at of offsetsOf(zip, 0x02014b50)) view.setUint32(at + 24, 1_000, true);
    expect(listZipEntries(zip)?.[0]?.uncompressedSize).toBe(1_000);
    const opened = openDesignSystemZip(zip);
    // Lo que se infló no pasa de lo declarado (fflate no agranda el buffer).
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.files.get("assets/imagery/liar.jpg")?.byteLength).toBe(1_000);
    }
  });
});
