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

### Sesión 2026-09-24 (4) — Sprint 8: biblioteca de modelos y formatos con voz

Decisiones del dueño: FFmpeg sin distribución (`P0-REPO-004` cerrada), `snapchat` = Inter, HDR→SDR
fuera, "no agregar formatos sin modelo". **Corrección**: el sprint 7 dijo que ningún proveedor
ofrecía voz/lip-sync por API; era cierto para Higgsfield y **falso para fal** (ElevenLabs v3,
MiniMax Speech, OmniHuman v1.5, Sync Lipsync, Wan 2.2 Animate Replace). Con eso: 8 formatos con voz,
character swap y talking head. ManyChat **no** lee perfiles de Instagram (API de DMs): `P1-ONB-011`
queda adaptada (bio pegada o capturas con OCR).

Biblioteca de modelos a nivel dueño (`/models`, 0033): importar, voz, asignar a varias marcas sin
reentrenar, UGC por marca, JV-6 por modelo. `tasks.md`: sólo quedan `P2-JV-002/003` (dataset a mano).
Nada de Higgsfield/fal corrió contra el servicio real. `verify` 18/18; `test:int` worker 386,
api 787, db 260.

### Sesión 2026-09-24 (3) — Sprint 7: paridad con Fastlane, backlog cerrado

Detalle y porqué: [`SESSION-2026-09-24-sprint7-paridad.md`](SESSION-2026-09-24-sprint7-paridad.md).
Mapa por feature: [`PARIDAD-FASTLANE.md`](PARIDAD-FASTLANE.md).

Una auditoría de las ~230 tareas `P1–P5` que nunca se habían reconciliado con PU encontró 75 hechas
sin tachar, 56 fuera de alcance y 69 huecos. Dos tandas de agentes (A–G, H–J) los cerraron:
**`tasks.md` queda sin tareas abiertas** salvo la plantilla de DoD, con 11 `[!]` que esperan al
dueño, derechos o un proveedor con voz por API.

Lo que el uso diario pegaba de frente: todo post fuera de Automations salía **sin caption**; la
**música nunca llegaba al video**; un video propio subido terminaba siempre `FAILED`; no había cómo
programar a mano ni reintentar un fallo. Todo arreglado.

**Verificado en la app real:** Blitz → prompt → green screen → **búsqueda automática del meme en
YouTube** → clip recortado → tarjeta con el meme sobre el fondo → Schedule… → render 1080×1920
mirado; música importada por link → swap en el editor → rebuild con la mezcla medida; JV-4
verificando el perfil con qwen 7B; campana con un aviso real. Sin credenciales, nada de
publicación ni generación paga corrió contra el servicio real.

Migraciones `0024–0032`. `verify` 18/18; `test:int` worker 373, api 738, db 260.

### Sesión 2026-09-24 (2) — Uso personal: sprints 1 a 4 construidos y probados en la app real

Cuatro tandas de agentes en paralelo y una pasada en el navegador por cada una. **Para usarla:**
[`GUIA-DE-USO.md`](GUIA-DE-USO.md). Estado por tarea en `tasks.md` §PU (36 cerradas).

**Verificado en la app real, sin simular nada:** `pnpm start`; modelo local (Ollama
`qwen2.5:7b-instruct`, instalado con Homebrew) configurado desde la UI; marca nueva →
análisis de una web real → perfil `partial` con origen y confianza por campo; kit de fondos
automático cuando no hay media (11 fondos en 18 s); Blitz (deck, crear desde prompt,
aceptar, Edit, Schedule Post); el editor cambia el texto y el video rehecho lo trae; Regenerate
con el LLM real; calendario; Today; pantallas de Integrations, Connections y AI Studio.

**Construido y testeado, sin probar contra el mundo real** (faltan credenciales del dueño):
OAuth y publicación en IG/Threads/FB/X/TikTok (borrador), Higgsfield/fal, recorte con fal,
`pnpm start --tunnel` completo.

Bugs que sólo aparecieron en el navegador (todos arreglados, trampas 50–53): aceptar con perfil
`partial` daba 409; las marcas nacían en UTC; `test:int` vaciaba la base de la app; cookie de
marca vieja sin salida; el editor abría vacío (ahora deriva las cajas del payload);
`width_percent` era `integer` (migración 0016).

Decisiones: `D-13` corregida (sin ninguna cuenta logueada para scrapers), `D-17` (Cloudflare
Tunnel), mapeo editor→px (PRD FR-051); el proceso de media pública reenvía **sólo** el callback de
OAuth a la web; perfil `partial` alcanza para aceptar en Blitz.

### Sesión 2026-09-24 — El plan cambia: uso personal y piloto automático

**Decisión del dueño:** la app es para él, sin auth, límites ni billing, y tiene que manejar
**varias marcas casi sin intervención**. La IA entiende cada marca por su web y sus perfiles,
genera contenido sin parar, él aprueba en Blitz (o la marca va en piloto) y se publica sola. El
plan está en **[`PLAN-USO-PERSONAL.md`](PLAN-USO-PERSONAL.md)**, el orden en `tasks.md` §PU (va
primero) y las decisiones `D-06`…`D-16` en PRD §2.7, más `EXT-009`…`EXT-012`.

Lo que costó tiempo y no se deduce del código:
- **TikTok no aprueba apps para publicar en cuentas propias**: su guía lo declara *not
  acceptable*, y sin auditoría todo sale privado. Por eso TikTok va por **borrador**
  (`IN_USER_INBOX`, `D-10`).
- **IG y las fotos de TikTok traen la media por URL pública.** MinIO en localhost no sirve para
  publicar: hace falta un túnel o un bucket público (`PU-RUN-005`).
- **Ningún scraper de IG o X anda sin cuenta de forma confiable hoy.** Para esos, una cuenta
  secundaria descartable (§6.1 del plan).
- **El render ya compone green-screen con croma**: un meme verde importado sale local y gratis.
- **Higgsfield tiene API oficial** (asíncrona, SDK Node), pero lipsync, personajes y upscale
  **no figuran por API**. Los Influencers no se planifican encima hasta verificarlo.

Fuera por `D-15`: Warmed Accounts, Billing, API pública, MCP y Growth.

### Sesión 2026-09-23 (5) — La primera pieza real

**Verificado a mano, de punta a punta, sin simular nada:** subida real al Media Bank →
`POST /content` → cola → worker con `HttpMediaRenderer` → `services/render` con fuentes activadas →
dos slides 1080×1350 y thumbnail en MinIO, con Inter Bold legible. Es la primera vez que el
producto produce una pieza de verdad.

Tres cosas lo hicieron posible: el render real montado en el build (`835628e`); las fuentes
activadas por proceso, porque en macOS el Pango de sharp sólo tiene CoreText y fontconfig no
tenía nada que ver (trampa 6 corregida); y el texto escalado por `canvas.width / 360`
(`af8d80d`, decisión del dueño anotada en el PRD). Blitz arma su `buildPayload` desde la
sugerencia antes de cobrar (`a914d47`), pero **necesita un LLM configurado** para tener cola.

**Cómo levantarlo** (orden importa: el worker muere si el render no contesta al arrancar):
`fonts:fetch` a un directorio fuera del repo → `services/render` con `RENDER_FONT_DIR`, el
secreto y `NODE_OPTIONS=--experimental-ffi` → API → worker con `RENDER_SERVICE_URL` y el mismo
secreto → `pnpm dev:workspace` para la key de la web.

### Sesión 2026-09-23 (4) — Primero las features: auth y suscripciones a otra rama

**Decisión del dueño:** las suscripciones y la auth multiusuario son secundarias por ahora; lo
primero es tener todas las features para usar la app él mismo. Todo lo de identidad, workspaces
y cuotas de plan quedó en la rama **`auth-y-suscripciones`** (Better Auth, BFF de sesión, primer
workspace Free + trialing, `onboardingComplete`), verde y verificado de punta a punta. **`main`
se rearmó** desde `a5e680d` trayendo sólo lo que no depende de eso: el 404 para ids no-uuid y el
cierre del onboarding (`bdf5eed`), el accept de Blitz (`635f867`) y la cuota como 429 (`116ca08`).

**Para usarla vos:** `pnpm dev:workspace` crea el workspace de desarrollo en plan **pro** y
emite la `FASTGRAM_API_KEY` de la web. Verificado con API + web + worker levantados: las
pantallas cargan y Blitz hace el ciclo completo (cola vacía → relleno → accept cobra y encola).

**El hueco que eso destapó: una pieza de Blitz no se construye.** El worker la cierra
`FAILED` con `invalid_build_payload` porque una sugerencia no lleva `buildPayload`. Es la
próxima feature: generar el contenido a partir de la sugerencia.

### Sesión 2026-09-23 (3) — Una tarea hecha que no se cumplía

Dos agentes. **`P3-PUB-007` estaba `[x]` y ningún post recibía un código diferenciado**: el worker
escribía el motivo del puerto tal cual, y un test fijaba `post_limit_exceeded`. La tabla
determinística de DP-006 (`382f82d`) ya está cableada (`3118b48`). `/brand` existe con sus tres
secciones, la tarjeta de fuentes y la procedencia por campo (`262fb25`). Hubo que agregar
`apiSend` porque `apiRequest` trataba un 204 vacío como una respuesta rota: **todo `DELETE`
exitoso fallaba**. Faltan en la API `expectedBrandRevision` en el perfil y una forma de ver las
propuestas del re-análisis.

### Sesión 2026-09-23 (2) — Un save regalado por cada edición fallida

Tres agentes más. Detalle en
[`SESSION-2026-09-23-sexta-tanda.md`](SESSION-2026-09-23-sexta-tanda.md), sección «Séptima tanda».

**Bug de dinero, cerrado (`eab8fa5`).** Las ediciones se encolaban en `content-build`, que al
fallar reembolsa. Una pieza editada ya entregó su save: cada edición fallida lo devolvía y dejaba
la pieza `FAILED`, cuando el PRD dice que la versión anterior sigue usable. Ahora hay
`content-rebuild` con su propio cierre. **Y ninguna edición llega al video**: el render no lee las
cajas de texto, y el mapeo a píxeles no está en el PRD.

**Una regla de build rota, cerrada (`a7a7f3e`).** `lastEdit.failureReason` llevaba el mensaje
crudo del proveedor y sale por la API. Los tests afirmaban el texto crudo.

**Dos carreras de lectura sin lock**, cerradas con `FOR UPDATE`: el re-análisis (`0a26503`) y
`PATCH`/`regenerate` de contenido. **No se implementó** el filtro por fecha de `GET /posts`: el PRD
no documenta el parámetro. La propuesta está en el session doc.

### Sesión 2026-09-23 — Las escrituras llegan; las fuentes pueden salir de `pending`

Ocho agentes, doce commits. Detalle en
[`SESSION-2026-09-23-sexta-tanda.md`](SESSION-2026-09-23-sexta-tanda.md).

**Destrabado con código, sin probar de punta a punta.** El proxy acepta escrituras con
anti-CSRF (`91a43d9`). Existe el extractor `website` con guarda SSRF (`6f68221`) y el handler de
`brand-source-analysis` (`62b91cb`), que **sólo se monta** con extractor + LLM + retención
configurados; hoy ningún entorno los trae. `media-normalization` tiene productor y se monta con
su propio renderer HTTP (`dc20938`). `snapshot-purge` tiene handler. Colas con handler:
**9 de 21**, dos de ellas condicionadas a configuración.

**Un bug que el consumidor destapó.** El re-análisis de otro día repetía su clave de job, pg-boss
lo deduplicaba y la API respondía 202 con la fuente `analyzing` para siempre (trampa 45).

**Dos tests verdes que no miraban lo que decían.** Los de `createHandlers` no veían qué renderer
recibía la normalización (trampa 46), y uno de `env.test.ts` no podía fallar (trampa 47).

**39 invariantes** entre paquetes (eran 30): las uniones de `ports` con gemelo son listas.
Apareció una divergencia real que queda **fijada sin decidir**: `SubscriptionStatus` del
puerto tiene `incomplete`, que la base rechaza.

### Sesión 2026-09-22 (4) — Lo que un test verde no dice

Cuatro agentes. El hilo: **seis roturas deliberadas**, y las tres que más
enseñaron son las que **no** salieron como se esperaba.

**Una línea sostiene el aislamiento de los 28 repositorios, y la cubría un
test.** Sacando el `eq(companyId)` de `base.ts` y corriendo la suite entera de
`packages/db`: `1 failed | 135 passed`. Los 19 tests de acceso cruzado de
`repositories-write` no se enteraron, porque con el GUC puesto **RLS tapa el
agujero** y el `WHERE` nunca se ejerce. El archivo nuevo corre sin GUC: ahora son
**7 rojos**, cubriendo lectura y escritura.

**Las fuentes: bajarlas no era el problema.** Se bajaron las 32 OFL, eran TTF
válidos con nombres internos correctos, y el motor seguía sin tomarlas. La causa
era una conclusión falsa documentada en el propio cargador —«lo que funciona es
pasar el archivo con `fontfile`, verificado con Georgia»—: Georgia es una fuente
del sistema y resolvía **por nombre**. Pedir «Anton» pasándole el archivo de
Georgia da el centinela: **`fontfile` no se usa**. El bloqueo queda partido en
conseguir los archivos (hecho) e instalarlos (trabajo del Dockerfile bloqueado).

**Una rotura que dio el resultado tranquilizador.** Romper el advisory lock del
refill en `packages/db/src` dejó los 23 tests verdes: `apps/worker` resuelve
`@fastgram/db` a su **`dist`**, así que la rotura no se ejecutaba. Recompilando,
cae con el mensaje exacto que el agente había reportado.

**Y una que reveló una guarda casi redundante.** Borrar el pre-chequeo de
duplicados de brand dejó 40 tests verdes — el índice global lo atrapa igual.
Casi: con el workspace en el cap de 5, sin pre-chequeo el usuario recibe «borrá
una fuente» sobre una fuente que ya tiene. La respuesta no era borrar la guarda
ni dejarla sin test, sino **encontrar el caso que la distingue**.

**Lo que se construyó.** El mensaje «the queue replenishes in the background»
dejó de ser una promesa vacía. Ninguna brand source envejecía nunca, y ahora hay
un barrido con `SECURITY DEFINER` medido (sin él: cero filas, sin error). Nueve
rutas de brand sobre un dominio que llevaba tandas sin poder alcanzarse, más un
test que compara el OpenAPI contra las rutas **registradas** en los dos sentidos
— y que en su primera corrida encontró una tercera mentira que nadie pidió
buscar. El `JudgmentSink` contra la base. La tab `My Posts` y una status page
que redacta **en el servidor**, porque no renderizar no es no publicar.

Detalle completo en `docs/SESSION-2026-09-22-cuarta-tanda.md`.

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

- **(2026-09-23, decisión del usuario) Primero las features; auth y suscripciones después**, en
  la rama `auth-y-suscripciones`. En `main` la web usa una API key de servidor (`pnpm
  dev:workspace`) y el workspace de desarrollo es plan pro.
- **(2026-09-23, decisión del usuario) Swipes diarios sin límite, por ahora.** Se cuentan y no se
  limitan. Provisorio, por configuración; PRD §2.4.

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

**Números al 2026-09-23 (octava tanda).** Son lo que permite distinguir "lo rompí yo" de "ya estaba rojo".
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
| `pnpm typecheck` | `tsc --noEmit` por paquete, 18 tareas | **18 successful** |
| `pnpm boundaries` | las reglas de la arquitectura | **0 errores** · 514 módulos · **1691 dependencias** |
| `pnpm consistency` | los números del PRD escritos en más de un paquete | **41 invariantes** |
| `pnpm test` | unitarios | **2.420** |

Desglose de `pnpm test`, por si uno solo se cae:

| Paquete | Tests | | Paquete | Tests |
|---|---|---|---|---|
| `core` | 561 | | `adapters` | 464 (+10 salteados) |
| `web` | 432 | | `contracts` | 274 |
| `render-service` | 207 | | `ui` | 170 |
| `api` | 175 | | `db` | 52 |
| `worker` | 76 | | `config` | 9 |

### Lo que necesita servicios levantados

```bash
docker compose up -d                       # Postgres con pgvector + MinIO con el bucket creado
pnpm test:int                              # db 218 · api 239 (+11 salteados sin S3) · worker 148 · adapters 9 → 614
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
grep -c '^- \[x\]' tasks.md     # terminadas — hoy: 151
grep -c '^- \[~\]' tasks.md     # en curso o parciales — hoy: 43
grep -c '^- \[!\]' tasks.md     # bloqueadas — hoy: 1
grep -c '^- \[ \]' tasks.md     # pendientes — hoy: 193
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
   La defensa es **verificar contra una sonda centinela** (`fontLoader.ts`). **Corregido el
   2026-09-23 (`835628e`), porque dos cosas de acá eran falsas:** `fontfile` **no se usa** (la
   trampa 40), y `FONTCONFIG_FILE` no falla por fontconfig sino porque **en macOS el Pango de
   sharp sólo tiene backend CoreText** y nunca le pregunta. Lo que funciona en macOS es
   registrar los archivos en CoreText con scope de proceso (`fontActivation.ts`, `node:ffi`,
   `--experimental-ffi`); en Linux, `FONTCONFIG_FILE` es justamente el mecanismo (sin verificar
   todavía). Y un tercer error de la sonda: pedía la familia sin peso, y `"Montserrat 700"` Pango
   lo lee como familia inexistente — un "verificado" con la fuente de fallback.

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

38. **La aserción negativa primero no alcanza si el `await` de arriba es
    positivo.** En un test que prueba que algo **no** pasa, poner
    `expect(...).toBeNull()` antes que la positiva es necesario y no suficiente:
    si el `await` que espera a que la pantalla se estabilice es
    `findByRole("alert")`, espera por lo **correcto** y falla ahí, antes de
    llegar a la negativa.

    ```
    await positivo  → × Unable to find an element with role="alert"
    await neutral   → × expected <p class="fg-state__title"/> to be null
    ```

    Las dos son rojas; sólo la segunda manda a mirar donde hay que mirar.
    Esperá una señal que sea **verdadera en los dos mundos** —que se apague el
    `aria-busy`, por ejemplo— y afirmá después.

39. **Un `singletonKey` con id determinista dispara una sola vez en la vida.**
    El adaptador de pg-boss deriva de la clave el id del job, así que una clave
    fija por workspace choca para siempre contra el `ON CONFLICT DO NOTHING` de
    la PK: el adaptador encuentra el job viejo —ya completado— y devuelve
    `created: false`.

    O sea que `singletonKey: \`refill:${companyId}\`` acota los jobs **y**
    hace que el trabajo no se repita nunca. No se ve en ningún test que mire una
    sola petición. Si el trabajo tiene que poder repetirse, la clave necesita
    algo que rote — un cubo de tiempo, por ejemplo.

40. **Una conclusión sacada de un experimento confundido sobrevive años en un
    comentario.** `fontLoader.ts` documentaba que «lo que funciona es pasar el
    archivo con `fontfile`, verificado con Georgia.ttf: 545x40 contra 517x39 del
    fallback». Georgia es una fuente **del sistema** en macOS: aquel experimento
    comparó «una familia que existe» contra «una que no», no «con archivo»
    contra «sin archivo».

    ```
    Anton CON su propio fontfile      517x39   ← NO carga
    Anton CON el fontfile de Georgia  517x39   ← el archivo se ignora
    ```

    El control que faltaba era pedir una familia **pasándole el archivo de
    otra**. Cuando un comentario afirme que X es lo que hace que algo funcione,
    el experimento que lo prueba tiene que **variar X dejando todo lo demás
    igual** — y el caso de Georgia no variaba X, variaba si la familia existía.

    Corolario práctico: **bajar fuentes a un directorio no es instalarlas.**

41. **Una rotura que no pone nada rojo puede significar que la guarda es *casi*
    redundante — y lo interesante está en el «casi».** Borrar el pre-chequeo de
    duplicados del alta de brand dejó **40 tests verdes**: el índice único
    global atrapa el duplicado igual y produce la respuesta idéntica.

    Casi: con el workspace **en el cap de 5**, sin pre-chequeo la validación de
    cap se evalúa antes del `INSERT` y le dice al usuario «borrá una fuente»
    sobre una fuente que **ya tiene**. Consejo falso.

    Las dos salidas fáciles son malas. Borrar la guarda porque «ningún test la
    extraña» pierde el caso; dejarla sin test deja que alguien la borre mañana.
    Lo que corresponde es **buscar el caso que la distingue**, escribirlo, y
    volver a romper para comprobar que ahora sí duele.

42. **Un doble de test que divergió del puerto falla de la peor forma: el campo
    que el código lee queda `undefined`.** `RecordingQueue.enqueue` devolvía
    `{jobId, queue}` cuando el puerto dice `{jobId, created}`. No era «le falta
    un campo»: un caso de uso que mire `created` para distinguir «encolé» de «ya
    estaba» recibía `undefined` —falsy— y se comportaba como «ya estaba»
    **siempre**, con el test en verde.

    Igual `captionLimits: { captionMaxChars }` en vez de `{ caption }`:
    `texto.length > limits.caption` con `caption` indefinido es **siempre
    falso**, así que el límite no se aplicaba nunca.

    Las dos vivieron porque **`apps/api` y `apps/worker` no typechequeaban su
    carpeta `test/`**: `tsconfig.json` incluía sólo `src/**/*`, y son las dos
    únicas apps con los tests fuera de `src`. Un doble no verificado por el
    compilador no es un doble: es una segunda implementación del puerto, escrita
    de memoria.

43. **Arreglar un doble permisivo pone rojos los tests que medían su
    permisividad — y eso es bueno.** Al hacer que `RecordingQueue` honre
    `singletonKey` como el adaptador real, dos tests del refill cayeron. Decían
    «dos intentos registran dos jobs con la misma clave», y eso sólo era cierto
    porque el doble registraba todo sin mirar la clave.

    El rojo no significaba que el arreglo estuviera mal: significaba que los
    tests afirmaban una propiedad **del doble**. Reescritos sobre lo que pasa en
    producción —la segunda petición no crea un job— son más fuertes que antes.

    Y de paso apareció una colisión que era invisible: los cinco tests
    compartían el minuto del reloj fijo y se deduplicaban entre sí.

44. **Una decisión de seguridad correcta puede dejar media app muerta sin que
    nadie lo escriba.** El proxy de `apps/web` exporta **sólo `GET`**, con su
    razón documentada en la cabecera: no hay anti-CSRF, y con escrituras
    abiertas cualquier página podría disparar un `DELETE` contra el workspace
    del servidor.

    Lo que no estaba escrito es la **consecuencia**: ninguna pantalla de
    escritura de la app puede funcionar contra la configuración por defecto.
    Cada `POST`/`PATCH` pega contra el 405 de Next. El auto-guardado de
    `/blitz/settings` se construyó, se testeó, se reportó como funcionando — y
    manda su `PATCH` por ese mismo camino muerto desde hace dos tandas.

    Cuando una decisión deliberada apague una capacidad, **la consecuencia va en
    el mismo comentario que la decisión**. Ahí no estaba, y por eso nadie la vio
    hasta que un agente fue a construir la segunda pantalla que escribe.

45. **Una clave con un contador que se reinicia es una clave fija en el
    reinicio.** El re-análisis encolaba con `brand-source:<id>:<analysisCount>`,
    y el comentario explicaba bien la trampa 39. Pero el contador **vuelve a 1**
    al vencer la ventana: el segundo re-análisis de otro día repetía `:1`, pg-boss
    lo deduplicaba contra el job viejo y la API respondía 202 con la fuente
    `analyzing` sin nada que la analizara. Como la columna de la ventana no
    existe, en la práctica volvía a 1 **siempre**.

    Dos lecciones. Una clave que tiene que ser distinta por pedido necesita un
    componente que **no se repite** (el instante), no uno que suele crecer. Y
    quien encola y **no mira `created`** no se entera de que no encoló: no se
    notó hasta que alguien escribió el consumidor.

46. **Un test de «qué se monta» no ve «con qué se monta».** `media-normalization`
    recibe un renderer propio porque el de `content-build` es el de memoria y
    marcaría `failed` cada video real. Los tests de `createHandlers` verificaban
    qué colas quedaban montadas; cambiar una línea para pasarle `deps.renderer`
    —exactamente el fallo que el diseño previene— los dejaba **todos verdes**.
    Cuando una dependencia existe por una razón, el test tiene que atravesarla
    con un doble que falle si llega la otra.

47. **`expect.unreachable` dentro de un `try` se atrapa a sí mismo.** Un test
    «el mensaje de error no incluye el secreto» ponía `expect.unreachable()`
    después de la llamada, **dentro** del `try`. Si la llamada no lanzaba, el
    `catch` del propio test atrapaba el error de `unreachable` y comparaba *su*
    mensaje — que no incluye el secreto. Verde sin que nada lanzara. Se vio al
    quitar la guarda. Usá `expect(() => …).toThrow()` o poné el `unreachable`
    **fuera** del `try`.

48. **`pnpm build` no restaura un `dist` editado a mano.** Para romper algo que
    un consumidor lee vía `dist` (trampa 31) es tentador editar el `.js`
    compilado. Pero el `tsbuildinfo` incremental cree que el `dist` está al día
    y `tsc` no lo reescribe: la rotura **sobrevive al rebuild**. Hay que borrar
    `tsconfig.build.tsbuildinfo` y el `.js` tocado. Mejor todavía: romper el
    `src` y recompilar.

49. **Reusar un camino que ya existe puede heredar su política de dinero.** Las
    ediciones se encolaban con `enqueueBuild` en `content-build` porque el
    render es el mismo. Pero la cola decide también **cómo se cierra un
    fallo**, y la de build reembolsa. Una pieza editada ya entregó su save:
    cada edición fallida devolvía uno. Cuando dos flujos comparten motor y no
    comparten reglas de cobro, van por colas —o al menos por cierres— distintos.

50. **`pnpm test:int` de la API borraba la base de la app.** Los fixtures hacen
    `truncate … cascade` y el default era `…/fastgram`, la misma de `pnpm start`:
    correrlos con la app levantada dejaba la web en "Access Denied" sin marcas ni
    piezas. Ahora cada suite deriva su base (`fastgram_api`, `fastgram_worker`) y
    un `globalSetup` la crea, la migra y crea el esquema de pg-boss (el test de
    health dependía, sin decirlo, de que `pnpm start` lo hubiera creado antes).

51. **Una cookie de marca vieja dejaba la web sin salida.** Con `fg_workspace`
    apuntando a una marca borrada, **todo** daba 404, incluido `/mode`, y la web
    leía eso como "no es modo personal": escondía el selector y no había forma de
    volver. `/mode` y `/workspaces…` son rutas del dueño e ignoran el header.

52. **Dos agentes, dos migraciones y un `when` al revés.** La 0013 quedó con un
    `when` mayor que la 0014, y el migrador de Drizzle corre sólo lo que tiene
    `when` mayor que la última aplicada: una base con la 0013 y sin la 0014 se
    saltearía la 0014 para siempre y sin error. `packages/db/test/journal.test.ts`
    exige `when` estrictamente creciente en el orden de `idx`.

53. **Con el panel del navegador oculto, los timers de la página se frenan.** El
    polling del editor "no avanzaba" con la pieza ya `CREATED` en la base. No es
    un bug de la app: recargar o leer el estado por JS.

54. **El quick tunnel de Cloudflare sirve para Instagram y no para TikTok fotos.**
    `PULL_FROM_URL` de TikTok exige un dominio verificado por DNS; un
    `*.trycloudflare.com` aleatorio no se puede verificar. Y un quick tunnel no
    arranca si existe `~/.cloudflared/config.yaml`.

55. **En un webm VP9 con alfa, ffprobe dice `yuv420p`.** Lo único que delata el
    alfa es la tag `alpha_mode=1`, y para decodificarlo hay que forzar
    `-c:v libvpx-vp9` **antes** del `-i`; si no, el foreground sale opaco.

56. **Un parámetro de ruta que termina en `…Id` y no es uuid da 404 siempre.** El
    hook `neutralizeMalformedIds` reescribe cualquier `:…Id` no-uuid. El id de la
    elección de Página de Facebook era un nonce: el selector nunca mostró Páginas.
    Ids de ruta: uuid, o un nombre de parámetro que no termine en `Id`.

57. **Un workflow de ComfyUI tiene que exportarse en formato API**, no el del
    editor (que la UI rechaza con ese mensaje). Y ComfyUI sirve sus resultados por
    `http://`: el descargador lo permite **sólo** desde la base URL configurada de
    ComfyUI; todo lo demás sigue siendo https.

58. **`*/` dentro de un comentario de bloque lo cierra.** Un `*/TOTAL` en una
    cabecera rompió el parseo de un archivo entero (`pnpm lint` → Parsing error).

59. **La API de Reddit exige aprobación previa para cualquier app nueva**
    (Responsible Builder Policy, 2026). El módulo de Engagement funciona sin la
    API: agregar un post por link, generar la respuesta, copiarla y marcar
    "I posted it" (así el ban meter la cuenta). OAuth, descubrimiento y "Send"
    sólo sirven con una app aprobada.

60. **`yt-dlp --dump-single-json` no escribe la miniatura** salvo con
    `--no-simulate --skip-download`, y su salida trae cookies con GeoIP:
    limpialas antes de guardar un fixture.

61. **Dos migraciones escritas en paralelo pueden quedar con `when` entre
    medio.** La 0021 terminó con un `when` menor que la 0022 porque la 0022 ya
    existía: una base que ya aplicó la 0022 se saltearía la 0021 (trampa 52).
    Con agentes en paralelo, recrear las bases de test al integrar.

62. **"Tomar N para procesar" con `LIMIT` en un UPDATE…FROM no limita.** La
    consulta que reservaba slots de campaña para generar tomó 7 con límite 6.
    La tanda se elige en un CTE (`select … limit … for update skip locked`) y el
    UPDATE va contra ese CTE. Lo encontró una corrida real, no los tests.

63. **Dos consumidores en la misma cola se despachan por payload.**
    `automation-generation` es del piloto (payload por marca) y de las campañas
    (payload con `automationId`); igual que `discovery-refill`
    (`promptRequestId`) y `media-import` (`inspirationItemId`). Los tests del
    piloto fijan que un payload de campaña no lo toca.

64. **Reservar migraciones como `SELECT 1` funciona sólo si la app no migra en el medio.**
    Drizzle aplica por `when` y marca aplicada la que corrió: si `pnpm start` corre mientras
    una reservada sigue vacía, su contenido real nunca se ejecuta en esa base. Reservar, llenar e
    integrar **con la app bajada o sin reiniciarla**, y recrear las bases de test al integrar.

65. **Buscar un meme por el tema literal no encuentra memes.** YouTube los indexa por reacción
    ("facepalm", "slow clap"). Primero palabras de reacción (modelo de texto), después el tema.

66. **`cover` a canvas completo destruye un clip 16:9 en 9:16** (~70 % recortado). El meme va
    `contain` en el tramo de abajo; el editor decía `fill` "porque el render estira" y era falso:
    el default del render es `cover`.

67. **Instagram no acepta Reels de menos de 3 s**, y un meme de reacción dura 2–3 s. El render
    repite el clip hasta ≥ 5 s (`-stream_loop`).

68. **`pnpm verify` con `next dev` corriendo falla en `.next/types`.** Bajar la app antes.

69. **Los tests de api/worker leían el `~/.fastgram` real del dueño** (y llamaban a su Ollama).
    Los configs de vitest ponen un `FASTGRAM_HOME` temporal; un test que necesita otro lo pisa.

70. **Dos `test:int` en paralelo sobre la misma base se traban en los `truncate`.** Un agente que
    corre integración a la vez que otro usa un `DATABASE_URL` propio.

71. **qwen 7B mezcla alfabetos** (un hashtag en chino en copy en inglés). Con idioma latino, otro
    alfabeto descarta la copy (`foreign_script`).

72. **"Ningún proveedor lo ofrece" hay que verificarlo en cada proveedor configurado.** El sprint 7
    bloqueó 10 formatos mirando sólo la doc de Higgsfield; fal tenía TTS, talking avatar, lip-sync y
    character swap. Dos agentes de investigación además se colgaron dos horas recorriendo catálogos
    enteros: pedir la página `/api` puntual de cada endpoint.

## 8. Qué falta

> **Al cierre del sprint 7 (2026-09-24):** `tasks.md` no tiene tareas abiertas. Lo que falta es
> (1) credenciales del dueño para la primera publicación real, (2) sus decisiones (`snapchat`,
> licencia de FFmpeg, `OQ-13`), (3) un proveedor con voz/lip-sync por API para 10 formatos y el
> talking head, y (4) la deuda chica listada en `handoffs/HANDOFF-2026-09-24-sprint7.md`. Las
> tablas de abajo son **históricas** (fase SaaS): varias filas ya no aplican o están cerradas
> (render montado, fuentes 11/12, contraste, colas con consumidor, UI contra la API).

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
| **Las 10 fuentes de `tiktok`/`snapchat`** (las otras 32 ya se bajan con `pnpm fonts:fetch`) | el overlay de texto de los 4 formatos | `P2-RENDER-008` |
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
| **El adaptador de `MediaRenderer` rinde video real y sigue sin montarse** | quedan **dos** bloqueos, y el de las fuentes cambió de forma: los 32 archivos OFL **ya se bajan** (`pnpm fonts:fetch`) y **el motor sigue sin tomarlos**, porque `fontfile` se ignora y lo único que resuelve es el nombre en el sistema — instalarlas es trabajo del Dockerfile que `P0-REPO-004` bloquea. El otro es **el origen del audio**, que nadie definió | `P2-RENDER-015` |
| ~~**Nada encola `discovery-refill`**~~ **cerrado** | `POST /blitz` con la cola vacía y el onboarding lo encolan, con clave por minuto (trampa 39). Sigue sin haber pasado por pg-boss real | `P2-DISC-001` |
| **La UI nunca se probó contra la API sirviendo datos** | la Library se ejercitó contra un stub; las 4 keys de desarrollo están hasheadas y no se pudo crear una. Hay 20 filas en `contents` esperando | `P1-UI-012` |
| ~~**No hay ni un test de componente**~~ **cerrado** | el arnés está (`vitest` + jsdom + Testing Library) y hay 83 tests de componente. Lo que falta ahora es otra cosa: **nadie abrió un navegador** con las dos pantallas nuevas, y jsdom no pinta | `P1-UI-014` |
| **11 de las 21 colas siguen sin consumidor** | 10 tienen handler; `media-normalization` y `brand-source-analysis` sólo se montan con su configuración, y hoy ningún entorno la trae. Un job sin handler no falla: se queda esperando para siempre | `P1-QUEUE-*` |
| ~~**NINGUNA pantalla de escritura de la app funciona**~~ **destrabado, sin probar en navegador** | el proxy acepta escrituras con anti-CSRF (`Origin` exacto contra `FASTGRAM_APP_ORIGIN`, `Sec-Fetch-Site`, header propio). **No es autenticación**: `fg_session` no está firmada y cualquiera que alcance el puerto se fabrica una sesión | `P1-AUTH-002` |
| **No hay configuración de CORS del bucket** | el PUT del navegador a la URL firmada **nunca se hizo desde un navegador**: el test de integración lo hace desde Node, donde no hay CORS. Sólo existe `API_CORS_ORIGINS`, que es de la API. Va a fallar con pinta de error de red | `P1-INFRA-004` |
| **`brand-source-analysis` tiene handler, montado sólo con configuración** | extractor `website` + `LLM_*` + `BRAND_SNAPSHOT_RAW_RETENTION_DAYS`, sin defaults (el PRD no da los números). Sin eso, las fuentes siguen en `pending`. Con eso: `website`/`other_url` se analizan, las sociales fallan con `unsupported_platform` y degradan a D. Nunca corrió con un LLM real. Confianza siempre `low` hasta `JV-4` | `P1-BRAND-007…011`, `P1-BRAND-016` |
| **`SubscriptionStatus` del puerto tiene `incomplete`; DATA-002 y Postgres no** | guardarlo tal cual lo rechaza la base. Hoy nadie lo guarda. Está fijado en `check-consistency` como divergencia conocida: o se traduce al persistir, o se suma al PRD y a la base | `P4-BILL-001` |
| **`GET /posts` no filtra por fecha, y ningún endpoint publica la zona horaria** | el calendario pide hasta 500 posts y dice cuando no alcanzan; usa la zona del navegador, y la Library usa UTC: un post puede caer en días distintos en cada pantalla | `P2-CAL-*` |
| ~~**El contrato público miente en tres lugares**~~ **cerrado, y con guardián** | los cinco `/brand/*` **existen**; `409 media_in_use` se quitó (implementarlo necesita un operador «contiene» en los filtros de `packages/db`); y `openapi-routes.test.ts` compara ahora el OpenAPI contra las rutas **registradas** en los dos sentidos. En su primera corrida encontró una tercera mentira que nadie pidió buscar: `GET /blitz/angles/page` existía y el contrato no la nombraba | — |
| ~~**P1-BRAND: dominio completo y cero rutas**~~ **cerrado** | las nueve rutas de §9.14 existen. Lo que falta ahora es otra cosa: **nadie consume el job que encolan** (fila de arriba) | `P1-BRAND-*` |
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
| [`PARIDAD-FASTLANE.md`](PARIDAD-FASTLANE.md) | cada feature de Fastlane: anda, adaptada, fuera o bloqueada, y por qué |
| [`GUIA-DE-USO.md`](GUIA-DE-USO.md) | cómo usar la app hoy, y qué necesita algo del dueño |
| [`SESSION-2026-09-24-sprint7-paridad.md`](SESSION-2026-09-24-sprint7-paridad.md) | la auditoría del backlog, los huecos que el uso diario pegaba de frente, y lo que costó |
| [`COST-MODEL.md`](COST-MODEL.md) | **cuánto cuesta** cada driver, con fuente y fecha. **Caduca rápido**: los precios de IA se mueven en semanas |
| [`SESSION-2026-09-21-plan-implementacion.md`](SESSION-2026-09-21-plan-implementacion.md) | cómo se llegó del PRD al plan, y qué se descartó |
| [`SESSION-2026-09-21-implementacion.md`](SESSION-2026-09-21-implementacion.md) | cómo se organizó el trabajo en paralelo, y las trampas que costaron tiempo |
| [`SESSION-2026-09-21-escritura-y-endpoints.md`](SESSION-2026-09-21-escritura-y-endpoints.md) | la escritura en los repositorios y los 16 endpoints, con cuatro agentes en paralelo |
| [`SESSION-2026-09-23-sexta-tanda.md`](SESSION-2026-09-23-sexta-tanda.md) | escrituras con anti-CSRF, el handler de brand que no miente, y una clave de job que se repetía sin parecerlo |
| [`SESSION-2026-09-22-cuarta-tanda.md`](SESSION-2026-09-22-cuarta-tanda.md) | seis roturas deliberadas, y las tres que enseñaron son las que no salieron como se esperaba |
| [`SESSION-2026-09-22-tercera-tanda.md`](SESSION-2026-09-22-tercera-tanda.md) | la auditoría que encontró 67 tareas mal contadas, y las tres mediciones que salieron al revés de lo esperado |
| [`SESSION-2026-09-22-segunda-tanda.md`](SESSION-2026-09-22-segunda-tanda.md) | la segunda tanda de cuatro: seis cosas que nunca habían funcionado y ningún síntoma las delataba |
| [`SESSION-2026-09-22-cuatro-agentes.md`](SESSION-2026-09-22-cuatro-agentes.md) | cuatro tandas en paralelo: el contrato entre agentes, el 500 que nadie veía, y las dos trampas de coordinar |
| [`SESSION-2026-09-21-worker-content-build.md`](SESSION-2026-09-21-worker-content-build.md) | el handler que cierra el círculo, y dónde va lo que dos apps comparten |
| [`../CLAUDE.md`](../CLAUDE.md) | instrucciones de arranque para agentes |
