# Plan de uso personal — FastGram como piloto automático de redes

> **Fecha:** 2026-09-24 · **Estado:** vigente, **manda sobre el orden de `tasks.md`** hasta que el dueño
> diga lo contrario. El PRD sigue siendo la fuente de verdad funcional de cada pantalla; este
> documento decide **qué se construye primero y qué se cambia del alcance**. Las decisiones que
> cambian el PRD están también en su §2.7 (`D-06`…`D-16`).

---

## 1. La idea, en una frase

**Una app que un solo usuario levanta con un comando y que maneja las redes de varias marcas casi
sin intervención**: entiende cada marca leyendo su web y sus perfiles, genera contenido (slideshows,
wall of text, memes con pantalla verde, hooks) sin parar, el humano aprueba —o no, si la marca está
en piloto automático— y todo se publica solo en la fecha que corresponde, en cada red configurada.

## 2. El circuito, de punta a punta

Cada paso dice si el código ya existe. **Nada de esto se probó todavía con redes reales.**

| # | Paso | Qué pasa | Hoy |
|---|---|---|---|
| 1 | **Alta de la marca** | Pegás una web y/o perfiles de IG/TikTok/X. La IA arma el perfil: identidad, tono, audiencia, oferta y pilares. | Web: sí (extractor tier B + síntesis por LLM). Perfiles sociales: **no** (faltan los extractores, ver §6). |
| 2 | **Estrategia** | Por marca: en qué redes, cuántas piezas por día y por red, horarios, mix de formatos, idioma y **autonomía** (manual o piloto). | Existen Blitz Settings y los content angles. Faltan frecuencia por red, horarios y autonomía. |
| 3 | **Generación continua** | El worker mantiene llena la cola de cada marca: el LLM escribe, el render compone y, si la pieza lo pide, genera imagen o video con IA. | Cola de Blitz y render real: sí. **Sin LLM configurado la cola queda vacía.** Generación de imagen/video: no. |
| 4 | **Aprobación** | Blitz: swipe, y editor para caption, fondo, música, meme o asset y texto. En piloto automático se aprueba sola si pasa el pre-chequeo. | Backend de accept/editar/regenerar: sí. **Ninguna pantalla.** Las ediciones no llegan al video (§8). |
| 5 | **Calendario** | Lo aprobado cae solo en el próximo horario libre de su estrategia. Se puede arrastrar. | Vista mes: parcial. Auto-slot: no. |
| 6 | **Publicación** | A la hora, un adaptador por red sube la pieza por la **API oficial**. TikTok queda como borrador y lo terminás en el celular. | Máquina de estados, worker de publicación y tabla de errores: sí. **Adaptadores reales: ninguno.** |
| 7 | **Vuelta** | Las métricas vuelven y ajustan qué formatos y ángulos se generan después. | Modelo de métricas: sí. Sync y aprendizaje: no. |

**Crear desde un prompt** (el pedido de "videos como Fastlane en Blitz"): escribís el tema → el LLM
elige un meme de tu biblioteca, lo pone sobre el fondo de la marca y escribe el caption → aparece en
Blitz como cualquier otra pieza, con el mismo editor.

## 3. Decisiones del dueño (2026-09-24)

| # | Decisión | Consecuencia |
|---|---|---|
| D-06 | **Uso personal**: un usuario, sin auth, sin billing, sin cuotas y sin rate limiting | Hay que agregar un modo `personal` que apague cuotas y límites. La rama `auth-y-suscripciones` queda intacta para después. |
| D-07 | **Multicuenta = una marca por workspace** | Selector de marca en el shell. Cada marca tiene sus conexiones, su estrategia y su cola. |
| D-08 | **Autonomía configurable por marca**: manual (Blitz) o piloto automático | El piloto aprueba solo con pre-chequeo (`JV-3`) y manda un resumen diario. |
| D-09 | **Redes, en orden**: Instagram, TikTok, X, Threads, Facebook. YouTube y LinkedIn después | Una sola app de Meta cubre IG, Threads y FB. |
| D-10 | **TikTok por borrador** (Upload → `IN_USER_INBOX`), no Direct Post | TikTok no aprueba apps para publicar en cuentas propias (§5). El estado `IN_USER_INBOX` ya existe. Bonus: al terminar el post en la app podés sumar un sonido en tendencia. |
| D-11 | **Sólo APIs oficiales para publicar**; nunca automatizar el navegador ni usar APIs privadas | Es lo que protege a las cuentas (§5). |
| D-12 | **Memes: importar por link** (TikTok/YouTube/X) y recortar el fondo | El dueño asume la responsabilidad por los derechos de lo que publica. |
| D-13 | **Leer perfiles con un scraper open source**, nunca con las cuentas propias logueadas | Salta el gate legal `OQ-16` **para uso personal**. Si la app se abre a terceros, se reabre. |
| D-14 | **Modelos multi-proveedor, elegibles por tarea**: Higgsfield y opciones baratas o gratis; locales más adelante. Presupuesto de US$20–50 por mes | Nuevos puertos `ImageGen`, `VideoGen` y `BackgroundRemoval`, más un registro de modelos (§4). |
| D-15 | **Fuera**: Warmed Accounts y Billing/API pública/MCP (con referidos, roadmap y changelog). **Al final**: Engagement Reddit e Inspiration | Esas tareas pasan a `~~tachadas~~` o al final del orden. |
| D-16 | **Corre en la Mac y después en un VPS** | Primero `pnpm start` local. Después, Docker Compose para un VPS barato. |

## 4. Modelos de IA

Todo con evidencia en la investigación del 2026-09-24 (fuentes en §10). **Ningún id de modelo va
fijo en el código**: sale del registro de modelos (variables de entorno y un archivo local fuera
del repo), porque cambian mes a mes (ADR-009).

| Tarea | Por defecto (presupuesto US$20–50) | Alternativa gratis o barata | Local (después) |
|---|---|---|---|
| Texto: captions, ángulos, síntesis de marca, juicios | LLM barato por un gateway compatible con OpenAI: OpenRouter o DeepSeek | Groq y Cerebras (tier gratis, JSON schema estricto), Gemini (tier gratis; **los datos se usan para entrenar**) | Ollama, LM Studio, vLLM: todos compatibles con OpenAI y con salida por JSON schema |
| Imagen: fondos, slides | Higgsfield (Soul 2, Z-Image Turbo…) | fal FLUX schnell (US$0,003/MP), Cloudflare Workers AI | ComfyUI (API HTTP) |
| Video: clips y reacciones | Higgsfield (Kling, Wan, Seedance; desde US$0,021/s) | fal (Wan 2.2 desde US$0,04/s, LTX) | ComfyUI |
| Recortar el fondo de un clip | **FFmpeg chromakey local si el clip ya es verde (gratis, ya está en el render)** | fal BiRefNet v2 → video con alfa (webm VP9 / ProRes 4444) | rembg o BiRefNet local |

- **El puerto `Llm` ya es compatible con OpenAI**: OpenRouter, Groq, Gemini, Cerebras, Ollama, LM Studio y vLLM
  entran **sin código nuevo**, sólo con `LLM_BASE_URL`, `LLM_API_KEY` y `LLM_MODEL`. Falta la pantalla que
  deje elegirlo por tarea, y el preset para cada uno.
- **Higgsfield**: API asíncrona (`https://api.higgsfield.ai`, header `Authorization: Key id:secret`),
  SDK oficial `@higgsfield/client`, webhooks o polling, y **los resultados duran 7 días**: hay que
  copiarlos a nuestro storage. Concurrencia limitada (hay un ejemplo con 4). Lo que termina `failed`
  o `nsfw` no se cobra. Tiene un endpoint que **estima el costo antes de generar**: lo usamos para
  mostrar el precio y respetar un tope mensual.
- **No confirmado por API en Higgsfield**: lipsync, Soul ID (personaje consistente), upscale y
  recorte de fondo. Existen en su app web, pero no en el catálogo público de la API. Los
  Influencers de Fastlane dependen de esto: hasta verificarlo, **no se planifican sobre Higgsfield**.
- **"Importar modelos locales"** = dar de alta un endpoint compatible con OpenAI (texto) o una URL
  de ComfyUI (imagen y video) en la pantalla de Modelos. El diseño de puertos ya lo permite.

## 5. Publicar sin que te marquen como bot

Hechos verificados (fuentes en §10):

| Red | Cómo se publica | Qué hace falta de tu lado | Tope oficial |
|---|---|---|---|
| **Instagram** | Content Publishing API: reels, carruseles (hasta 10), imágenes JPEG y stories | Cuenta **Business o Creator**. App de Meta en **modo desarrollo** con tus cuentas como usuarios con rol: no necesita App Review (deducido de la doc de modos; se confirma con la primera cuenta real) | 100 por 24 h (la misma doc dice 50 en otra sección: planificamos con 50) |
| **Threads** | API oficial: texto, imagen, video y carrusel (hasta 20) | La misma app de Meta | 250 por 24 h |
| **Facebook Pages** | Reels por API | La misma app de Meta y una Página | 30 reels por 24 h |
| **TikTok** | **Upload → borrador en la app** (D-10) | App de desarrollador de TikTok con Content Posting API | ~15 por día por cuenta, 6 requests/min por token |
| **X** | API oficial, pago por uso | Cuenta de desarrollador con crédito | Sin tope publicado: US$0,015 por post, **US$0,20 si lleva link** |
| YouTube (después) | `videos.insert`; un video vertical de ≤3 min es un Short | **Pedir la auditoría de Google desde el día 1**: sin ella, todo sale privado | 100 subidas por día por proyecto |

**Qué hace la app para no parecer un bot** (ninguna plataforma publica una "cadencia segura", así
que los valores son **configurables** y los defaults son una elección nuestra, no un dato):

1. Sólo APIs oficiales: la plataforma sabe que el post viene de una app registrada.
2. Topes propios por red **por debajo** de los oficiales (default: 3 por día y por red).
3. Jitter aleatorio en la hora (± 7 min) y separación mínima entre cuentas que publican a la vez.
4. Nunca la misma pieza en dos marcas: cada marca genera la suya. Dedup por similitud (`P3-AUTO-007`).
5. Etiqueta de contenido IA donde la red la pide (`P3-SCHED-009`).
6. Nada de likes, follows ni comentarios automáticos: eso sí es lo que castigan.

**Trampa que hay que resolver antes de publicar desde la Mac:** Instagram y las fotos de TikTok
**traen la media desde una URL pública** (TikTok la exige de un dominio verificado). MinIO en
`localhost` no es público. Opciones: un túnel (Cloudflare Tunnel) o un bucket público (R2). Es la
tarea `PU-RUN-005`, y se verifica con la primera publicación real.

## 6. Leer perfiles y bajar memes

- **Extractores de perfiles (D-13)**: un scraper open source detrás del puerto `SocialReader`,
  que ya está previsto (`P1-BRAND-001`). La elección está en §6.1. **Antes de instalarlo se
  audita su código a mano**, como pidió el dueño. La skill "spector" de NVIDIA no está en esta
  máquina: si aparece, se usa para esa auditoría.
- **Instagram, vía oficial y complementaria**: Business Discovery lee cuentas Business y Creator
  de terceros con tu propio token (necesita Facebook Login). Se usa cuando la cuenta califica.
- **Memes y audio por link (D-12)**: `yt-dlp` baja el clip. Si es verde, lo recorta el chromakey
  del render (gratis). Si no, pasa por BiRefNet (fal) → video con alfa. Después el LLM le pone
  etiquetas (emoción, situación, duración) para poder elegirlo solo. Hace falta un modelo con
  visión: Gemini, u otro compatible con imágenes.
- **Música**: no investigamos APIs de música libre de derechos. Por ahora la biblioteca es la tuya,
  subida o importada por link. En TikTok, el sonido lo sumás al terminar el borrador.

### 6.1 Scraper elegido

Evaluación del 2026-09-24. Estrellas y último push salen de la API de GitHub; el estado sale de
los issues de los últimos dos meses. **Ninguno se ejecutó todavía**: el primer paso de
`PU-SCRAPE-001` es auditarlo a mano y probarlo.

| Uso | Elegido | ★ · último push · licencia | Login | Por qué, y el riesgo |
|---|---|---|---|---|
| Bajar un clip por link | **yt-dlp** (+ `curl_cffi`, canal nightly) | 193k · 2026-09-16 · Unlicense | No | Es el estándar. Tiene issues abiertos en TikTok y YouTube que dependen de la IP. |
| TikTok: perfiles y posts | **Evil0ctal/Douyin_TikTok_Download_API** (contenedor aparte, REST) | 20,3k · 2026-09-23 · Apache-2.0 | No | Es el único mantenido que no pide cookies. `TikTok-Api` está roto para videos de usuario (#1311). |
| Instagram | **instaloader anónimo**, con cache y pocas llamadas | 13,4k · 2026-09-06 · MIT | No, pero **está degradado** | Tira 429 en anónimo (#2726). Si no alcanza: instagrapi con una **cuenta secundaria descartable** (API privada, riesgo de ban de *esa* cuenta). |
| X | **twscrape** | 2,8k · 2026-09-22 · MIT | **Sí**, cuenta secundaria | Es lo más mantenido. snscrape está abandonado desde 2023 y twikit, estancado. |
| Sitios web | **crawl4ai** (renderiza JS; sube el extractor web a tier C) | 84k · 2026-09-23 · Apache-2.0 | No | firecrawl es AGPL. El extractor actual no ejecuta JS. |

- **D-13 corregida (el dueño, 2026-09-24): ninguna cuenta logueada, tampoco una secundaria.** En Instagram se usa el modo anónimo o Business Discovery, y si no alcanza, se pega la bio a mano. En X, lo que se pueda sin login (tweets sueltos), y si no, a mano. instagrapi y twscrape **quedan descartados**.
- Estas herramientas se rompen cada pocas semanas, y una IP de VPS anda peor que la de tu casa.
  El diseño asume que van a fallar: cada extractor tiene fallback a Business Discovery (IG) o a
  pegar la bio a mano, y el alta de la marca nunca depende de uno solo.
- Ninguna aparece en GitHub Trending de este mes (el trending muestra nitter, que es AGPL y usa
  sesiones).

## 7. Interfaz "2026"

Criterio: **la pantalla principal es la cola, no un dashboard**. Todo lo demás está a un atajo.

- **Shell**: sidebar compacta con avatares de marca (el selector es el primer elemento), `⌘K` para
  todo (cambiar de marca, crear desde prompt, ir a cualquier pantalla), oscuro por defecto,
  transiciones con física.
- **Hoy**: qué se publica hoy en todas las marcas, qué espera aprobación, qué falló y los
  borradores de TikTok pendientes (con un botón para marcarlos hechos).
- **Blitz**: deck con gestos (arrastrar, flechas del teclado y botones), preview que se reproduce, y
  el editor en un panel lateral con **preview en vivo en el cliente** (misma escala de 360 unidades
  que el render, así lo que ves es lo que sale).
- **Calendario**: semana y mes, drag & drop, filtro por marca o todas, color por red.
- **Settings**: Modelos (proveedor por tarea, costo estimado y gasto del mes), Conexiones (por
  marca), Estrategia (por marca).
- Dependencias nuevas que hacen falta (**las instala el coordinador, no un agente**): una
  librería de animación y una de drag & drop.

## 8. Lo que ya existe y lo que bloquea

**Existe y se reusa tal cual**: el render real (slideshow, wall of text, **green-screen con
croma**, video hook, fuentes y escala de texto), las colas y el worker, el Media Bank con subida a
S3, la máquina de estados de posts (incluido `IN_USER_INBOX`), la tabla de errores de publicación,
el análisis de marca desde la web, el puerto `Llm` compatible con OpenAI y el workspace de
desarrollo.

**Bloquea el circuito, en orden**:
1. **Un LLM configurado.** Sin él, Blitz no tiene cola. Es una variable de entorno: el primer paso.
2. **Ninguna pantalla de Blitz.**
3. **Las ediciones no llegan al video.** El mapeo ya está **decidido** (PRD FR-051, 2026-09-24): x, y y ancho como porcentaje del lienzo, y fuente y contorno en unidades
   de editor × `canvas.width / 360` (la misma regla que ya decidió el dueño para el texto). Cierra
   `P2-CONTENT-004`.
4. **Sin adaptadores de publicación ni URL pública de la media.**
5. **Trámites humanos** (§9).

## 9. Lo que tiene que hacer el dueño (no se resuelve con código)

| Qué | Para qué | Cuándo |
|---|---|---|
| Elegir y cargar una key de LLM (OpenRouter, DeepSeek o Groq) en su entorno local | Cola de Blitz y análisis de marca | **Ya** |
| Pasar las cuentas de IG a **Business o Creator** | Publicar en IG | Antes del sprint 3 |
| Crear una **app de Meta** (developers.facebook.com) y sumar sus cuentas como testers | IG, Threads, FB y Business Discovery | Antes del sprint 3 |
| Crear una **app de TikTok** con Content Posting API (Upload) | Borradores en TikTok | Antes del sprint 3 |
| Cuenta de desarrollador de **X** con crédito cargado | Publicar en X | Antes del sprint 3 |
| Key de **Higgsfield** (console.higgsfield.ai) y de **fal** | Imagen, video y recorte | Sprint 4 |
| ~~Decidir el túnel o el bucket público~~ → **Cloudflare Tunnel** (`D-17`) | Que IG y TikTok puedan traer la media | Decidido |

**Ninguna key se escribe en el repo** (CLAUDE.md). Van a un `.env.local` ignorado por git o al
archivo local `~/.fastgram/`.

## 10. Orden de trabajo (sprints)

El detalle ejecutable está en `tasks.md`, sección **"PU — Uso personal"**, con IDs `PU-*`. Cada
sprint termina con algo que **se usa**, no sólo con tests en verde.

| Sprint | Resultado que se puede usar |
|---|---|
| **1 — Arranca y genera** | `pnpm start` levanta todo en orden. Modo personal sin límites. Pantalla de Modelos con el LLM. Shell nuevo con selector de marca. **Blitz deck**: veo piezas reales y las acepto. |
| **2 — Edito y agendo** | Editor de Blitz con preview en vivo, con las ediciones llegando al video. Crear desde un prompt. Aprobar → auto-slot en el calendario. Alta y estrategia de marcas. |
| **3 — Se publica solo** | App de Meta → IG, Threads y FB. X. TikTok en borrador. URL pública de la media. Topes, jitter y reintentos. Pantalla "Hoy". |
| **4 — Memes e IA generativa** | Importar memes y audio por link, recorte de fondo, etiquetado. Higgsfield y fal para imagen y video. Extractores de perfiles con el scraper. |
| **5 — Piloto automático** | Generación continua por marca, piloto con pre-chequeo, resumen diario, métricas de vuelta. |
| **6 — 24/7** | Docker Compose y deploy a un VPS. Backups. |
| Después | YouTube (con auditoría), LinkedIn, modelos locales (Ollama/ComfyUI), Influencers (si Higgsfield expone personajes por API), Engagement Reddit, Inspiration. |

## 11. Fuentes (verificadas el 2026-09-24)

- Instagram: developers.facebook.com/docs/instagram-platform/content-publishing · app modes: developers.facebook.com/docs/development/build-and-test/app-modes · Business Discovery: developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
- TikTok: developers.tiktok.com/doc/content-posting-api-get-started · content-sharing-guidelines (el caso "herramienta para subir a las cuentas que vos manejás" figura como *not acceptable*) · upload-content
- X: docs.x.com/x-api/getting-started/pricing · YouTube: developers.google.com/youtube/v3/docs/videos/insert · Threads: developers.facebook.com/docs/threads/posts · FB Reels: developers.facebook.com/docs/video-api/guides/reels-publishing
- Higgsfield: docs.higgsfield.ai/docs (+ /concepts/requests, /rate-limits, /billing-and-retention, /how-to/webhooks) · github.com/higgsfield-ai/higgsfield-js · higgsfield.ai/higgsfield-api
- fal: fal.ai/models/fal-ai/flux/schnell · fal.ai/models/fal-ai/birefnet/v2 · Groq: console.groq.com/docs/rate-limits · OpenRouter: openrouter.ai/docs/api-reference/limits · Gemini: ai.google.dev/gemini-api/docs/pricing · Ollama: docs.ollama.com/api/openai-compatibility · ComfyUI: docs.comfy.org/development/comfyui-server/comms_routes

**Sin verificar** (no se construye encima hasta confirmarlo): si una cuenta tester publica en IG
en modo desarrollo sin App Review; lipsync, personajes y upscale de Higgsfield por API; el precio
en USD del crédito de Higgsfield; si Upload de TikTok (borrador) tiene límites propios.
