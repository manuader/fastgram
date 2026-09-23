# FastGram — estado del proyecto

**Fecha de corte:** 2026-09-23 · **Rama de referencia:** `main` (commit `3b984d1`) · **Para:** quien
audite o retome el proyecto sin haber participado.

Este documento es autocontenido: se puede leer sin conocer el historial. Dice qué es el proyecto,
qué funciona (y qué tan verificado está), qué falta, qué lo bloquea, cómo probarlo y por dónde
seguir. Cuando algo **no** se verificó, lo dice explícitamente: una afirmación sin esa aclaración
se verificó con tests automáticos o a mano, y dice cuál.

---

## 1. Qué es

**FastGram** es un clon funcional de **Fastlane**, una plataforma de marketing con IA para redes
sociales: a partir de la identidad de una marca genera piezas de contenido (slideshows, videos con
texto encima, green-screen, video-hook), las propone en un flujo tipo Tinder (**Blitz**), las
renderiza y las publica o programa en TikTok, Instagram, YouTube, LinkedIn y Reddit.

El clon agrega extensiones propias sobre el original. La más importante (`EXT-001`) es poder dar de
alta la marca desde un perfil social en vez de una página web.

**Estado en una línea:** el sistema de punta a punta ya produce **piezas reales** (subida de media →
creación de contenido → cola → render con fuentes reales → archivos en storage), verificado a mano
el 2026-09-23. Falta mucho producto alrededor: conexiones OAuth reales a las redes, publicación
real, la mayoría de las pantallas del editor, analytics, automations, y todo lo de cuentas y
suscripciones, que está **deliberadamente apartado** en otra rama (ver §5).

---

## 2. Cómo está hecho

### Arquitectura

Hexagonal (puertos y adaptadores), en un monorepo con **pnpm workspaces + turbo**.

| Pieza | Qué es | Tecnología |
|---|---|---|
| `apps/web` | La app que usa la persona | Next.js 15 (App Router), React, TanStack Query |
| `apps/api` | API REST `/api/v1` | Fastify 5, Zod, OpenAPI generado desde los contratos |
| `apps/worker` | Consumidor de las 21 colas de trabajo | Node + pg-boss |
| `apps/mcp` | Servidor MCP (esqueleto) | — |
| `packages/core` | **Dominio puro**: reglas de negocio, cuotas, planificación | TypeScript sin I/O |
| `packages/ports` | Interfaces hacia afuera (render, publicación, LLM, storage…) | TypeScript |
| `packages/adapters` | Implementaciones de los puertos | pg-boss, S3, OpenAI-compatible, HTTP |
| `packages/db` | Esquema, migraciones y repositorios | Postgres 16 + Drizzle, RLS por workspace |
| `packages/contracts` | Contratos de la API (schemas Zod) | Zod |
| `packages/ui` | Tokens y componentes compartidos | — |
| `services/render` | Servicio de render de piezas | Fastify + sharp (texto) + FFmpeg (video) |
| `services/vision` | Servicio de visión (OCR, etc.) | Python |

Infraestructura local: `docker-compose.yml` levanta **Postgres (con pgvector)** y **MinIO** (S3
local, bucket `fastgram-dev` ya creado).

### Reglas que el build hace cumplir

Si se rompen, falla `pnpm verify`. Son las que más cuidado piden al cambiar código:

- `packages/core` nunca importa adaptadores ni SDKs de proveedores (lo controla `dependency-cruiser`).
- `apps/api` y `apps/worker` **no pueden importar `drizzle-orm`**: todo SQL vive en
  `packages/db/src/repositories`. Es lo que impide que un proceso arme su propio `WHERE` y se olvide
  del workspace.
- Todo acceso a datos lleva `companyId`; el aislamiento lo refuerza **Row Level Security** de
  Postgres. Un acceso cruzado entre workspaces devuelve **404, no 403** (no revela existencia).
- Ningún error crudo de un proveedor sale por la API: se traduce a un código estable.
- `strict: true` en TypeScript; ningún secreto en el repo.
- `scripts/check-consistency.mjs` compara **41 invariantes** entre paquetes: listas y números del
  PRD que viven en más de un lugar (estados, formatos, límites) y que TypeScript no puede ver juntos.

### Documentos del repo (en orden de autoridad)

| Documento | Responde | Tamaño |
|---|---|---|
| `PRD.md` | **Qué** construir. Fuente de verdad funcional, con evidencia etiquetada (CONFIRMED / SUPPORTED / INFERRED / UNKNOWN). Si el código contradice al PRD, gana el PRD. | ~4.000 líneas |
| `docs/IMPLEMENTATION-PLAN.md` | **Cómo**: arquitectura y 15 ADRs con su razón | ~280 líneas |
| `tasks.md` | **En qué orden**, con cada tarea marcada `[x]` hecha, `[~]` parcial, `[ ]` pendiente, `[!]` bloqueada, y notas del porqué | ~760 líneas |
| `docs/HANDOFF.md` | **Dónde está parado** el proyecto sesión por sesión, decisiones (§5), cómo verificar (§6), **49 trampas ya pagadas** (§7), qué falta (§8) | ~1.200 líneas |
| `docs/SESSION-*.md` | El detalle y el porqué de cada sesión de trabajo | archivo |
| `CLAUDE.md` | El protocolo de trabajo para agentes | corto |
| **este documento** | La foto para alguien de afuera | — |

---

## 3. Qué está hecho

Conteo de `tasks.md`: **153 hechas · 54 parciales · 180 pendientes · 1 bloqueada** (388 en total).
"Parcial" casi siempre significa: el código existe y tiene tests, pero algo del PRD no se pudo
completar sin una decisión o una dependencia externa. La nota de cada tarea dice qué.

### Base (sólida, con tests)

- **Modelo de datos completo** (`P1-DATA`, 15/15): 33 tablas, RLS en todas las de negocio, migraciones
  versionadas con Drizzle.
- **API** (`P1-API`, 8/8): envelopes `{data}` / `{error}`, paginación por cursor, versionado, API
  keys `fsln_live_*` hasheadas, idempotencia con `Idempotency-Key`, rate limiting por token bucket,
  OpenAPI generado y testeado contra las rutas reales.
- **Cuotas** (`P1-QUOTA`, 13/14): content saves con orden de consumo (incluidos → comprados →
  overage), reembolso si el build falla, créditos de AI Studio, reset en el día ancla de facturación.
- **Colas** (`P1-QUEUE`): 21 colas definidas; **10 tienen handler**, de las cuales 3 sólo se montan
  si su configuración está presente (ver §6). Los jobs se encolan **dentro** de la transacción de
  negocio (la razón de usar pg-boss sobre Postgres en vez de Redis, `ADR-005`).
- **Storage** (`P1-STORAGE`): subida en dos pasos con URL firmada (reserva → PUT directo al bucket
  → finalización), probado contra MinIO real.

### Producto

| Área | Estado | Verificación |
|---|---|---|
| **Render** (`P2-RENDER`) | Los 4 formatos (slideshow hasta 20 slides, wall-of-text, green-screen, video-hook). Normalización de video (MOV→MP4, faststart). **Fuentes reales**: 32 de 42 archivos. | **A mano, de punta a punta**: slideshow real 1080×1350 con Inter Bold, subido a MinIO. Tests con FFmpeg real. |
| **Blitz** (`P2-BLITZ`) | Cola de sugerencias que se rellena sola; las sugerencias eligen formato, ángulo, estilo y media del Media Bank; aceptar cobra 1 save + 1 swipe, arma el contenido y encola el render. Pantalla de settings. | Tests de integración; ciclo a mano hasta el encolado. **Falta la UI del deck** (swipe, tarjetas). |
| **Contenido** (`P2-CONTENT`) | Crear, editar (con concurrencia optimista por `revision`), regenerar, borrar. Las ediciones reconstruyen por su propia cola sin volver a cobrar. | Tests de integración. **Una edición todavía no llega al video** (ver §7). |
| **Media Bank** (`P2-MEDIA`) | Subida, categorías, listado, borrado; normalización de videos en background. | Tests + MinIO real. |
| **Library** (`P2-LIB`) | Mis contenidos, mis posts, Media Bank, con los estados de §19 del PRD. | Tests de componentes; se vio en navegador contra un stub. |
| **Calendar** (`P2-CAL`) | Vista mensual, chips por plataforma, contadores. | Tests de componentes. La API no permite filtrar posts por fecha (ver §7). |
| **Brand** (`P1-BRAND`, `P1-BRANDPG`) | Alta de fuentes (web y perfiles sociales), detección y normalización de URLs y handles, protección SSRF, extractor de sitios web, análisis con LLM que materializa el perfil de marca respetando lo que el usuario editó, página `/brand`. | Tests, incluido uno adversarial de prompt injection sobre el cuerpo HTTP real. **Nunca corrió con un LLM real.** |
| **Onboarding** (`P1-ONB`) | Paso 1 (fuente de marca) y paso 4 (procesamiento); cierre del onboarding. | Tests de componentes. |
| **Publicación** (`P3-PUB`) | Handler de publicación con traducción de errores de cada plataforma a códigos estables (tabla determinística, `DP-006`). | Tests. **No hay adaptadores reales** de TikTok/Instagram/etc. |
| **Shell de la app** (`P1-UI`) | Las ~40 rutas existen; navegación, tema claro/oscuro, i18n. La mayoría de las pantallas son placeholders. | Tests + navegador. |

### Verificación automática (estado a la fecha de corte)

```
pnpm verify     → 18/18 tareas: format · lint · typecheck · boundaries · consistency · tests
                  2.518 tests unitarios · 41 invariantes · 526 módulos, 0 violaciones de arquitectura
pnpm test:int   → 682 tests de integración contra Postgres y MinIO reales
                  (db 224 · api 285 + 11 salteados sin S3 · worker 164 · adapters 9)
pnpm smoke:binary → arranca los binarios compilados de API y worker y verifica que se entienden
```

---

## 4. Decisiones del dueño del producto que cambian el alcance

Tomadas el 2026-09-23. Están anotadas en `PRD.md` §2.4 y en `docs/HANDOFF.md` §5.

1. **Primero las features, para uso propio; cuentas y suscripciones después.** Todo lo de login,
   sesiones, workspaces por usuario y cuotas de plan quedó en la rama `auth-y-suscripciones`.
2. **Swipes diarios de Blitz: sin límite por ahora.** Se cuentan, no se limitan. Provisorio, por
   configuración (`BLITZ_DAILY_SWIPE_LIMIT = null` en `packages/core/src/quota/content-saves.ts`).
3. **Tamaño de texto:** `fontSize` y `strokeWidth` son unidades de editor relativas a una vista de
   360 px; el render las escala por `ancho_del_lienzo / 360` (en 1080 px, ×3).
4. *(Sólo en la rama de auth)* El primer workspace de un usuario nace en plan Free con estado
   `trialing`.

---

## 5. Ramas

| Rama | Qué tiene | Estado |
|---|---|---|
| **`main`** | Todo el producto **sin** auth multiusuario. La web usa una API key de servidor y un workspace de desarrollo en plan Pro. | Verde (§3). **Es la rama a usar.** |
| **`auth-y-suscripciones`** | `main` hasta `a5e680d` + identidad real con **Better Auth** (ADR-008): signup, login, logout, recuperación de contraseña, sesión firmada con la web como BFF, resolución sesión → usuario → workspace, creación del primer workspace, `onboardingComplete` en la sesión. | Verde en su momento y **verificado de punta a punta** con API y web levantadas. No recibe los cambios posteriores de `main`. |

**Al volver a juntarlas hay un conflicto conocido de migraciones:** las dos ramas tienen su propia
`0011` (y la de auth, una `0012`) con distinto contenido. Hay que renumerar las de la rama de auth
**después** de las de `main` y revisar el campo `when` de `packages/db/drizzle/meta/_journal.json`
(Drizzle saltea una migración cuyo `when` es menor que el último aplicado). También cambian
`.env.example` (la rama de auth retira `FASTGRAM_API_KEY` de la web) y el proxy de la web.

---

## 6. Cómo probarlo

### Requisitos

- Node **26** (el render en macOS necesita `node:ffi`), pnpm 12, Docker, FFmpeg en el `PATH`.
- Ningún secreto está en el repo. Los que hacen falta se generan en el momento (abajo).

### Verificación automática (sin levantar nada a mano)

```bash
pnpm install
docker compose up -d        # Postgres + MinIO
pnpm db:migrate
pnpm verify                 # tiene que salir verde
pnpm test:int               # necesita el compose arriba
```

### Levantar la app completa

El **orden importa**: el worker se niega a arrancar si el servicio de render no le contesta.

```bash
# 1. Fuentes, FUERA del repo. Sale con código 1 por tiktok/snapchat: es esperado.
pnpm --filter @fastgram/render-service fonts:fetch ~/fastgram-fonts

# 2. Un secreto compartido por render y worker. Exportarlo en la terminal de los dos.
export RENDER_MEDIA_GRANT_SECRET=$(openssl rand -base64 32)

# 3. Servicio de render (terminal A). En macOS, el flag es obligatorio.
cd services/render && NODE_OPTIONS=--experimental-ffi RENDER_FONT_DIR=~/fastgram-fonts pnpm dev
#    Comprobar: curl -s localhost:3002/capabilities → fonts.activation.applied = true, 32 verificadas

# 4. API (terminal B). Variables S3_* de .env.example (valores de MinIO local).
cd apps/api && pnpm dev

# 5. Worker (terminal C), con el MISMO secreto.
cd apps/worker && RENDER_SERVICE_URL=http://localhost:3002 pnpm dev
#    El log tiene que decir "servicio de render para content-build, content-rebuild y media-normalization".

# 6. Workspace de desarrollo + API key de la web. Imprime la key UNA vez: pegarla en el .env local.
pnpm dev:workspace

# 7. Web (terminal D)
cd apps/web && FASTGRAM_API_URL=http://localhost:3001/api/v1 FASTGRAM_API_KEY=<la key> pnpm dev
#    → http://localhost:3000
```

### Qué necesita configuración para funcionar

| Función | Variables | Sin ellas |
|---|---|---|
| Render real | `RENDER_SERVICE_URL` + `RENDER_MEDIA_GRANT_SECRET` (worker) | Los builds usan un renderer de memoria: la pieza llega a `CREATED` con **bytes sintéticos**, no un video. |
| Normalización de videos | las mismas | Los videos subidos quedan en `processing`. |
| **Sugerencias de Blitz** | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_CONTEXT_WINDOW_TOKENS` (gateway compatible con OpenAI, ADR-009) | **La cola de Blitz queda vacía**: una sugerencia sin copy no se puede construir. |
| Análisis de marca | las `LLM_*` + las 7 `BRAND_WEBSITE_*` + `BRAND_SNAPSHOT_RAW_RETENTION_DAYS` | Las fuentes de marca quedan en `pending`. |

Ningún número de los que el PRD no da tiene un default inventado: esas variables son obligatorias
y el arranque dice cuál falta.

### Prueba manual de punta a punta (la que se hizo el 2026-09-23)

1. Subir una imagen: `POST /api/v1/media/upload-url` → `PUT` al `uploadUrl` → `POST /api/v1/media`
   con el `uploadId`. La media queda `ready`.
2. `POST /api/v1/content` con `Idempotency-Key` y un payload de slideshow cuyo `image.url` sea el
   `r2Url` de esa media.
3. Consultar `GET /api/v1/content/:id` hasta que pase de `BUILDING` a `CREATED`. Los `files` y el
   `thumbnailUrl` apuntan a MinIO; bajarlos y mirarlos.

Para Blitz, además: subir media con sus categorías (`slideshow-image`, `background-video`,
`hook-video`, `green-screen-background` + `green-screen-video`), configurar el LLM, y
`POST /api/v1/blitz`.

---

## 7. Qué falta

### Por área (de `tasks.md`)

| Área | Hecho | Parcial | Pendiente | Qué es lo principal que falta |
|---|---|---|---|---|
| Blitz (UI) | 0 | 2 | 12 | El deck de tarjetas con swipe, el editor inline, los modales de swap de media |
| Content Studio | 1 | 2 | 7 | El wizard de creación, remix, previsualización |
| Brand Sources | 7 | 5 | 12 | Extractores de Instagram/TikTok/X/YouTube/LinkedIn (bloqueados por un spike y por revisión legal) |
| Conexiones OAuth | 2 | 0 | 9 | OAuth real con cada red social |
| Scheduling / Publicación | 7 | 1 | 10 | Adaptadores reales de publicación, el flujo de programar |
| Automations | 0 | 0 | 13 | Todo |
| Engagement | 0 | 0 | 12 | Todo |
| Influencers (IA) | 3 | 0 | 10 | Generación y entrenamiento de personajes |
| Analytics | 0 | 0 | 4 | Todo |
| Warmed Accounts | 2 | 0 | 6 | Compra y aprobación |
| Billing, API pública, MCP | 1 | 0 | 17 | Todo (billing apartado por decisión) |
| Auth / Tenant | 1 | 5 | 5 | En la rama `auth-y-suscripciones` |
| Infraestructura | 1 | 0 | 5 | Entornos, IaC, deploy, backups, secretos |
| Observabilidad | 2 | 0 | 3 | Trazas, Sentry/PostHog, alertas |

### Huecos concretos conocidos (el código sabe que existen)

- **Una edición de texto no llega al video.** El render lee el payload original; las cajas de texto
  editadas se guardan aparte y el PRD no dice cómo mapear las coordenadas del editor (0–100) a
  píxeles. El rebuild se cierra honestamente como "no aplicada" en vez de fingir.
- **`GET /posts` no filtra por fecha** y el PRD no documenta ese parámetro: el calendario pide hasta
  500 posts y avisa si no alcanzan. Hay una propuesta escrita para el PRD.
- **No existe la librería compartida de audio ni de media**, así que ninguna pieza lleva audio y
  `ownMediaPercentage` no tiene efecto.
- **Remix de tendencias** no está: las sugerencias salen como contenido original y lo dicen.
- **Ninguna ruta crea `media_sets` de influencer**, así que Blitz nunca elige un influencer.
- **12 de las 21 colas no tienen consumidor**: un job encolado ahí espera para siempre sin fallar.
- **El texto con contorno grueso** (stroke 8 → 24 px) no se miró; puede verse dentado.

---

## 8. Bloqueantes

### Necesitan a una persona (no avanzan escribiendo código)

| Qué | Bloquea | Tarea |
|---|---|---|
| **Licencia del build de FFmpeg** (componentes GPL vs LGPL) | el Dockerfile del render, y con él el despliegue | `P0-REPO-004` (la única tarea `[!]`) |
| Revisión legal del scraping de perfiles públicos (`OQ-16`) | leer perfiles sociales sin OAuth (tier C) | `P1-BRAND-024` |
| Derechos del catálogo de tendencias (`OQ-13`) | toda la épica de Inspiration/Trending | `P2-TREND-001` |
| Fuentes `tiktok` / `snapchat` (licencia) | esas 2 de 12 familias tipográficas | `P2-RENDER-008` |
| Confirmación de Cloudflare sobre R2 para servir video | la elección de storage en producción | `P1-INFRA-004` |
| Tarifario de créditos (`OQ-21`) | el margen del producto | — |
| **Qué LLM y con qué gateway** | Blitz y el análisis de marca en la práctica | ADR-009 (el modelo no se fija en el repo a propósito) |
| Mapeo de cajas del editor a píxeles | que las ediciones lleguen al video | `P2-CONTENT-004` |
| Número de saves del trial Free | aceptar en Blitz con plan Free (hoy 503 honesto) | rama de auth |

### Técnicos (resolubles con código)

- **El render en Linux/Docker no está verificado.** En macOS las fuentes se activan con CoreText por
  proceso; en Linux el mecanismo es `FONTCONFIG_FILE` y nunca se probó. Antes de desplegar, probarlo
  en un contenedor.
- **El servicio de render baja la media por URL canónica sin firmar.** En local funciona porque el
  bucket de MinIO es de lectura pública; en producción, con un bucket privado, no.
- **No hay CORS configurado en el bucket de producción**: la subida desde el navegador fallaría.
- **`node:ffi` es experimental** (Node 26) y su API ya cambió una vez.

---

## 9. Lo que NO está verificado

Esta lista es la parte más importante para un auditor: todo lo de arriba que no está acá tiene
tests automáticos o una verificación a mano documentada.

- **Nadie recorrió la app en un navegador** con la API sirviendo datos reales, salvo `/library`
  contra un stub y las pantallas de login de la rama de auth. Onboarding, calendario, `/brand` y
  Blitz settings sólo existen en tests con jsdom.
- **Ningún LLM real** generó copy, análisis de marca ni juicios. Todo corrió contra dobles del
  gateway. El prompt, el esquema JSON estricto y la calidad de salida están sin probar.
- **Ningún handler corrió a través de pg-boss real** salvo `content-build` en `smoke:binary`: los
  reintentos, backoff y timeouts del catálogo no están ejercitados.
- **Blitz de punta a punta hasta un video**: se verificó el ciclo hasta encolar y, por separado, el
  render real; no las dos cosas juntas, porque requiere LLM.
- **Wall-of-text, green-screen y video-hook con fuentes reales** a través del producto (sí con el
  servicio directo).
- **HDR→SDR** nunca corrió con FFmpeg (este build no trae los filtros necesarios).
- **Ningún adaptador real de red social** (publicación, lectura, OAuth).

---

## 10. Siguiente paso recomendado

En orden, pensando en que el dueño lo quiere **usar**:

1. **Configurar un LLM** y correr Blitz de punta a punta hasta un video real. Es lo que falta para
   que la función central se pueda usar, y va a destapar problemas de prompt y de formato.
2. **Recorrer la app en el navegador** con todo levantado (§6) y listar lo que no funciona. Hay
   mucho construido que sólo se vio en tests.
3. **La UI del deck de Blitz** (`P2-BLITZ-001…013`): hoy la lógica existe pero no hay pantalla para
   swipear.
4. **Decidir el mapeo editor → píxeles** para que las ediciones lleguen al video.
5. Después: OAuth y publicación real con una sola red (probablemente TikTok o Instagram), y recién
   entonces volver a la rama de auth y a infraestructura.

---

## 11. Cómo trabajar en el repo sin romperlo

- **Leer primero** `docs/HANDOFF.md` §7 (trampas). Las que más tiempo costaron:
  - Los paquetes se consumen compilados (`dist`): un cambio en `packages/*/src` no llega a las apps
    hasta `pnpm --filter <paquete> build`. Un "experimento de rotura" sin recompilar da verde falso.
  - Con RLS activo, un test de acceso cruzado puede pasar aunque falte el filtro por workspace en el
    `WHERE`: RLS lo tapa. Por eso hay tests que corren **sin** contexto de workspace.
  - Una clave de deduplicación de pg-boss fija dispara el job **una sola vez en la vida**; una que
    lleva un contador que se reinicia tiene el mismo problema en el reinicio.
  - Un test que usa `Promise.all` para simular una carrera casi nunca la produce: hay que retener el
    lock y esperar a ver a los dos pedidos bloqueados en `pg_stat_activity`.
- **Verificar lo que un test dice medir**: quitar la guarda a propósito y confirmar que el test se
  pone rojo. Varias veces en este proyecto un test verde no medía nada.
- **Registrar** cada sesión: `docs/SESSION-<fecha>.md` con el porqué, y una entrada nueva en
  `docs/HANDOFF.md` §4.

---

## Glosario

| Término | Significado |
|---|---|
| **Blitz** | Modo de descubrimiento: tarjetas de contenido sugerido que se aceptan o descartan |
| **Save / content save** | Unidad de cuota: aceptar o crear una pieza consume uno |
| **Swipe** | Cada decisión en Blitz; se cuenta por día |
| **Media Bank** | La media propia del workspace (imágenes y videos subidos) |
| **Brand Source** | Una fuente de identidad de marca: web o perfil social |
| **Tier A/B/C/D** | Cómo se lee una fuente: A = OAuth del usuario, B = API pública/OpenGraph, C = fetch de página (apagado hasta revisión legal), D = asistido (el usuario pega la bio) |
| **Workspace / company** | El tenant; todo dato pertenece a uno |
| **`buildPayload`** | Lo que el render necesita para producir una pieza: lienzo, media, textos |
| **PRD** | Documento de requerimientos; los IDs `FR-`, `F-`, `AI-`, `DATA-`, `NFR-`, `OQ-` apuntan a secciones de él |
| **OQ** | Open Question del PRD: algo que el original no permitió saber y hay que decidir |
