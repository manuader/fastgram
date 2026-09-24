/**
 * Baja las fuentes que `FR-051` exige — `P2-RENDER-008`, bloqueo #1 de
 * `P2-RENDER-015`.
 *
 * ## Bajar no es activar
 *
 * Consigue los 32 archivos de las 10 familias OFL, con su licencia y su
 * procedencia. Que el motor de texto los encuentre **por nombre** es otro paso:
 * lo hace `../src/render/fontActivation.ts` al arrancar el servicio, sólo para
 * ese proceso y sin instalar nada (CoreText por proceso en macOS —con
 * `NODE_OPTIONS=--experimental-ffi`—, un `fonts.conf` propio en Linux).
 *
 * Hasta el 2026-09-23 este comentario decía que hacía falta instalarlas en el
 * sistema porque `fontfile` se ignora y `FONTCONFIG_FILE` no alcanza. Lo
 * primero es cierto; lo segundo sólo en macOS, y por una razón que no se había
 * visto: el Pango de sharp en macOS no tiene backend fontconfig. Ver la
 * cabecera de `fontActivation.ts` con los números.
 *
 * ## Por qué un script y no archivos en el repo
 *
 * Los 42 archivos de fuente no están en ningún lado, y **sin ellos no se
 * renderiza nada**: sin `RENDER_FONT_DIR` poblado, el cargador marca toda
 * fuente como no disponible y, con `RENDER_FONT_STRICT=true` (el default), cada
 * build muere con `font_unavailable` — pieza fallada y save reembolsado.
 *
 * Meterlos en git resolvería eso y abriría otras dos preguntas que no son de
 * ingeniería: cuánto pesa el historial y cómo se cumple la atribución de la
 * OFL. Un script con procedencia registrada es auditable, reproducible y no
 * decide ninguna de las dos por nadie.
 *
 * ## El registro es la única fuente de verdad
 *
 * Este archivo **importa** `FONT_REGISTRY` en vez de copiar la lista. Una copia
 * se desincronizaría en silencio: el día que alguien agregue un peso, el
 * servicio lo exigiría y el script no lo bajaría, y el síntoma sería
 * `font_unavailable` para una familia que «ya está descargada».
 *
 * ## El user-agent decide el formato, y hay una trampa
 *
 * `fonts.googleapis.com/css2` elige el formato según el `User-Agent`. Pango y
 * FreeType leen ttf, y `fontFileName()` del registro pide exactamente
 * `<familia>-<peso>.ttf`.
 *
 * **Medido el 2026-09-22, porque la intuición estaba mal.** El primer intento
 * usó `Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)` razonando que «un UA
 * viejo da ttf». La API lo tomó al pie de la letra y devolvió **EOT** —el
 * formato de Internet Explorer 6— por una URL `/l/font?kit=…` sin extensión y
 * con `content-type: text/html`. El archivo pesaba 130 KB y parecía una fuente.
 *
 * Lo atrapó la comprobación de bytes mágicos: la firma era `04fe0100`, que es
 * el **tamaño del archivo en little-endian** — la cabecera de un EOT. Sin esa
 * comprobación habrían quedado 32 archivos en disco, el script habría salido en
 * verde, y el fallo habría aparecido mucho más tarde como un `font_unavailable`
 * de una familia «ya descargada».
 *
 * `Mozilla/4.0` a secas sí devuelve ttf (`00010000`). Verificado también con
 * `Mozilla/5.0` y `curl/8.0`: lo que dispara EOT es anunciarse como MSIE.
 *
 * ## Lo que NO baja, y falla diciéndolo
 *
 * Desde el 2026-09-24 ninguna: `tiktok` es TikTok Sans y `snapchat` es Inter (sustituto
 * elegido por el dueño). Si una familia volviera a quedar `unresolved`, vale lo de abajo:
 * el PRD la nombra y **no hay archivo distribuible que se pueda nombrar sin
 * inventarlo**. El script la saltea y termina con código 1 si se le pidieron,
 * en vez de dejar 37 de 42 archivos y salir en verde — que se vería idéntico a
 * un éxito hasta el primer build con esa familia.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FONT_FAMILIES,
  FONT_REGISTRY,
  fontFileName,
  type FontFamily,
} from "../src/domain/fonts.js";

/**
 * UA que devuelve ttf. **No lo cambies por uno «más realista» de MSIE**: eso
 * hace que la API sirva EOT. Ver el encabezado.
 */
const UA_TTF = "Mozilla/4.0";
const CSS_API = "https://fonts.googleapis.com/css2";
const OFL_RAW = "https://raw.githubusercontent.com/google/fonts/main/ofl";

/** Los cuatro primeros bytes de un TrueType/OpenType válido. */
const FIRMAS_TTF = new Set(["00010000", "74727565", "74746366", "4f54544f"]);

interface Descarga {
  readonly family: FontFamily;
  readonly weight: number;
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

function salir(mensaje: string): never {
  process.stderr.write(`✗ ${mensaje}\n`);
  process.exit(1);
}

async function pedir(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`${url} → HTTP ${String(res.status)}`);
  return res;
}

/** Nombre del directorio de la familia en `google/fonts`: minúsculas, sin espacios. */
function carpetaOfl(pangoFamily: string): string {
  return pangoFamily.toLowerCase().replace(/\s+/gu, "");
}

/** Resuelve la URL del ttf de un peso concreto leyendo el CSS que devuelve la API. */
async function urlDelTtf(pangoFamily: string, weight: number): Promise<string> {
  const familia = encodeURIComponent(pangoFamily).replace(/%20/gu, "+");
  const css = await (
    await pedir(`${CSS_API}?family=${familia}:wght@${String(weight)}`, {
      "User-Agent": UA_TTF,
    })
  ).text();

  // Se acepta cualquier URL y **el formato lo decide la firma del archivo**, no
  // la extensión: la rama EOT de la API devuelve una URL sin extensión y sería
  // indistinguible de un acierto si acá se exigiera `.ttf`.
  const match = /url\((https:\/\/[^)]+)\)/u.exec(css);
  if (match?.[1] === undefined) {
    // Pasa cuando la familia no publica ese peso: la API responde 200 con un
    // CSS que no tiene `src`. Es un error del registro, no de la red.
    throw new Error(
      `la API no devolvió un ttf para "${pangoFamily}" peso ${String(weight)}. ` +
        "¿El registro pide un peso que esa familia no publica?",
    );
  }
  return match[1];
}

async function bajarFuente(
  family: FontFamily,
  weight: number,
  destino: string,
): Promise<Descarga> {
  const spec = FONT_REGISTRY[family];
  if (spec.pangoFamily === null) throw new Error(`"${family}" no tiene familia Pango`);

  const url = await urlDelTtf(spec.pangoFamily, weight);
  const bytes = new Uint8Array(await (await pedir(url)).arrayBuffer());

  // **Sin esto, una página de error escrita a disco pasaría por fuente.** El
  // cargador la rechazaría después, en un build, con un mensaje que no dice
  // que el archivo está mal bajado.
  const firma = Buffer.from(bytes.subarray(0, 4)).toString("hex");
  if (!FIRMAS_TTF.has(firma)) {
    throw new Error(`${url} no es un ttf (empieza con 0x${firma})`);
  }

  const file = fontFileName(family, weight);
  await writeFile(path.join(destino, file), bytes);
  return {
    family,
    weight,
    file,
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

async function bajarLicencia(family: FontFamily, destino: string): Promise<void> {
  const spec = FONT_REGISTRY[family];
  if (spec.pangoFamily === null) return;
  // La OFL exige que la licencia acompañe a la fuente. Va una por familia,
  // con el nombre de la familia, porque son textos distintos: cada una lleva
  // su propio Copyright Holder y su Reserved Font Name.
  const texto = await (
    await pedir(`${OFL_RAW}/${carpetaOfl(spec.pangoFamily)}/OFL.txt`)
  ).text();
  await writeFile(path.join(destino, `LICENCIA-${family}.txt`), texto);
}

const destino = process.argv[2] ?? process.env["RENDER_FONT_DIR"];
if (destino === undefined || destino === "") {
  salir(
    "falta el directorio.  uso: pnpm fonts:fetch <dir>   (o RENDER_FONT_DIR=<dir>)\n" +
      "  Es el mismo que lee el servicio: sin él, cada build muere con `font_unavailable`.",
  );
}

await mkdir(destino, { recursive: true });

const sinLicencia = FONT_FAMILIES.filter((f) => FONT_REGISTRY[f].pangoFamily === null);
const bajables = FONT_FAMILIES.filter((f) => FONT_REGISTRY[f].pangoFamily !== null);

const descargas: Descarga[] = [];
const fallos: string[] = [];

for (const family of bajables) {
  try {
    await bajarLicencia(family, destino);
  } catch (error: unknown) {
    fallos.push(`licencia de ${family}: ${String(error)}`);
  }
  for (const weight of FONT_REGISTRY[family].weights) {
    try {
      const d = await bajarFuente(family, weight, destino);
      descargas.push(d);
      process.stdout.write(
        `  ok  ${d.file.padEnd(22)} ${String(d.bytes).padStart(7)} B\n`,
      );
    } catch (error: unknown) {
      fallos.push(`${fontFileName(family, weight)}: ${String(error)}`);
    }
  }
}

await writeFile(
  path.join(destino, "PROVENANCE.json"),
  `${JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      note:
        "Generado por services/render/scripts/fetch-fonts.mts. El sha256 permite " +
        "detectar que Google Fonts publicó una versión nueva de una familia: " +
        "la URL lleva la versión (v31, v40…) y cambia sin aviso.",
      files: descargas,
      unresolved: sinLicencia,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`\n${String(descargas.length)} archivos en ${destino}\n`);

if (fallos.length > 0) {
  process.stderr.write(`\n✗ ${String(fallos.length)} fallo(s):\n`);
  for (const f of fallos) process.stderr.write(`  · ${f}\n`);
  process.exit(1);
}

if (sinLicencia.length > 0) {
  // No es un aviso decorativo: con estas familias faltando, un build que las
  // pida falla y reembolsa. Que el script salga en 1 es lo que impide leer
  // "32 archivos" como "listo".
  process.stderr.write(
    `\n✗ ${String(sinLicencia.length)} familia(s) SIN archivo distribuible: ` +
      `${sinLicencia.join(", ")}\n` +
      "  El PRD las nombra y no hay fuente libre equivalente: es una decisión de\n" +
      "  licencia, de una persona. Hasta entonces, un build que las pida va a\n" +
      "  fallar con `font_unavailable` y reembolsar el save.\n" +
      "  Salida sin código: `fonts.json` puede mapear esa familia a otro nombre Pango.\n",
  );
  process.exit(1);
}
