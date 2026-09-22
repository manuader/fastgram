# 2026-09-22 — Segunda tanda de cuatro agentes: lo que nunca había funcionado

Cuatro tandas más, en directorios disjuntos: `packages/db`, `apps/web`,
`services/render`, `apps/api`. Lo que sigue son las seis cosas que costaron
tiempo y no se deducen del código.

El hilo que las une: **esta tanda encontró cosas que nunca habían funcionado, y
ninguna daba síntoma.** No son regresiones. Son cosas que estaban rotas desde el
día que se escribieron, tapadas por un test que medía otra cosa o por un camino
que nadie recorría.

## 1 · Los tests de cross-tenant medían RLS, no el código

Lo encontró el agente de `packages/db` rompiendo su propio trabajo: quitó el
`eq(companyId)` de tres repositorios y **la suite siguió verde**.

La razón es que IMPL §2.4 tiene dos capas —RLS en Postgres y el `WHERE` del
repositorio— y los tests corren con `withCompany(..., { role: APP_ROLE })`. Con
el GUC puesto, la capa 1 tapa el agujero y la capa 2 **nunca se mide**.

Avisó que sospechaba del resto del paquete. Tenía razón, y era mío:

```
### lockContent SIN el filtro de companyId:
      Tests  146 passed (146)
```

El arreglo es un test que corre **como superusuario, sin `SET ROLE` y sin GUC**,
donde lo único que aísla es el `WHERE`. Con ése puesto y el `WHERE` roto, rojo.

**La lección general:** una defensa en profundidad hace que cada capa sea difícil
de testear por separado, porque la otra la tapa. Si las dos capas están activas
en el test, el test mide *que alguna funcione*, no las dos.

## 2 · Dos bugs de `normalize` que se cancelaban entre sí

`P2-RENDER-013` decía, desde hacía tandas, *"MOV→MP4 y faststart escritos pero
nunca corridos sobre un archivo real"*. Al correrlo aparecieron dos:

1. `isMp4Compatible` daba `true` para un `.mov`.
2. `needsRemux` daba `true` siempre.

Uno decía "ya está bien" y el otro "hay que convertir". **En el único caso que
alguien miró, el resultado era correcto.**

La causa del primero, verificada contra ffmpeg:

```
.mov → format_name=mov,mp4,m4a,3gp,3g2,mj2   major_brand=qt
.mp4 → format_name=mov,mp4,m4a,3gp,3g2,mj2   major_brand=isom
```

MOV y MP4 **comparten demuxer**: ffprobe emite la misma lista para los dos y el
discriminador real es `major_brand`. El test unitario pasaba porque fabricaba
`["mov","quicktime"]`, **una lista que ffprobe no emite jamás**.

Esa es la forma más cara de tener un bug: un doble que devuelve algo que el
sistema real no produce. El test no mide el mundo; mide la idea que el autor
tenía del mundo.

## 3 · Ninguna pantalla había arrancado nunca en desarrollo

`pnpm --filter @fastgram/web dev` moría con `Module not found: Can't resolve
'./cn.js'`. El `extensionAlias` de `next.config.ts` **sólo lo lee webpack** y el
script `dev` corre `next dev --turbopack`.

No era de una pantalla: el `layout.tsx` raíz importa `@fastgram/ui`, así que
morían **todas**. `next build` va por webpack y estaba verde — por eso nadie lo
vio en tres tandas de CI.

**El arreglo fue de raíz y no del script.** `packages/ui` dejó de escribir la
extensión en sus imports internos, y podía hacerlo porque su `package.json`
apunta `main` y `types` a `./src/index.ts`: **no tiene `dist` y nadie lo corre
por Node**, así que esas extensiones no le servían a ningún consumidor. Con
imports sin extensión los resuelven los dos bundlers, y el parche de webpack se
borró entero.

`packages/contracts` **sí** las conserva y tiene que conservarlas: tiene `dist` y
lo consume `apps/api` por Node ESM. La diferencia no es de estilo, es de quién
ejecuta el archivo.

## 4 · CI llevaba tandas en rojo, y yo reportaba verde

`pnpm format:check` fallaba sobre 14 archivos desde el commit de los 16
endpoints, y CI lo corre en su línea 32. No lo vi porque **`pnpm verify` no lo
incluía**: lint, typecheck, boundaries, consistency y test.

Lo arreglé metiéndolo en `verify`, y lo primero que marcó fue peor:

```
[error] .github/workflows/ci.yml: SyntaxError: Nested mappings are not allowed
        in compact mappings (159:15)
> 159 |       - name: los dos binarios: la API escribe y encola, el worker consume
```

Un `:` sin comillas en un escalar de YAML **parte la clave y el workflow entero
deja de parsear**. Lo escribí yo en `daa4d0f`, dos tandas atrás. O sea que CI no
estaba "rojo por formato": no era un workflow válido.

**La lección:** un chequeo que sólo corre en CI es un chequeo que se descubre
roto tarde y de a muchos archivos. Y si además lo primero que encuentra es que
CI no parsea, nadie lo iba a ver nunca.

De paso, `.prettierignore` no excluía los `.venv` de Python, así que
`prettier --check .` traía decenas de archivos de `site-packages`. Una lista de
warnings que siempre trae los mismos ajenos enseña a ignorar la lista entera.

## 5 · La prueba del bucket no corría en ningún lado

`pnpm test:int` daba `126 passed | 11 skipped` para `apps/api` **aunque las
variables estuvieran exportadas**: turbo no propaga variables arbitrarias a las
tareas. La suite de MinIO se salteaba sola diciendo el motivo en el nombre del
describe —que es lo correcto— pero eso pasa desapercibido entre 137 casos.

Y el job `integration` de CI corre exactamente ese comando. O sea: la única
prueba que ejercita el `PUT` real contra el bucket **no corría en ningún lado**
salvo cuando alguien invocaba el paquete con `--filter`.

`DATABASE_URL` parecía funcionar, y funcionaba por casualidad: los fixtures
tienen un default hardcodeado. Las `S3_*` no tienen default y no pueden tenerlo.

## 6 · El contrato estaba mal y dos capas lo parcheaban

`contentSchema.thumbnailUrl` era obligatorio, y `apps/api` **omite el campo**
cuando la columna es null — o sea en **toda** pieza en `BUILDING`. Validar con el
contrato convertía cada build en curso en un `invalid_response`.

`apps/api` lo resolvía con un `Omit<Content, "thumbnailUrl">` y una nota en la
cabecera. `apps/web` tuvo que poner un schema local para poder pintar la Library.
**Dos parches del mismo lado equivocado.**

Lo que hizo que se cerrara fue un test del agente de `apps/web` que decía
explícitamente *"el día que el contrato se corrija, ese test se pone rojo y este
`extend` se borra"*. Se puso rojo (`expected true to be false`) en el minuto en
que toqué el contrato.

**Eso es lo que hay que copiar**: cuando hay que poner un parche porque el
arreglo está en otro paquete, el parche viene con un test que avisa cuándo
sacarlo. Si no, el parche sobrevive al problema.

## Qué quedó montado sin adaptador real, y por qué

Tres handlers del worker corren con los puertos cableados a nada: `content-build`
con el renderer de memoria, `publishing` con un mapa de publicadores **vacío**, e
`influencer-pipeline` sin generador.

El criterio es el mismo en los tres y conviene dejarlo escrito porque va a
volver: **entre no registrar el handler y registrarlo sin proveedor, gana
registrarlo** — siempre que lo que escriba sea verdad.

- No registrarlo deja la fila esperando para siempre **sin que nada falle**, que
  es el peor modo de falla de este sistema.
- Registrarlo con un doble que **miente** es peor todavía: un post marcado
  `POSTED` con un permalink inventado no se distingue de uno real hasta que
  alguien lo busca.
- Registrarlo con el proveedor ausente y **fallar con un motivo honesto** le dice
  al usuario que eso no está disponible, y le devuelve lo que le cobramos.

Por eso el renderer de memoria sí se monta (un artefacto sintético se nota) y el
publicador de memoria no.
