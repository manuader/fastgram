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

### Sesión 2026-09-22 (3) — El documento mentía sobre 67 tareas

**Lo más importante de esta sesión no es código.** `tasks.md` —el documento que
decide en qué se trabaja— sobreestimaba lo pendiente en 67 tareas, y estuve a
punto de despachar dos agentes a construir lo que ya existía.

Apareció así: toda `P2-ANGLE` figuraba `[ ]` mientras su ruta tenía **560
líneas** con las tres mutaciones reconciliando pesos dentro de la misma
transacción. Un minuto después, la nota de `P2-RENDER-002` citaba un
`payload.ts` que **no existe**, para afirmar algo que `P2-RENDER-014` había
arreglado tres líneas más abajo en el mismo documento.

```
antes   99 hechas · 11 parciales · 276 pendientes
ahora  145 hechas · 36 parciales · 206 pendientes
```

El patrón es uniforme: **capa de dominio completa y bien testeada, sin una sola
ruta HTTP ni UI encima.** P1-BRAND tiene 11 tareas así — defensa contra SSRF con
tests de IP decimal y el borde 172.32, y cero rutas `/brand` en la API.

Una casilla va para atrás: `P2-RENDER-009` de `[x]` a `[~]`, porque la
validación existe sólo en `services/render`, que no está montado.

**Cinco notas en prosa afirmaban cosas falsas.** No se borraron: cada una quedó
con qué decía y por qué cayó. Una nota que desaparece sin rastro no enseña que
las notas caducan.

**Lo que entró de código.** El adaptador de render estaba atrasado respecto de
su propio servicio: `/probe`, `/normalize` y `/thumbnail` existían desde la
tanda anterior y seguía lanzando «does not expose». No era inocuo —
`build-handler` llama a `thumbnail()` en **cada** build dentro de un `try/catch`
que loguea y sigue, así que montarlo habría dejado **todas** las piezas sin
miniatura. Tercera vez en tres tandas que el punto de integración entre dos
agentes no lo verifica ninguno.

El puerto `MediaRenderer` lleva ahora `MediaAuthorization` obligatoria, **al
lado** del job y no adentro: `fingerprint(job)` hashea el job y toda
autorización lleva vencimiento, así que un `expiresAt` adentro haría que el
cache de IMPL §5 no acierte **nunca** — con factura de CPU como único síntoma.
La firma se verificó contra el servicio real, no contra un doble.

Y `renderAll` subió al puerto: hasta hoy **un slideshow de más de un slide no se
podía construir en absoluto**.

`discovery-refill`: nada en todo el repo insertaba una fila en `suggestions`, y
por eso `POST /blitz` daba siempre «cola vacía». El handler está montado; **el
productor no existe todavía**, y es el próximo tapón.

También: el `DELETE` de contenido no comprobaba posts enlazados, `GET /health`
respondía 200 con Postgres caído, y `pnpm smoke:binary` no arrancaba en una
máquina sin `.env` desde que las variables de S3 se volvieron obligatorias.

Detalle completo en `docs/SESSION-2026-09-22-tercera-tanda.md`.

### Sesión 2026-09-22 (2) — Lo que nunca había funcionado

Cuatro tandas más en paralelo. El hilo: **todo lo que apareció estaba roto desde
el día que se escribió**, tapado por un test que medía otra cosa o por un camino
que nadie recorría.

- **Los tests de cross-tenant medían RLS, no el `WHERE` del repositorio.** Con el
  GUC puesto, la capa 1 de IMPL §2.4 tapa el agujero y la 2 nunca se mide.
  Confirmado sobre código mío: sin el `companyId`, 146 tests verdes.
- **Dos bugs de `normalize` que se cancelaban entre sí.** MOV y MP4 comparten
  demuxer; el test pasaba fabricando `["mov","quicktime"]`, una lista que ffprobe
  **no emite jamás**.
- **Ninguna pantalla había arrancado nunca en desarrollo.** `--turbopack` no lee
  el `extensionAlias` de webpack y el `layout.tsx` raíz importa `@fastgram/ui`.
  `next build` iba por webpack y estaba verde.
- **CI llevaba tandas en rojo y yo reportaba verde**, porque `pnpm verify` no
  incluía `format:check`. Al meterlo, lo primero que marcó fue que **el workflow
  no parsea**: un `:` sin comillas en un nombre de paso, escrito por mí.
- **La prueba del bucket no corría en ningún lado**: turbo no propaga variables y
  la suite de MinIO se salteaba sola, también en CI.
- **El contrato estaba mal y dos capas lo parcheaban** (`thumbnailUrl`
  obligatorio contra un serializer que lo omite en toda pieza en `BUILDING`).

Y entró lo que se pedía: `S3Storage` montado en las dos apps con `PUT` real
verificado, los tres endpoints que le faltaban a `services/render`, las columnas
del cargo de créditos, los handlers de `publishing` e `influencer-pipeline`, y
**la primera pantalla que habla con la API** — con la primera vez que alguien
abre un navegador en este proyecto.

Detalle en `docs/SESSION-2026-09-22-segunda-tanda.md`.


### Sesión 2026-09-22 — Cuatro agentes en paralelo, y un 500 que nadie veía

Cuatro tandas simultáneas en directorios disjuntos: `services/render` (audio
opcional + endpoint de artefacto), el adaptador HTTP de `MediaRenderer`, el cobro
de créditos de `POST /influencers`, y el saldo comprado + el barrido de cuota.

**Programar un post devolvía 500, siempre.** Apareció verificando, no haciendo
una tarea. `posts.ts` encolaba en `"publish-post"`, un literal escrito a mano
cuando no existía `JOB_QUEUES`; el registro nombró a esa cola `"publishing"`.
`main.ts` registra `[...ALL_JOB_QUEUES]` y pg-boss se niega a encolar en una cola
no registrada dentro de una transacción. Cuarta aparición de la trampa 19, y la
primera con consecuencia inmediata. Vivió con 82 tests verdes por **tres**
razones y hubo que arreglar las tres: el literal, el arnés que aceptaba cualquier
nombre, y que **nadie ejercitaba la ruta** — con el bug puesto y el arnés ya
estricto, los 82 seguían verdes.

**`withoutCompany` no saltea RLS.** Con `FORCE ROW LEVEL SECURITY` y sin GUC, un
`UPDATE` afecta **cero filas sin error**, y en desarrollo la conexión es
superusuaria y parece andar. Trampa 16 por cuarta vez. Medido:
`UPDATE` pelado → 0 filas; la función `SECURITY DEFINER` → 1.

**El saldo comprado se perdía al cambiar de ciclo**, en silencio: §16.2 dice que
no caduca y `lockPeriod` creaba el período nuevo en 0.

**`POST /influencers` no cobraba nada** — 250 créditos y 15–20 min de GPU, el
driver de costo #1.

**Y el adaptador de render existe y no está montado**, a propósito: hoy rompería
todos los builds (ver `P2-RENDER-015`). Con el de memoria el artefacto es
sintético; con el real mal configurado el pipeline cobra y reembolsa en bucle.

Dos lecciones de coordinación, en la trampa 25: **el punto de integración entre
dos agentes no lo verifica ninguno de los dos**, y **arreglar estado compartido
por mensaje dura una sesión** — hay que arreglarlo en el default.

Detalle en `docs/SESSION-2026-09-22-cuatro-agentes.md`.


### Sesión 2026-09-21 (cierre 3) — El worker consume, y el círculo cierra

**Nadie consumía la cola.** `POST /content` creaba la pieza, **cobraba el content save**
y encolaba el build; `apps/worker` imprimía *"sin handlers todavía"* y terminaba. La pieza
quedaba en `BUILDING` para siempre con el save cobrado y sin devolver, y **no fallaba nada**.

Ahora hay handler de `content-build`, y `pnpm smoke:binary` levanta **los dos binarios** y
espera a que la pieza llegue a `CREATED`. Encolar sin consumir no es un circuito.

La forma que va a valer para los 20 handlers que faltan: **leer corto, trabajar largo,
escribir corto.** El render dura 30 s – 2 min (`NFR-001`) y no puede ocurrir dentro de una
transacción; el precio es que entre medio el mundo se mueve, y de ahí sale todo lo demás —
la `revision` se comprueba **al escribir**, no sólo al leer.

**Cuatro cosas que aparecieron al escribirlo:**

1. **Dos payloads en la misma cola** y ningún consumidor que reconociera a los dos: Blitz
   encolaba uno con `suggestionId` obligatorio, la ruta otro con `reason` y `custom`.
   Unificados en `core/jobs/content-build.ts`, con parser a mano — el payload vuelve de la
   cola como `unknown` y un `as` ahí termina en `WHERE id = 'undefined'`, que no falla.
2. **`audio` era obligatorio en el puerto `MediaRenderer`** y `FR-053.1` dice que *No audio*
   omite el bloque. El contrato ya lo tenía opcional: el payload más común del producto no se
   podía ni escribir como `RenderJob`. **`services/render` todavía lo exige.**
3. **`JobContext` no decía cuántos intentos quedan**, y el handler tiene que cerrar la pieza
   en el último en vez de relanzar. Se agregó `maxAttempts`, con un invariante nuevo que lo
   ata al `retryLimit` del productor.
4. **El log de "colas sin handler" mentía** — la lista estaba escrita dos veces en `main.ts`.

**Y dos de mis tests pasaban por la razón equivocada** (trampa 24), que es la parte que más
vale de la sesión: los dos se veían verdes y sólo se vio quitando el mecanismo.

Detalle en `docs/SESSION-2026-09-21-worker-content-build.md`.


### Sesión 2026-09-21 (tarde) — Escritura, los 16 endpoints, y tres cosas que no funcionaban

**El desbloqueo.** Los 28 repositorios eran sólo lectura y `drizzle-orm` no es alcanzable
desde `apps/api`, así que no había forma de implementar ninguna escritura: 16 endpoints
bloqueados. `P1-DATA-014` agrega `create`/`update`/`upsert`/`hardDelete` y un **filtro
declarativo** —data, no SQL— que es lo que le permite cruzar esa frontera. La propiedad que
lo sostiene no es "acordate del scope": **`companyId` no está en el tipo de los valores**.

**Los 16 endpoints**, con cuatro agentes en paralelo, un archivo de rutas cada uno. Detalle
en `docs/SESSION-2026-09-21-escritura-y-endpoints.md`.

**Tres cosas que no funcionaban y nadie lo sabía:**

1. **Encolar dentro de la transacción de Drizzle no andaba.** Es la razón entera de `ADR-005`
   y sólo se había probado contra el ejecutor interno de pg-boss, que corre sobre `pg`. Por la
   vía real fallaban tres cosas distintas (trampa 18 y el commit `21a2e62`).
2. **`fastgram_app` no podía encolar**: `permission denied for schema pgboss`. Las cuatro
   rutas que encolan fallaban en producción y andaban en desarrollo. Tercera aparición de la
   misma clase de bug — ver trampa 16.
3. **`core` y el worker usaban nombres de cola distintos** (trampa 19).

**Cuatro aserciones de contrato que no medían lo que prometían**, encontradas al ejecutar por
primera vez las 37 que nunca habían corrido (trampa 20).

**Y dos bugs de mi propio código anterior**: `canFinalize` fallaba **abierto** —un `committed`
caía en `proceed`, o sea segundo cobro— y `createBuildingContent` devolvía un `revision: 0`
que la base rechaza con su CHECK.

### Sesión 2026-09-21 (cierre 2) — La cuota cobra

`POST /content` **no cobraba nada**, y no por descuido: el motor de `core` estaba
escrito y testeado, pero faltaban tres piezas alrededor. Las tres están:

- **La clave del período** (`YYYY-MM-DD`, inicio del ciclo). El schema la dejaba
  pendiente; la decide `billingPeriodKey`, y no es `YYYY-MM` porque §16.2 resetea en
  el día ancla y el ciclo cruza meses calendario.
- **`contents.save_bucket` y `save_period`** (migración `0005`), que es lo que hace
  posible el reembolso de `FR-050`: devolver al bucket que no fue es un error de
  facturación que nadie ve.
- **El bloqueo** (`SELECT … FOR UPDATE` en `lockPeriod`), porque §9.4 pide reservas
  atómicas y leer-y-escribir no lo es.

El test extremo a extremo encontró además que el `402` llegaba **sin `resetAt`**:
`DomainError.details` no se publica nunca, con razón, pero para los dos códigos de
cuota el PRD nombra el detalle como parte del contrato.

Y `pnpm smoke:binary` + el job `binario` de CI, que en su primera corrida encontró un
foot-gun que yo mismo había documentado y no cerrado: los grants de la cola eran sólo
para el esquema `pgboss`, y `QUEUE_SCHEMA` es configurable.

### Sesión 2026-09-21 (cierre) — El binario arranca y las rutas se ejecutan

**`P0-REPO-013`.** Los paquetes emiten `dist` y `node dist/main.js` corre de verdad. La
complicación de `packages/db` tenía una cuarta salida que la tarea no listaba y es mejor que
las tres: apuntar drizzle-kit al schema **compilado**, que ya es JavaScript y no tiene el
conflicto de `.js` contra `.ts`. `@fastgram/ui` es la única excepción y sigue exportando
fuente, porque su único consumidor empaqueta.

Dejó dos trampas, las dos silenciosas: dependency-cruiser se quedó ciego entre paquetes
(trampa 20) y `boss.start()` levanta el proceso pero no registra las colas (trampa 21).

**El arnés de rutas** (`P1-API-008`). Los 16 endpoints estaban escritos y ninguno se había
ejecutado. `startApi()` monta la app entera contra Postgres real con `app.inject()`, con una
cola que se puede inspeccionar y la opción de montarla **sin** cola. 21 tests sobre lo que
nadie había ejercido: los códigos de estado, el replay de idempotencia y el encolado.

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

Y una de la sesión del worker:

8. **La API cobra y el worker reembolsa; ninguna app hace las dos cosas.** Es lo que evita la
   segunda copia de la regla que decide **a qué bucket** vuelve un content save — la parte cara de
   equivocarse, porque los tres tienen precio distinto y el error no tiene síntoma. Lo que sí es
   común sube: la parte pura a `core` (`parsePlanId`), la que sólo toca el puerto a `adapters`
   (`canonicalObjectUrl`), la que es SQL a `db` (`lockContent`).
   **No hay ningún paquete que dependa de `core` y de `db` a la vez**, y esa ausencia es
   deliberada: no existe una capa de casos de uso compartida entre apps. Cada vez que algo
   necesite las dos, la salida es una de esas tres. Si aparece algo que no entra en ninguna, es
   una decisión de IMPL §2.2 y no de una tarea suelta.

## 6. Cómo verificar

**Números al 2026-09-22 (tercera tanda).** Son lo que permite distinguir "lo rompí yo" de "ya estaba rojo".
Si tu corrida da menos, algo se perdió; si da más, actualizá esta sección.

```bash
pnpm install          # pnpm 12. Si falla, ver la trampa 7 de §7
pnpm verify           # lint · typecheck · boundaries · consistency · test
```

`pnpm verify` **tiene que salir en verde**. Lo que corre, en orden:

| Comando | Qué mide | Esperado hoy |
|---|---|---|
| `pnpm format:check` | prettier sobre el repo. **Entró en `verify` tarde**: CI lo corría solo y llevaba tandas en rojo sin que nadie lo viera | **limpio** |
| `pnpm lint` | eslint una vez sobre todo el repo | **0 errores** |
| `pnpm typecheck` | `tsc --noEmit` por paquete, 12 tareas | **12 successful** |
| `pnpm boundaries` | las reglas de la arquitectura | **0 errores** · 439 módulos · **1265 dependencias** |
| `pnpm consistency` | los números del PRD escritos en más de un paquete | **19 invariantes** |
| `pnpm test` | unitarios | **1.772** |

Desglose de `pnpm test`, por si uno solo se cae:

| Paquete | Tests | | Paquete | Tests |
|---|---|---|---|---|
| `core` | 430 | | `adapters` | 355 |
| `contracts` | 253 | | `ui` | 170 |
| `render-service` | 207 | | `web` | 137 |
| `api` | 131 | | `db` | 52 |
| `worker` | 28 | | `config` | 9 |

### Lo que necesita servicios levantados

```bash
docker compose up -d                       # Postgres con pgvector + MinIO con el bucket creado
pnpm test:int                              # db 147 · api 140 · worker 86 · adapters 9 → 382
pnpm --filter @fastgram/adapters test:int  # 9 — encolado dentro de la transacción de Drizzle
pnpm build && pnpm smoke:binary           # el artefacto que se despliega, de verdad
```

`pnpm smoke:binary` arranca `node apps/api/dist/main.js` **y `node apps/worker/dist/main.js`**:
autentica, escribe, mira que el job quede en pg-boss, y espera a que el worker lo consuma y
deje la pieza en `CREATED`. Es lo único que ve si el artefacto funciona —todo lo demás corre
con tsx o vitest, que resuelven TypeScript— y lo único que verifica que los **dos procesos se
entienden**: el nombre de la cola, la forma del payload y los permisos del rol sobre `pgboss`.
Ya atrapó tres fallos que el build no veía.

`packages/adapters` tiene su propio `test:int` y **no entra en el `pnpm test:int` de la
raíz**: es el que prueba `ADR-005` por la vía real. Si lo salteás, la garantía que
justifica toda la decisión de usar Postgres en vez de Redis queda sin medir.

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
grep -c '^- \[x\]' tasks.md     # terminadas — hoy: 145
grep -c '^- \[~\]' tasks.md     # en curso o parciales — hoy: 36
grep -c '^- \[!\]' tasks.md     # bloqueadas — hoy: 1
grep -c '^- \[ \]' tasks.md     # pendientes — hoy: 206
```

### Lo que `pnpm verify` NO mide

- **Que el binario compilado arranque** ya lo mide `pnpm smoke:binary`, y lo corre el job
  `binario` de CI. Lo que sigue sin medir `pnpm verify` es eso mismo: hay que correrlo aparte.
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

13. **El bootstrap de la API key es el único acceso sin `companyId`, y por eso rompe en
    producción y no en desarrollo.** Resolver una key no puede llevar scope: el `companyId` es
    lo que está averiguando. Eso choca con el `FORCE ROW LEVEL SECURITY` de `api_keys`. En
    desarrollo la conexión suele ser superusuario y saltea RLS, así que anda; con `fastgram_app`
    devuelve cero filas y **toda la API responde 401**. No un endpoint: todos.
    Resuelto con `app.resolve_api_key` (migración `0003`), `SECURITY DEFINER` y `search_path`
    fijo. **Si aparece otra consulta sin `companyId` en el código, sospechá de esto mismo.**

14. **Un limitador de tasa con `read` y `write` separados no limita nada bajo concurrencia.**
    Entre las dos llamadas hay un `await`: N peticiones simultáneas leen el mismo estado y pasan
    todas. Medido: **120 de 120** contra un límite de 60. Los tests secuenciales no lo ven —éste
    vivió en el código hasta que alguien lo leyó pensando en concurrencia. El contrato de
    `BucketStore` exige `compareAndSwap` por eso.

15. **`*/` dentro de un comentario de bloque lo cierra.** Escribir `` `*/upload-url` `` en un
    docstring produce un error de esbuild —*"Expected ';' but found 'POST'"*— apuntando a una
    línea de prosa.

16. **«Funciona en desarrollo y no en producción» ya es una *clase*, no un incidente.** Van tres,
    y las tres veces el mecanismo fue el mismo: en desarrollo la conexión es **superusuario** y
    saltea RLS y privilegios, así que el camino roto se ve verde. Las tres:
    `FORCE ROW LEVEL SECURITY` sobre `api_keys` (trampa 13), el `WHERE` que parecía aislar y sólo
    aislaba porque nadie corría como `fastgram_app`, y ahora `permission denied for schema pgboss`
    — que tiraba abajo **las cuatro rutas que encolan**.
    **La regla que sale de esto:** todo test que verifique aislamiento o permisos corre con
    `SET LOCAL ROLE fastgram_app`, y si no lo hace no está midiendo nada. Si escribís código que
    toca un esquema nuevo, la pregunta no es "¿anda?": es "¿anda con el rol de la aplicación?".

17. **Un `GRANT ON ALL TABLES` sobre un esquema vacío no falla: no hace nada.** Y esa es la peor
    combinación posible en una migración. pg-boss crea sus tablas en otro proceso y **después**
    del deploy, así que el grant tiene que ser `ALTER DEFAULT PRIVILEGES`, que aplica a lo que se
    cree más adelante. Si alguien cambia `QUEUE_SCHEMA`, **hay que repetir los grants para el
    esquema nuevo**: una migración SQL no se parametriza, y un grant sobre el esquema equivocado
    tampoco falla.

18. **`drizzle()` le cambia los serializadores al cliente que recibe.** Pone la identidad en los
    tipos `json` y `jsonb` porque serializa por su cuenta — pero el cliente es **compartido**, así
    que cualquier otro que inserte un objeto plano en una columna `jsonb` por esa conexión lo
    manda crudo al protocolo y postgres.js muere con `ERR_INVALID_ARG_TYPE`. Es el caso del `data`
    de un job de pg-boss. Y **no se puede autodetectar**: medido, el handle que `db.transaction()`
    pasa al callback es una función **sin `.options`**. Por eso el puente se elige a mano
    (`drizzleTransactionToExecutor`) y no hay una rama automática.

19. **Un nombre de cola escrito de los dos lados ya divergió una vez.** `core` encolaba en
    `build-content` y el catálogo del worker escuchaba `content-build`. El job entra en una cola
    que nadie lee: el POST devuelve `201`, la pieza queda en `BUILDING` para siempre y **nunca
    falla**, así que el save tampoco se reembolsa. No aparece en ningún log de errores. Ahora los
    21 nombres salen de `JOB_QUEUES` y hay un invariante que lo verifica.

20. **Al mover los paquetes a `dist`, dependency-cruiser se queda ciego y no lo dice.**
    `dist` está en el `exclude` del cruise, así que cuando `exports` pasa a apuntar ahí, todos
    los imports entre paquetes dejan de tener un módulo destino y **las reglas de frontera
    quedan verdes sin comprobar nada**. Se ve sólo en un número: las dependencias cruzadas
    cayeron de 1019 a 949. Se arregla con los alias **pelados** (`@fastgram/core`, no sólo
    `@fastgram/core/*`) en `tsconfig.base.json`, y lo cubre un invariante de consistencia —
    una regla de depcruise no sirve, porque la arista excluida no llega a existir.

21. **`boss.start()` no es `queue.start()`.** El adaptador arranca pg-boss **y crea las colas**;
    el `boss` pelado sólo lo primero. El proceso levanta bien y la primera petición que encola
    muere con *"Queue must be registered before enqueuing inside a transaction"* — correcto,
    porque dentro de una transacción no hay forma de crear la cola al vuelo. Los tipos no lo
    ven: las dos llamadas existen y las dos compilan.

22. **Un test de concurrencia puede pasar por la razón equivocada.** El del ledger de
    cuota creaba el período *dentro* de las dos transacciones paralelas, así que se
    serializaban por el `ON CONFLICT DO NOTHING` del INSERT y el `FOR UPDATE` no se
    estaba midiendo — pasaba con el bloqueo y sin él. El caso útil es el que corre
    sobre una fila **que ya existe**, donde no hay conflicto de inserción que
    serialice y el lock es lo único que queda. Regla: un test de carrera no vale nada
    hasta que se lo ve rojo con el mecanismo quitado.

23. **Una suite de contrato puede estar verde y no medir lo que promete.** La primera corrida de
    las 37 aserciones que nunca se habían ejecutado encontró cuatro casos así: un `fingerprint es
    puro` que comparaba dos llamadas sobre **la misma instancia** (un renderer con un `randomUUID()`
    por instancia pasaba las diez aserciones); un caso llamado "trae permalink" que nunca miraba
    `permalink`; una aserción de idempotencia de facturación **sin ninguna aserción**; y una
    implicación al revés que hacía imposible declarar un tier. La lección operativa: cuando
    escribas una suite de contrato, **rompé el adaptador a propósito** y confirmá que se pone
    roja. Verde sin eso no significa nada.

24. **Un test de idempotencia también puede pasar por la razón equivocada** — y peor que el de
    concurrencia, porque no hay pausa que meter para desenmascararlo. El del reembolso decía
    *"reejecutar el handler no devuelve el save dos veces"*, corría verde, y seguía verde con la
    guarda de `saveRefundedAt` **quitada**: lo que frena el segundo reembolso es el chequeo de
    **estado**, que ve la pieza en `FAILED` y ni llega al reembolso. La guarda está detrás y el
    handler hoy no puede alcanzarla.

    El segundo caso: el chequeo de `revision` estaba probado en la **lectura** —llega un job
    viejo— y no en la **escritura**, que es donde importa. La carrera real es la edición que entra
    *durante* el render, entre las dos transacciones, y quitar esa comprobación no ponía nada en
    rojo. Para provocarla hay que **hacer que el doble inyectado mute la base desde adentro**: un
    callback en `render()` que corre el `UPDATE`. Con `Promise.all` desde afuera no se reproduce,
    porque las dos transacciones del handler son cortas y se ordenan solas.

    Regla que resume las trampas 20, 22, 23 y ésta: **un test verde no dice nada hasta que se lo
    vio rojo.** Romper el mecanismo y volver a correr cuesta un minuto.

25. **Coordinar agentes en paralelo tiene dos modos de falla propios**, y los dos
    aparecieron en la misma tanda.

    **(a) El punto de integración entre dos agentes no lo verifica ninguno de los
    dos.** Uno construía `services/render` y el otro el adaptador HTTP contra ese
    mismo servicio. El reporte del segundo declaraba, como bloqueo de producto
    número uno, que el servicio seguía exigiendo `audio` — y eso **ya era falso**:
    el primero lo había hecho opcional mientras el segundo trabajaba. Era verdad
    cuando lo leyó y mentira cuando lo escribió, y ninguno de los dos tenía cómo
    saberlo. El coordinador tiene que levantar las dos mitades **en su estado
    final** y medir el cruce; si no, el sistema queda con dos partes que cada una
    cree que la otra está rota. Acá fueron tres renders reales, con `ffprobe` del
    artefacto bajado a través del adaptador.

    Corolario para los prompts: **fijá el contrato por escrito antes de
    despachar**, y decile a cada uno que si le parece que hay que cambiarlo lo
    **reporte** en vez de cambiarlo. Eso funcionó — el `href` encajó sin una ronda
    de corrección.

    **(b) Arreglar estado compartido por mensaje dura una sesión.** Les pasé la
    misma `DATABASE_URL` a dos agentes, y el fixture de `apps/api` arranca con un
    `truncate` de nueve tablas que son las que siembra el otro. Lo vi a tiempo y
    le mandé una base aparte por mensaje — y eso arregló esa sesión y **dejó la
    trampa para la siguiente**, porque el default del fixture seguía apuntando a
    la base compartida. La primera corrida de `pnpm test:int` pasó igual, por
    timing, que es la peor forma de tenerlo. Se arregla **en el default** (la base
    se deriva del `DATABASE_URL` y el `globalSetup` la crea) o vuelve.

26. **Una defensa en profundidad hace que cada capa sea imposible de testear por
    separado — y entonces el test mide "que alguna funcione".** IMPL §2.4 pone
    dos capas de aislamiento: RLS en Postgres y el `WHERE` del repositorio. Los
    tests de cross-tenant corren con `withCompany(..., { role: APP_ROLE })`, o
    sea con el GUC puesto, así que **RLS tapa el agujero y el `WHERE` nunca se
    mide**. Quitándole el `eq(companyId)` a tres repositorios la suite siguió
    verde; a `lockContent` también, con 146 tests en verde.

    El arreglo es un caso por repositorio que corra **como superusuario, sin
    `SET ROLE` y sin GUC**, donde lo único que aísla es el código. Los tests "las
    dos capas juntas" se quedan: miden la redundancia, que también vale. Lo que
    no puede faltar es el que mide **una sola**.

27. **Un doble que devuelve algo que el sistema real no produce no prueba nada, y
    es la forma más cara de tener un bug.** El test de `isMp4Compatible`
    fabricaba `format_name = ["mov","quicktime"]`. ffprobe **no emite esa lista
    jamás**: para un `.mov` y para un `.mp4` emite la misma
    (`mov,mp4,m4a,3gp,3g2,mj2`), porque comparten demuxer, y el discriminador
    real es `format.tags.major_brand`. El test no medía el mundo: medía la idea
    que el autor tenía del mundo.

    Peor todavía: había **dos** bugs en ese camino y se cancelaban entre sí, así
    que en el único caso que alguien miró el resultado era correcto. Regla: si un
    módulo habla con una herramienta externa, el doble tiene que construirse con
    **una salida real capturada**, no escrita a mano.

28. **Un chequeo que sólo corre en CI se descubre roto tarde y de a muchos
    archivos.** `pnpm format:check` llevaba tandas fallando sobre 14 archivos y
    nadie lo vio, porque `pnpm verify` no lo incluía. Al meterlo, lo primero que
    encontró fue **que el workflow de CI no parsea**: un `:` sin comillas en un
    nombre de paso parte la clave del YAML y el archivo entero deja de ser
    válido. O sea que CI no estaba "rojo por formato" — no era un workflow.

    Corolario del mismo día: **turbo no propaga variables de entorno a las
    tareas**, así que la suite de MinIO se salteaba sola en `pnpm test:int` y por
    lo tanto también en CI. `DATABASE_URL` parecía funcionar y funcionaba por
    casualidad: los fixtures tienen un default hardcodeado. Se arregla con
    `passThroughEnv`.

29. **Cuando tengas que parchear algo porque el arreglo está en otro paquete, el
    parche viene con un test que avisa cuándo sacarlo.** `contentSchema.thumbnailUrl`
    era obligatorio y el serializer lo omite en toda pieza en `BUILDING`, así que
    `apps/api` puso un `Omit<>` y `apps/web` un schema local: dos parches del
    mismo lado equivocado, y el problema sobreviviendo a los dos.

    Lo que lo cerró fue un test que decía *"el día que el contrato se corrija,
    esto se pone rojo y el `extend` se borra"*. Se puso rojo en el minuto en que
    se tocó el contrato. Sin él, el parche habría sobrevivido al problema.

30. **Entre no registrar un handler y registrarlo sin proveedor, gana
    registrarlo — si lo que escribe es verdad.** No registrarlo deja la fila
    esperando para siempre **sin que nada falle**. Registrarlo con un doble que
    miente es peor: un post marcado `POSTED` con un permalink inventado no se
    distingue de uno real hasta que alguien lo busca. Registrarlo con el
    proveedor ausente y fallar con un motivo honesto le dice al usuario que eso
    no está disponible **y le devuelve lo que se le cobró**.

    Por eso el renderer de memoria sí se monta —un artefacto sintético se nota—
    y el publicador de memoria no.

31. **Una rotura deliberada sobre un paquete que publica `dist` no vale hasta
    recompilar.** Rompí el advisory lock en `packages/db/src`, corrí los 23
    tests del refill y quedaron **verdes**: iba a reportar que el agente se
    había equivocado. `apps/worker` resuelve `@fastgram/db` a su `dist`, así que
    rompí código que no se estaba ejecutando. Recompilando, el test cae con el
    mensaje exacto que el agente había reportado.

    Es la trampa más peligrosa de la lista, porque **da el resultado
    tranquilizador**: «lo rompí y no pasó nada» se lee como «la guarda es
    inútil» o como «el test es malo», y las dos conclusiones son falsas. Antes
    de creerle a una rotura, comprobá que llegó al artefacto que se ejecuta —
    `grep` sobre el `dist`, no sobre el `src`.

32. **Las notas en prosa de `tasks.md` envejecen peor que las casillas, y se
    revisan menos.** En la auditoría del 2026-09-22, **cinco** afirmaban cosas
    falsas; una citaba un archivo borrado (`render/payload.ts`) para justificar
    una limitación que la tarea de tres líneas más abajo había levantado.

    Una casilla la mira cualquiera que planifica; una nota la lee quien ya
    decidió tomar la tarea, y para entonces suena a contexto y no a afirmación
    verificable. Cuando corrijas una, **dejá escrito qué decía y por qué cayó**:
    borrarla sin rastro no enseña que las notas caducan.

33. **El patrón que desincronizó el backlog: dominio completo, sin una sola ruta
    encima.** `P2-ANGLE` entero figuraba pendiente con 560 líneas de ruta
    implementadas; P1-BRAND tiene 11 tareas con dominio testeado —SSRF con IP
    decimal y el borde 172.32— y **cero** rutas `/brand`.

    Quien escribe el dominio marca su parte y nadie marca la tarea, porque la
    tarea describe la capacidad de punta a punta. Antes de planificar sobre
    `tasks.md`, **mirá el código de la primera sección que vayas a tomar**:
    cuesta un minuto y evita construir lo que ya está.

34. **Un test de concurrencia puede estar midiendo `connect(2)`.** Tres entregas
    lanzadas con `Promise.all` no se solapaban: `postgres.js` conecta bajo
    demanda, la primera reusaba la conexión abierta y las otras dos perdían
    ~8 ms montando el TCP. El test pasaba **sin guarda**. Con el pool caliente y
    la misma rotura, la cola quedaba en 15 en vez de 5.

    Un test de carrera que no calienta el pool mide el arranque del driver. Y
    aun calentándolo sigue dependiendo del timing: el que de verdad mide la
    guarda es el que **sostiene una transacción abierta a mano** y comprueba que
    la segunda no puede terminar.

35. **En un test que prueba que algo NO pasa, la aserción negativa va primero.**
    Con la positiva delante, el día que el banner diga `All changes saved` con
    una petición en vuelo el test falla diciendo *«no encontré Saving…»*, y
    quien lo lea va a buscar en el lugar equivocado.

    ```
    positiva primero → × Unable to find an element with the text: Saving…
    negativa primero → × expected <span class="fgw-autosave__label"/> to be null
    ```

    Las dos son rojas; sólo la segunda mide la mentira. La variante hermana:
    una aserción visible colocada **después** del contador de llamadas de un
    mock hace que el test mida el mock y no la pantalla. Las dos aparecieron el
    mismo día, en agentes distintos, y las encontraron rompiendo el código.

36. **Un barrido grande no sustituye al caso elegido a mano.** Un sweep de
    4×202 combinaciones sobre el reparto de pesos siguió **verde** con la rama
    de «todo lo que queda vale 0» rota; dos tests escritos a mano cayeron.

    El motivo, medido: al bajar desde 100 el primer paso pide repartir 1 punto
    entre tres y el reparto de restos lo acierta por casualidad; del paso
    siguiente en adelante ya hay un peso distinto de 0 y la rama rota no se
    vuelve a tocar. Un barrido cubre el espacio que **recorre**, no el que
    parece cubrir.

37. **Una sentencia atómica no es una guarda si la operación es un `INSERT`.**
    `claimCreditsRefund` se sostiene sola porque es un `UPDATE`: con READ
    COMMITTED el segundo espera y **reevalúa** su `WHERE`. Un `INSERT` no
    bloquea contra nada — dos transacciones toman su snapshot, las dos cuentan
    0, las dos insertan.

    Escribir conteo e inserción en una sola sentencia da atomicidad entre sí y
    **ningún aislamiento**. Lo que cierra esa carrera es un índice único —que
    una cola de sugerencias no puede tener, admite N filas iguales— o un lock
    que las dos entregas disputen. Lo que la sentencia única sí aporta es que no
    se puedan escribir en transacciones distintas por descuido: la diferencia
    entre una invariante y una convención.

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
**32 de esos 42 son de 10 familias con licencia OFL y se bajan sin que nadie decida nada.** Los 10
de `tiktok` y `snapchat` los nombra el PRD pero **no hay archivo distribuible que se pueda nombrar
sin inventarlo** — es una decisión de licencia, y tiene salida sin código: `fonts.json` permite
mapear una familia a otro nombre Pango.

Y una corrección a cómo estaba escrito: **no es «el default `inter`»**. `family` no tiene default
en el schema; fallan las 12 familias igual, porque el fallo es por **directorio ausente** y no por
familia. `RENDER_FONT_DIR` ya está documentada en `.env.example`, con la consecuencia de no
ponerla.

### Bloqueantes técnicos que sí resuelve código

| Qué | Por qué urge | Tarea |
|---|---|---|
| **El adaptador de `MediaRenderer` rinde video real y sigue sin montarse** | de los cinco bloqueos quedan **dos**. Cerrados: el grant (el puerto lleva `MediaAuthorization` y el adaptador la firma, verificado contra el servicio real), `renderAll` para el slideshow multi-slide, y el `thumbnail()` que se llama en cada build y era un stub que lanzaba. Abiertos: **las fuentes** —sin ellas, `font_unavailable` permanente y save reembolsado en cada build— y **el origen del audio**, que nadie definió | `P2-RENDER-015` |
| **Nada encola `discovery-refill`** | el handler está montado y testeado; el nombre sólo aparece en el catálogo y en `queues.ts`. Sin productor la cola sigue vacía, `POST /blitz` sigue dando «cola vacía», y **toda P2-BLITZ sigue sin datos que mostrar**. Es el tapón del producto | `P2-DISC-001` |
| **La UI nunca se probó contra la API sirviendo datos** | la Library se ejercitó contra un stub; las 4 keys de desarrollo están hasheadas y no se pudo crear una. Hay 20 filas en `contents` esperando | `P1-UI-012` |
| ~~**No hay ni un test de componente**~~ **cerrado** | el arnés está (`vitest` + jsdom + Testing Library) y hay 83 tests de componente. Lo que falta ahora es otra cosa: **nadie abrió un navegador** con las dos pantallas nuevas, y jsdom no pinta | `P1-UI-014` |
| **16 de las 21 colas siguen sin consumidor** | la API ya encola en varias; un job sin handler no falla, se queda esperando para siempre | `P1-QUEUE-*` |
| **El contrato público miente en tres lugares** | el OpenAPI documenta `409 media_in_use`, que la ruta **nunca** devuelve, y publica **cinco endpoints `/brand/*` que no existen**. El test de OpenAPI comprueba 27 paths y no incluye ninguno. Además la cabecera de `content.ts` dice que no consume el content save, y lo consume desde `P1-QUOTA-010` | — |
| **P1-BRAND: 11 tareas con dominio completo y cero rutas** | SSRF con tests de IP decimal y el borde 172.32, síntesis, link-in-bio, unicidad global, los 14 `ERR-B` en el i18n — y no hay una sola ruta `/brand` en la API. Es el mejor retorno por línea que queda | `P1-BRAND-*` |
| **No hay adaptador de identidad**: la API sólo acepta API key | el proxy de `apps/web` usa **una key por despliegue**, o sea un workspace para todo el que llegue a la app. Es provisorio y está escrito como tal | `P1-AUTH-*` |
| `text-subtle` en modo oscuro no llega a AA para texto normal (3,65:1 y 3,16:1) | accesibilidad, y hoy está sin restricción de uso | `P1-UI-011` |

Salieron de acá, cerrados: `P0-REPO-013`, `P1-DATA-014`, `P1-DATA-015`,
`P1-STORAGE-007` (S3 montado en las dos apps, con `PUT` real verificado contra MinIO),
`P1-QUOTA-011` (cobra, y el handler del pipeline ya devuelve los 250),
`P2-CONTENT-006` (el `DELETE` comprobaba menos que el `PATCH`) y la mitad de API de
`P1-OBS-004` (`/health` respondía 200 con Postgres caído).

### Lo que nadie miró todavía

- ~~**Nadie abrió un navegador.**~~ **Ya no**: en la segunda tanda del 22 alguien
  abrió uno y vio `/library` con sus cuatro estados, el `Load more` del cursor y
  una pieza pasando sola de `BUILDING` a `CREATED` — con la cadencia medida en
  10,1 s, no supuesta. Lo que **sigue sin verse**: esa pantalla contra la API
  sirviendo datos de verdad (se ejercitó contra un stub), las dos pantallas
  nuevas de la tercera tanda (`/blitz/settings` y la tab del Media Bank, que
  sólo existen en jsdom, y jsdom no pinta), y las otras 37 páginas.
- **Ninguno de los cinco handlers corrió a través de pg-boss de verdad.** Los
  tests los invocan directo con un `JobContext` armado a mano: la reentrega
  real, el backoff y los timeouts del catálogo no están ejercitados. `smoke:binary`
  sí atraviesa pg-boss, pero sólo para `content-build` y sólo por el camino feliz.
- **Ningún frame renderizado se miró.** Los hashes son estables, la geometría está testeada;
  "determinista" no es "se ve bien".
- **MOV→MP4 y faststart ya corrieron sobre archivos reales**, y aparecieron dos bugs que se
  cancelaban entre sí (trampa 27). **HDR→SDR exitoso sigue sin correr nunca**: este build de
  ffmpeg no trae `zscale` ni `libplacebo`, así que la cadena de tonemapping **jamás fue
  ejecutada por ffmpeg** — sólo existe como string en un test de plan. Falla cerrado sobre un
  PQ real, que es lo único verificable en esta máquina.
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
| [`SESSION-2026-09-21-escritura-y-endpoints.md`](SESSION-2026-09-21-escritura-y-endpoints.md) | la escritura en los repositorios y los 16 endpoints, con cuatro agentes en paralelo |
| [`SESSION-2026-09-22-tercera-tanda.md`](SESSION-2026-09-22-tercera-tanda.md) | la auditoría que encontró 67 tareas mal contadas, y las tres mediciones que salieron al revés de lo esperado |
| [`SESSION-2026-09-22-segunda-tanda.md`](SESSION-2026-09-22-segunda-tanda.md) | la segunda tanda de cuatro: seis cosas que nunca habían funcionado y ningún síntoma las delataba |
| [`SESSION-2026-09-22-cuatro-agentes.md`](SESSION-2026-09-22-cuatro-agentes.md) | cuatro tandas en paralelo: el contrato entre agentes, el 500 que nadie veía, y las dos trampas de coordinar |
| [`SESSION-2026-09-21-worker-content-build.md`](SESSION-2026-09-21-worker-content-build.md) | el handler que cierra el círculo, y dónde va lo que dos apps comparten |
| [`../CLAUDE.md`](../CLAUDE.md) | instrucciones de arranque para agentes |
