# HANDOFF — FastGram, estado actual

> **Ya hay código.** El monorepo está en pie con las fronteras enforzadas en CI, y hay trabajo
> real en los trece paquetes. El estado exacto, con números, está en §6.
>
> Sigue vigente: el PRD es la fuente de verdad funcional, `tasks.md` es el backlog, y el plan de
> implementación dice cómo.
>
> **Lo que hay que saber antes de tocar nada:** el PRD es la fuente de verdad funcional y está
> construido sobre evidencia etiquetada (CONFIRMED / SUPPORTED / INFERRED / UNKNOWN / EXTENSION).
> No lo trates como un borrador: cada afirmación tiene una fuente. Si le agregás algo, etiquetalo igual.

## 0. Cómo se usa este documento

Si sos un agente que llega: leé **este archivo y el más nuevo de `handoffs/`**. Dos documentos.
Con eso alcanza para saber dónde estamos.

| Dónde | Qué va | Vida |
|---|---|---|
| este general | lo que sigue siendo cierto: arquitectura, reglas, decisiones cerradas, trampas pagadas, §4 | permanente, **acumula** |
| `docs/SESSION-<fecha>-<tema>.md` | el detalle de UNA sesión | permanente, **no se edita después** |
| `handoffs/HANDOFF-<fecha>-<tema>.md` | estado al cerrar: qué queda abierto | efímero, **gitignored** |

Al terminar, tres cosas: (1) escribí tu session doc, (2) dejá tu handoff, (3) **actualizá este
archivo** — entrada nueva en §4 más lo que corresponda en §5, §7 y §9.
**El paso 3 es el que se saltea y el que sostiene todo esto.**

Si encontrás acá un dato que ya no es cierto, **arreglalo**. Un general que se cree y está
equivocado es peor que no tener ninguno.

## 1. Qué es esto

FastGram es un clon funcional de [Fastlane](https://www.usefastlane.ai) (`app.usefastlane.ai`):
una plataforma que convierte una URL —o, en nuestra versión, **un perfil social**— en contenido
short-form generado por IA, lo programa y lo publica en TikTok, Instagram Reels, YouTube Shorts,
LinkedIn y Reddit. Incluye influencers IA persistentes, un motor de descubrimiento con aprobación
por swipe (Blitz), campañas multi-semana, cuentas gestionadas por humanos y una API pública con
servidores MCP.

El stack está **decidido pero no escrito**: TypeScript en monorepo, arquitectura hexagonal,
PostgreSQL como única base, FFmpeg para render, modelos de pesos abiertos para generación.
Todo en `docs/IMPLEMENTATION-PLAN.md` §3, cada decisión con su razón.

## 2. Reglas del repo

- `packages/core` **nunca** importa `packages/adapters` ni un SDK de proveedor. Se enforcea con
  `dependency-cruiser` en CI, no con buena voluntad.
- Todo acceso a datos lleva `companyId`. Cross-tenant devuelve **404**, nunca 403 — para no
  filtrar existencia.
- `strict: true`, sin `any` sin justificar.
- Ningún error crudo de proveedor sale hacia afuera.
- Una tarea de `tasks.md` = un PR, con el ID en el título.
- `handoffs/` está gitignored a propósito. Los session docs y este general **sí** se versionan.
- Nunca un secreto en el repo ni en un doc.

## 3. Arquitectura

Hexagonal. La regla de dependencia es lo único que no se negocia:

```
apps/*  ──→  packages/core  ──→  packages/ports
   │                                   ↑
   └──────→  packages/adapters  ────────┘
```

`core` es dominio puro: entidades, invariantes, casos de uso. Sin frameworks, sin IO.
`ports` son interfaces. `adapters` las implementa. `apps` cablea.

**Por qué acá no es ceremonia:** hay nueve proveedores externos intercambiables y tres de ellos
—el de juicio, el de extracción social y el de render— están marcados como "a validar" o "detrás
de bandera". Sin puertos, validar uno significa tocar el producto entero.

Dos puertos que parecen triviales y no lo son: **`Clock` y `Rng`**. El producto depende de fechas
(lead times, ventanas de publicación, resets a 00:00 UTC) y de muestreo ponderado (`angleWeights`,
`influencerChance`). Sin poder fijarlos, la mitad de las reglas de negocio no se puede testear.

El detalle está en `docs/IMPLEMENTATION-PLAN.md` §2. No lo repito acá para que no se desincronice.

## 4. Qué cambió, sesión por sesión

### Sesión 2026-09-21 — Del PRD al plan ejecutable

Se cerró la investigación del producto original y se construyó todo el andamiaje de
especificación. En orden:

1. **`PRD.md`** — reconstrucción funcional de Fastlane a partir de tres fuentes: el bundle de
   producción de `app.usefastlane.ai` (rutas, enums, copy), la documentación oficial de su API
   (29 endpoints, dos servidores MCP) y los 9 videos de `/docs` analizados frame a frame.
2. **Extensión `EXT-001`** — el alta deja de exigir una página web: puede partir de un perfil de
   Instagram, TikTok, X, YouTube o LinkedIn. Cuatro decisiones de producto cerradas (`D-01`…`D-04`).
3. **`EVAL-JEV.md`** — evaluación de TypeSafe/Jev. Conclusión: encaja en dos huecos reales, pero
   no conviene comprometerse con el proveedor. Lo que sí conviene es declarar la capa.
4. **`EXT-008` + PRD §25** — puerto `Judgment`, siete puntos de decisión (`DP-001`…`DP-007`) y seis
   features (`JV-1`…`JV-6`).
5. **`docs/IMPLEMENTATION-PLAN.md`** y **`tasks.md`** — arquitectura, stack con 15 ADRs, y ~360
   tareas en 6 fases.

Detalle y razones: [`SESSION-2026-09-21-plan-implementacion.md`](SESSION-2026-09-21-plan-implementacion.md).

### Sesión 2026-09-21 (2) — Del plan al código

Se ejecutó el P0 completo y una parte grande de la Fase 1, con **ocho agentes en paralelo** sobre
directorios disjuntos.

**Lo que hizo funcionar el paralelismo** no fue la cantidad de agentes: fue identificar qué es
estado compartido mutable. `pnpm-lock.yaml` y todo `package.json`, `git`, y
`tasks.md`/`PRD.md`/`docs/**`. **Ningún agente los toca**; si le falta una dependencia, la reporta
en vez de instalarla. Resultado: ninguno pisó a otro en toda la sesión.

**El costo de esa regla**, y es una tensión real con el `CLAUDE.md` de este repo: ningún agente
pudo marcar su tarea en `tasks.md` ni escribir su handoff. Los ocho lo señalaron por separado. La
coordinación quedó centralizada en quien orquesta. **Antes de la próxima tanda hay que decidir**:
o los agentes marcan y se acepta el riesgo de colisión en un archivo, o el protocolo dice
explícitamente que en paralelo marca el coordinador.

**Descubrimientos que cambiaron decisiones ya tomadas** — los tres salieron de medir, no de pensar:

1. **El modelo de costos invirtió el orden del plan §5.** Egress y CPU de render eran el #1 y el
   #2; son el #4 y el #6. El driver dominante es la **generación de video en GPU**, por dos
   órdenes de magnitud. Consecuencias en `ADR-006` (premisa refutada), `ADR-013` (Hetzner subió
   +113–173 % y su vCPU es un *thread*), `ADR-009` (el self-host está mucho más lejos) y `OQ-21`
   nueva en el PRD.
2. **La resolución de fuentes por nombre en `sharp` está rota a medias** — trampa 6 de §7. Habría
   salido a producción con la tipografía equivocada en cada pieza.
3. **Los paquetes exportan `.ts` crudo**, así que `pnpm build` pasa y el binario no arranca
   (`P0-REPO-013`).

Detalle, decisiones y lo que se descartó:
[`SESSION-2026-09-21-implementacion.md`](SESSION-2026-09-21-implementacion.md).

## 5. Decisiones que no se vuelven a discutir

Las de producto (`D-01`…`D-05`) están en PRD §2.7 con su razón. Las de arquitectura, en
`IMPLEMENTATION-PLAN.md` §3 como ADR-001…ADR-015. Las cuatro que más se van a querer reabrir:

1. **El signup no pide OAuth** (`D-01`). Razón: el objetivo entero de `EXT-001` es que alguien sin
   web y sin ganas de autorizar nada llegue a Blitz. Si OAuth entra en el paso 1, no queda nada de
   la extensión. La importación de media **se ofrece después** del análisis, nunca antes.
2. **Render con FFmpeg, no Remotion** (`ADR-007`). Razón medida: Remotion es gratis hasta 3
   personas, pero un producto de generación automatizada cae en su licencia *Automators*, que
   cobra **$0,01 por render con mínimo de $100/mes**. A un millón de renders son **$10.000**. El
   render *es* el producto: no puede tener un peaje por unidad.
3. **Imagen con FLUX.1 [schnell], no [dev]** (`ADR-010`). Razón: **schnell es Apache-2.0 y permite
   uso comercial; dev es no-comercial** y exige licencia paga de Black Forest Labs. Un producto que
   vende generación no puede apoyarse en dev sin comprarla.
4. **La cola vive en Postgres** (`ADR-005`). Razón: permite encolar **dentro de la transacción**
   que descuenta la cuota. Si el job se encolara fuera, un fallo entre commit y push deja cuota
   consumida sin trabajo — y el PRD exige que un build fallido reembolse el save, lo que obliga a
   saber con certeza que el job existe.

Y tres que se decidieron al empezar a escribir código:

5. **`packages/core` no puede importar NADA de npm**, sólo `@fastgram/ports`. Es más estricto que
   "no importa adapters", y a propósito: el día que `core` importe una utilidad de fechas, la mitad
   de las reglas de negocio dejan de ser testeables sin fijar esa librería. Para fechas y azar hay
   puertos. Lo enforcea `dependency-cruiser`.
6. **Los 9 videos de referencia quedan fuera de git.** 164 MB, ya exprimidos en el PRD §0.2 con
   timestamps. El repo entero pesa hoy 765 KiB; con los videos serían 165 MB en la historia, para
   siempre, en cada clone. Es un desvío del literal de `P0-REPO-001` y está asumido.
7. **El reset de cuota se calcula en lectura, no con un cron.** Hay un job programado, pero es
   **red, no mecanismo**: si el reset dependiera del cron, la cuota de un cliente dependería de que
   el cron haya corrido. Así depende del reloj, que es lo que el usuario ve.

## 6. Cómo verificar

**Números al 2026-09-21.** Son lo que permite distinguir "lo rompí yo" de "ya estaba rojo".
Si tu corrida da menos, algo se perdió; si da más, actualizá esta sección.

```bash
pnpm install          # pnpm 12. Si falla, ver la trampa 7 de §7
pnpm verify           # lint · typecheck · boundaries · consistency · test
```

`pnpm verify` **tiene que salir en verde**. Lo que corre, en orden:

| Comando | Qué mide | Esperado hoy |
|---|---|---|
| `pnpm lint` | eslint una vez sobre todo el repo | **0 errores** |
| `pnpm typecheck` | `tsc --noEmit` por paquete, 12 tareas | **12 successful** |
| `pnpm boundaries` | las reglas de la arquitectura | **0 errores**, ~3 warnings de huérfanos · 366 módulos |
| `pnpm consistency` | los números del PRD escritos en más de un paquete | **9 invariantes** |
| `pnpm test` | unitarios | **1.226** |

Desglose de `pnpm test`, por si uno solo se cae:

| Paquete | Tests | | Paquete | Tests |
|---|---|---|---|---|
| `core` | 391 | | `ui` | 170 |
| `contracts` | 253 | | `adapters` | 153 |
| `render-service` | 119 | | `api` | 62 |
| `db` | 29 | | `web` | 22 |
| `worker` | 18 | | `config` | 9 |

### Lo que necesita servicios levantados

```bash
docker compose up -d                       # Postgres con pgvector + MinIO con el bucket creado
pnpm test:int                              # db 44 · api 22  → 66
```

Las suites de contrato de `Storage` y `Queue` de `packages/adapters` corren dentro de
`pnpm test` y **se saltean solas indicando el motivo en el nombre del caso** si los servicios
no responden. Si ves `· sin MinIO` en un nombre de test, el compose no está arriba.

### Python

```bash
cd services/vision
uv venv --python 3.12 .venv && uv pip install -e ".[dev]"
.venv/bin/python -m pytest -q              # 19 passed
.venv/bin/python -m ruff check .           # limpio
```

**Arranca sin PaddleOCR a propósito** y lo publica en `GET /health` (`ocr_available`). Con el
motor ausente, todo análisis devuelve `partial`: es lo que manda `AI-016`.

### Estado del backlog

```bash
grep -c '^- \[x\]' tasks.md     # terminadas — hoy: 78
grep -c '^- \[~\]' tasks.md     # en curso o parciales — hoy: 7
grep -c '^- \[!\]' tasks.md     # bloqueadas — hoy: 1
grep -c '^- \[ \]' tasks.md     # pendientes — hoy: 285
```

### Lo que `pnpm verify` NO mide

- **Que el binario compilado arranque.** `pnpm build` pasa y `node dist/main.js` **no funciona**
  (`P0-REPO-013`). Verde en CI y roto en producción.
- **Que algo se vea bien.** Nadie abrió un navegador ni miró un frame renderizado.
- **Calidad de los modelos.** Cero tokens de LLM gastados: los adaptadores se prueban contra
  gateways falsos, lo que verifica el adaptador y no el modelo.

## 7. Trampas que ya pagamos

1. **Los 9 videos de `/docs` son de DOS generaciones distintas del producto.** Ocho son de
   febrero-2026 bajo la marca anterior **"Aftermark"** (`app.aftermark.ai`); sólo
   `7-ai-influencers.mp4` es de mayo-2026 y muestra el Fastlane actual. Si mirás un video viejo y
   asumís que es el producto de hoy, documentás una UI que ya no existe: el sidebar, la Library y
   el Content Studio cambiaron. PRD §0.4 tiene la regla de resolución de conflictos.

2. **`developers.usefastlane.ai` sirve la SPA para cualquier path.** `curl` de `/llms.txt`,
   `/openapi.json` o cualquier ruta devuelve el shell de HTML, no el contenido. La documentación
   sólo se obtiene renderizando la página en un navegador. Costó varios intentos entender que no
   era un 404.

3. **El FFmpeg del entorno de desarrollo no trae el filtro `drawtext`** (build sin libfreetype).
   Cualquier pipeline que lo use falla con `Filter not found` y **0 frames escritos**, sin más
   explicación. Relevante para `P2-RENDER-*`: el overlay de texto no puede asumir `drawtext`
   disponible; verificá el build o componé el texto con sharp antes de pasar a FFmpeg.

4. **Los claims de marketing de Jev no coinciden con su documentación.** La latencia de "70–500 ms"
   **no aparece en los docs**; el múltiplo de costo cambió de 100x a 200x/400x según la fuente; y
   donde el marketing dice "sin alucinaciones", los docs dicen literalmente *"typed output
   guarantees the interface, not truth"*. Además **el modelo es text-only**: no ve imágenes ni
   video, lo que elimina la mitad de los casos de uso obvios en un producto de video. Verificá
   contra `docs.typesafe.ai` antes de repetir cualquier número.

5. **El PRD tiene una contradicción interna heredada de la documentación oficial de Fastlane**
   sobre el rate limit: la sección `Rate limits` dice 60 req/min por workspace y varios endpoints
   dicen 20 req/min. Está registrada como `OQ-05`. No la "resuelvas" eligiendo una al azar:
   implementá **60/min configurable** y dejá el número expuesto.

6. **La resolución de fuentes por nombre en `sharp` está rota — pero a medias.** `sharp` 0.33
   trae su propio libvips con fontconfig sin configuración por defecto. Medido con la sonda
   `"MWiljq1080 Hamburgefonstiv"` a 40px: `__NoSuchFamily__`, `Helvetica`, `Courier` y
   `Montserrat` dan **todas 517x39**. Idénticas. Pero `Comic Sans MS` da 555x44 — o sea que
   **algunas familias sí resuelven**, y eso es lo peligroso: quien spot-chequea con la fuente
   equivocada ve que "anda" y cierra la investigación, y el producto sale con la tipografía
   incorrecta en cada pieza.
   La defensa está implementada en `services/render/src/render/fontLoader.ts`: cargar por archivo
   absoluto y **verificar contra una sonda centinela**. `FONTCONFIG_FILE` con un `fonts.conf`
   propio **no** funciona; ya se probó.

7. **Borrar `node_modules/.modules.yaml` a mano corrompe el lockfile de pnpm.** Deja symlinks
   colgados: `ls -d node_modules/eslint` responde bien y `ls node_modules/eslint/` falla. El
   síntoma es `command not found` de un binario que está "instalado". **No alcanza con
   `pnpm install --force`**: hay que borrar `node_modules` **y** `pnpm-lock.yaml`.

8. **pnpm 12 cambió la clave de los build scripts y edita tu `pnpm-workspace.yaml`.** No es
   `onlyBuiltDependencies` ni va en `package.json`: es **`allowBuilds`, con booleanos, en
   `pnpm-workspace.yaml`**. Y pnpm escribe él mismo un bloque `allowBuilds` con placeholders
   (`set this to true or false`) la primera vez, así que si agregaste el tuyo terminás con una
   clave duplicada — y el error, *"duplicate mapping key"*, no dice que pnpm editó tu archivo.

9. **`minio/minio:latest` ya no existe en Docker Hub.** Falla con *"pull access denied … or may
   require 'docker login'"*, que **parece un problema de credenciales y no lo es**. MinIO publica
   en **quay.io**: `quay.io/minio/minio` y `quay.io/minio/mc`.

10. **`singletonKey` de pg-boss NO deduplica con la política por defecto.** Los índices únicos de
    pg-boss sobre `(name, singleton_key)` están **filtrados por política de cola**, y con la
    política `standard` no hay ninguno. Medido: con `standard`, dos encolados con la misma
    `singletonKey` crean **dos jobs**. Y cambiar a `short` no arregla nada — el índice es sobre
    `COALESCE(singleton_key,'')`, así que **todos los jobs sin clave colapsan a `''`** y sólo
    puede haber uno encolado en toda la cola.
    Usado de forma ingenua, `NFR-004` sería una creencia y `NFR-015` —no duplicar un post de
    TikTok— se rompería el día del primer reintento. La solución implementada: derivar el `id`
    del job como UUID v5 de `(cola, singletonKey)`, con `ON CONFLICT DO NOTHING` sobre la PK.

11. **La URL de subida firmada NO protege el `Content-Type` por defecto.**
    `@aws-sdk/s3-request-presigner` firma `content-length;host` y **deja `content-type` afuera**,
    aunque el comando lo declare. Medido contra MinIO: una reserva hecha para `image/png`
    aceptaba con **200** un PUT con `application/zip`. Con `signableHeaders` incluyendo
    `content-type`, ese mismo PUT da **403**.
    Es el mismo agujero que la validación de extensión de `PRD §9.8` intenta cerrar del otro
    lado: sin esto, un cliente reserva como `.png` y sube HTML.

12. **Un adaptador de `Judgment` sobre un LLM tiene que ordenar las preguntas del lote.** §9.15.1
    promete preguntas **independientes** sobre el mismo estado. Un modelo autorregresivo es
    sensible al orden de las claves del esquema: verificado desactivando el ordenamiento, la
    misma pregunta cambia de respuesta según con qué otras viaje. Sin ordenar por id, la promesa
    de independencia es falsa.

13. **`*/` dentro de un comentario de bloque lo cierra.** Escribir `` `*/upload-url` `` en un
    docstring produce un error de esbuild —*"Expected ';' but found 'POST'"*— apuntando a una
    línea de prosa.

## 8. Qué falta

El backlog real es `tasks.md`. El estado de hoy está en §6.

### Bloqueado por una persona, no por código

Ninguna de estas avanza escribiendo software, y todas tienen plazo largo. **Conviene arrancarlas
ya**, en paralelo con el código.

| Qué | Bloquea | Tarea |
|---|---|---|
| Revisión legal del scraping de perfiles públicos (`OQ-16`) | el tier C del alta social | `P1-BRAND-024` |
| Derechos del catálogo de tendencias (`OQ-13`) | **toda la épica P2-TREND** | `P2-TREND-001` |
| Decisión de licencia del build de FFmpeg | el render | `P0-REPO-004` |
| Estrategia de librerías UGC (`OQ-13`) | P5-LIBR | `P5-LIBR-001/002` |
| **Las 42 fuentes: conseguir los archivos, y decidir qué hacer con `tiktok` y `snapchat`** | el overlay de texto de los 4 formatos | `P2-RENDER-008` |
| **Confirmación escrita de Cloudflare**: si R2 + Workers está permitido hoy para servir video fuera de Enterprise | `ADR-006`, y con él la elección de storage | `P1-INFRA-004` |
| **`OQ-21`**: si el tarifario de créditos se hereda o se recalibra | el margen del producto entero | — |

Sobre las fuentes: **ninguna de las 12 familias está en la máquina** y hacen falta 42 archivos.
Diez son Google Fonts (OFL, distribuibles). `tiktok` y `snapchat` los nombra el PRD pero **no hay
archivo distribuible que se pueda nombrar sin inventarlo** — es una decisión de licencia.

### Bloqueantes técnicos que sí resuelve código

| Qué | Por qué urge | Tarea |
|---|---|---|
| Los paquetes exportan `.ts` crudo: **`pnpm build` pasa y el binario no arranca** | verde en CI y roto en producción es la peor forma de tenerlo | `P0-REPO-013` |
| `text-subtle` en modo oscuro no llega a AA para texto normal (3,65:1 y 3,16:1) | accesibilidad, y hoy está sin restricción de uso | `P1-UI-011` |

### Lo que nadie miró todavía

- **Nadie abrió un navegador.** Ni una pantalla se vio renderizada, ni con estilos aplicados.
- **Ningún frame renderizado se miró.** Los hashes son estables, la geometría está testeada;
  "determinista" no es "se ve bien".
- **MOV→MP4, faststart y HDR→SDR** nunca corrieron sobre un archivo real. HDR→SDR además **falla
  cerrado** porque este build de ffmpeg no trae `zscale` ni `libplacebo`.
- **Las 82 aserciones de contrato de puerto** existen desde que se escribieron los puertos; sólo
  corrieron las de `Storage` (contra `MemoryStorage`) — y **encontraron dos bugs reales en su
  primera ejecución**. Esperá más de lo mismo con cada adaptador nuevo: un fallo de contrato es
  información, no un problema.

## 9. Mapa de documentos

| Documento | Responde |
|---|---|
| **este** | dónde está parado el proyecto, arquitectura, reglas, trampas |
| [`../PRD.md`](../PRD.md) | **qué** construir. Fuente de verdad funcional, con evidencia etiquetada |
| [`../EVAL-JEV.md`](../EVAL-JEV.md) | por qué existe el puerto `Judgment` y qué se evaluó de TypeSafe/Jev |
| [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) | **cómo**: arquitectura, stack, 15 ADRs con su razón |
| [`../tasks.md`](../tasks.md) | **en qué orden**, y dónde tachar |
| [`COST-MODEL.md`](COST-MODEL.md) | **cuánto cuesta** cada driver, con fuente y fecha. **Caduca rápido**: los precios de IA se mueven en semanas |
| [`SESSION-2026-09-21-plan-implementacion.md`](SESSION-2026-09-21-plan-implementacion.md) | cómo se llegó del PRD al plan, y qué se descartó |
| [`SESSION-2026-09-21-implementacion.md`](SESSION-2026-09-21-implementacion.md) | cómo se organizó el trabajo en paralelo, y las trampas que costaron tiempo |
| [`../CLAUDE.md`](../CLAUDE.md) | instrucciones de arranque para agentes |
