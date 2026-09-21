#!/usr/bin/env node
/**
 * Consistencia entre paquetes — un chequeo que ningún paquete puede hacer solo.
 *
 * El PRD fija números y enumeraciones que terminan escritos en más de un lugar:
 * el cap de 20 slides vive en `contracts` (validación de entrada), en `core`
 * (invariante de dominio) y a veces en `db` (constraint). Cada uno lo escribe
 * quien construye ese paquete, y nadie ve los tres a la vez.
 *
 * Si divergen, el síntoma es horrible de diagnosticar: la API acepta 25 slides,
 * el dominio los rechaza, y el usuario ve un error genérico en una operación
 * que el contrato decía soportar.
 *
 * Esto compara los valores donde están escritos. Es a propósito **tonto y
 * explícito**: extrae por nombre y **falla si no encuentra** la constante, en
 * vez de pasar en silencio. Un chequeo que puede no encontrar nada y decir que
 * todo está bien es peor que no tenerlo.
 *
 * Correr: `node scripts/check-consistency.mjs`
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const problemas = [];
const verificados = [];

function leer(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    problemas.push(`no existe el archivo ${rel}`);
    return null;
  }
}

/** Extrae `NOMBRE = 123` o `nombre: 123`. Falla si no lo encuentra. */
function numero(rel, nombre) {
  const src = leer(rel);
  if (src === null) return null;
  const m =
    src.match(new RegExp(`\\b${nombre}\\s*[=:]\\s*(\\d[\\d_]*)`)) ??
    src.match(new RegExp(`\\b${nombre}\\b[^\\n]*?(\\d[\\d_]*)`));
  if (!m) {
    problemas.push(`no encontré \`${nombre}\` en ${rel} — ¿lo renombraron?`);
    return null;
  }
  return Number(m[1].replace(/_/g, ""));
}

/** Extrae los literales de un array `NOMBRE = ["a", "b"]`. */
function literales(rel, nombre) {
  const src = leer(rel);
  if (src === null) return null;
  const m = src.match(new RegExp(`\\b${nombre}\\s*=\\s*(?:z\\.enum\\()?\\[([^\\]]+)\\]`));
  if (!m) {
    problemas.push(`no encontré la lista \`${nombre}\` en ${rel} — ¿la renombraron?`);
    return null;
  }
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function mismoNumero(etiqueta, fuentes) {
  const valores = fuentes.map(([rel, nombre]) => ({
    rel,
    nombre,
    valor: numero(rel, nombre),
  }));
  if (valores.some((v) => v.valor === null)) return;
  const distintos = [...new Set(valores.map((v) => v.valor))];
  if (distintos.length > 1) {
    problemas.push(
      `${etiqueta} difiere entre paquetes:\n` +
        valores.map((v) => `      ${v.rel} · ${v.nombre} = ${v.valor}`).join("\n"),
    );
  } else {
    verificados.push(`${etiqueta} = ${distintos[0]} (${valores.length} lugares)`);
  }
}

function mismaLista(etiqueta, fuentes) {
  const valores = fuentes.map(([rel, nombre]) => ({
    rel,
    nombre,
    valor: literales(rel, nombre),
  }));
  if (valores.some((v) => v.valor === null)) return;
  const canon = valores.map((v) => JSON.stringify([...v.valor].sort()));
  if (new Set(canon).size > 1) {
    problemas.push(
      `${etiqueta} difiere entre paquetes:\n` +
        valores
          .map((v) => `      ${v.rel} · ${v.nombre} = ${v.valor.join(", ")}`)
          .join("\n"),
    );
  } else {
    verificados.push(`${etiqueta} = [${valores[0].valor.join(", ")}]`);
  }
}

// ── Lo que se compara ──────────────────────────────────────────────────────
// Agregá una entrada cada vez que un número del PRD quede escrito en dos
// paquetes. Es más barato que descubrir la divergencia en producción.

mismaLista("estados de Content (PRD DATA-008)", [
  ["packages/db/src/schema/enums.ts", "CONTENT_STATUS"],
  ["packages/contracts/src/primitives/enums.ts", "contentStatusSchema"],
]);

mismoNumero("content angles por workspace (PRD FR-056)", [
  ["packages/core/src/quota/plans.ts", "contentAngles"],
]);

mismoNumero("influencers activos por workspace (PRD FR-080)", [
  ["packages/core/src/quota/plans.ts", "activeInfluencers"],
]);

// Los del editor de texto viven en tres paquetes escritos por agentes que no
// se hablaron entre sí: el contrato que valida la entrada, el dominio que
// sostiene la invariante, y el motor que finalmente dibuja. Coinciden hoy;
// nada lo garantizaba.
mismoNumero("slides por slideshow (PRD FR-070) · 3 paquetes", [
  ["packages/core/src/quota/plans.ts", "slidesPerSlideshow"],
  ["packages/contracts/src/resources/content.ts", "SLIDESHOW_MAX_SLIDES"],
  ["services/render/src/domain/payload.ts", "MAX_SLIDES"],
]);

mismoNumero("fontSize mínimo (PRD FR-051)", [
  ["packages/contracts/src/resources/content.ts", "FONT_SIZE_MIN"],
  ["services/render/src/domain/text.ts", "FONT_SIZE_MIN"],
]);

mismoNumero("fontSize máximo (PRD FR-051)", [
  ["packages/contracts/src/resources/content.ts", "FONT_SIZE_MAX"],
  ["services/render/src/domain/text.ts", "FONT_SIZE_MAX"],
]);

mismoNumero("widthPercent mínimo (PRD FR-051)", [
  ["packages/contracts/src/resources/content.ts", "TEXT_WIDTH_PERCENT_MIN"],
  ["services/render/src/domain/text.ts", "WIDTH_PERCENT_MIN"],
]);

mismoNumero("strokeWidth máximo (PRD FR-051)", [
  ["packages/contracts/src/resources/content.ts", "STROKE_WIDTH_MAX"],
  ["services/render/src/domain/text.ts", "STROKE_WIDTH_MAX"],
]);

// El `limit` de la paginación estaba escrito **tres** veces: `contracts` (que
// valida el query param), `db` (que lo aplica) y un tercer módulo en `apps/api`
// que se borró en `P1-DATA-015`. Los tres coincidían por suerte. Lo que hace
// falsa la sensación de seguridad es que el que valida y el que aplica son
// distintos: si `contracts` acepta 200 y `db` clampa a 100, la API responde 100
// filas a una petición de 200 sin decir que recortó nada.
mismoNumero("límite mínimo de paginación (PRD §9.10)", [
  ["packages/contracts/src/primitives/pagination.ts", "PAGINATION_LIMIT_MIN"],
  ["packages/db/src/limits.ts", "limitMin"],
]);

mismoNumero("límite máximo de paginación (PRD §9.10)", [
  ["packages/contracts/src/primitives/pagination.ts", "PAGINATION_LIMIT_MAX"],
  ["packages/db/src/limits.ts", "limitMax"],
]);

mismoNumero("límite por defecto de paginación (PRD §9.10)", [
  ["packages/contracts/src/primitives/pagination.ts", "PAGINATION_LIMIT_DEFAULT"],
  ["packages/db/src/limits.ts", "limitDefault"],
]);

// Las cajas de texto tienen sus rangos como CHECK en la base, como validación
// en el contrato y como aritmética en el motor de render. La base es la que
// falla más tarde y peor: un `widthPercent` que el contrato acepta y el CHECK
// rechaza sale como error de base en medio de un build, no como 400.
mismoNumero("texto de caja, máximo de caracteres (PRD FR-051)", [
  ["packages/contracts/src/resources/content.ts", "TEXT_BOX_MAX_LENGTH"],
  ["packages/db/src/limits.ts", "textMaxChars"],
]);

mismoNumero("widthPercent mínimo, contrato contra base (PRD FR-051)", [
  ["packages/contracts/src/resources/content.ts", "TEXT_WIDTH_PERCENT_MIN"],
  ["packages/db/src/limits.ts", "widthPercentMin"],
]);

mismoNumero("fontSize máximo, contrato contra base (PRD FR-051)", [
  ["packages/contracts/src/resources/content.ts", "FONT_SIZE_MAX"],
  ["packages/db/src/limits.ts", "fontSizeMax"],
]);

mismoNumero("generaciones en vuelo (PRD FR-090)", [
  ["packages/core/src/quota/plans.ts", "inFlightGenerations"],
  ["apps/worker/src/jobs/catalog.ts", "concurrency"],
]);

/**
 * Los nombres de cola: `core` los declara, el catálogo del worker los consume.
 *
 * Es el invariante que este script existe para tener. `core` encolaba en
 * `build-content` y el catálogo escuchaba `content-build`: dos literales
 * plausibles, y el efecto es que el job entra en una cola que nadie lee. El
 * POST devuelve 201, la pieza queda en `BUILDING` y se queda ahí para siempre,
 * sin aparecer en ningún log de errores.
 *
 * Ahora el catálogo referencia `JOB_QUEUES`, así que no pueden divergir por
 * typo — pero sí por alguien que agregue un job al catálogo con un literal
 * suelto. Esto lo detecta.
 */
{
  const registro = leer("packages/core/src/jobs/queues.ts");
  const catalogo = leer("apps/worker/src/jobs/catalog.ts");
  if (registro !== null && catalogo !== null) {
    const declarados = [...registro.matchAll(/^\s{2}(\w+): "([^"]+)",/gm)].map(
      (m) => m[1],
    );
    const usados = [...catalogo.matchAll(/name: JOB_QUEUES\.(\w+),/g)].map((m) => m[1]);
    const literales = [...catalogo.matchAll(/^\s+name: "([^"]+)",/gm)].map((m) => m[1]);

    if (declarados.length === 0) {
      problemas.push(
        "no encontré ningún nombre de cola en `JOB_QUEUES` — ¿cambió la forma?",
      );
    } else if (literales.length > 0) {
      problemas.push(
        `el catálogo del worker escribe ${literales.length} nombre(s) de cola a mano ` +
          `(${literales.join(", ")}): tienen que salir de \`JOB_QUEUES\`, o el productor ` +
          "y el consumidor pueden divergir sin que falle nada",
      );
    } else {
      const huerfanos = usados.filter((k) => !declarados.includes(k));
      if (huerfanos.length > 0) {
        problemas.push(
          `el catálogo usa claves que \`JOB_QUEUES\` no declara: ${huerfanos.join(", ")}`,
        );
      } else {
        verificados.push(
          `nombres de cola (PRD §9.5) = ${declarados.length} declarados, ${usados.length} consumidos por el catálogo`,
        );
      }
    }
  }
}

/**
 * El presupuesto de reintentos del build: lo elige el productor, lo declara el
 * consumidor.
 *
 * `POST /content` encola con `retryLimit`, que son **re**intentos; el catálogo
 * del worker declara `maxAttempts`, que son intentos totales. Uno tiene que ser
 * el otro más uno.
 *
 * Por qué importa y no es cosmética: el handler decide con el **último**
 * intento. Ahí no relanza —cierra la pieza en `FAILED` y devuelve el content
 * save (`FR-050`)—, y lee `maxAttempts` del job, así que si el productor encola
 * con menos reintentos de los que el catálogo promete, el handler nunca llega a
 * su último intento según el catálogo pero la cola ya se rindió: la pieza queda
 * en `BUILDING` para siempre con el save cobrado. Que es exactamente el estado
 * que `P1-QUEUE-008` vino a cerrar.
 */
{
  const ruta = leer("apps/api/src/routes/v1/content.ts");
  const catalogo = leer("apps/worker/src/jobs/catalog.ts");
  if (ruta !== null && catalogo !== null) {
    const retry = /retryLimit:\s*(\d+)/.exec(ruta);
    const attempts = /contentBuild:\s*\{[\s\S]*?maxAttempts:\s*(\d+)/.exec(catalogo);
    if (retry === null || attempts === null) {
      problemas.push(
        "no encontré el `retryLimit` de `POST /content` o el `maxAttempts` de " +
          "`contentBuild` — ¿cambió la forma?",
      );
    } else if (Number(retry[1]) + 1 !== Number(attempts[1])) {
      problemas.push(
        `la ruta encola el build con retryLimit ${retry[1]} (o sea ${Number(retry[1]) + 1} ` +
          `intentos) y el catálogo del worker declara maxAttempts ${attempts[1]}`,
      );
    } else {
      verificados.push(
        `intentos del build de contenido (PRD §9.5.3) = ${attempts[1]}, ` +
          `productor y catálogo de acuerdo`,
      );
    }
  }
}

/**
 * Los alias de `tsconfig.base.json` cubren el especificador **pelado**.
 *
 * Es el chequeo menos obvio del archivo y el que más silenciosamente se rompe.
 * `tsconfig.base.json` existe sólo para que dependency-cruiser resuelva los
 * imports entre paquetes. Desde `P0-REPO-013`, `@fastgram/core` resuelve por
 * `exports` a `dist/index.js` — y `dist` está en el `exclude` del cruise, así
 * que depcruise **deja de ver el grafo del otro paquete**: `core-no-npm`,
 * `ports-no-adapters` y `web-no-db` quedan verdes sin comprobar nada.
 *
 * No se puede detectar con una regla de depcruise, porque la arista excluida no
 * llega a existir. Lo único observable desde adentro es que las dependencias
 * cruzadas caen —pasó: de 1019 a 949— y el chequeo sigue diciendo que todo está
 * bien. Por eso se comprueba la causa: que cada paquete con `exports` a `dist`
 * tenga su alias pelado.
 */
{
  const base = leer("tsconfig.base.json");
  if (base !== null) {
    let paths = {};
    try {
      paths = JSON.parse(base).compilerOptions?.paths ?? {};
    } catch {
      problemas.push("`tsconfig.base.json` no es JSON válido");
    }
    const faltantes = [];
    for (const dir of readdirSync(join(ROOT, "packages"))) {
      const pkgPath = join(ROOT, "packages", dir, "package.json");
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch {
        continue;
      }
      for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
        const dest = typeof target === "string" ? target : (target?.default ?? "");
        if (!dest.includes("/dist/")) continue;
        const spec = sub === "." ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, "")}`;
        if (paths[spec] === undefined) faltantes.push(spec);
      }
    }
    if (faltantes.length > 0) {
      problemas.push(
        `\`tsconfig.base.json\` no tiene alias para: ${faltantes.join(", ")}. ` +
          "Sin eso depcruise resuelve a `dist`, que está excluido del cruise, y las " +
          "reglas de frontera quedan verdes sin mirar nada.",
      );
    } else {
      verificados.push(
        `alias de resolución para depcruise = ${Object.keys(paths).length} entradas, ` +
          "todos los `exports` a `dist` cubiertos",
      );
    }
  }
}

// ── Informe ────────────────────────────────────────────────────────────────
for (const v of verificados) console.log(`  ok  ${v}`);

if (problemas.length > 0) {
  const unicos = [...new Set(problemas)];
  console.error(`\n✗ ${unicos.length} problema(s) de consistencia entre paquetes:\n`);
  for (const p of [...new Set(problemas)]) console.error(`  · ${p}`);
  console.error(
    "\nUn número del PRD escrito en dos lugares con dos valores hace que la API\n" +
      "acepte lo que el dominio rechaza, y el usuario ve un error genérico en una\n" +
      "operación que el contrato decía soportar.\n",
  );
  process.exit(1);
}

console.log(`\n✓ ${verificados.length} invariantes consistentes entre paquetes`);
