# PRD — Clon funcional de Fastlane (usefastlane.ai)

**Documento:** Product Requirements Document — source of truth para construir un clon con paridad funcional.
**Producto original:** Fastlane / Fastlane AI — `https://www.usefastlane.ai` (marketing) · `https://app.usefastlane.ai` (aplicación) · `https://developers.usefastlane.ai` (API/MCP) · `https://api.usefastlane.ai` (API REST + MCP).
**Empresa:** Aftermark AI (branding anterior del producto: **Aftermark**, `app.aftermark.ai`; CDN de media aún sirve desde `media.aftermark.ai`).
**Fecha de la investigación:** 2026-09-21.
**Idioma del documento:** español. **Todos los identificadores, strings de UI, enums, rutas y nombres de campo se conservan textualmente en inglés**, porque son requisitos literales de implementación.

---

## 0. Metodología, fuentes y convenciones de evidencia

### 0.1 Fuentes utilizadas

| Código | Fuente | Qué aporta |
|---|---|---|
| `[APP]` | Bundle JavaScript público de `app.usefastlane.ai` (`/assets/index-BMyzFjrT.js`, `AppRoot-Da6yL4B1.js`, `V2Root-GqOGKuPl.js` y chunks por página) | Mapa exacto de rutas, nombres de vistas, enums, copy de UI, mensajes de error, catálogo de formatos de contenido |
| `[DEV]` | `developers.usefastlane.ai` (documentación oficial de API REST v1, autenticación, rate limits, y los dos servidores MCP) | Contrato de API, entidades, estados, cuotas, reglas de negocio, ciclo de vida de Automations |
| `[WWW]` | `usefastlane.ai`: `llms.txt`, `llms-full.txt` (896 KB), `/pricing`, `/tools/*`, `/for/*`, `sitemap.xml`, `robots.txt` | Posicionamiento, planes y precios, límites por plan, catálogo de features de marketing, FAQ oficial |
| `[DOCS-n]` | `/docs/features/demo/*.mp4` y `*.mov` (9 videos, ~31,6 min, analizados frame a frame + transcripción de narración) | Comportamiento observado de la UI, flujos paso a paso, estados intermedios, textos exactos |

### 0.2 Inventario completo de `/docs` (auditado al 100 %)

| Archivo | Duración | Resolución | Audio | Marca mostrada | Contenido |
|---|---|---|---|---|---|
| `docs/features/demo/compressed-intro-homepage-guide.mov` | 149,0 s | 1728×1080 | Sí | Aftermark (`app.aftermark.ai`) | Introducción + Home + Trending Content + FAQ |
| `docs/features/demo/compressed-blitz-guide.mov` | 251,0 s | 1152×720 | Sí | Aftermark | Blitz completo: swipe, why-this-content, edición, preferencias, scheduling |
| `docs/features/demo/2-green-screen.mp4` | 360,3 s | 1920×1080 | Sí | Aftermark | Content Studio → Green Screen Meme, generación, edición, schedule, library |
| `docs/features/demo/3-wall-of-text.mp4` | 225,3 s | 1920×1080 | Sí | Aftermark | Content Studio → Wall of Text (remix y create-new, estilos) |
| `docs/features/demo/4-hook-demo.mp4` | 126,8 s | 1920×1080 | Sí | Aftermark | Content Studio → Video Hook & Demo, demo video, audio |
| `docs/features/demo/5-slideshows.mp4` | 104,4 s | 1920×1080 | Sí | Aftermark | Content Studio → Slideshow, preview por slide, swap de imagen |
| `docs/features/demo/6-calendar-library.mp4` | 134,5 s | 1920×1080 | Sí | Aftermark | Calendar, Library (My Posts / My Content), Home v2, Company Profile |
| `docs/features/demo/7-ai-influencers.mp4` | 507,8 s | 1664×1080 | Sí | **Fastlane** (`app.usefastlane.ai`) | Influencers (creación, imágenes, videos, configuración), Blitz actual, Blitz Settings, Media Bank |
| `docs/features/demo/manual-creation-demo.mp4` | 37,8 s | 1920×1080 | **No** | Fastlane (layout nuevo) | Content Studio rediseñado (Mode / Mention / Prompt) |

No existen otros archivos en `/docs` (ni imágenes, PDFs, markdown, JSON ni código). Se verificó recursivamente; sólo hay `.DS_Store`.

### 0.3 Niveles de confianza

- **CONFIRMED** — observado directamente en la aplicación (bundle en producción) o en un video de `/docs` con timestamp.
- **SUPPORTED** — respaldado por documentación oficial pública (developers.usefastlane.ai, llms-full.txt, páginas de producto).
- **INFERRED** — inferencia razonada, necesaria para implementar; se explicita el razonamiento.
- **UNKNOWN** — no se pudo determinar. Se lista en §24.
- **EXTENSION** — **no existe en Fastlane**. Es una decisión de producto deliberada del equipo del clon, solicitada explícitamente. Se marca aparte para que nadie la confunda con una observación del original y para que sea trivial identificarla o descartarla si se quiere paridad estricta. Todas las extensiones están indexadas en §2.6.

### 0.4 Advertencia crítica: dos generaciones del producto conviven en las fuentes

`/docs` contiene material de **dos versiones distintas** del producto:

1. **Generación A — "Aftermark"** (8 de los 9 videos, grabados el 13-feb-2026, dominio `app.aftermark.ai`): Content Studio con wizard de 4–6 pasos, Library con 2 pestañas, Home con Performance/Weekly Posts.
2. **Generación B — "Fastlane"** (`7-ai-influencers.mp4`, grabado ~12-may-2026, dominio `app.usefastlane.ai`, tema claro con acento naranja): sidebar expandido con 10 secciones, módulo Influencers, Blitz con chips de influencer/ángulo, Library con 3 pestañas incluyendo Media Bank, Blitz Settings dedicado.

**Regla de resolución de conflictos aplicada en todo este PRD** (orden de prioridad declarado por el usuario):
1. Comportamiento observado hoy en la aplicación (bundle de producción de `app.usefastlane.ai`) →
2. Demos recientes (`7-ai-influencers.mp4`, `manual-creation-demo.mp4`) →
3. Documentación oficial actual (`developers.usefastlane.ai`) →
4. Otras fuentes oficiales (`llms-full.txt`, páginas de producto) →
5. Demos antiguos (Generación A) →
6. Inferencia.

Cuando una pantalla sólo existe en la Generación A, se documenta como **legacy** y se marca explícitamente. El clon debe implementar la **Generación B**; la Generación A se conserva en el PRD porque muchos flujos internos (wizard de creación manual, modales de selección, scheduling de 3 pasos) siguen vigentes y sólo cambiaron de envoltorio visual.

### 0.5 Esquema de identificadores

`MOD-XXX` módulo · `F-XXX` feature · `FR-XXX` requisito funcional · `FLOW-XXX` user flow · `DATA-XXX` entidad/requisito de datos · `INT-XXX` integración · `AI-XXX` comportamiento IA/automatización · `NFR-XXX` requisito no funcional · `EVT-XXX` evento de analytics · `ERR-XXX` estado de error/vacío.

---

# 1. Product Overview

## 1.1 Qué hace Fastlane

Fastlane es una **plataforma de contenido social impulsada por IA para marcas**. Convierte una única URL de sitio web en un mes de contenido short-form on-brand, programado y publicado nativamente en TikTok, Instagram Reels, YouTube Shorts, LinkedIn y (para engagement/leads) Reddit. `[WWW]` SUPPORTED

Declaración oficial: *"Fastlane turns a single website URL into a month of scheduled, on-brand short-form content. It generates content, lets you swipe through ideas (Blitz mode), schedules across platforms, and tracks performance."* `[WWW llms-full.txt §What is Fastlane?]` SUPPORTED

El bucle central del producto es: **analizar el negocio → generar sugerencias de contenido en una cola → el usuario aprueba por swipe → se renderiza el media → se programa y publica → se miden resultados → se realimenta la generación.**

## 1.2 Problema que resuelve

Las marcas pequeñas (indie hackers, apps de consumo, SaaS, e-commerce, agencias) necesitan distribución orgánica en short-form video pero no tienen equipo de contenido, ni habilidades de producción de video, ni tiempo para producir volumen diario sostenido. Fastlane elimina las tres barreras: **ideación** (cola de sugerencias generada por IA a partir de tendencias reales), **producción** (renderizado server-side de 4 formatos base + catálogo extendido de formatos IA), y **distribución** (publicación nativa programada y cuentas "warmed" gestionadas por humanos). `[WWW]` SUPPORTED

## 1.3 Usuarios objetivo

`[WWW llms.txt]` SUPPORTED — founders, indie hackers, apps de consumo, marketers, marcas de e-commerce, agencias de marketing, creadores de cursos, dropshipping, TikTok Shop, artistas musicales, moda, beauty/skincare, startups tech, proyectos "vibe coded" (Lovable, Claude Code, Rork).

Onboarding pregunta explícitamente por: **rol**, **tamaño de equipo**, **modelo de negocio**, **categoría de negocio**, **revenue mensual actual** y **expectativas sobre la plataforma**. `[APP OnboardingPage]` CONFIRMED

## 1.4 Propuesta de valor

1. **Cero fricción de arranque:** una URL → perfil de marca completo generado por IA en minutos.
   - **EXTENSION del clon (`EXT-001`):** la fuente no tiene por qué ser una web. Puede ser **un perfil de Instagram, TikTok, X, YouTube o LinkedIn**, o cualquier enlace público que el usuario pegue. Nadie necesita tener sitio web para darse de alta. Ver `FR-011`.
2. **Volumen sin fatiga creativa:** cola de sugerencias auto-rellenable + modo swipe (Blitz) para aprobar en segundos.
3. **Contenido que ya funcionó:** remix de una librería de 25 000+ videos en tendencia, etiquetados por nicho y con analytics. `[WWW]` SUPPORTED
4. **Talento sintético propio:** influencers IA persistentes ("train once, generate endlessly") con cara consistente entre videos. `[DOCS-7 t=0s]` CONFIRMED
5. **Distribución real:** publicación nativa multi-plataforma + cuentas TikTok/Instagram reales, creadas y "calentadas" por humanos en US/EU.
6. **Atribución:** analytics unificado por post y tracking de tráfico web/signups.
7. **Programabilidad:** API REST v1 + dos servidores MCP para que agentes de IA creen y publiquen contenido.

## 1.5 Casos de uso principales

| ID | Caso de uso | Módulos implicados |
|---|---|---|
| UC-1 | "Quiero postear todos los días sin pensar" | Onboarding → Blitz → Calendar |
| UC-2 | "Quiero remixar este video viral para mi producto" | Home/Inspiration → Remix → Content Studio → Schedule |
| UC-3 | "Quiero una creadora UGC propia y consistente" | Influencers → AI Studio → Blitz (influencer frequency) |
| UC-4 | "Quiero una campaña de 4 semanas ya programada" | Automations (DRAFT → GENERATING → REVIEW → ACTIVE) |
| UC-5 | "No quiero postear desde mi cuenta personal" | Warmed Accounts |
| UC-6 | "Quiero encontrar gente en Reddit que necesite mi producto" | Engagement (Lead Discovery + AI replies + ban meter) |
| UC-7 | "Quiero que mi agente de IA publique por mí" | API keys + MCP server |
| UC-8 | "Quiero saber qué contenido funciona y hacer más de eso" | Analytics + Blitz preferences |
| UC-9 | "No tengo web, sólo un Instagram/TikTok — quiero empezar igual" | Onboarding → Brand Sources (`FR-011`) → Blitz — **EXTENSION** |

## 1.6 Conceptos centrales del producto (glosario normativo)

| Concepto | Definición | Evidencia |
|---|---|---|
| **Workspace / Company** | Contenedor de todo: perfil de marca, conexiones, contenido, posts, influencers, cuotas, API keys. El usuario puede tener varios y cambiar entre ellos. Las API keys son *workspace-scoped*. | `[DEV Authentication]` SUPPORTED |
| **Company Profile / Brand** | Perfil de negocio generado por IA: identidad, oferta, beneficios, problema que resuelve, mercado y competencia. Alimenta toda la generación. Versionado con `brandRevision`. En Fastlane se deriva de la URL del sitio; **en el clon se deriva de una o más `Brand Sources`**. | `[DOCS-6 t=81s]`, `[DEV POST /blitz/angles]` CONFIRMED · alcance ampliado EXTENSION |
| **Brand Source** | **EXTENSION.** Cualquier origen del que la IA extrae la identidad de marca: `website`, `instagram`, `tiktok`, `x`, `youtube`, `linkedin`, `other_url` o `manual`. Un workspace puede tener varias; se fusionan con precedencia explícita. Cada una guarda un snapshot de lo extraído y cuándo. | `FR-011`, `DATA-031` EXTENSION |
| **Content Angle** | Persona/encuadre narrativo que condiciona la copy generada. Tiene `title`, `description`, `targetAudience`, `isActive`, `influencerIds`. Máx. 100 por workspace, máx. 10 ángulos por influencer. | `[DEV GET/POST/PATCH/DELETE /blitz/angles]` SUPPORTED |
| **Discovery queue** | Backlog rodante de ~5 sugerencias de contenido por workspace, auto-rellenado en background. | `[DEV POST /blitz]` SUPPORTED |
| **Suggestion** | Item de la cola: `contentType`, `generatedText`, `aiExplanation`, `createdAt`, opcionalmente `remixSourceUrl`. | `[DEV]` SUPPORTED |
| **Content** | Pieza renderizada (`_id`, `type`, `status`, `files[]`, `thumbnailUrl`, `generatedText`, `revision`). Es el artefacto de media, independiente de los posts. | `[DEV GET /content]` SUPPORTED |
| **Post** | Instancia de publicación de un Content en una cuenta y plataforma concreta, con su propio estado y métricas. | `[DEV GET /posts]` SUPPORTED |
| **Content save** | Unidad de cuota consumida al crear una pieza de contenido. Se consume al aceptar un Blitz, al crear contenido vía API y al finalizar un custom video. Se reembolsa si el build falla. | `[DEV Rate limits]` SUPPORTED |
| **Blitz swipe** | Unidad de cuota diaria; cada aceptación de Blitz descuenta un swipe. Reset a 00:00 UTC. | `[DEV Rate limits]` SUPPORTED |
| **AI Studio credit** | Moneda de generación de imágenes/videos IA (influencers, AI Studio). Saldo visible y recargable. | `[DOCS-7 t=15s]` CONFIRMED |
| **Influencer** | Personaje IA persistente entrenado (`status`: `generating_variations` → `training` → `ready`/`failed`/`inactive`). Máx. 50 activos por workspace. | `[DEV /influencers]` SUPPORTED |
| **Media Bank** | Biblioteca de assets propios del workspace (imágenes/videos) con categorías que los hacen elegibles para pools automáticos de Blitz. | `[DEV /media]`, `[DOCS-7 t=375s]` CONFIRMED |
| **Set** | Agrupación curada de media dentro del Media Bank (tipos: SLIDESHOW, VIDEO, CURATED). | `[DOCS-7 t=375s]` CONFIRMED |
| **Connection** | Cuenta social conectada por OAuth (`platform`, `platformUsername`, `scopes`, `publishable`, `tokenExpiry`). | `[DEV GET /connections]` SUPPORTED |
| **Warmed Account** | Cuenta TikTok/Instagram real creada y "calentada" 5 días por un humano en un teléfono real, gestionada por el equipo de Fastlane. | `[WWW /tools/buy-tiktok-accounts]`, `[DEV GET /warmed-accounts]` SUPPORTED |
| **Automation** | Campaña multi-semana que genera y programa N slots de contenido hacia M cuentas. | `[DEV MCP Automations]` SUPPORTED |
| **Slot** | Unidad de contenido dentro de una Automation que se abanica a un post por cuenta destino. | `[DEV]` SUPPORTED |
| **Lead** | Conversación de Reddit detectada como oportunidad comercial, con score y sugerencia de respuesta IA. | `[APP ActionsView]` CONFIRMED |

---

# 2. Product Scope

## 2.1 Funcionalidades CONFIRMED (observadas directamente)

Autenticación vía Clerk · Onboarding con análisis de website (ampliado en el clon a análisis de perfiles sociales — ver §2.6) · Company Profile / Brand · Home (dashboard) · Trending Content / Inspiration con remix · **Blitz** (cola, swipe, why-this-content, edición inline, preferencias) · **Blitz Settings** (página dedicada) · **Content Studio** (Slideshow, Wall of Text, Video Hook & Demo, Green Screen Meme, Custom + 17 formatos IA) · **Influencers** (wizard 3 pasos, galería de imágenes, galería de videos, configuración, animate) · **AI Studio** · **Library** (My Posts / My Content / My Media Bank + Sets) · **Calendar** (vista mes con chips de post) · **Analytics** · **Warmed Accounts** · **Engagement** (leads de Reddit, respuestas IA, ban meter) · **Automations** · **Settings** (account, workspaces, integrations, warmed-accounts, notifications, preferences, billing, api) · **Refer & Earn** · **Guide** · **Roadmap** · **Changelog** · **Feedback** · **Status** · **Admin** (interno) · **Developers / API keys** · scheduling multi-plataforma · toasts de progreso · gestión de cuotas y créditos.

## 2.2 Funcionalidades SUPPORTED (documentación oficial)

API REST v1 completa (29 endpoints) · MCP OAuth connector (8 tools) · MCP API-key server (34 tools) · Partner API (multi-tenant/white-label) · API overage billing · idempotencia · paginación por cursor · rate limiting por workspace y por partner · reembolso de content save en fallo de build · ciclo de vida completo de Automations · entitlements (`tiktokDirect`, `autoCaptions`) · etiquetado AI-generated content · disclosure de paid partnership · TikTok commercial sounds · Instagram slideshow format (carousel/reel) · LinkedIn y Reddit como destinos.

## 2.3 Funcionalidades INFERRED

- Modelo de permisos con roles **owner** y **member** dentro de un workspace (el connector OAuth está restringido al *"paid owner of a direct Fastlane workspace"*, y existe `Failed to create special user from invite`). INFERRED — ver §4.
- Notificaciones in-app y por email con centro de preferencias (existe `Could not save notification settings.` y sección `notifications` en Settings, pero no se observó el panel). INFERRED.
- Búsqueda global. No se encontró evidencia de un search global; sí búsquedas por pantalla. INFERRED que no existe.

## 2.4 Funcionalidades UNKNOWN

Ver §24 (Open Questions). Resumen: detalle de la matriz de permisos por rol, panel de notificaciones, límites exactos de swipes diarios por plan, webhooks salientes, exportación de datos, y el alcance real de la superficie "V2 / Fastlane OS".

> **Decisiones del dueño del producto (2026-09-23), para lo que este PRD dejaba abierto:**
> - **Límite diario de swipes: sin límite por ahora.** El swipe se cuenta pero no se limita. Es provisorio y se cambia por configuración; no es un número del producto original.
> - **Plan y estado del primer workspace: Free + `trialing`.** Un workspace nace en el plan Free de §16.1 («No credit card») con `subscriptionStatus = trialing`, así que le aplican las restricciones de trial de §16.7. Crear el **primero** no consulta el límite de workspaces; los adicionales siguen sin número para Free.

## 2.5 Fuera de alcance (no construir)

- **Admin interno** (`/admin/*`): 13 páginas de back-office de Fastlane (companies, copilot, doctrine, RAG, velocity, zero-view-media, media-usage, base-character-gallery, design-system…). Es tooling interno del vendor, no del cliente. Se documenta su existencia en §3 pero **no forma parte del clon**. CONFIRMED `[APP routes]`
- **Partner API / white-label multi-tenant**: superficie comercial separada, sólo relevante si el clon quiere revender. Documentada en §9.7 como opcional.
- **Fastlane OS / superficie V2** (`/v2/*`, `os.usefastlane.ai`): rutas presentes en el bundle (`agent`, `genesis`, `strategy`, `activity`) pero sin UI observable ni documentación. Fuera de alcance de la paridad v1; documentado en §3.6 como señal de roadmap.
- Replicar el **catálogo de contenido de terceros** (los 25 000 videos en tendencia son datos licenciados/scrapeados; el clon necesita su propia estrategia de ingestión — ver `FR-041`).
- Reproducir los **modelos de IA propietarios** ("Fastlane V8"); el clon debe usar proveedores equivalentes — ver §11.

## 2.6 Extensiones deliberadas sobre Fastlane (EXTENSION)

Funcionalidad que **el clon tendrá y Fastlane no**. Decidida por el equipo de producto, no observada en el original. Se centraliza aquí para que sea trivial identificarla, estimarla o descartarla.

| ID | Extensión | Por qué | Dónde se especifica |
|---|---|---|---|
| **EXT-001** | **Brand Sources multi-origen: alta desde un perfil social en lugar de una web** | En Fastlane, sin web sólo queda escribir la descripción a mano (`Use description instead`). Eso excluye o degrada a todo el segmento que vive en social: creadores, tiendas de Instagram, cuentas de TikTok Shop, negocios locales, artistas, coaches, restaurantes. El clon debe extraer identidad, tono, audiencia y oferta directamente de **Instagram, TikTok, X, YouTube o LinkedIn**, o de cualquier enlace público. | `FR-011` (núcleo), `FR-010` (onboarding), `FR-020` (gestión posterior), `DATA-031`/`DATA-032`, `AI-016`, `INT-014`…`INT-018`, §9.14 |
| EXT-002 | Webhooks salientes además del polling | La API v1 de Fastlane no los tiene; son estándar para integraciones de cliente | §9.3, OQ-11 |
| EXT-003 | Sección `members` en Settings con matriz de permisos explícita | Fastlane tiene miembros pero no expone su gestión | §14, §4, OQ-01/OQ-02 |
| EXT-004 | Audit log visible de acciones destructivas y facturables | No observado en el original | §9.12 |
| EXT-005 | Caps configurables por plan en vez de hardcodeados | En el original son opacos | OQ-14 |
| EXT-006 | Recorte inteligente en slideshows en vez de `stretch-to-canvas` | El original documenta la distorsión como limitación conocida de su v1 | `FR-070` |
| **EXT-007** | **Pre-flight de publicación**: detectar antes de programar lo que la plataforma va a rechazar o ajustar | En Fastlane el fallo se descubre *después* de publicar (`instagram_repeated_mention`, `captionAdjustmentReason`, límites de plataforma son todos post-mortem) | `JV-3` en §25 |
| **EXT-008** | **Judgment layer**: capa explícita para las decisiones semánticas del sistema, con puerto propio y adaptadores intercambiables | El PRD especifica decenas de decisiones con salida finita pero no define su mecanismo. Sin una capa declarada, cada una se resolvería ad-hoc con un LLM parseado o un if-else frágil | §9.15 y §25 |

**Regla transversal:** una extensión nunca puede romper un comportamiento CONFIRMED. `EXT-001` es **estrictamente aditiva**: el camino "pego mi web" sigue funcionando igual que en Fastlane, con sus mismas validaciones y su mismo copy.

## 2.7 Decisiones de producto tomadas (log)

Decisiones **cerradas** por el equipo de producto. No son hipótesis ni recomendaciones: son restricciones de diseño. Quien implemente no necesita volver a abrirlas.

| # | Decisión | Elegido | Implicación directa |
|---|---|---|---|
| **D-01** | Cómo se lee un perfil social en el alta | **Público primero, OAuth si falla** | El signup **no pide OAuth**. Orden de resolución: API pública → fetch público (tras `OQ-16`) → oferta de conectar → asistido. Ver `FR-011.4`. |
| **D-02** | Plataformas en la primera versión | **Las cinco: Instagram, TikTok, X, YouTube, LinkedIn** | Cinco extractores en Fase 1. Ver `FR-011.1` y §21. |
| **D-03** | Profundidad del análisis de contenido | **Texto + OCR en Fase 1; ASR en Fase 2** | Bio, captions, hashtags, link-in-bio y texto superpuesto. La transcripción de audio se difiere. Ver `FR-011.3` y `AI-016`. |
| **D-04** | Importación de posts propios al Media Bank | **Fase 1, opt-in durante el alta** | El Media Bank puede arrancar con media real de la marca. Ver `FR-011.5.1`. |
| **D-05** | Cómo se resuelven las decisiones semánticas del sistema | **Puerto `Judgment` con adaptador LLM por defecto; Jev (TypeSafe) detrás de bandera, pendiente de validación** | Ninguna decisión semántica llama a un proveedor directamente. Ver §9.15, §25 y `EVAL-JEV.md`. |

**Sobre D-05.** La evaluación de arquitectura (`EVAL-JEV.md`, 2026-09-21) concluyó que Jev encaja genuinamente en dos huecos que este PRD deja sin motor (`DP-001`, `DP-002`) y habilita dos comportamientos nuevos (`DP-004`, `DP-007`), pero que **no conviene comprometerse con el proveedor todavía**: tiene semanas de vida, no publica cifras de latencia y no hay benchmarks independientes. Lo que sí conviene, y cuesta casi nada mientras no haya código, es **declarar la capa**. De ahí D-05: se adopta la *forma*, no el proveedor.

### Tensión entre D-01 y D-04, y cómo se resuelve

D-01 dice que el alta **no** pide OAuth. D-04 dice que durante el alta se ofrece importar los posts propios — y eso **sólo es posible con OAuth** (tier A). Son compatibles, pero sólo si el orden es el correcto:

1. El usuario pega su perfil y pulsa `Analyse`. **Sin pedirle nada.**
2. Se construye el perfil de marca con datos públicos. El alta ya está salvada: a partir de aquí el usuario puede terminar el onboarding y llegar a Blitz.
3. **Después** del análisis, y presentada como mejora y no como requisito, aparece la oferta: `Connect @<handle> to publish from it — and bring your photos and videos with you.` Conectar sirve para dos cosas a la vez (publicar, que va a necesitar igual, e importar media).
4. Si no conecta, el onboarding sigue sin fricción y la oferta reaparece en `Settings → integrations`.

**Regla dura:** la importación de media **nunca** puede convertirse en una razón para pedir OAuth antes del análisis. Si alguna vez se mueve delante, se rompe D-01 y con ella el objetivo entero de `EXT-001`.

---

# 3. Information Architecture

## 3.1 Sitemap textual — aplicación (Generación B, vigente)

Todas las rutas siguientes están **CONFIRMED** en el bundle de producción `[APP AppRoot-Da6yL4B1.js]`.

```
/                                   → redirect a /home (autenticado) o /login
/login  ·  /login/*                 → Clerk sign-in (incluye SSO)
/signup ·  /signup/*                → Clerk sign-up
/logout                             → cierre de sesión
/auth/sso-callback                  → callback SSO de Clerk
/onboarding                         → wizard de alta (multi-paso)

/home                               → Dashboard
/engagement                         → Engagement (Reddit leads) — layout con tabs
   /engagement/actions              → Actions / lista de leads
   /engagement/insights             → Insights de engagement
/blitz                              → Blitz (swipe deck)
   /blitz/settings                  → Blitz Settings (configuración de generación)
/ai-studio                          → AI Studio (generación libre de imagen/video)
/influencers/*                      → Influencers
   /influencers                     → listado
   /influencers/:influencerId       → detalle (?tab=images|videos|configuration)
/content                            → Content Studio (hub)
   /content/slideshow
   /content/wall-of-text
   /content/video-hook-and-demo
   /content/green-screen-meme
   /content/custom
   /content/character-swap
   /content/claymation
   /content/cutting-fruit
   /content/felt
   /content/green-screen-mobile-app
   /content/lego
   /content/netflix-documentary
   /content/news-anchor
   /content/notes-green-screen
   /content/on-a-walk
   /content/product-spokesperson
   /content/skeleton
   /content/speaking-hook
   /content/street-interview
   /content/talking-head-green-screen
   /content/talking-head-ugc
   /content/talking-objects
/library                            → Library (tabs: My Posts · My Content · My Media Bank)
/calendar                           → Calendar
/analytics                          → Analytics
/warmed-accounts                    → Warmed Accounts
/automations                        → Automations (listado)
   /automations/new                 → wizard de creación
   /automations/:automationId       → detalle de campaña
   /automations/:automationId/edit  → edición de campaña
/brand                              → Brand / Company Profile
/inspiration                        → Inspiration (librería de trending, búsqueda + filtro por nicho)
/guide                              → Guide
/roadmap                            → Roadmap público de producto
/changelog                          → Changelog
/feedback                           → Feedback
/refer-and-earn                     → Programa de referidos
/upgrade                            → Paywall / selección de plan
/settings                           → Settings (secciones: account · workspaces · integrations ·
                                       warmed-accounts · notifications · preferences · billing · api)
/developers  ·  /developer          → Documentación de API embebida + gestión de keys
/status                             → Status page

/auth/tiktok/callback
/auth/instagram/callback
/auth/youtube/callback
/auth/linkedin/callback
/auth/reddit/callback               → callbacks OAuth por plataforma
/partner/checkout/success
/partner/checkout/cancel            → retorno de checkout de partner
/*                                  → 404
```

**Rutas internas del vendor (fuera de alcance, ver §2.5):**
`/admin`, `/admin/analytics`, `/admin/base-character-gallery`, `/admin/changelog`, `/admin/companies`, `/admin/copilot`, `/admin/copilot/threads/:threadId`, `/admin/design-system`, `/admin/doctrine`, `/admin/feedback`, `/admin/media-usage`, `/admin/rag`, `/admin/roadmap`, `/admin/status`, `/admin/velocity`, `/admin/version`, `/admin/zero-view-media`. Sub-secciones internas observadas: `users`, `top-users`, `leads`, `distributions`, `post-health`, `system`.

## 3.2 Sidebar principal (Generación B) — CONFIRMED `[DOCS-7 t=0s]`

Encabezado: logotipo **Fastlane** + botón de colapsar/expandir.

**Bloque primario (orden exacto):**
1. `Home` (icono casa)
2. `Engagement` (icono personas)
3. `Blitz` (icono cohete)
4. `AI Studio` (icono varita)
5. `Influencers` (icono persona)
6. `Content` (icono claqueta)
7. `Library` (icono libros)
8. `Calendar` (icono calendario)
9. `Analytics` (icono barras)
10. `Warmed Accounts` (icono personas)

**Bloque secundario (separado, abajo):**
11. `Admin` (sólo staff — omitir en el clon o gatear por rol)
12. `Refer & Earn` (icono regalo)
13. `Brand` (icono maletín)
14. `Guide` (icono mapa)
15. `Feedback` (icono bocadillo)
16. `Discord` (icono Discord → enlace externo `https://discord.gg/aaAQ9VzQ6j`)
17. `Settings` (icono engranaje, **con indicador de punto rojo** cuando hay acción pendiente)

**Requisito de implementación FR-001:** el sidebar es colapsable a sólo-iconos; en estado colapsado, el hover muestra un tooltip con el label (`Calendar`, `Content`, …). CONFIRMED `[DOCS-6 t=120s]`, `[DOCS-2 t=354s]`

Widget flotante de soporte (burbuja naranja) fijo en la esquina inferior derecha en todas las páginas. CONFIRMED `[DOCS-7]`

### 3.2.1 Sidebar legacy (Generación A) — referencia
Orden: Home · (person-search = Inspiration) · Blitz (cohete) · Content (claqueta) · Library · Calendar · Analytics; bloque inferior: shield (Admin) · maletín (Brand/Profile) · mapa (Guide) · bocadillo (Feedback) · Discord · Settings. CONFIRMED `[DOCS-1 t=9s]`

## 3.3 Navegación secundaria por módulo

| Módulo | Navegación interna |
|---|---|
| Content Studio (legacy) | Tabs superiores: `Green Screen Meme` · `Wall of Text` · `Video Hook & Demo` · `Slideshow`. CONFIRMED `[DOCS-5 t=0s]`. En `manual-creation-demo` el orden es `Slideshow` · `Wall of Text` · `Video Hook & Demo` · `Green Screen Meme`. |
| Content Studio (actual) | Hub `/content` con tarjetas por formato (label + description + poster + video de ejemplo). CONFIRMED `[APP]` |
| Influencer detail | Tabs: `Images` · `Videos` · `Configuration` + enlace `Configure in Blitz →`. Query param `?tab=`. CONFIRMED `[DOCS-7 t=138s/156s/198s]` |
| Library | Tabs: `My Posts` · `My Content` · `My Media Bank` + botón `What is this?`. CONFIRMED `[DOCS-7 t=375s]` |
| Engagement | Sub-rutas `actions` e `insights`. CONFIRMED `[APP]` |
| Settings | Secciones por id: `account`, `workspaces`, `integrations`, `warmed-accounts`, `notifications`, `preferences`, `billing`, `api`. CONFIRMED `[APP]` |
| Automations | Listado → `new` (wizard) → `:id` (detalle) → `:id/edit`. CONFIRMED `[APP]` |
| Blitz | Botón flotante `Configure` (engranaje, esquina superior derecha) → `/blitz/settings`. CONFIRMED `[DOCS-7 t=342s]` |

## 3.4 Inventario de modales y drawers

| ID | Nombre exacto | Origen | Evidencia |
|---|---|---|---|
| M-01 | `Select Video` (tabs `Library` / `My Videos`, chips de filtro, toggle `Tags`, paginación `Page X of Y`, `Cancel`) | Blitz Edit → Swap Video; Studio → Select a video | `[DOCS-B t=84s]`, `[DOCS-3 t=66s]` CONFIRMED |
| M-02 | `Select Audio` (lista de pistas con nombre, `Cancel`) | Studio → Select audio; Blitz Edit → Swap Audio | `[DOCS-4 t=72s]` CONFIRMED |
| M-03 | `Swap image for slide N` (tabs `Theme Images` / `My Images`, selección con check, footer `New image selected`, `Cancel` / `Swap`) | Studio Slideshow → Swap Image | `[DOCS-5 t=75s]` CONFIRMED |
| M-04 | `What would you like to do?` — `Step 1 of 3` (opciones `Save to Library` / `Schedule Post`, `Cancel`) | Blitz → aprobar | `[DOCS-B t=174s]` CONFIRMED |
| M-05 | `Select Platforms` — `Step 1 of 2` (checkboxes por plataforma + menú `...` con `Posting Mode`) | Studio → Schedule | `[DOCS-5 t=96s]`, `[DOCS-3 t=198s]` CONFIRMED |
| M-06 | `Content Details` — `Step 3 of 4` (campos por plataforma, contadores, `Improve`, `Regenerate`) | Blitz/Studio → Schedule | `[DOCS-B t=201s]`, `[DOCS-7 t=429s]` CONFIRMED |
| M-07 | `Schedule` — `Step 4 of 4` / `Step 3 of 3` (Select Time + Select Date + disclaimers) | Blitz/Studio → Schedule | `[DOCS-B t=210s]`, `[DOCS-2 t=318s]` CONFIRMED |
| M-08 | `New influencer (1/3 · 2/3 · 3/3)` | Influencers → New influencer | `[DOCS-7 t=15s/48s/81s]` CONFIRMED |
| D-01 | Panel de detalle de imagen generada (PROMPT, MODEL, ASPECT, RESOLUTION, BATCH, CREDITS, CREATED, `Download`, `ANIMATE THIS IMAGE`) | Influencer → Images → click | `[DOCS-7 t=138s]` CONFIRMED |
| D-02 | Drawer `Preferences` de Blitz (legacy) | Blitz → engranaje | `[DOCS-B t=150s]` CONFIRMED |
| D-03 | Panel `Why This Content` (bullets de explicación IA) | Blitz → `Why This Content?` | `[DOCS-B t=21s]` CONFIRMED |
| D-04 | Panel `Remixed From` (video fuente + likes + views + carrusel) | Blitz (sólo remixes) | `[DOCS-B t=3s]` CONFIRMED |
| D-05 | Inspector de edición derecho (Dimensions / Text / acciones de media) | Blitz Edit y Studio Preview | `[DOCS-7 t=363s]`, `[DOCS-5 t=39s]` CONFIRMED |
| D-06 | Barra flotante de generación (prompt + `Template` + `Generate`) | Influencer Images/Videos, AI Studio | `[DOCS-7 t=111s/156s]` CONFIRMED |

## 3.5 Toasts observados (copy literal)

- `Building post!` + enlace `View in Library` `[DOCS-B t=216s]`
- `Content saved!` + `View in Library` `[DOCS-B t=234s]`
- `Posting in ~5 minutes!` + `View in Library` `[DOCS-7 t=447s]`
- `Building post! It may take a few minutes to appear on TikTok.` + `View in Library` `[DOCS-manual t=36s]`
- `All changes saved` (banner persistente en Blitz Settings y en Influencer Configuration) `[DOCS-7 t=198s/291s]`
- `Subscription activated!` `[APP]`
- `Thanks for your feedback!` `[APP]`
- `Workspace ready!` `[APP OnboardingPage]`

## 3.6 Superficie V2 / "Fastlane OS" (fuera de alcance, señal de roadmap)

Rutas presentes en `V2Root-GqOGKuPl.js`, servidas bajo `/v2/*` y en el host `os.usefastlane.ai` (tema oscuro forzado, `#0d0d0d`): `home`, `home/:threadId`, `agent`, `agent/:threadId`, `activity`, `analytics`, `calendar`, `campaigns`, `campaigns/calendar`, `campaigns/runs/:runId`, `genesis`, `onboarding`, `refer`, `roadmap`, `settings`, `settings/:section`, `settings/integrations/ad-account`, `settings/integrations/warmed-accounts`, `strategy`, `strategy/:segmentId/plan`, `studio`, `studio/create`, `studio/create/:format`, `studio/create/ai`, `studio/influencers`, `studio/influencers/:influencerId`, `studio/library`, `support`. CONFIRMED `[APP]`. Comportamiento: UNKNOWN.


---

# 4. User Roles & Permissions

> **Nota de confianza:** Fastlane no expone públicamente una matriz de roles. Lo que sigue combina hechos CONFIRMED/SUPPORTED con una reconstrucción INFERRED mínima y suficiente para implementar.

## 4.1 Roles

| Rol | Existencia | Evidencia |
|---|---|---|
| **Anonymous** | CONFIRMED | Rutas `/login`, `/signup`, `/status`, callbacks OAuth neutrales |
| **Workspace Owner** | SUPPORTED | *"The connector is available only to the paid owner of a direct Fastlane workspace. Members, free accounts, and Partner-created workspaces cannot use it."* `[DEV MCP]` |
| **Workspace Member** | SUPPORTED | Misma cita: existen "Members" distintos del owner |
| **Special user (invited)** | INFERRED | String `Failed to create special user from invite:` `[APP]` — existe un flujo de invitación que crea un usuario con capacidades acotadas |
| **Partner** | SUPPORTED | Partner API keys, `X-Fastlane-Workspace-Id`, workspaces "Partner-created", billing por evento `[DEV]` |
| **Staff / Admin (vendor)** | CONFIRMED | Rutas `/admin/*` y entrada `Admin` en sidebar `[APP]`, `[DOCS-7 t=0s]` — fuera de alcance del clon |

## 4.2 Matriz de permisos (especificación normativa para el clon)

| Capacidad | Owner | Member | Partner (sobre workspaces que provisiona) | Anonymous |
|---|:--:|:--:|:--:|:--:|
| Ver Home / Analytics / Library / Calendar | ✅ | ✅ | ✅ (vía API) | ❌ |
| Ejecutar Blitz (swipe, aceptar) | ✅ | ✅ | ✅ | ❌ |
| Editar contenido y regenerar copy | ✅ | ✅ | ✅ | ❌ |
| Programar y cancelar posts | ✅ | ✅ | ✅ | ❌ |
| Crear/editar Content Angles y Blitz Preferences | ✅ | ✅ | ✅ | ❌ |
| Crear/entrenar Influencers (consume créditos) | ✅ | ⚠️ INFERRED: sí, sujeto a créditos del workspace | ✅ | ❌ |
| Conectar/desconectar cuentas sociales | ✅ | ⚠️ INFERRED: sí | ✅ (partner-connect) | ❌ |
| Aprobar/gestionar Warmed Accounts y decisiones de reemplazo | ✅ (owner) | ❌ SUPPORTED: `replacementDecisions` "awaiting the workspace owner" `[DEV]` | ⚠️ | ❌ |
| Crear/revocar API keys | ✅ | ⚠️ UNKNOWN | ✅ (partner keys) | ❌ |
| Usar el MCP OAuth connector | ✅ (sólo owner de pago, workspace directo) | ❌ SUPPORTED | ❌ SUPPORTED | ❌ |
| Cambiar de plan / gestionar billing | ✅ | ❌ INFERRED | N/A (billing por usage) | ❌ |
| Borrar workspace | ✅ | ❌ INFERRED | ⚠️ | ❌ |
| Borrar cuenta de usuario | ✅ (propia) | ✅ (propia) | — | ❌ |
| Lanzar / cancelar Automations | ✅ | ⚠️ INFERRED: sí | ✅ | ❌ |

## 4.3 Diferencias de UI por rol

- **Member:** `Settings → Billing` y `Settings → API` ocultos o en modo lectura; la tarjeta de Warmed Accounts muestra "awaiting owner approval" sin acciones. INFERRED.
- **Free / trial:** el contenido pasa a modo view-only al agotar cuota — copy literal: `Your content is view-only. Upgrade to create and publish again.` CONFIRMED `[APP]`. Además: `Warmed accounts are unavailable on trial` y `Your trial can only post to your own connected accounts. Remove the warmed accounts or upgrade to launch.` CONFIRMED `[APP AutomationWizard]`.
- **Plan sin AI Studio:** `Your current plan doesn't include AI Studio. Upgrade to use it.` CONFIRMED `[APP AiStudioPage]`.
- **Plan sin Automations:** los MCP tools de Automations devuelven `forbidden`; en UI debe ocultarse el módulo. SUPPORTED `[DEV]`.
- **Staff:** entrada `Admin` visible en el sidebar. CONFIRMED.

**FR-002 (permissions):** toda comprobación de permiso debe ejecutarse en el servidor. El cliente sólo oculta/deshabilita. Los recursos son siempre *workspace-scoped*: cualquier acceso cruzado debe devolver `404 not_found` (no `403`), tal y como hace el original — *"content doesn't exist or isn't in your workspace"*. SUPPORTED `[DEV]`

---

# 5. Complete Feature Inventory

Formato: `ID · nombre · descripción · objetivo · módulo · entry point · rol · dependencias · evidencia · confianza`.

## MOD-001 — Authentication & Onboarding

| ID | Nombre | Descripción | Entry point | Dependencias | Evidencia | Conf. |
|---|---|---|---|---|---|---|
| F-001 | Sign up | Alta de cuenta vía Clerk (email/password + SSO) | `/signup` | — | `[APP]` | CONFIRMED |
| F-002 | Sign in | Login, incluye `/auth/sso-callback` | `/login` | F-001 | `[APP]` | CONFIRMED |
| F-003 | Logout | Cierre de sesión | `/logout`, sidebar | F-002 | `[APP]` | CONFIRMED |
| F-004 | Website analysis onboarding | Introducir URL → la IA analiza el negocio y crea el workspace | `/onboarding` | F-002 | `[APP OnboardingPage]` | CONFIRMED |
| F-005 | Manual brand context | Alternativa sin website: describir la marca a mano (`Use description instead`) | `/onboarding` | F-004 | `[APP]` | CONFIRMED |
| F-006 | Profiling questionnaire | Rol, tamaño de equipo, modelo de negocio, categorías, revenue, expectativas | `/onboarding` | F-004 | `[APP]` | CONFIRMED |
| F-007 | Logo upload | Subida opcional de logo de empresa | `/onboarding`, `/brand` | F-004 | `[APP]` | CONFIRMED |
| F-008 | Workspace creation | Creación del workspace con límite de creación por usuario | `/onboarding` | F-004 | `[APP]` | CONFIRMED |
| F-009 | Workspace switching | Cambiar entre workspaces del usuario | Sidebar / Settings | F-008 | `[APP]` | CONFIRMED |
| F-010 | Quick start guide | Checklist de onboarding en Home que desaparece al completarse | `/home` | F-008 | `[DOCS-1 t=24s]` | CONFIRMED |
| F-011 | Account deletion | Borrado permanente de cuenta con confirmación por email | `/settings` → account | F-002 | `[APP]` | CONFIRMED |
| **F-012** | **Brand Source: perfil social como origen de marca** | Analizar Instagram, TikTok, X, YouTube o LinkedIn para derivar la identidad, sin necesidad de web | `/onboarding`, `/brand` | F-002 | `FR-011` | **EXTENSION** |
| **F-013** | **Detección automática de plataforma** | Un único input deduce el origen de una URL o un `@handle` y normaliza a forma canónica | `/onboarding`, `/brand` | F-012 | `FR-011.1` | **EXTENSION** |
| **F-014** | **Multi-source con fusión y precedencia** | Hasta 5 fuentes por workspace, una primaria, con resolución explícita de conflictos | `/brand` | F-012 | `FR-011.6` | **EXTENSION** |
| **F-015** | **Cierre de huecos por preguntas** | Los campos de baja confianza se completan preguntando, nunca inventando | `/onboarding` | F-012 | `FR-011.3` | **EXTENSION** |
| **F-016** | **Reutilización de cuentas OAuth como fuente** | Conectar una cuenta ofrece analizarla para mejorar el perfil de marca | `Settings → integrations` | F-012, F-232 | `FR-011.5` | **EXTENSION** |
| **F-017** | **Importación de posts propios al Media Bank** | Opt-in: sembrar el Media Bank con el contenido real de la marca | `Settings → integrations` | F-016, F-125 | `FR-011.5.1` | **EXTENSION** |

## MOD-002 — Brand / Company Profile

| ID | Nombre | Descripción | Entry point | Evidencia | Conf. |
|---|---|---|---|---|---|
| F-020 | Company Profile view | Perfil generado por IA en secciones editables | `/brand` (legacy `/profile`) | `[DOCS-6 t=81s]` | CONFIRMED |
| F-021 | Section editing | Botón `Edit` por sección (Identity & Product, Market & Competition, …) | `/brand` | `[DOCS-6 t=81s]` | CONFIRMED |
| F-022 | Brand revision tracking | `brandRevision` entero que invalida sugerencias generadas antes de un cambio | API | `[DEV POST /blitz/angles/generate]` | SUPPORTED |
| F-023 | Re-analyse website | Volver a analizar la URL para refrescar el perfil | `/brand` | `[APP]` (`Failed to reset website:`) | INFERRED |
| **F-024** | **Brand sources management** | Listar, añadir, re-analizar, marcar como primaria y eliminar fuentes | `/brand` | `FR-020`, `FR-011` | **EXTENSION** |
| **F-025** | **Trazabilidad por campo** | Cada campo del perfil muestra de qué fuente salió y con qué confianza, con acceso al extracto citado | `/brand` | `FR-011.2` | **EXTENSION** |
| **F-026** | **Snapshot staleness** | Una fuente con más de 90 días se marca `stale` y se ofrece refrescarla | `/brand` | `FR-011.8` | **EXTENSION** |

## MOD-003 — Home / Dashboard

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-030 | KPI tiles | `Engaged Leads`, `Content Posted`, `Total Views`, `Total Likes`, `Total Comments` | `[DOCS-6 t=72s]` | CONFIRMED |
| F-031 | Views History chart | Serie temporal de views con selector de rango (`Monthly`) | `[DOCS-6 t=72s]` | CONFIRMED |
| F-032 | Enable website analytics CTA | Botón para activar el script de tracking | `[DOCS-6 t=72s]` | CONFIRMED |
| F-033 | Tasks card | Tareas sugeridas con progreso (`Suggested · Reply to leads · 0/5`) y contador de completadas | `[DOCS-6 t=72s]` | CONFIRMED |
| F-034 | Trending Content feed | Carrusel/grid de contenido en tendencia con chips de nicho y `Remix` | `[DOCS-1 t=81s]`, `[DOCS-6 t=72s]` | CONFIRMED |
| F-035 | Performance card (legacy) | Views + Posts acumulados 7 días, dual-axis, `View analytics →` | `[DOCS-1 t=9s]` | CONFIRMED |
| F-036 | Weekly Posts goal (legacy) | Objetivo semanal de posts con progreso y `Schedule posts →` | `[DOCS-1 t=9s]` | CONFIRMED |
| F-037 | Home FAQ | 5 categorías de preguntas plegables | `[DOCS-1 t=126s]` | CONFIRMED |
| F-038 | Community links | Discord + "book a call" | `[DOCS-1 t=147s]` | CONFIRMED |

## MOD-004 — Inspiration / Trending Library

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-040 | Inspiration browser | Librería de contenido en tendencia con búsqueda y filtro por nicho, `Updated daily` | `[APP InspirationPage]` | CONFIRMED |
| F-041 | Trending content ingestion | Ingesta/curación del catálogo (25 000+ items, tagged por nicho + analytics). **Mecanismo de etiquetado: `DP-001` / `JV-1` (§25).** | `[WWW]` | SUPPORTED (qué) / EXTENSION (cómo) |
| F-042 | Remix from trending | `Remix this` → abre el Studio con la fuente precargada | `[APP]`, `[DOCS-manual t=0s]` | CONFIRMED |
| F-043 | Open original | Abrir el permalink público original | `[APP]` | CONFIRMED |
| F-044 | Slideshow preview in cards | Navegación por slides dentro de la tarjeta (dots + flechas) | `[DOCS-1 t=81s]` | CONFIRMED |
| F-045 | Engagement overlays | Views y likes sobre cada tarjeta | `[DOCS-1 t=81s]` | CONFIRMED |

## MOD-005 — Blitz (núcleo del producto)

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-050 | Discovery queue | Cola rodante de ~5 sugerencias auto-rellenada en background | `[DEV]` | SUPPORTED |
| F-051 | Swipe deck | Stack de tarjetas; swipe derecha = aprobar, izquierda = rechazar | `[DOCS-B t=3s]` | CONFIRMED |
| F-052 | Keyboard shortcuts | ← rechazar, → aprobar | `[DOCS-B t=3s]` | CONFIRMED |
| F-053 | Content type badge | Chip con el tipo (`Slideshow`, `Wall of Text`, …) | `[DOCS-B t=3s]` | CONFIRMED |
| F-054 | Influencer & angle chips | Chips `👤 <influencer>` y `<angle title>` cuando aplica | `[DOCS-7 t=342s]` | CONFIRMED |
| F-055 | Why This Content? | Explicación IA en bullets de por qué se eligió la pieza | `[DOCS-B t=21s]` | CONFIRMED |
| F-056 | Remixed From panel | Fuente original con likes y views | `[DOCS-B t=3s]` | CONFIRMED |
| F-057 | Mute / Unmute | Alternar audio de la previsualización | `[DOCS-B t=3s]` | CONFIRMED |
| F-058 | Inline editor | Edición sin salir de Blitz (assets, copy, tipografía, slides) | `[DOCS-B t=99s]`, `[DOCS-7 t=363s]` | CONFIRMED |
| F-059 | Regenerate Text | Regenerar la copy con un prompt opcional | `[DOCS-B t=99s]` | CONFIRMED |
| F-060 | Mention business toggle | `Yes`/`No` por pieza | `[DOCS-B t=99s]` | CONFIRMED |
| F-061 | Swap video / audio / image | Reemplazar assets desde librería o propios | `[DOCS-B t=84s]` | CONFIRMED |
| F-062 | Blitz Preferences (drawer legacy) | Mezcla de tipos, remix ratio, mention business | `[DOCS-B t=150s]` | CONFIRMED |
| F-063 | Blitz Settings page | Configuración completa: influencers, voice & angles, visual sources, content mix | `[DOCS-7 t=291s]` | CONFIRMED |
| F-064 | Accept → Save to Library | Guardar sin programar | `[DOCS-B t=174s]` | CONFIRMED |
| F-065 | Accept → Schedule Post | Programar en una o varias plataformas | `[DOCS-B t=174s]` | CONFIRMED |
| F-066 | Daily swipe cap | Cuota diaria de swipes, reset 00:00 UTC | `[DEV]` | SUPPORTED |
| F-067 | On-demand type generation | Forzar un `contentType` concreto en lugar de tomar el siguiente de la cola | `[DEV POST /blitz]` | SUPPORTED |
| F-068 | Aspect ratio override | `1:1 / 4:5 / 3:4 / 9:16` (sólo slideshow, default `4:5`) | `[DEV]` | SUPPORTED |

## MOD-006 — Content Studio

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-070 | Format hub | Catálogo de 22 formatos con label, descripción, poster y video de ejemplo | `[APP]` | CONFIRMED |
| F-071 | Remix mode | Partir de un contenido en tendencia | `[DOCS-5 t=0s]` | CONFIRMED |
| F-072 | Create New mode | Partir de cero eligiendo assets | `[DOCS-3 t=102s]` | CONFIRMED |
| F-073 | Stepper wizard | Pasos con check de completitud; `Generate` deshabilitado hasta cumplir requisitos | `[DOCS-5 t=0s]` | CONFIRMED |
| F-074 | Trending Content picker | Carrusel paginado (`3 / 72`) con chips de nicho y botón `Remix` | `[DOCS-5 t=12s]` | CONFIRMED |
| F-075 | Preview + inspector | Vista previa del render con panel de edición de texto y media | `[DOCS-5 t=39s]` | CONFIRMED |
| F-076 | Slide navigation | Navegar slides con ‹ › y dots | `[DOCS-5 t=51s]` | CONFIRMED |
| F-077 | Swap image per slide | Modal `Swap image for slide N` (Theme Images / My Images) | `[DOCS-5 t=75s]` | CONFIRMED |
| F-078 | Wall-of-text styles | Selector `Select a style` (p. ej. `Storytime`, `Quick Thought`) | `[DOCS-3 t=102s]`, `[DOCS-manual t=36s]` | CONFIRMED |
| F-079 | Demo video selection | Elegir el video de demo del producto + enlace `Need help recording? See how ↗` | `[DOCS-4 t=6s]` | CONFIRMED |
| F-080 | Audio picker | Modal `Select Audio` con catálogo de pistas nombradas | `[DOCS-4 t=72s]` | CONFIRMED |
| F-081 | Save to library | Guardar el contenido generado | `[DOCS-2 t=204s]` | CONFIRMED |
| F-082 | Schedule from Studio | Flujo `Select Platforms → Content Details → Schedule` | `[DOCS-2 t=216s]` | CONFIRMED |
| F-083 | Custom upload | Subir video propio como contenido | `[APP]`, `[DEV /content/custom/video]` | CONFIRMED |
| F-084 | AI format library | 17 formatos generativos adicionales (claymation, lego, news anchor, …) | `[APP]` | CONFIRMED |

### F-070/F-084 — Catálogo exacto de formatos (labels y descripciones literales) CONFIRMED `[APP]`

| `id` | `label` | `description` | `path` |
|---|---|---|---|
| `slideshow` | Slideshow | Multi-image carousel with captions | `/content/slideshow` |
| `wall-of-text` | Wall of Text | Bold text on a plain background | `/content/wall-of-text` |
| `video-hook-and-demo` | Video Hook & Demo | Hook clip + app demo stitched together | `/content/video-hook-and-demo` |
| `green-screen-meme` | Green Screen Meme | Trending video with your background image | `/content/green-screen-meme` |
| `custom` | Custom | Upload your own video or image | `/content/custom` |
| `speaking-hook` | Speaking Hook & Demo | Someone says the hook out loud, then your demo | `/content/speaking-hook` |
| `talking-head-ugc` | Talking Head UGC | AI avatar speaks a script to camera | `/content/talking-head-ugc` |
| `talking-head-green-screen` | Talking Head Green Screen | AI avatar composited into the corner of a demo video | `/content/talking-head-green-screen` |
| `notes-green-screen` | Notes Green Screen | A presenter with a mic talks over an iOS Notes list | `/content/notes-green-screen` |
| `green-screen-mobile-app` | Green Screen Mobile with App | A presenter holding a phone with your app on screen | `/content/green-screen-mobile-app` |
| `product-spokesperson` | Product Spokesperson | A character holds your product and talks about it | `/content/product-spokesperson` |
| `street-interview` | Street Interview | Impromptu street vox-pop that looks like unedited iPhone footage | `/content/street-interview` |
| `news-anchor` | AI News Anchor | A news anchor breaks your customer's problem as tonight's top story | `/content/news-anchor` |
| `talking-objects` | Talking Objects | A niche object talks straight at the viewer to drive the point home | `/content/talking-objects` |
| `on-a-walk` | On a Walk | Your text over a generated walking selfie | `/content/on-a-walk` |
| `cutting-fruit` | Cutting Fruit | Your text over a generated kitchen clip | `/content/cutting-fruit` |
| `netflix-documentary` | Netflix Documentary | Your text over a generated interview clip | `/content/netflix-documentary` |
| `claymation` | Claymation | Stop-motion clay ad with narration and captions | `/content/claymation` |
| `lego` | Lego | Stop-motion Lego brick ad with narration and captions | `/content/lego` |
| `felt` | Felt | Stop-motion felt ad with narration and captions | `/content/felt` |
| `skeleton` | Skeleton | Educational skeleton video with narration and captions | `/content/skeleton` |
| `character-swap` | Character Swap | Swap the character in a video using AI | `/content/character-swap` |

## MOD-007 — Influencers (AI characters)

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-090 | Influencer list | Grid de personajes con nombre, estado y `gender · age · ethnicity` | `[DOCS-7 t=0s]` | CONFIRMED |
| F-091 | Create influencer wizard | 3 pasos: describir → generar/validar base image → confirmar coste y crear | `[DOCS-7 t=15s]` | CONFIRMED |
| F-092 | Upload own base image | Alternativa a generar: `Upload your own` | `[DOCS-7 t=15s]`, `[DEV]` | CONFIRMED |
| F-093 | Regenerate base character | Nuevo personaje (no edición) con instrucciones opcionales, 4 créditos | `[DOCS-7 t=48s]` | CONFIRMED |
| F-094 | Async training | 15–20 min; estados `generating_variations` → `training` → `ready`/`failed` con `progress` 0–100 | `[DOCS-7 t=81s]`, `[DEV]` | CONFIRMED |
| F-095 | Continue influencer creation | Reanudar un wizard interrumpido | `[DOCS-7 t=0s]` | CONFIRMED |
| F-096 | Image generation | Prompt libre + `Template` → imágenes del personaje (4 créditos, ~30–60 s) | `[DOCS-7 t=111s]` | CONFIRMED |
| F-097 | Video generation | Tab `Video`: prompt de movimiento, modelo, duración 5s/10s (60 créditos, ~1–3 min) | `[DOCS-7 t=156s]` | CONFIRMED |
| F-098 | Talking Head UGC | Tab con `Script`, `Duration`, `Language`, `Caption overlay` | `[DOCS-7 t=138s]` | CONFIRMED |
| F-099 | Animate this image | Convertir una imagen en video desde su detalle o al hover | `[DOCS-7 t=138s/246s]` | CONFIRMED |
| F-100 | Asset management | Borrar imágenes/videos individualmente | `[DOCS-7 t=111s]` | CONFIRMED |
| F-101 | Configuration: content angles | Restringir la copy de Blitz a ángulos concretos cuando aparece el influencer | `[DOCS-7 t=198s]` | CONFIRMED |
| F-102 | Configuration: publishing accounts | Cuentas por plataforma desde las que publica este influencer | `[DOCS-7 t=198s]` | CONFIRMED |
| F-103 | Configuration: slideshow/video sets | Fuentes de imagen y video para contenido con influencer | `[DOCS-7 t=198s]` | CONFIRMED |
| F-104 | Configure in Blitz | Enlace directo a `/blitz/settings` | `[DOCS-7 t=198s]` | CONFIRMED |
| F-105 | Delete influencer | Borrado con confirmación; libera slot del cap de 50 | `[DOCS-7 t=111s]`, `[DEV]` | CONFIRMED |
| F-106 | Credits balance + Buy more | Saldo de créditos y compra | `[DOCS-7 t=111s]` | CONFIRMED |

## MOD-008 — AI Studio

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-110 | Free-form generation | Generar imágenes/videos con prompt, contador de imágenes y referencias | `[APP AiStudioPage]` | CONFIRMED |
| F-111 | Reference images | `composition reference`, `product image`, `person reference` | `[APP]` | CONFIRMED |
| F-112 | Generation queue limit | Máximo 10 generaciones en vuelo simultáneas | `[APP]` | CONFIRMED |
| F-113 | Content filter | Bloqueo por prompt o imagen; mensajes específicos | `[APP]` | CONFIRMED |
| F-114 | How to use AI Studio | Panel de ayuda embebido | `[APP]` | CONFIRMED |
| F-115 | Plan gating | Bloqueado en planes sin AI Studio | `[APP]` | CONFIRMED |

## MOD-009 — Library & Media Bank

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-120 | My Posts | Grid de posts con plataforma, cuenta, estado, fecha, tipo y métricas | `[DOCS-6 t=21s]` | CONFIRMED |
| F-121 | Refresh Metrics | Forzar sincronización de métricas | `[DOCS-6 t=21s]` | CONFIRMED |
| F-122 | Select / bulk mode | Modo de selección múltiple sobre la grid | `[DOCS-6 t=21s]` | CONFIRMED |
| F-123 | Reschedule / Cancel | Acciones por post en hover | `[DOCS-2 t=345s]` | CONFIRMED |
| F-124 | My Content | Contenido guardado no programado, con `Created:` y tipo | `[DOCS-6 t=27s]` | CONFIRMED |
| F-125 | My Media Bank | Assets propios con filtros, categorías, tamaño y fecha | `[DOCS-7 t=375s]` | CONFIRMED |
| F-126 | Drag & drop upload | `Drop images or videos here` — JPG, PNG, WebP, MP4 | `[DOCS-7 t=375s]` | CONFIRMED |
| F-127 | Media sets | Conjuntos curados (`SLIDESHOW`, `VIDEO`, `CURATED`) + `New set`, con **mínimo 5 assets** | `[DOCS-7 t=375s / t=237s]` | CONFIRMED |
| F-128 | Influencer filter | Filtrar el banco por influencer | `[DOCS-7 t=375s]` | CONFIRMED |
| F-129 | Media categories | `slideshow-image`, `green-screen-background`, `background-video`, `hook-video`, `green-screen-video` | `[DEV /media]` | SUPPORTED |
| F-130 | Demo assets | Assets de demo del producto marcados con badge `Demo` | `[DOCS-7 t=375s]` | CONFIRMED |

## MOD-010 — Calendar

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-140 | Month view | Cuadrícula mensual con navegación ‹ › y título `MMMM YYYY` | `[DOCS-6 t=0s]` | CONFIRMED |
| F-141 | Post chips | Chip por post: icono de plataforma + tipo + hora, coloreado por plataforma | `[DOCS-6 t=0s]` | CONFIRMED |
| F-142 | Per-day counter | `(N posts)` junto al número de día | `[DOCS-6 t=0s]` | CONFIRMED |
| F-143 | Status counters | Contadores globales en cabecera: posted (✓), inbox, scheduled | `[DOCS-6 t=0s]` | CONFIRMED |
| F-144 | View switcher | Alternar vista (grid/calendar) | `[APP AutomationWizard: Calendar view / Grid view]` | CONFIRMED |

## MOD-011 — Scheduling & Publishing

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-150 | Platform selection | Checkboxes multi-plataforma con opciones por plataforma | `[DOCS-3 t=198s]` | CONFIRMED |
| F-151 | TikTok posting mode | `Send to Inbox` (default) / `Post Directly` | `[DOCS-5 t=96s]`, `[DEV]` | CONFIRMED |
| F-152 | TikTok privacy level | `PUBLIC_TO_EVERYONE` / `MUTUAL_FOLLOW_FRIENDS` / `FOLLOWER_OF_CREATOR` / `SELF_ONLY` | `[DOCS-7 t=429s]`, `[DEV]` | CONFIRMED |
| F-153 | Per-platform copy | Caption (IG 2200), Title (TikTok 90), Description (TikTok 4000) | `[DOCS-7 t=429s]` | CONFIRMED |
| F-154 | Improve / Regenerate copy | Acciones IA por campo de texto | `[DOCS-7 t=429s]` | CONFIRMED |
| F-155 | Auto-Add Music | Toggle para que TikTok añada música en tendencia al slideshow | `[DOCS-7 t=429s]` | CONFIRMED |
| F-156 | Date & time picker | Hora (h:mm + AM/PM) + calendario mensual | `[DOCS-B t=210s]` | CONFIRMED |
| F-157 | Post now | Publicar inmediatamente | `[DOCS-B narración]` | CONFIRMED |
| F-158 | Instagram slideshow format | `carousel` / `reel` (sólo warmed) | `[DEV]` | SUPPORTED |
| F-159 | TikTok commercial sounds | Selección de sonido para slideshows en cuentas warmed estándar | `[DEV /tiktok/sounds]` | SUPPORTED |
| F-160 | AI content disclaimer | Etiqueta nativa de contenido generado por IA | `[DEV]` | SUPPORTED |
| F-161 | Paid partnership disclosure | `disclose_as_ads` en cuentas warmed | `[DEV]` | SUPPORTED |
| F-162 | Batch cancel / delete | Cancelar o borrar hasta 100 posts de forma atómica | `[DEV]` | SUPPORTED |
| F-163 | Caption generation on schedule | `enableCaptionGeneration` rellena campos vacíos | `[DEV]` | SUPPORTED |

## MOD-012 — Analytics

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-170 | Cross-platform performance | `Track your content performance across all platforms.` con selector de días | `[APP AnalyticsPage]` | CONFIRMED |
| F-171 | Platform breakdown | `TikTok posts`, `Instagram posts`, `YouTube posts`, `LinkedIn posts`, `Reddit posts` | `[APP]` | CONFIRMED |
| F-172 | Content type breakdown | `Slideshow`, `Wall of Text`, `Green Screen`, `Hook & Demo` | `[APP]` | CONFIRMED |
| F-173 | Social website views | Tráfico web atribuido a social | `[APP]` | CONFIRMED |
| F-174 | Website analytics script | Script ligero de tracking activable/desactivable | `[APP]` | CONFIRMED |
| F-175 | Ad attribution | Atribución de anuncios (on/off) | `[APP]` | CONFIRMED |
| F-176 | Per-post metrics | `views`, `likes`, `comments`, `postUrl`, `postedAt` | `[DEV /analytics/posts]` | SUPPORTED |
| F-177 | Lifetime breakdowns | `Loading lifetime post breakdowns` | `[APP]` | CONFIRMED |

## MOD-013 — Warmed Accounts

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-180 | Purchase warmed account | $100/mes por cuenta + $1,50 por post | `[WWW]` | SUPPORTED |
| F-181 | Configure new account | Plataforma, país (US/EU), nicho y keywords; bloqueado tras el warming | `[WWW]`, `[APP]` | SUPPORTED |
| F-182 | Human warming | 5 días de actividad humana real en un teléfono real | `[WWW]` | SUPPORTED |
| F-183 | Account approval | El owner debe aprobar la cuenta antes de programar | `[APP]` | CONFIRMED |
| F-184 | Slot balance | `slotBalance` de posts disponibles | `[DEV]` | SUPPORTED |
| F-185 | Lead time enforcement | `minLeadTimeMs` por cuenta (hasta ~2 días); máx. 30 días de antelación | `[DEV]`, `[APP]` | SUPPORTED |
| F-186 | Posting availability states | `available` / `checking` / `replacement_needed` | `[DEV]` | SUPPORTED |
| F-187 | Replacement decisions | Decisiones pendientes cuando una cuenta es baneada | `[DEV]` | SUPPORTED |
| F-188 | Unified analytics | Analytics por cuenta warmed dentro del mismo dashboard | `[WWW]` | SUPPORTED |

## MOD-014 — Engagement (Reddit leads)

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-190 | Connect Reddit account | OAuth de Reddit | `[APP]` | CONFIRMED |
| F-191 | Lead discovery | Descubrimiento periódico de leads en subreddits configurados | `[APP]` | CONFIRMED |
| F-192 | Configure discovery subreddits | Selección de subreddits a monitorizar | `[APP]` | CONFIRMED |
| F-193 | Lead list & filters | `Most Engaged Leads`, `Top Scored Leads`, `Unseen only`, búsqueda | `[APP]` | CONFIRMED |
| F-194 | Lead detail | Post completo, `Why this lead?`, `View on Reddit` | `[APP]` | CONFIRMED |
| F-195 | AI reply generation | `Generate AI reply` / `Regenerate reply` con reglas personalizables | `[APP]` | CONFIRMED |
| F-196 | Reply settings | Tono y reglas propias (`Save Custom Rules`) | `[APP]` | CONFIRMED |
| F-197 | Ban risk meter | 4 niveles: Safe / Caution / Warning / Danger con recomendaciones | `[APP]` | CONFIRMED |
| F-198 | Thread monitoring | Seguimiento del hilo tras responder | `[APP]` | CONFIRMED |
| F-199 | Sync with Reddit | Verificación y actualización del estado del hilo | `[APP]` | CONFIRMED |
| F-200 | Value/promo ratio guidance | Recomendación 60-70 % valor / 20-30 % sutil / 10-20 % directo | `[APP]` | CONFIRMED |
| F-201 | Delete lead | Descartar un lead | `[APP]` | CONFIRMED |

## MOD-015 — Automations

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-210 | Create campaign | Campaña DRAFT gratuita | `[DEV]` | SUPPORTED |
| F-211 | Configure campaign | Cuentas destino, cadencia (1–3/día/cuenta), duración (1–4 semanas), fecha de inicio, timezone | `[DEV]` | SUPPORTED |
| F-212 | Content preferences snapshot | `prefsSnapshot` con pesos de tipo, remix, ángulos, estilos de caption, audio mix | `[DEV]` | SUPPORTED |
| F-213 | Generate slots | Generación asíncrona DRAFT → GENERATING → REVIEW | `[DEV]` | SUPPORTED |
| F-214 | Review slots | Editar texto, captions por plataforma y hora de publicación | `[DEV]` | SUPPORTED |
| F-215 | Re-roll slot | Regenerar una sugerencia (consume cuota) | `[DEV]` | SUPPORTED |
| F-216 | Launch validation | Gates: content budget, post slots, límite diario por cuenta, restricción de trial | `[DEV]`, `[APP]` | SUPPORTED |
| F-217 | Launch campaign | Reserva slots, cobra presupuesto y arranca los builds | `[DEV]` | SUPPORTED |
| F-218 | Monitor campaign | Totales de engagement y detalle por post | `[DEV]` | SUPPORTED |
| F-219 | Cancel / delete campaign | Cancelar publicación futura / borrar campaña no viva | `[DEV]` | SUPPORTED |
| F-220 | Calendar & grid views | Dos vistas de los slots en el wizard | `[APP]` | CONFIRMED |

## MOD-016 — Settings, Billing & Developers

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-230 | Account settings | Perfil, email, borrado de cuenta | `[APP]` | CONFIRMED |
| F-231 | Workspaces | Listado, cambio, creación, borrado | `[APP]` | CONFIRMED |
| F-232 | Integrations | Conectar/desconectar TikTok, Instagram, YouTube, LinkedIn, Reddit; multi-cuenta | `[APP]` | CONFIRMED |
| F-233 | Warmed accounts settings | Gestión y configuración de cuentas warmed | `[APP]` | CONFIRMED |
| F-234 | Notifications settings | Preferencias de notificación | `[APP]` | CONFIRMED |
| F-235 | Preferences | Timezone (sincronizada), tema, idioma | `[APP]` | CONFIRMED |
| F-236 | Billing | Plan actual, cambio de plan, próxima factura, portal de facturación, cancelación con feedback | `[APP]` | CONFIRMED |
| F-237 | Credit top-up | Compra de créditos con slider/input de cantidad | `[APP]` | CONFIRMED |
| F-238 | Content save top-up | `Buy saves` y `Buy posts` | `[APP]` | CONFIRMED |
| F-239 | API keys | Crear/revocar keys `fsln_live_*`, mostradas una sola vez | `[DEV]` | SUPPORTED |
| F-240 | API overage billing | Toggle de facturación por exceso | `[DEV]` | SUPPORTED |
| F-241 | AI connectors | Vincular el MCP OAuth connector a un workspace (`Use this workspace`) | `[DEV]` | SUPPORTED |
| F-242 | Partner keys | Keys de partner con etiqueta y revocación | `[APP]`, `[DEV]` | CONFIRMED |
| F-243 | Embedded API docs | Documentación de API dentro de la app (`/developers`) | `[APP]` | CONFIRMED |

## MOD-017 — Growth & Support

| ID | Nombre | Descripción | Evidencia | Conf. |
|---|---|---|---|---|
| F-250 | Refer & Earn | Programa de referidos (30 % recurrente de por vida) | `[APP]`, `[WWW]` | CONFIRMED |
| F-251 | Guide | Guía de uso in-app | `[APP]` | CONFIRMED |
| F-252 | Roadmap | Roadmap público de producto | `[APP]` | CONFIRMED |
| F-253 | Changelog | Registro de cambios | `[APP]` | CONFIRMED |
| F-254 | Feedback | Formulario de feedback con confirmación | `[APP]` | CONFIRMED |
| F-255 | Status page | Estado del servicio | `[APP]` | CONFIRMED |
| F-256 | Discord | Enlace a la comunidad | `[DOCS-1 t=147s]` | CONFIRMED |
| F-257 | Book a call | Agendar llamada con el equipo | `[DOCS-1 t=147s]` | CONFIRMED |
| F-258 | Support widget | Burbuja de soporte persistente | `[DOCS-7]` | CONFIRMED |


---

# 6. Functional Requirements

> Esta es la sección normativa. Cada `FR-XXX` es implementable y verificable. Las cadenas entre comillas son **copy literal** a reproducir.

## FR-010 — Onboarding con análisis de la marca

**Purpose.** Convertir **cualquier rastro público de la marca** en un workspace operativo con perfil de marca, para que el usuario llegue a Blitz con contenido ya generado.

> **Cambio respecto a Fastlane (EXT-001).** Fastlane admite exactamente **una** fuente automática: la URL del sitio web. Su única alternativa es escribir la descripción a mano (`Use description instead`). El clon generaliza el paso a un selector de **Brand Source**, donde una web es sólo uno de los orígenes posibles. El camino de web se conserva **idéntico** (misma copy, mismas validaciones, mismo comportamiento) — lo nuevo se suma, no reemplaza. La mecánica de análisis de perfiles sociales se especifica completa en `FR-011`.

**Entry points.** `/signup` → `/onboarding`; también `/onboarding` al crear un workspace adicional (`Create another workspace`).

**UI.** Wizard multi-paso a pantalla completa, con indicador de progreso (`Automation setup progress` análogo), botón `Exit setup` y `Log out`. Pasos y campos observados `[APP OnboardingPage]` CONFIRMED:

1. **Brand source** — paso de origen de marca.
   - *Comportamiento Fastlane (CONFIRMED, conservado):* input `Company Website`, botón `Analyse Website` (título de pantalla `Analyze your website`). Enlace `Use description instead` → rama manual: *"No website yet? Add the brand context we should use for content generation."*
   - *Ampliación del clon (EXTENSION):* sobre el mismo paso se añade un selector de origen. El título pasa a `Where can we learn about your brand?` y el campo acepta **una web, un enlace de perfil social o un @handle**. El sistema **detecta la plataforma automáticamente** a partir de lo pegado y no obliga a elegir nada antes de escribir. Detalle completo de UI, detección, validación y extracción en `FR-011`.
2. **Company details** — `Company Name`, `Company Description` (placeholder de ayuda: *"Describe what you sell, who it is for, why it matters, and the tone we should use."*), `Company Logo (optional)`. Nota: *"We use this to understand your brand and generate relevant content."* y *"We'll enhance your input with AI"*.
3. **Profiling** — `Select your role`; `How big is your current team?`; `Business model`; `Business category (select all that apply)`; `What is your current monthly revenue?`; `What do you expect from the platform? Select all that apply`. Selector genérico `Select one`.
4. **Processing** — estados en secuencia: `Analyzing company profile...` → `Processing with AI...` → `Creating Workspace...` → `Setting up your workspace...` → `Preparing workspace` → `Workspace ready!` → `Completing Setup...` → `Continue to Dashboard`.
5. **Path hint** — tarjetas de camino: `Blitz Mode` — *"Generate and schedule content at scale with AI"* y `Manual Creation` — *"Create and customize content step by step"*, con `Key benefits:`, `Problem solved:`, `Things to avoid:`.

**User flow.** `/signup` → verificación Clerk → `/onboarding` → **introducir una Brand Source** (web, perfil social o @handle) → `Analyse` → (IA rellena el perfil) → revisar/editar detalles, con los campos de baja confianza destacados → responder cuestionario → esperar preparación → `Continue to Dashboard` → `/home`.

**Variante sin ninguna fuente.** Si el usuario no tiene ni web ni perfil social, `Use description instead` sigue existiendo y produce una `Brand Source` de tipo `manual`. CONFIRMED (el enlace) / EXTENSION (que se modele como una source más).

**System behavior.**
- Al enviar la fuente: validar según su tipo, crear `company` en estado *draft*, crear la `BrandSource` y encolar un job de análisis que produce el Company Profile. Para `website` el job es scrape + LLM (CONFIRMED); para orígenes sociales es el pipeline de `AI-016` (EXTENSION).
- El resto del onboarding (detalles, cuestionario, preparación del workspace) es **idéntico sea cual sea el origen**. El tipo de fuente sólo cambia el extractor, no el resto del flujo.
- Mientras corre, la UI muestra los estados de progreso; el job persiste su estado para permitir recarga de página (`Failed to save progress:`, `Failed to retrieve onboarding data:` implican almacenamiento intermedio). CONFIRMED
- Al finalizar: crear el workspace real, sembrar `content angles` iniciales, arrancar el relleno de la discovery queue y marcar onboarding como completo.
- Si el análisis falla: *"Your company profile needs support before setup can finish."* + *"and create a support ticket so we can help."*

**Data.** Crea `User`, `Company/Workspace`, `CompanyProfile`, `OnboardingRecord` (con owner y payload). Lee nada previo. No borra.

**States.** `default` (formulario vacío) · `loading` (análisis en curso, con sub-estados textuales) · `success` (`Workspace ready!`) · `failed` (`Setup error occurred`, `Failed to complete setup. Please try again.`) · `resumable` (datos de onboarding persistidos).

**Validation** (copy literal, CONFIRMED para la rama web):
- `Website URL is required` · `Please enter a valid website URL` · `Localhost URLs are not allowed` · `Private IP addresses are not allowed` · `Blocked URL for security reasons` · `This website is already registered.`
- **EXTENSION** — validaciones adicionales para orígenes sociales en `FR-011`; el mensaje genérico del paso pasa a ser `Add a website or a social profile to continue` cuando no hay ninguna fuente y tampoco se eligió la rama manual.
- `Company name is required` · `Company name must be at least 2 characters` · `Full name is required` · `Name must be at least 2 characters`
- `Please select your role` · `Please tell us your role` · `Please select your team size` · `Please select your business model` · `Please select at least one business category` · `Please tell us your business category` · `Please select your monthly revenue`
- `Complete all three fields to continue.` · `Add your company details before finishing setup.` · `Each answer is limited to 4,000 characters.`
- Logo: `Failed to upload logo. Please try again.` · `The image could not be processed`
- Cuota: `You've reached your workspace creation limit. Please try again later.`

**Permissions.** Cualquier usuario autenticado. El creador queda como **owner** del workspace.

**Edge cases.** Website ya registrado en otro workspace → bloquear con mensaje. Usuario abandona a mitad → al volver, reanudar desde el paso guardado. Usuario cancela creación de workspace adicional → `Failed to abort new workspace:` / se conserva el workspace previo (`Keep workspace`, `Use current workspace`).

**Acceptance criteria.**
1. Introducir una URL pública válida crea un workspace con Company Profile no vacío en < 3 min.
2. Cada mensaje de validación listado se muestra en su condición exacta.
3. Recargar la página a mitad del wizard conserva el progreso.
4. Al terminar, `/home` muestra el quick-start y la discovery queue tiene ≥ 1 sugerencia lista en ≤ 5 min.
5. Un segundo intento con la misma URL en otro workspace muestra `This website is already registered.`
6. **EXTENSION** — un usuario que **sólo** pega `instagram.com/<handle>` (o `@handle` + plataforma detectada) completa el onboarding y llega a Blitz con contenido generado, **sin introducir ninguna URL de sitio web en ningún momento**. Este es el criterio de aceptación central de `EXT-001`.
7. **EXTENSION** — el resto del wizard (detalles, cuestionario, preparación) se comporta igual con origen `website` y con origen social; sólo cambia el extractor.

---

## FR-011 — Brand Sources: análisis de perfiles sociales (EXTENSION · EXT-001)

> **Toda esta sección es EXTENSION.** No existe en Fastlane. Es el requisito nuevo solicitado: que cualquiera pueda darse de alta rápido sin necesidad de tener una página web que explique su identidad de marca.

**Purpose.** Permitir que la identidad de marca se extraiga de **un perfil social o de cualquier enlace público**, con la misma profundidad con la que Fastlane la extrae de un sitio web, de modo que el onboarding no dependa de tener web.

**Entry points.**
- `/onboarding` → paso 1 (`FR-010`).
- `/brand` → tarjeta `Brand sources` → `+ Add source` (para añadir, re-analizar o quitar fuentes después del alta).
- `Settings → integrations` → al conectar una cuenta por OAuth, se ofrece usarla también como Brand Source (ver §FR-011.5).

### FR-011.1 — Orígenes soportados

| `sourceType` | Entrada aceptada | Ejemplos de entrada válida |
|---|---|---|
| `website` | URL http(s) | `miproducto.com`, `https://www.miproducto.com/es` |
| `instagram` | URL de perfil o `@handle` | `instagram.com/mimarca`, `@mimarca` |
| `tiktok` | URL de perfil o `@handle` | `tiktok.com/@mimarca`, `@mimarca` |
| `x` | URL de perfil o `@handle` | `x.com/mimarca`, `twitter.com/mimarca`, `@mimarca` |
| `youtube` | URL de canal, `@handle` o `/c/`, `/channel/` | `youtube.com/@mimarca` |
| `linkedin` | URL de company page o perfil | `linkedin.com/company/mimarca` |
| `other_url` | Cualquier URL pública que no encaje arriba | Linktree, Beacons, Notion público, Etsy, Shopify store, Google Business, Substack |
| `manual` | Texto libre escrito por el usuario | rama `Use description instead` |

**Alcance de la Fase 1 (D-02).** Las **cinco** plataformas sociales entran en la primera versión, más `website`, `other_url` y `manual`. No hay extractores diferidos.

**Detección automática de plataforma.** El campo es **uno solo**. Al pegar o escribir, el sistema deduce el `sourceType` del host o del patrón, normaliza a una forma canónica y muestra un chip con la plataforma detectada y el handle extraído. Reglas:
- Se aceptan URLs con o sin esquema, con o sin `www.`, con query string y con parámetros de tracking (se descartan `utm_*`, `igshid`, `si`, `fbclid`).
- `x.com` y `twitter.com` se normalizan ambos a `x`.
- Un `@handle` sin dominio es ambiguo: la UI muestra un desambiguador con las plataformas soportadas y **preselecciona la que el usuario ya tenga conectada por OAuth**, si la hay.
- Un enlace a un **post concreto** (no a un perfil) se resuelve al perfil de su autor y se avisa: `We'll analyse the whole @<handle> profile, not just that post.`
- Si el host no se reconoce, el `sourceType` es `other_url` y se procesa con el mismo extractor que `website`.
  > **Aclaración (2026-09-21, al implementar la detección).** La tabla de arriba define `website` como "URL http(s)", lo que se lee como que **toda** URL http(s) es `website`; esta regla dice que un host no reconocido es `other_url`. Se contradicen. **Gana esta regla**, que es la normativa explícita: la detección automática devuelve `other_url` para cualquier host que no se reconozca.
  > Para que el camino de web siga siendo idéntico al de Fastlane, el chip `Website` de `FR-011.2` y el campo legacy `Company Website` pasan un **hint** que fuerza `website`. No es cosmético: la precedencia de fusión de `FR-011.6` pone `website` primero y `other_url` penúltimo, así que confundirlos cambia qué fuente gana un conflicto.

### FR-011.2 — UI

**En onboarding (paso 1).**
- Título `Where can we learn about your brand?`; subtítulo `Paste your website, your Instagram, TikTok, X, YouTube or LinkedIn — whatever describes you best.`
- Un único input con placeholder `yoursite.com, instagram.com/yourbrand, or @yourbrand`.
- Fila de chips de atajo por plataforma (icono + nombre) que, al pulsarlos, prefijan el input y fijan el `sourceType`: `Website` · `Instagram` · `TikTok` · `X` · `YouTube` · `LinkedIn`.
- Al detectar un origen válido, aparece bajo el input una **tarjeta de confirmación** con el favicon/avatar, el nombre resuelto y el handle, más el botón primario `Analyse`.
- Enlace secundario `Use description instead` (conservado de Fastlane).
- Enlace terciario `Add another source` — permite encadenar varias fuentes antes de analizar (máx. 5).

**Durante el análisis.** Lista de sub-pasos con check progresivo, específicos del tipo de fuente. Fase 1 (D-03) para Instagram: `Reading profile` → `Reading recent posts` → `Reading on-screen text` → `Building your brand profile`. En Fase 2 se inserta `Transcribing videos` antes del último paso. Cada sub-paso puede fallar individualmente sin abortar el conjunto (ver estados).

**Resultado — pantalla de revisión.** Cada campo del Company Profile se muestra editable con:
- un **badge de origen** (`from @mimarca on Instagram`, `from miproducto.com`), clicable para ver el extracto exacto del que se dedujo;
- un **indicador de confianza** (`high` / `medium` / `low`);
- los campos con confianza `low` aparecen agrupados arriba bajo `Worth a quick check` con el texto `We guessed these. Fix anything that's off — it shapes every post we write for you.`

**Cómo se calcula esa confianza.** No es una estimación del LLM que derivó el campo: es una **verificación independiente** de si el extracto respalda el valor. Ver `DP-004` / `JV-4` en §25. Sin ese paso, `high/medium/low` sería decorativo y la regla *"nunca inventar"* de `AI-016` no sería verificable.

**En `/brand` (post-onboarding).** Tarjeta `Brand sources` con una fila por fuente: icono de plataforma, handle/dominio, fecha de último análisis, badge de estado, y menú `⋯` con `Re-analyse`, `Set as primary`, `Remove`. Botón `+ Add source`.

### FR-011.3 — Qué se extrae de cada plataforma

| Plataforma | Señales de perfil | Señales de contenido (últimos N ítems, default N=24) |
|---|---|---|
| **Instagram** | display name, handle, bio, categoría de negocio, link en bio, nº de seguidores, foto de perfil, highlights | captions, hashtags, menciones, tipo de post (imagen/carrusel/reel), **OCR del texto en imagen** (F1), comentarios con más likes, **transcripción ASR de reels** (F2) |
| **TikTok** | nickname, handle, bio, link, seguidores, likes totales | descripciones, hashtags, sonido usado, **OCR de overlays de texto** (F1), comentarios destacados, **transcripción ASR** (F2) |
| **X** | nombre, handle, bio, ubicación, link, seguidores | post fijado, últimos posts, hilos, hashtags recurrentes |
| **YouTube** | nombre del canal, descripción de *About*, enlaces, suscriptores, país | títulos y descripciones de videos, tags, miniaturas (**OCR**, F1), **subtítulos/transcripción** (F2) |
| **LinkedIn** | nombre de la página, tagline, *About*, industria, tamaño de empresa, sede, website | posts recientes y su tono |
| **website / other_url** | title, meta description, OpenGraph, favicon, logo | texto principal, páginas de producto/precios/about si son alcanzables |

**Derivación a campos del Company Profile** (mapa normativo):

| Campo del perfil | Señales primarias | Fuerza desde social |
|---|---|---|
| `CORE IDENTITY` | nombre, bio, tagline, categoría, tono agregado de los posts | **alta** |
| `PRODUCT OFFERING` | link en bio + página de destino, posts de producto, descripciones | **media** — en social suele ser implícita |
| `UNIQUE BENEFITS` | claims repetidos en captions, comentarios positivos recurrentes | media |
| `PROBLEM SOLUTION` | hooks y preguntas recurrentes en el contenido | **baja** — suele requerir confirmación del usuario |
| `MARKET & COMPETITION` | nicho inferido de hashtags, cuentas similares, categoría | media |
| `toneOfVoice` | estilo agregado de captions y del texto en pantalla (+ transcripciones en F2) | **muy alta** — es la mayor ventaja del origen social sobre la web |
| `targetAudience` | lenguaje, hashtags, perfil de quien comenta | alta |
| `businessCategories` | categoría declarada + clasificación del contenido | alta |
| Semilla de `contentAngles` | temas recurrentes detectados, ordenados por engagement | alta |

**Nota sobre D-03.** El OCR entra en Fase 1 porque en short-form el hook vive en el overlay, no en la caption: es la señal de mayor rendimiento por unidad de coste. El ASR se difiere a Fase 2 — sube el coste por alta de forma notable y su aporte incremental se concentra en cuentas de talking-head. Mientras no exista, `toneOfVoice` se deriva de captions + OCR, y los campos afectados deben reflejarlo en su nivel de confianza (no asumir confianza alta por defecto en cuentas mayoritariamente de video).

**Regla de cierre de huecos.** Los campos que quedan con confianza `low` **no se inventan**. Se rellenan con una pregunta explícita al usuario, integrada en el paso de detalles del onboarding: p. ej. `In one line: what do you actually sell?` o `What problem does someone have right before they find you?`. Si el usuario los deja vacíos, el campo queda vacío y el motor de generación opera sin él (y `mentionBusinessPercentage` se recomienda bajo hasta que se complete).

### FR-011.4 — Estrategia de adquisición (D-01: público primero, OAuth si falla)

| Nivel | Método | Riesgo | Calidad del dato |
|---|---|---|---|
| **B** | **API pública oficial / oEmbed / OpenGraph** del proveedor | bajo | media |
| **C** | **Fetch de la página pública renderizada**, propio o vía proveedor de extracción | **sujeto a ToS y robots**; capacidad **desactivable por configuración**, apagada por defecto hasta `OQ-16` | media |
| **A** | **API oficial con OAuth del propio usuario** | ninguno | **la más alta** |
| **D** | **Asistido**: el usuario pega su bio, sube capturas de su perfil o describe la marca | ninguno | baja |

**Orden de resolución en el alta (normativo, D-01):**

```
B  →  C (si el flag está activo)
      │
      └─ si ambos fallan, la cuenta es privada o la señal es insuficiente:
            ofrecer A (conectar la cuenta)  →  si el usuario no quiere, D (asistido)
```

**El signup no pide OAuth.** El tier A sigue siendo el de mayor calidad de dato, pero **deja de ser el punto de partida**: se ofrece *después* del análisis, presentado como mejora, y de nuevo en el momento de conectar para publicar. Esto es exactamente lo que hace que alguien sin web y sin ganas de autorizar nada pueda llegar a Blitz.

**Consecuencia honesta de D-01 que hay que asumir:** con tier B/C la señal es **peor** que con OAuth — menos posts accesibles, sin insights, y sujeta a lo que cada plataforma exponga públicamente. Por tanto se espera **más campos en confianza `low` y más preguntas de cierre de huecos** que en el camino con OAuth. El diseño lo absorbe (los huecos se preguntan, no se inventan), pero es un coste real de la decisión, no un detalle.

**Cobertura por plataforma sin OAuth: a verificar antes de construir.** Lo que cada plataforma permite leer públicamente y por qué vía varía mucho entre las cinco, y no forma parte de lo investigado en este PRD. Para cada una hay que determinar, antes de escribir su extractor: qué expone su API pública sin autenticación, qué devuelve su oEmbed, y si el tier C es siquiera necesario. **Es probable que la cobertura útil sin OAuth sea desigual entre las cinco** — ver `OQ-19`.

**Requisito de diseño.** La UI **nunca** debe exponer en qué nivel se resolvió el análisis, salvo cuando degrada a D — ahí lo dice explícitamente y pide la ayuda concreta que necesita.

**Requisito legal (bloqueante para el tier C).** Antes de activarlo en producción hay que documentar, por plataforma: términos de servicio aplicables, base legal del tratamiento, política de retención del snapshot y mecanismo de borrado. Ver `OQ-16`.

### FR-011.5 — Reutilización de cuentas ya conectadas

Cuando el usuario conecta TikTok, Instagram, YouTube, LinkedIn o X en `Settings → integrations`, el sistema ofrece: `Use this account to improve your brand profile?` con un botón `Analyse @<handle>`. Aceptar crea una `BrandSource` de nivel A. Esto resuelve el caso de quien se dio de alta con poca información y luego conecta su cuenta real.

**FR-011.5.1 — Siembra del Media Bank (Fase 1, opt-in — D-04).** Con una fuente de nivel A, el sistema importa los posts propios del usuario al Media Bank como assets con `origin: "imported"`. Beneficio directo: `ownMediaPercentage` deja de ser inútil el día 1 y el primer Blitz ya genera con media real de la marca en vez de librería compartida. Es el mayor salto de calidad percibida del alta social.

**Dónde se ofrece (crítico, por D-01).** La oferta aparece **después** de que el análisis haya terminado y el perfil de marca ya exista — nunca antes. Copy propuesto, que vende las dos cosas a la vez porque conectar sirve para ambas:

> `Connect @<handle> to publish from it — and bring your photos and videos with you.`
> ☐ `Also import my recent posts to my Media Bank`

**Reglas.**
- **Opt-in explícito**, checkbox desmarcado por defecto.
- Requiere tier A (OAuth). Si el usuario no conecta, la oferta **no bloquea nada**: el onboarding continúa y reaparece en `Settings → integrations`.
- Respeta la cuota de storage del plan; si no entra todo, importa los más recientes y lo dice.
- Los assets importados se marcan de forma distinguible en la UI (badge propio) y son borrables en bloque.
- **Prohibido:** usar la importación como excusa para pedir OAuth antes del análisis. Ver §2.7.

### FR-011.6 — Múltiples fuentes y fusión

- Un workspace admite **hasta 5 Brand Sources**; exactamente una es `isPrimary`.
- Precedencia por defecto para resolver conflictos: `website` > `linkedin` > `instagram` ≈ `tiktok` > `youtube` > `x` > `other_url` > `manual`. La fuente marcada como primaria **gana siempre** en empate.
- Para `toneOfVoice` la precedencia se **invierte**: los orígenes sociales ganan a la web, porque reflejan mejor cómo habla la marca en el canal donde va a publicar.
- Cuando dos fuentes se contradicen en un campo, se guarda el conflicto en el snapshot, se elige según precedencia y se marca el campo con confianza `medium` como máximo, para que aparezca en la revisión.
- Añadir una fuente **no** sobrescribe ediciones manuales del usuario: un campo con `editedByUser: true` sólo se cambia si el usuario lo acepta explícitamente (`This source suggests a different answer — replace?`).

### FR-011.7 — System behavior

1. Validar y normalizar la entrada; resolver `sourceType`, `handle` y `canonicalUrl`.
2. Comprobar unicidad: una misma `(sourceType, handle)` no puede estar en dos workspaces (misma regla que Fastlane aplica a la web).
3. Crear `BrandSource` en estado `pending` y encolar `brand-source-analysis`.
4. El job resuelve el nivel de adquisición (A→D), recoge señales, ejecuta ASR/OCR donde aplique, y llama al LLM de síntesis (`AI-016`).
5. Persistir `BrandSourceSnapshot` (materia prima + extractos citados) y actualizar `CompanyProfile` con `confidence` y `sourceRef` por campo.
6. Incrementar `brandRevision`. Como en Fastlane, **el cambio sólo afecta a generaciones futuras**: la cola existente no se vacía.
7. Sembrar `contentAngles` a partir de los temas detectados (sólo en el primer análisis del workspace, para no duplicar ángulos existentes).

### FR-011.8 — States

`idle` · `detecting` (resolviendo plataforma mientras escribe) · `resolved` (tarjeta de confirmación visible) · `queued` · `analyzing` (con sub-pasos) · `partial` (algunas señales fallaron; hay perfil pero con huecos marcados) · `ready` · `failed` · `stale` (el análisis tiene más de 90 días; se ofrece `Re-analyse`).

### FR-011.9 — Validation y errores (copy propuesto)

| Condición | Mensaje |
|---|---|
| Campo vacío y sin rama manual | `Add a website or a social profile to continue` |
| Entrada irreconocible | `We couldn't tell what this is. Paste a website URL or a social profile link.` |
| Handle ambiguo sin plataforma | `Which platform is @<handle> on?` |
| Perfil inexistente | `We couldn't find @<handle> on <Platform>. Check the spelling.` |
| Cuenta privada | `@<handle> is private, so we can't read it. Connect the account or paste your bio instead.` |
| Perfil sin contenido | `@<handle> doesn't have enough posts yet. Add another source or describe your brand.` |
| Ya registrada | `This profile is already connected to another workspace.` |
| Plataforma temporalmente inaccesible | `<Platform> isn't responding right now. Try again in a few minutes or add a different source.` |
| Rate limit del proveedor | `We're reading a lot of profiles right now. We'll keep trying in the background.` |
| Señal insuficiente tras analizar | `We got the basics but not much else. A couple of quick answers will fix that.` → salta a las preguntas de cierre de huecos |
| Máximo de fuentes | `You can analyse up to 5 sources per workspace.` |
| Límite de re-análisis | `You've refreshed this source recently. Try again in <N> hours.` |
| Nivel C deshabilitado | (nunca se muestra como error; degrada silenciosamente al nivel D) |

Reglas de seguridad heredadas de la rama web y **aplicables a todos los orígenes**: se rechazan `localhost`, IPs privadas y hosts bloqueados (protección SSRF). El contenido extraído de perfiles de terceros es **dato, nunca instrucción**: el pipeline debe neutralizar cualquier intento de prompt injection incrustado en una bio o caption antes de pasarlo al LLM de síntesis.

### FR-011.10 — Permissions

Owner y member pueden añadir y re-analizar fuentes. Sólo el owner puede eliminar la fuente primaria. Importar posts al Media Bank requiere cuota de storage disponible.

### FR-011.11 — Edge cases

- **Perfil personal vs. de marca.** Un perfil personal que habla de varios temas produce una identidad difusa. Detectar baja cohesión temática y avisar: `Your posts cover a lot of ground. Tell us which part is the business.`
- **Cuenta nueva con 2 posts.** Señal insuficiente → degradar a preguntas de cierre y permitir arrancar igualmente.
- **Idioma distinto del de la interfaz.** El perfil se analiza en su idioma original y `toneOfVoice` lo registra; no se traduce la voz de la marca.
- **Link-in-bio (Linktree y similares).** Se sigue **un** nivel de enlaces para alcanzar el destino real, con límite de 5 destinos y sin recursión.
- **Handle cambiado tras el análisis.** El snapshot queda `stale`; se ofrece re-analizar.
- **Usuario que sí tiene web pero prefiere social.** Permitido: ambas son fuentes de primera clase.
- **Cuenta suspendida/borrada tras el análisis.** El perfil de marca **sobrevive** — ya está materializado en `CompanyProfile`; la fuente pasa a `failed` y se avisa sin bloquear nada.

### FR-011.12 — Acceptance criteria

1. Pegar `instagram.com/<handle>` de una cuenta pública con ≥ 12 posts produce un `CompanyProfile` con `CORE IDENTITY`, `toneOfVoice`, `targetAudience` y `businessCategories` no vacíos, **sin pedir ninguna URL de web**.
2. Lo mismo para TikTok, X, YouTube y LinkedIn.
3. Escribir sólo `@handle` dispara el desambiguador de plataforma y preselecciona la que el usuario ya tenga conectada.
4. Cada campo del perfil muestra su origen y su nivel de confianza, y los `low` aparecen agrupados para revisión.
5. Una cuenta privada degrada al nivel D con el mensaje exacto y **no** bloquea el alta.
6. Analizar una segunda fuente no pisa los campos que el usuario ya editó a mano sin pedirle confirmación.
7. Un intento de registrar un perfil ya usado en otro workspace se rechaza con el mensaje de unicidad.
8. Texto malicioso incrustado en una bio (p. ej. instrucciones dirigidas al modelo) no altera el comportamiento del pipeline.
9. El tiempo desde `Analyse` hasta perfil listo es < 3 min para un perfil de 24 ítems, o devuelve `partial` con lo que consiguió.
10. Desactivar el nivel C por configuración no rompe ningún alta: el sistema degrada a D.
11. **D-01** — completar el alta con una fuente social **no requiere autorizar OAuth en ningún momento**. Un test end-to-end debe cubrir el camino entero sin un solo consentimiento OAuth.
12. **D-02** — los cinco extractores sociales funcionan en Fase 1 sobre una cuenta pública representativa de cada plataforma.
13. **D-03** — el OCR se ejecuta en Fase 1 y su texto aparece citado como `excerpt` en al menos un campo del perfil cuando la cuenta usa overlays.
14. **D-04** — la oferta de conectar e importar media aparece **después** del análisis, con el checkbox desmarcado, y declinarla no interrumpe el onboarding.

---

## FR-020 — Company Profile / Brand

**Purpose.** Ser la fuente de verdad de marca que condiciona toda la generación de copy e imagen.

**Entry point.** Sidebar → `Brand` (`/brand`; legacy `/profile`).

**UI.** CONFIRMED `[DOCS-6 t=81s]`
- Cabecera: icono + `<Company>'s Company Profile`, subtítulo *"We've analysed your business to understand how to do the best marketing for you. Please review your profile and make any changes."*, botón `Edit` a la derecha.
- Sección **Identity & Product** con subcampos etiquetados en mayúsculas: `CORE IDENTITY`, `PRODUCT OFFERING`, `UNIQUE BENEFITS`, `PROBLEM SOLUTION`.
- Sección **Market & Competition** con su propio `Edit`.
- (INFERRED: secciones adicionales de tono/audiencia, dado que la generación usa tono y audiencia.)
- **EXTENSION — tarjeta `Brand sources`.** Lista las fuentes analizadas (icono de plataforma, handle o dominio, fecha del último análisis, badge de estado `ready`/`partial`/`failed`/`stale`) con menú `⋯` → `Re-analyse` · `Set as primary` · `Remove`, y botón `+ Add source`. Cada campo del perfil muestra además su **badge de origen** y su **nivel de confianza** (ver `FR-011.2`). Máximo 5 fuentes.

**User flow.** `/brand` → leer → `Edit` en una sección → editar campos de texto → guardar → confirmación.

**System behavior.** Cada guardado incrementa `brandRevision`. Las sugerencias ya encoladas **no** se invalidan automáticamente (paralelo con `blitz/preferences`: *"All preference changes apply only to future generations"*). Las operaciones que persisten una sugerencia generada contra el brand deben enviar `expectedBrandRevision`; si no coincide, se rechaza. SUPPORTED `[DEV]`

**EXTENSION — re-análisis y edición manual.** Re-analizar una fuente reejecuta `AI-016` y **respeta los campos marcados `editedByUser`**: si la nueva extracción difiere, se propone el cambio en vez de aplicarlo (`This source suggests a different answer — replace?`). Un re-análisis cuenta contra un límite por fuente y día (`You've refreshed this source recently. Try again in <N> hours.`). Un snapshot con más de 90 días marca la fuente como `stale` y la UI ofrece refrescarla.

**Data.** Lee/actualiza `CompanyProfile`. No borra.

**States.** default · loading · saving · saved · error.

**Validation.** Campos de texto largos (INFERRED límite 4 000 caracteres, por coherencia con onboarding).

**Permissions.** Owner y member pueden editar (INFERRED).

**Edge cases.** Perfil incompleto/fallido → Blitz devuelve `409 company_profile_not_ready` y la UI debe enviar al usuario a `/brand` a completar. SUPPORTED `[DEV]`

**Acceptance criteria.** (1) Editar una sección persiste y sube `brandRevision`. (2) Con perfil no listo, Blitz muestra un estado bloqueante con CTA a Brand.

---

## FR-030 — Home / Dashboard

**Purpose.** Dar contexto de rendimiento y el siguiente paso accionable.

**Entry point.** Sidebar → `Home` (`/home`), ruta por defecto tras login.

**UI (Generación B).** CONFIRMED `[DOCS-6 t=72s]`
- Fila de 5 KPI tiles con icono y color propio: `Engaged Leads`, `Content Posted`, `Total Views`, `Total Likes`, `Total Comments`.
- Tarjeta **Tasks** con contador `Completed N` y filas de tarea: badge `Suggested`, título (`Reply to leads`), progreso (`0/5`) y chevron de expansión.
- Tarjeta **Views History**: línea temporal por día, botón `Enable website analytics`, selector de rango `Monthly`.
- Sección **Trending Content**: chips de nicho sobre la tarjeta central (p. ej. `E-Commerce`, `Self Improvement`, `B2C App`, `Relationships`), carrusel 3-up con la central ampliada.
- FAQ agrupada por categorías (ver `FR-037`).
- Footer con Discord y "book a call".

**UI (legacy, referencia).** `Here's how you're tracking.` + tarjeta **Performance** (`Cumulative views & posts over 7 days`, leyenda `Views`/`Posts`, eje dual, `View analytics →`) + tarjeta **Weekly Posts** (badge `18/5`, *"Stay consistent to grow your audience"*, 5 círculos de check, barra de progreso, `You've hit your weekly goal!`, `Schedule posts →`) + grid `Trending Content` con `Page 1 of 40` y `Previous`/`Next`. CONFIRMED `[DOCS-1 t=9s, t=81s]`

**System behavior.** Los KPI agregan sobre posts del workspace. `Enable website analytics` inyecta el script de tracking y activa `Social website views`. Las tareas se generan a partir del estado del workspace (p. ej. leads sin responder).

**States.** default · loading (skeletons) · empty (`No posts`) · error.

**Copy de FAQ (categorías y preguntas, literal).** CONFIRMED `[APP Home.js]`, `[DOCS-1 t=126s]`
- `WARMING UP YOUR ACCOUNT`: `How do I warm up my account?` · `How do I navigate "zero view jail"?` · `What should I actually do in the first few weeks?` · `Why are my first few posts getting low views?`
- `WHY THIS TYPE OF CONTENT`: `Why can I only make slideshows, wall of text, hook and demo, and green screen memes?` · `Why are slideshows so effective?` · `Why is wall of text so effective?` · `Why are hook demo videos so effective?` · `Why are green screen memes so effective?`
- `CREATING AND REMIXING CONTENT`: `How does Remix work?` · `What if the trending content in Fastlane isn't in my niche? Should I still remix it?` · `How do I create a product demo video?` · `Can I upload my own media/videos/images?` · `Can I generate my own AI avatars for UGC videos?` · `Are you going to add more content formats?` · `Why does editing my content sometimes create a new post instead of updating the original?` · `What if I get a "post failed" error?` · `What are the platform rules around copyright?` · `How do I get support from the team?`
- `OPTIMISING YOUR GROWTH STRATEGY`: `How quickly should I expect results?` · `How many videos should I be posting per day?` · `Do I need an existing audience for this to work?` · `Should I post the same video across all platforms?` · `How should I be mentioning my product?` · `How do I hit 1,000 views consistently?` · `Should I use hashtags? Which ones should I use?` · `Should you only post one content format per account for maximum algorithm benefit?` · `What if I run out of ideas?` · `Does posting at a certain time of day impact performance?`
- `ACCOUNTS AND WORKSPACES`: `How many TikTok, Instagram, or YouTube accounts can I connect?` · `How can I add multiple social media accounts?` · `How can I connect another one of my businesses to Fastlane?` · `What's the difference between a personal account and a business account on TikTok?` · `What's the difference between a creator account and a business account on Instagram?` · `What's the difference between a personal account and a brand account on YouTube?` · `What are the TikTok posting limits?` · `What are the Instagram posting limits?` · `What are the YouTube posting limits?` · `What happens if I hit a posting limit?`

> **Corregido el 2026-09-21.** Esta enumeración tiene **39** preguntas (4 + 5 + 10 + 10 + 10), no 37 como decía la tabla de §23. Se corrigió §23: la enumeración está marcada CONFIRMED desde el bundle (`[APP Home.js]`), que es evidencia más fuerte que el conteo de una tabla resumen.
>
> **El PRD registra las preguntas pero NINGUNA respuesta.** No se inventan: una respuesta inventada sobre "los límites de publicación de TikTok" es peor que una ausencia visible. Quien implemente la FAQ tiene que obtenerlas del producto original o escribirlas y marcarlas como propias.

**Acceptance criteria.** (1) Los 5 KPI coinciden con la suma de posts publicados del workspace. (2) `Enable website analytics` activa el tracking y la tarjeta cambia de estado. (3) La FAQ contiene exactamente las preguntas listadas, agrupadas por esas 5 categorías.

---

## FR-040 — Inspiration / Trending Content

**Purpose.** Permitir descubrir y remixar contenido que ya funcionó en el nicho del usuario.

**Entry points.** Sidebar → Inspiration (`/inspiration`); sección Trending Content en `/home`; picker `Trending Content` dentro del Content Studio.

**UI.** CONFIRMED `[APP InspirationPage]`, `[DOCS-1 t=81s]`, `[DOCS-5 t=12s]`
- Buscador (`Search inspiration`, `Clear search`, `Open search`, `Close search`).
- `Filter by niche` (chips de nicho: `B2C App`, `B2B App`, `Productivity`, `Relationships`, `Personal Brand`, `Course/Digital Product`, `E-Commerce`, `Self Improvement`, `Travel`, `Study`, …).
- Grid/carrusel de tarjetas verticales 9:16 con overlay de `views` (icono ojo) y `likes` (icono corazón), navegación de slides (`Previous slide`, `Next slide`) para slideshows, y botón `Remix this`.
- Etiqueta `Updated daily`.
- Paginación: modo grid → `Previous` / `Page X of Y` / `Next`; modo carrusel → ‹ › y contador `3 / 72`.
- Acción `Open original` (abre el permalink en pestaña nueva, `rel="noopener noreferrer"`).

**System behavior.** `Remix this` navega al Content Studio del formato correspondiente con la fuente preseleccionada y `Mode = Remix`. La librería se filtra por el nicho inferido del Company Profile ("*we've filtered so it only shows you content hopefully that's in your niche*" — narración `[DOCS-1]`).

**States.** default · loading (`Preparing video`) · empty (`No results` + *"Try a different search or clear your filters."*) · not-ready (`Inspiration is being set up` + *"The library is not available yet. Check back soon."*) · error (*"We could not load inspiration right now. Try again in a moment."*).

**Acceptance criteria.** (1) Buscar y filtrar por nicho devuelven resultados combinables y reseteables. (2) `Remix this` abre el Studio con la fuente ya seleccionada. (3) Los tres estados de excepción muestran el copy exacto.

---

## FR-050 — Blitz (swipe deck)

**Purpose.** Reducir la aprobación de contenido a una decisión binaria en segundos, sobre piezas ya renderizadas y on-brand.

**Entry point.** Sidebar → `Blitz` (`/blitz`).

**UI.** CONFIRMED `[DOCS-B t=3s]`, `[DOCS-7 t=342s]`
- **Cabecera de la tarjeta:** chip de tipo (`Slideshow` / `Wall of Text` / `Green Screen` / `Video Hook`), chip de influencer `👤 <name>` (sólo si aplica), chip de ángulo (`One Idea, Everywhere`, `Consistency Without Burnout`, …). Debajo, pill `ⓘ Why This Content?`.
- **Centro:** tarjeta 9:16 con la pieza renderizada; detrás se ven 2–3 tarjetas apiladas (cola). Para slideshows: flechas ‹ › laterales y dots de posición.
- **Izquierda:** tarjeta `Remixed From` con el video fuente, icono corazón + `106.8K`, icono ojo + `1.3M`, y sus propios dots si es slideshow. Sólo para remixes.
- **Izquierda (al activar):** panel `ⓘ Why This Content` con bullets. Ejemplo literal: *"Curiosity hook taps into emotional desire to glimpse the future of one's family"*, *"Informal, high-energy tone builds shareability and mimics trending formats for engagement"*.
- **Derecha:** botón flotante engranaje. Legacy: tooltip `Preferences` → drawer. Actual: botón `⚙ Configure` → `/blitz/settings`.
- **Barra inferior:** `✕` (rojo, rechazar) · `✎ Edit` · `🔇 Unmute` / `Mute` · `✓` (verde, aprobar). Debajo de ✕ y ✓ se muestran las teclas `←` y `→`.
  - *Variante actual (Generación B):* la barra se reduce a `✕ · ✎ Edit · ✓`, y el estado de audio pasa a un **icono de mute superpuesto sobre la propia tarjeta**, en su esquina superior izquierda. CONFIRMED `[DOCS-7 t=465s]`

**User flow.**
1. Entrar a `/blitz` → se muestra la primera sugerencia lista.
2. (Opcional) `Why This Content?` → leer racional.
3. (Opcional) `Edit` → ver `FR-051`.
4. Decidir: swipe izquierda / `✕` / `←` = descartar; swipe derecha / `✓` / `→` = aprobar.
5. Al aprobar se abre `M-04` `What would you like to do?` — `Step 1 of 3`:
   - `Save to Library` — *"Save this content for later"*
   - `Schedule Post` — *"Post or schedule to your platforms"*
   - `Cancel`
6. `Save to Library` → toast `Content saved!` + `View in Library`. La siguiente tarjeta pasa al frente.
7. `Schedule Post` → flujo `FR-060`. Al confirmar: toast `Building post!` / `Posting in ~5 minutes!` + `View in Library`.

**System behavior.**
- Aceptar una sugerencia: descuenta **1 swipe diario** y **1 content save**, y lanza un build asíncrono (composición de imágenes, render de video, dibujado de overlays, subida a storage). El build tarda ~30 s – 2 min. El contenido queda `BUILDING` y pasa a `CREATED` o `FAILED`. SUPPORTED `[DEV]`
- Un build fallido **reembolsa** el content save consumido. SUPPORTED `[DEV]`
- Rechazar **no** consume cuota (INFERRED: sólo el endpoint de aceptación aparece como facturable).
- La cola se rellena sola en background hasta ~5 items; puede exceder transitoriamente por refills concurrentes. SUPPORTED `[DEV]`
- La operación **no es idempotente**: nunca reintentar automáticamente un timeout o 5xx. SUPPORTED `[DEV]`
  > **Aclaración (2026-09-21, al implementarla).** Parece chocar con `NFR-004` (*"toda operación facturable acepta `Idempotency-Key`"*), y aceptar una sugerencia **es** facturable. No chocan, y la diferencia importa: `NFR-004` dice que la operación **acepta** la key, y `NFR-005` dice que el cliente **no debe reintentar solo**. O sea: **sin** key no es idempotente y reintentar a ciegas cobra dos saves; **con** key sí lo es. Por eso la key es **opcional** acá, y obligatoria en los cuatro endpoints que lista §9.3. Nótese que `POST /blitz` **no** está en esa lista.

**Data.** Lee `Suggestion` de la cola y el Company Profile. Crea `Content`. Opcionalmente crea `Post`. Actualiza contadores de cuota.

> **Selección de la fuente a remixar.** Los pesos de `FR-055` deciden *cuánto* remix, no *qué* remixar. La elección del item concreto es `DP-005` / `JV-6` (§25), que ordena los candidatos por encaje con la marca en vez de filtrar sólo por nicho. El mismo mecanismo aplica a elegir personaje AI UGC y video UGC humano.

**States.**
- `default` — tarjeta lista.
- `loading` — carga inicial de la cola.
- `empty` — cola vacía: mostrar estado de espera y reintentar (el API devuelve `404 not_found`, *"discovery queue has no ready items yet. Try again shortly; the queue replenishes in the background."*). SUPPORTED
- `processing` — build en curso tras aceptar (el usuario continúa swipeando; el progreso se ve en Library).
- `blocked: profile` — `409 company_profile_not_ready`.
- `blocked: swipes` — `429 blitz_quota_exceeded`, con `resetAt` (00:00 UTC).
- `blocked: saves` — `429 content_quota_exceeded`, con `count`, `limit`, `resetAt`.
- `blocked: plan` — `Your content is view-only. Upgrade to create and publish again.`
- `failed` — build fallido; la pieza aparece `FAILED` en Library.

**Validation.** `contentType` ∈ {`slideshow`, `wall-of-text`, `green-screen`, `video-hook`}; `aspectRatio` ∈ {`1:1`, `4:5`, `3:4`, `9:16`} y sólo aplica a slideshow. Valor no reconocido → `400 bad_request`. SUPPORTED

**Permissions.** Owner y member.

**Edge cases.**
- `422 content_unavailable_for_type`: tipo válido pero no producible ahora (p. ej. `video-hook` sin demo video). Mensaje accionable: sugerir otro tipo o subir un demo. SUPPORTED
- Influencer configurado pero no entrenado → se cae a contenido regular. SUPPORTED
- `green-screen` **nunca** usa influencer. SUPPORTED

**Acceptance criteria.**
1. Las tres formas de aprobar (swipe, botón, `→`) producen el mismo resultado.
2. Aceptar descuenta exactamente 1 swipe y 1 save; un fallo de build devuelve el save.
3. `Why This Content?` muestra el racional almacenado con la sugerencia, nunca uno generado al vuelo.
4. Con cola vacía se muestra el estado de espera y la UI reintenta sin recargar.
5. Al alcanzar el cap diario, la UI muestra la hora de reset.

---

## FR-051 — Blitz inline editor

**Purpose.** Ajustar la pieza sin salir del flujo de aprobación.

**Entry point.** Botón `Edit` en la barra inferior de Blitz.

**UI — panel izquierdo `ASSETS`.** CONFIRMED `[DOCS-B t=99s]`, `[DOCS-7 t=363s]`
- Por cada asset, una fila con miniatura, etiqueta (`Video` / `Audio` / `Image Set`), subtítulo descriptivo (`Background ...`, `Audio track`, `Entrepreneur ...`) y botón `Swap`.
- `MENTION YOUR BUSINESS?` → toggle `Yes` / `No`.
- `PROMPT` → textarea. Placeholder legacy: vacío; actual: *"Optional instructions for regeneration…"*.
- Botón `⟳ Regenerate Text`.

**UI — panel derecho (inspector).** CONFIRMED
- Acciones de media (varían por formato): `Unmute Audio` / `Mute Audio`, `Swap Audio`, `Swap Video`, `Swap Hook Video`, `Swap Image`, `My Images`.
- `Dimensions` (colapsable).
- `Text` (colapsable):
  - `Apply to all text boxes` (checkbox) — sólo en slideshows.
  - `Weight: <Medium>` — slider.
  - `Size: <18px>` — slider.
  - `Color` — swatch + input hex (`#FFFFFF`).
  - `Stroke: <3px>` — slider.
  - `Stroke Color` — swatch + input hex (`#000000`).
  - `Background` — segmented `White` / `None` / `Snap…` + swatch + input hex.
- `Video` (sólo green-screen): `Zoom: 100%` slider, `Reset Position`, hint `Drag video to reposition`.
- Acciones de slide (slideshow): `Add Text`, `Add Slide`, `Delete Slide`, `Delete Image`.
- Botón central inferior `✓ Done Editing`.

**User flow (ejemplo verificado, `[DOCS-B t=84s→141s]`).** `Edit` → `Swap Video` → modal `Select Video` → filtrar `Woman` + `Reaction` → elegir → vuelve al editor con el nuevo fondo → escribir en `PROMPT`: *"reference valentines day in the video"* → `Regenerate Text` → la copy se reescribe manteniendo estructura → ajustar `Background` a `White` → arrastrar la caja de texto a la posición deseada → `Done Editing`.

**System behavior.**
- El texto es arrastrable sobre el canvas; la posición se guarda en unidades de editor (`position.x/y` 0–100, `widthPercent` 25–100). SUPPORTED `[DEV PATCH /content/:id`]
- `Regenerate Text` reescribe **todas** las cajas de texto preservando media, estructura de cajas, layout y estilo; en slideshows conserva el número exacto de slides y cajas. SUPPORTED
- Los cambios de copy/tipografía/color/posición son **minor edits**: no crean una nueva fila de contenido, no consumen content save, no generan un evento de facturación. SUPPORTED
- Cada edición aceptada incrementa `revision`; se requiere concurrencia optimista (`revision` debe coincidir, si no `409 stale_revision`). SUPPORTED

**Validation** (normativa, SUPPORTED `[DEV]`):
- `text` ≤ 5 000 caracteres, puede estar vacío.
- `position.x` / `position.y` ∈ [0, 100]; `widthPercent` ∈ [25, 100]; `font.size` ∈ [8, 72]; `stroke.width` ∈ [0, 8].
- Colores en `#RRGGBB`. `background.opacity` ∈ [0, 1]. `background.style` ∈ {`pill`, `full-width`}; `null` elimina el fondo.
- Familias tipográficas permitidas: `tiktok`, `snapchat`, `montserrat`, `poppins`, `inter`, `oswald`, `playfair`, `caveat`, `anton`, `bebas`, `bangers`, `pacifico`. Las seis primeras aceptan pesos 300–700 en pasos de 100; `playfair` y `caveat` 400–700; `anton`, `bebas`, `bangers`, `pacifico` sólo 400.
- `prompt` de regeneración ≤ 500 caracteres.
- Se rechazan campos desconocidos, IDs duplicados, IDs inexistentes, geometría inválida y `textBoxes` vacío, **sin aplicar ningún cambio**.

**States.** editing · regenerating (spinner en el botón) · rebuilding (`BUILDING`, el contenido previo sigue usable) · saved · error.

**Edge cases.**
- `409 content_edit_in_progress` — ya hay una edición corriendo.
- `409 content_has_linked_posts` — hay posts vinculados; **cancelar no basta**, hay que borrarlos.
- `409 unsupported_content_state` — el contenido está `BUILDING` o `FAILED`.
- `422 content_not_editable` — tipo/origen/payload legacy no soportado.
- Si el rebuild falla, la versión anterior sigue siendo usable y se reporta `lastEdit` fallido.
- Contenido creado vía `POST /content` (payload explícito) **no** es editable en el Studio: hay que reenviar un payload ajustado. SUPPORTED

**Acceptance criteria.** (1) Cada control del inspector modifica el render final. (2) `Regenerate Text` respeta el número de slides y cajas. (3) Una edición concurrente devuelve `stale_revision` y la UI recarga. (4) Editar contenido con posts vinculados está bloqueado con mensaje accionable.

---

## FR-052 — Modal `Select Video`

**UI literal.** CONFIRMED `[DOCS-B t=84s]`, `[DOCS-3 t=66s]`, `[DOCS-manual t=18s]`
- Título `Select Video`; toggle `👁 Tags` (muestra/oculta las etiquetas sobre las miniaturas); cerrar `✕`.
- Tabs: `📹 Library` (catálogo de Fastlane) · `⬆ My Videos` (assets propios).
- Fila `Filter:` con chips de color: `Activity`, `Neutral/Filler`, `Reaction`, `Man`, `Woman`, y enlace `Clear`.
- Grid 4×N de miniaturas verticales con badges de tag en la esquina superior izquierda (p. ej. `Woman` + `Reaction`).
- Footer: `‹ Previous` · `Page X of Y` · `Next ›` · botón `Cancel`.

**System behavior.** Los filtros son acumulativos (AND entre dimensiones, OR dentro de una dimensión) — INFERRED a partir de la combinación observada `Reaction` + `Woman`. `Clear` resetea todos. La paginación es por páginas numeradas (no scroll infinito). CONFIRMED

**States.** loading (skeletons con tags visibles y spinner) · results · empty · error.

---

## FR-053 — Modal `Select Audio`

**UI literal.** CONFIRMED `[DOCS-4 t=72s]`, `[DOCS-3 t=84s]`
- Título `Select Audio`, cerrar `✕`.
- Lista de **2 columnas** con scroll vertical; cada item es una tarjeta con icono de nota musical + nombre de la pista.
- **La primera opción siempre es `No audio`** (icono de nota tachada) — permite generar la pieza sin pista.
- La pista **seleccionada** se resalta con borde azul y su icono se convierte en una **forma de onda animada** (indica reproducción/preview).
- Botón `Cancel`.

**Dos catálogos distintos según el tipo de contenido.** CONFIRMED — los nombres observados difieren por formato, lo que confirma el parámetro `for` de la API:
- **Wall of Text** (`[DOCS-3 t=84s]`): nombres de archivo — `you_re crazy.mp3`, `who are you.mp3`, `western.mp3`, `trap strong beat.mp3`, `trap instrumentals.mp3`, `trap heavy beat.mp3`, `to the max.mp3`.
- **Video Hook & Demo** (`[DOCS-4 t=72s]`): nombres descriptivos — `everything`, `see it all`, `three strikes`, `where`, `beat drop`, `friendship`, `spanish beats`, `desire`.

**System behavior.** El catálogo de audio es **compartido por todos los workspaces** y está **curado por tipo de contenido**: la API expone `GET /api/v1/audio?for=wall-of-text|video-hook`. El Media Bank **no acepta subidas de audio**. SUPPORTED `[DEV]`

**Requisito adicional FR-053.1.** La opción `No audio` debe ser seleccionable y producir una pieza sin pista de audio; el payload de build omite entonces el bloque `audio`. CONFIRMED (UI) / INFERRED (payload)

---

## FR-054 — Blitz Preferences (drawer legacy)

**UI literal.** CONFIRMED `[DOCS-B t=150s]`
- Título `Preferences`.
- `CONTENT TYPES` — barra apilada de color + filas `Slideshow`, `Wall of Text`, `Green Screen`, `Video Hook`, cada una con punto de color, porcentaje y steppers `−` / `+`.
- `REMIX RATIO` — *"How often to remix trending content vs. creating original ideas from scratch."* Fila `Remix` `−` `80%` `+` `Original` + barra bicolor.
- `Mention Business` — *"Include your business in generated text"* + toggle.
- Botón `💾 Save Preferences`.

---

## FR-055 — Blitz Settings (página actual)

**Purpose.** Control completo del motor de generación.

**Entry points.** `/blitz/settings`; botón `⚙ Configure` en `/blitz`; enlace `Configure in Blitz →` desde el detalle de un influencer.

**UI.** CONFIRMED `[DOCS-7 t=291s]`
- Banner persistente `✓ All changes saved` (auto-guardado).
- **Influencers** (expandible) — subtítulo dinámico `N influencer · M active in Blitz · X% frequency`.
  - `INFLUENCER FREQUENCY` — *"What share of Blitz suggestions feature one of your trained influencers."* Slider 0–100 % con valor a la derecha.
  - Tarjeta por influencer: miniatura, nombre, badge `✓ ACTIVE IN BLITZ`, checklist (`Trained`, `N angles linked`, `M videos`, `youtube · tiktok · instagram`), botones `🖼 Add images` y `🎥 Add video`, enlace `Manage <name> →`.
  - `+ New influencer`.
- **Voice & angles** (colapsable) — resumen `N angles · mention sometimes`.
- **Visual sources** (colapsable) — resumen `N image sets · M video sets · K demo videos · J own uploads`.
- **Content mix** (expandible) — resumen `Slideshow 45% · Wall of text 45% · Green screen 10% · Hook demo videos 0%`.

**Mapa a la API (normativo).** SUPPORTED `[DEV GET/PATCH /blitz/preferences]`

| Control de UI | Campo | Rango / reglas |
|---|---|---|
| Content mix (4 sliders) | `slideshowWeight`, `wallOfTextWeight`, `greenScreenWeight`, `videoHookWeight` | Los cuatro juntos o ninguno; suma exacta = 100 |
| Remix ratio | `remixPercentage` | 0–100 |
| Own media vs shared library | `ownMediaPercentage` | 0–100 |
| Mention business | `mentionBusinessPercentage` | 0–100 |
| Influencer frequency | `influencerChance` | 0–100, decimales aceptados, default 50 |
| Smart text positioning | `smartTextPositioning` | boolean, default `true` |
| Gender filter | `genderFilter` | `"man"` \| `"woman"` \| `null` |
| Angle weights | `angleWeights` | mapa `{angleId: peso}`, cubre **todos** los ángulos activos, suma = 100 |
| Caption style mix | `textStyleWeights` | mapa `{presetId: peso entero}`, suma = 100, o `{}` para desactivar |

**Presets de estilo de caption (valores válidos).** `tiktok-classic`, `bold-impact`, `snapchat`, `white-box`, `yellow-pop`, `clean-karaoke`, `script-playful`. Cada preset agrupa fuente, color, stroke y fondo legibles sobre cualquier fondo; un preset al 100 % fija el look de todas las generaciones. SUPPORTED

**System behavior — reglas críticas.** SUPPORTED `[DEV]`
1. **Todos los cambios aplican sólo a generaciones futuras.** Las sugerencias encoladas y en curso se preservan. Guardar **nunca** vacía ni resetea la cola.
2. `influencerChance` es una tirada independiente por generación, **no** un ratio objetivo sobre un lote. `0` desactiva; `100` intenta siempre que sea elegible.
3. Si no hay influencer activo y entrenado elegible para el tipo habilitado, se cae a contenido regular.
4. `genderFilter` excluye el género opuesto para valores conocidos (`male`/`female`); otros valores siguen siendo elegibles.
   > **Aclaración (2026-09-21).** Parecen dos vocabularios en conflicto —la tabla de arriba dice `"man"`\|`"woman"` y esta regla dice `male`/`female`— pero son **dos campos distintos**: `BlitzPreferences.genderFilter` toma `man`\|`woman`\|`null`, y lo que filtra es `Influencer.gender`, que es el campo con valores `male`/`female` (la UI de `FR-080` muestra `male · 25 · White`). La correspondencia entre ambos la hace el código. Es una inconsistencia de nomenclatura del producto original, **no** una contradicción de la especificación: los dos vocabularios se conservan porque los dos son literales observados.
5. El contenido con influencer soporta `slideshow`, `wall-of-text` y `video-hook`. **`green-screen` es siempre contenido regular.**
6. Una automation nueva **congela** el valor actual en su `prefsSnapshot`; cambiar la preferencia del workspace no altera una automation existente.
7. `settingsApplication` (`mode: "future_generations"`, `targetQueuedItems: 5`) es **sólo de respuesta**: enviarlo en un PATCH devuelve `400 bad_request`.

**Auto-reconcile de `angleWeights`.** Crear un ángulo activo, cambiar `isActive` o borrar un ángulo reescribe `angleWeights` **en la misma transacción** a un reparto par que suma 100 (p. ej. 3 ángulos → 34/33/33). Si quedan 0 ángulos activos, se limpia el mapa. Renombrar o editar la descripción **no** dispara reconcile. Para pesos personalizados hay que hacer un PATCH explícito **después** de mutar el ángulo. SUPPORTED

**Validation.** Body vacío `{}` → `400`. Set parcial de los cuatro pesos → `400`. `angleWeights` que no cubre todos los activos o referencia inactivos/ajenos → `400`. `textStyleWeights` con preset desconocido → `400`. Rate limit dedicado de actualización de preferencias: **3/min**. SUPPORTED

**Acceptance criteria.** (1) Guardar preferencias no altera la cola existente. (2) Los cuatro pesos suman siempre 100 y se validan como unidad. (3) Crear/desactivar/borrar un ángulo reparte los pesos de forma par automáticamente. (4) Con `influencerChance = 0` ninguna generación futura usa influencer.

---

## FR-056 — Content Angles

**Purpose.** Definir los encuadres narrativos con los que la IA escribe.

**Entry points.** `/blitz/settings` → `Voice & angles`; `Influencers → :id → Configuration → Content angles`.

**UI.** CONFIRMED `[DOCS-7 t=198s]`
- Tarjeta `Content angles` con subtítulo *"Restrict Blitz copy to these angles when this influencer surfaces."*
- Tile `+ New angle`.
- Tarjeta por ángulo: checkbox de activación (círculo → check naranja cuando activo), `title` en negrita, `description` truncada a 2 líneas. Ejemplos literales observados: `Endless Content Block` — *"Focuses on the constant pressure businesses face to feed social…"*; `DIY Marketing Revolution` — *"Highlights how non-marketers can now produce high-quality, on-brand…"*; `Stack`; `Consistency Burnout`; `One Idea, Everywhere`; `Consistency Without Burnout`; `Trend Chasing Fatigue`.

**Campos y límites.** SUPPORTED `[DEV]`

| Campo | Tipo | Máx. | Obligatorio |
|---|---|---|---|
| `title` | string | 200 | sí |
| `description` | string | 2000 | sí |
| `targetAudience` | string | 500 | sí |
| `influencerIds` | string[] | — | no |
| `isActive` | boolean | — | — |

**Reglas.** Máx. **100 ángulos por workspace** (borrar libera slot) → `MAX_ANGLES_EXCEEDED`. Máx. **10 ángulos por influencer** → `MAX_ANGLES_PER_INFLUENCER_EXCEEDED`. Todos los `influencerIds` deben ser únicos y referir a influencers **activos y entrenados** del workspace; el ángulo y sus enlaces se crean atómicamente. Desactivar un ángulo **borra todos sus enlaces de influencer**; reactivarlo **no** los restaura. Asignar influencers a un ángulo inactivo → `400`. Borrar es un **soft-delete** (desactivación) reversible por PATCH. SUPPORTED

**Generación asistida.** Existe un generador de ángulos: devuelve `{title, description, targetAudience, brandRevision}` **sin persistir**. Usa el perfil del workspace, contexto RAG y los títulos existentes para evitar repetición. Límite de **5 sugerencias exitosas por minuto**; la reserva de cuota se libera si la generación falla. Al persistir hay que reenviar `brandRevision` como `expectedBrandRevision`. SUPPORTED `[DEV POST /blitz/angles/generate]`

**Acceptance criteria.** (1) Crear un ángulo lo activa inmediatamente y reparte pesos. (2) Superar 100 ángulos o 10 por influencer devuelve el código específico. (3) Desactivar limpia enlaces y reactivar no los restaura.

---

## FR-060 — Scheduling & Publishing (flujo completo)

**Purpose.** Llevar una pieza de contenido a una o varias cuentas con la configuración nativa correcta de cada plataforma.

**Entry points.** Blitz → aprobar → `Schedule Post`; Content Studio → botón `📅 Schedule`; Library → `Reschedule` en un post.

> **EXTENSION EXT-007.** Entre `Content Details` y `Schedule` se inserta el **pre-flight de publicación** (`DP-007` / `JV-3`, §25): detecta antes de programar lo que la plataforma va a rechazar o ajustar. En Fastlane todos esos fallos son post-mortem. El pre-flight **nunca** puede impedir publicar si el servicio de juicio no responde.

### Paso 1 — `Select Platforms` (`Step 1 of 2` desde Studio; paso 2 del flujo de Blitz)
CONFIRMED `[DOCS-3 t=198s]`, `[DOCS-5 t=96s]`
- Encabezado `Select Platforms` + `Step N of M` + barra de progreso.
- Etiqueta `🖥 Select Platform`.
- Una fila por plataforma con checkbox e icono: `Instagram`, `Youtube`, `Tiktok` (y `LinkedIn`, `Reddit` donde aplique).
- Al marcar una fila aparece un botón `…` que despliega un sub-panel de opciones. Para TikTok:
  - `➤ Posting Mode` — segmented `Send to Inbox` / `Post Directly`.
  - Enlace `Step-by-step guide to TikTok posting →`.
  - Nota contextual: *"Content will be sent to your TikTok inbox for review before posting."*
- Footer: `Cancel` · `Next →`.

### Paso 2 — `Content Details` (`Step 3 of 4`)
CONFIRMED `[DOCS-B t=201s]`, `[DOCS-7 t=429s]`
- Encabezado `Content Details` + `Step 3 of 4`.
- **Una sección por plataforma seleccionada**, encabezada por icono + nombre + handle de la cuenta (`Instagram @ellaparkergrowth`, `TikTok @@ellaparkergrowth`).
- Campos por plataforma con contador de caracteres a la derecha:
  - Instagram: `Caption` `0/2200`.
  - TikTok: `Title` `0/90`, `Description` `0/4000`.
  - (YouTube: `caption` = título del video, `description` = cuerpo. SUPPORTED `[DEV]`)
  - (LinkedIn: sólo `caption`. SUPPORTED)
- Cada campo tiene dos acciones: `⚡ Improve` y `⟳ Regenerate`.
- TikTok añade: `Privacy Level` (select, default `Public to Everyone`) y `🎵 Auto-Add Music` (toggle) con nota *"TikTok will automatically add trending music to your slideshow."*
- Mientras la IA genera, cada campo muestra un spinner inline.
- Footer: `← Back` · `Next →`.

### Paso 3 — `Schedule` (`Step 4 of 4` / `Step 3 of 3`)
CONFIRMED `[DOCS-B t=210s]`, `[DOCS-2 t=318s]`
- Encabezado `Schedule` + paso + barra de progreso.
- `🕐 Select Time` — tres selects: hora (1–12), minuto, meridiano (`AM`/`PM`).
- `📅 Select Date` — calendario mensual: título `MMMM YYYY`, navegación ‹ ›, cabecera `Su Mo Tu We Th Fr Sa`, días fuera de rango en gris (deshabilitados), día seleccionado resaltado en color primario.
- Disclaimers (TikTok): *"ⓘ Content may take a few minutes to appear on TikTok after posting."* y *"By posting, you agree to TikTok's Music Usage Confirmation."* (enlace).
- Footer: `← Back` · `✓ Schedule Post`.
- Existe además la opción de **publicar ahora** en lugar de programar. CONFIRMED (narración `[DOCS-B]`)

**System behavior.**
- Al confirmar se crea un `Post` por cada (contenido × plataforma × cuenta) con estado `SCHEDULED`, y se muestra un toast con enlace a Library.
- Si el contenido aún no está `CREATED`, el post queda en `BUILDING` hasta que el media esté listo.
- Resolución de cuenta: `connectionId` es opcional **sólo si** el workspace tiene exactamente una conexión activa en esa plataforma; si hay varias, es obligatorio y su ausencia devuelve `400 connection_ambiguous` con la lista de candidatas. SUPPORTED
- `connectionId` y `warmedAccountId` son **mutuamente excluyentes**. SUPPORTED
- Warmed accounts sólo soportan `tiktok` e `instagram`; `youtube` y `reddit` son sólo OAuth. SUPPORTED
- `posting_mode` es **sólo TikTok OAuth**; se rechaza con `warmedAccountId`. `privacy_level` es obligatorio con `posting_mode: "direct"` y requiere el entitlement `tiktokDirect`. SUPPORTED
- Generación de caption al programar (`enableCaptionGeneration`): rellena **sólo** campos vacíos; los valores explícitos no vacíos siempre ganan. Requiere entitlement `autoCaptions`. `reddit` no lo soporta. SUPPORTED

**Estados de un Post (enum normativo).** SUPPORTED `[DEV]` + CONFIRMED `[APP]`
`BUILDING` · `CREATED` · `SCHEDULED` · `UPLOADING_TO_TIKTOK` · `IN_USER_INBOX` · `POSTED` · `FAILED` · `DELETED` · `AWAITING_RECONNECT` · (`CANCELLED` para cancelaciones).

Semántica:
- `IN_USER_INBOX` — TikTok aceptó el post y lo entregó como borrador en la app del creador; **no está publicado** hasta que el usuario abra la app, vaya a `Inbox → System notifications` y pulse `Post`. No es un error.
- `AWAITING_RECONNECT` — la conexión OAuth estaba inactiva en el momento de ejecución; se reanuda a `SCHEDULED` cuando el usuario reconecta, o pasa a `FAILED` si la hora programada ya pasó.
- `UPLOADING_TO_TIKTOK` con `tiktokProcessingDelayed: true` — TikTok en su carril lento; suele publicar solo en 24–48 h; Fastlane reintenta hasta **72 h** antes de darlo por fallido. **No reprogramar** mientras el flag esté puesto (crearía un duplicado).
- `cancellationPending: true` — cancelación de un post warmed en curso; se resuelve sola a `CANCELLED` o a `POSTED` si salió antes. **No reintentar**.

**Caption ajustada por la plataforma.** Si Fastlane ajusta de forma segura una caption de Instagram antes de publicar, `caption` conserva la copy original del usuario y `publishedCaption` contiene la copy en vivo; `captionAdjustmentReason` actualmente sólo vale `"repeated_mention"`. Los fallos exponen un `errorCode` estable y neutral respecto al proveedor (p. ej. `instagram_repeated_mention`) y un `errorMessage` siempre seguro de mostrar. SUPPORTED

**Validation y errores (códigos literales).** SUPPORTED
`connection_ambiguous` · `posting_mode_not_supported_for_platform` · `privacy_level_required` · `invalid_privacy_level` (incluye `details.allowed_values`) · `privacy_level_not_allowed_without_direct_mode` · `403 forbidden` (falta `tiktokDirect` o warmed posting no habilitado) · `402 payment_required` (falta `autoCaptions` o no quedan post slots warmed) · `404 not_found` · `429 rate_limited` (límite de plataforma o cuota de caption) · `409 conflict` (cuenta warmed no activa/finalizada/postable o pausada) · `503 tiktok_creator_info_unavailable`.
Límites de plataforma diferenciados: `tiktok_post_limit_exceeded`, `youtube_post_limit_exceeded`, `instagram_post_limit_exceeded`.

**Reglas de cuentas warmed en scheduling.** CONFIRMED `[APP]` + SUPPORTED `[DEV]`
- `Warmed-account posts can only be scheduled up to 30 days ahead.`
- `Warmed-account posts need at least <lead time>` — usar el `minLeadTimeMs` **de la cuenta**, no el global.
- `Once you approve, you can schedule posts, with the earliest slot about two days out`
- `Warmed-account publishing may happen that day or the morning after. We don't control the exact hour.`
- `This warmed account is awaiting your approval. Approve the account, then reschedule this post.`
- `No posting windows are left on that day. Pick another day.`
- `Posts scheduled for today are handed off quickly and can't be cancelled once they're being posted.`

**Acceptance criteria.**
1. Seleccionar 3 plataformas produce 3 secciones de copy independientes con sus límites de caracteres correctos.
2. `Post Directly` en TikTok exige `Privacy Level` y falla con mensaje claro si falta el entitlement.
3. Programar con una cuenta warmed respeta su lead time individual y el techo de 30 días.
4. Un post en `IN_USER_INBOX` se muestra como pendiente de acción del usuario, no como error.
5. Un post con `tiktokProcessingDelayed` bloquea la reprogramación del mismo contenido.

---

## FR-070 — Content Studio (creación manual)

**Purpose.** Control total sobre una pieza concreta, con o sin fuente en tendencia.

**Entry points.** Sidebar → `Content`; `Remix this` desde Inspiration/Home; tarjeta de formato en `/content`.

### UI del wizard (Generación A, funcionalmente vigente) CONFIRMED `[DOCS-5 t=0s]`, `[DOCS-2 t=3s]`, `[DOCS-3 t=21s]`, `[DOCS-4 t=6s]`

Columna izquierda, pasos con indicador circular (✓ azul cuando completo):

1. `Choose how to create your content` / `…your video` → segmented `⤫ Remix` · `⊕ Create New`.
2. `Directly mention your business?` → `Yes` · `No`.
3. Paso de fuente, dependiente del formato y del modo:
   - Remix: `Select a trending slideshow` / `Select a trending video` → botón `Select` (pasa a `Change` tras elegir) + miniatura.
   - Create New (wall-of-text): `Select a video` → `Select audio` → `Select a style`.
   - Create New (video-hook): `Select a hook video` → `Select your demo video` → `Select audio`.
   - Remix (video-hook): `Select a trending video` → `Select your demo video`.
   - Bajo el paso de demo: enlace `Need help recording? See how ↗` → `https://www.usefastlane.ai/record-product-demo`.
4. `Enter a prompt (Optional)` → textarea con placeholder específico por formato:
   - Slideshow: `What should this slideshow be about?`
   - Green screen: `What should this meme be about?`
   - Wall of text: `What should the wall of text caption be about?`
   - Video hook: `What should the hook caption be about?`
5. Botón `✨ Generate` (deshabilitado hasta completar los pasos obligatorios; muestra `⟳ Generating...` mientras corre).

Columna derecha:
- Tabs `🔥 Trending Content` · `🗂 Preview` · `⊗ Clear`.
- En `Trending Content`: carrusel 3-up con la tarjeta central ampliada, chips de nicho encima, botón `⤫ Remix` sobre la tarjeta, overlays de likes/views, dots para slideshows, navegación ‹ › y contador `N / M` (`3 / 72`, `1 / 58`, `2 / 64`).
- En `Preview`: render de la pieza + inspector derecho (ver `FR-051`), navegación de slides.
- Botones superiores derechos una vez generado: `💾 Save` · `📅 Schedule`.

### UI del wizard (Generación B, rediseño) CONFIRMED `[DOCS-manual t=0s, t=36s]`
Tarjetas compactas sin numeración: `Mode` (`⊕ Create New` / `⤫ Remix`) · `Mention your business?` (`Yes`/`No`) · `Video` (miniatura + `Change`) · `Audio` (icono + `Change`) · `Style` (select, p. ej. `Quick Thought`) · `Prompt (Optional)` · `✨ Generate`. Tabs superiores reordenados: `Slideshow` · `Wall of Text` · `Video Hook & Demo` · `Green Screen Meme`. Las tarjetas de trending muestran `⤫ Remix this`.

**System behavior.**
- `Generate` encola un build; la pestaña `Preview` muestra spinner + `Generating your content...`. CONFIRMED `[DOCS-2 t=120s]`
- Al completar, `Preview` se selecciona automáticamente y aparecen `Save` y `Schedule`.
- `Clear` descarta el preview y vuelve al estado inicial (`Clear preview`, `Clear template`). CONFIRMED
- El render es **server-side**. Para slideshows la ratio objetivo por defecto es `4:5`; las imágenes fuente deben venir pre-recortadas porque el build v1 usa **stretch-to-canvas** (se distorsionan si no coinciden). SUPPORTED `[DEV]` — el clon debe implementar el mismo contrato o mejorarlo explícitamente.
- Máximo **20 slides** por slideshow. SUPPORTED

**Payloads de build (contrato normativo).** SUPPORTED `[DEV POST /content]`
- Objeto de texto común: `{content, x, y, width, fontSize, color, textAlign: left|center|right, fontWeight?: 100–900, strokeWidth?, strokeColor?, backgroundColor?}`.
- `canvas` = `{width, height}` en píxeles (p. ej. 1080×1920). Cada elemento de media lleva `drawX/drawY/drawW/drawH`.
- `wall-of-text`: `{canvas, video{url,draw…}, audio{url}, text}`.
- `green-screen`: `{canvas, image{url,draw…}, video{url,draw…}, text}` — el video con croma se compone **sobre** la imagen de fondo.
- `video-hook`: `{canvas, hook_video{…}, demo_video{…}, audio{url}, text}` — hook arriba, demo abajo.
- `slideshow`: `{num_images, images:[{canvas{width,height,aspectRatio}, image{url,draw…}, texts:[…]}]}`; `num_images` debe coincidir con la longitud de `images`.
- **Aclaración (2026-09-21, al contratar la API).** `wall-of-text`, `green-screen` y `video-hook` llevan **`text` en singular**: un solo objeto de texto. Sólo `slideshow` lleva `texts:[…]`, y por imagen. `FR-051` habla de "las cajas de texto" en plural describiendo el editor, lo que se lee como que los cuatro formatos aceptan varias; **no es así**. Este payload está marcado *contrato normativo* y gana. Si en el futuro un formato necesita varias cajas, es un cambio de contrato con versión nueva, no una lectura distinta de este párrafo.
- **Toda URL de media debe pertenecer al Media Bank del workspace o a la librería compartida de Fastlane.** Una URL arbitraria se rechaza con `400 bad_request` antes de iniciar el build. El audio sólo puede venir de la librería compartida.

**States.** default · source-selected · generating (`Generating your content...`) · preview · saving · scheduling · error.

**Edge cases.** `video-hook` sin demo video → no se puede generar (`422 content_unavailable_for_type` en la ruta automática). Subida de video propio: MP4/MOV, ≤ 50 MB; MOV se normaliza a MP4 en servidor. SUPPORTED

**Acceptance criteria.** (1) Cada uno de los 4 formatos base produce un render correcto en ambos modos. (2) `Generate` está deshabilitado hasta cumplir los pasos obligatorios. (3) El preview permite editar texto y media antes de guardar. (4) Una URL de media ajena al workspace se rechaza antes del build.

---

## FR-071 — Modal `Swap image for slide N`

**UI literal.** CONFIRMED `[DOCS-5 t=75s]`
- Título `Swap image for slide <N>`, cerrar `✕`.
- Tabs: `Theme Images` (catálogo temático de Fastlane) · `🖼 My Images` (Media Bank del workspace).
- Grid 4×N con scroll; la imagen seleccionada se marca con borde azul y check circular.
- Footer izquierdo: `New image selected` (estado). Footer derecho: `Cancel` · `Swap`.

**System behavior.** El swap afecta **sólo** al slide indicado. Tras confirmar, el preview se re-renderiza. CONFIRMED

---

## FR-080 — Influencers: creación

**Purpose.** Crear un personaje IA persistente y entrenado, reutilizable en todo el contenido.

**Entry point.** `/influencers` → `+ New influencer` (o `Continue influencer creation` si hay un borrador).

**UI — cabecera de `/influencers`.** CONFIRMED `[DOCS-7 t=0s]`
`Influencers ⓘ` + subtítulo *"Persistent AI characters — train once, generate endlessly."* · pill `<N> credits` · botón `Buy more` · botón `⟲ Continue influencer creation` · botón primario `+ New influencer`.
Grid de tarjetas: imagen vertical, `name`, badge `ACTIVE`, línea `gender · age · ethnicity` (p. ej. `male · 25 · White`).

**UI — wizard `New influencer`.** CONFIRMED `[DOCS-7 t=15s / t=48s / t=81s]`

**Paso 1/3** — `New influencer (1/3)`, barra de progreso de 3 tramos, saldo de créditos + `+ Add credits`.
- Segmented: `Generate base image` · `Upload your own`.
- Nota: *"Describe your character. We'll generate a base image as soon as you continue · 4 credits"*.
- Campos: `NAME` (texto) · `GENDER` (select, placeholder `Select…`) · `AGE · <n>` (slider, rango **18–60**, default 25) · `ETHNICITY` (texto) · `ADDITIONAL DETAILS (OPTIONAL)` (textarea, placeholder *"e.g. freckles, athletic build, curly red hair"*).
- Botón `Next` (deshabilitado hasta completar obligatorios).

**Paso 2/3** — `New influencer (2/3)`.
- Texto literal: *"Generating a base character now (~30–60s, costs 4 credits). Don't like it? Add instructions below and hit Regenerate to create a different base character. Regenerations produce a brand-new person, not edits to this one."*
- Imagen base generada (9:16).
- `REGENERATION INSTRUCTIONS (OPTIONAL)` — textarea, placeholder *"e.g. curlier hair, softer features, in a coffee shop"*.
- Botones: `Back` · `Regenerate · 4 credits` · `Continue`.

**Paso 3/3** — `New influencer (3/3)`.
- Miniatura + texto *"Our agents will go and create <Name> for you now. Takes about 15–20 minutes."*
- Panel: `COST` `250 credits` · `YOUR BALANCE` `<saldo>`.
- Botones: `Back` · `Create influencer`.

**System behavior.**
- La creación arranca un pipeline asíncrono de generación de variaciones + entrenamiento. Estados: `generating_variations` → `training` → `ready` \| `failed` \| `inactive`, con `progress` entero 0–100. SUPPORTED `[DEV]`
- El influencer sólo aparece en el catálogo utilizable (`GET /influencers`) cuando está **activo y entrenado** (`ready`). SUPPORTED
- Cap: **50 influencers activos por workspace**; desactivar libera slot. SUPPORTED
- La creación requiere **idempotencia** (`Idempotency-Key`) para que reintentos no dupliquen ni reserven créditos dos veces. SUPPORTED
- Ruta `Upload your own`: subida directa a storage con URL firmada; formatos `image/jpeg`, `image/png`, `image/webp`; la extensión del filename debe coincidir con el content type; **máx. 10 MB**. SUPPORTED

**Costes (CONFIRMED en UI).** Imagen base / regeneración: **4 créditos** (~30–60 s). Creación del influencer: **250 créditos** (~15–20 min). Generación de imagen del personaje: **4 créditos por imagen** (~30–60 s). Generación de video: **60 créditos** (~1–3 min).

**Validation / errores.** `402 payment_required` cubre tres causas: cap de 50 alcanzado, créditos insuficientes (incluye `details.balance` y `details.required`) o cuota de storage excedida. `409 conflict`: upload no alcanzable aún, otra creación finalizándolo, o idempotency key en uso. `410 gone`: reserva de upload expirada. `404 not_found`: reserva inexistente o de otro workspace. SUPPORTED
Copy de UI: `Not enough credits. Top up or upgrade to continue.` · `Not enough credits. Top up to generate.` · `<N> more credits to continue.` · `Couldn't open the influencer creator. Please try again.` · `We couldn't find this influencer. It may have been deleted.` CONFIRMED

**Acceptance criteria.** (1) El slider de edad se limita a 18–60. (2) Regenerar produce un personaje **nuevo**, no una edición. (3) El estado y el `progress` se pueden consultar hasta `ready`/`failed`. (4) Un reintento con la misma idempotency key replica la respuesta original.

---

## FR-081 — Influencer: galería de imágenes

**Entry point.** `/influencers/:id` (tab `Images`, por defecto).

**UI.** CONFIRMED `[DOCS-7 t=111s / t=246s]`
- Barra superior: `‹ Influencers` · nombre en negrita · badge `ACTIVE` · `gender · age · ethnicity` · pill de créditos · `Buy more` · `🗑 Delete` (rojo).
- Tabs: `Images` · `Videos` · `Configuration` · enlace `Configure in Blitz →`.
- Grid 5×N de imágenes verticales. Hover: icono papelera (arriba-derecha) y botón `🎞 Animate` (centro-inferior).
- **Barra flotante de generación** (inferior, con chevron para colapsar): input de prompt (placeholder `e.g. her at the beach` / `e.g. him at the beach` según el género) · nota `4 credits per image · ~30–60s` · select `✨ Template` · botón `➤ Generate`.

**Detalle de imagen (drawer).** CONFIRMED `[DOCS-7 t=138s]`
- Izquierda: imagen a tamaño completo. Derecha: panel con `PROMPT` (texto), y tarjetas de metadatos: `MODEL` (`Fastlane V8`), `ASPECT` (`9:16`), `RESOLUTION` (`1080p`), `BATCH` (`1`), `CREDITS` (`4`), `CREATED` (`DD/MM/YYYY, HH:MM:SS`).
- Botón `⬇ Download`.
- Bloque `ANIMATE THIS IMAGE` con tabs `Video` · `Talking Head UGC`:
  - `Talking Head UGC`: `Script` (textarea, placeholder *"Write what the person should say"*), validación en vivo *"0 words may be too short for 5s - Target 10-15 words"*, `Duration` (select `5s`), `Language` (select `English`), checkbox `Caption overlay` (marcado por defecto), botón `Generate`.

**System behavior.** La generación es asíncrona; el resultado aparece en la galería. `Talking Head UGC` produce un video y avisa: `Talking Head UGC generating. Check the Videos tab.` CONFIRMED `[APP]`

**Acceptance criteria.** (1) El prompt bar respeta el coste y lo descuenta. (2) `Animate` desde hover y desde el detalle llevan al mismo flujo. (3) La validación de longitud de script reacciona en vivo a la duración elegida.

---

## FR-082 — Influencer: galería de videos

**UI.** CONFIRMED `[DOCS-7 t=156s / t=477s]`
- Grid 5×N con thumbnail y botón ▶ centrado; hover muestra papelera.
- Barra flotante: tabs `Video` · `Talking Head UGC`; botón `🖼 IMAGE` (adjuntar imagen de referencia); input de prompt con placeholder *"describe the motion (optional, e.g. slow zoom on the face)"*; nota `60 credits · ~1–3 min`; select de modelo (`Kling v3 Pro`); select `✨ Template`; segmented de duración `5s` / `10s`; botón `➤ Generate video`.

**Acceptance criteria.** (1) Seleccionar duración cambia el coste/expectativa mostrada. (2) El video generado queda asociado al influencer y es elegible como fuente en Blitz.

---

## FR-083 — Influencer: Configuration

**UI.** CONFIRMED `[DOCS-7 t=198s]`
- Banner `✓ All changes saved`.
- **Content angles** (izquierda) — ver `FR-056`.
- **Publishing accounts** (derecha) — subtítulo *"Platform accounts this influencer publishes through."* Tres columnas: `TikTok`, `Instagram`, `YouTube`. Cada columna lista las cuentas conectadas con un checkbox circular (naranja cuando activa), p. ej. `Fastlane` / `@ellaparkergro…`, `ellaparkergrowth` / `usefastlane.ai`, `Ella Parker Gro…` / `Fastlane AI`.
- **Slideshow sets** (abajo-izquierda) — *"Image sources for influencer-flavoured slideshows"*.
- **Video sets** (abajo-derecha) — *"Background / hook video source for wall of text and video hook…"*.

**System behavior.** Auto-guardado con confirmación visual. Las cuentas marcadas condicionan a qué destinos se enruta el contenido generado con ese influencer.

---

## FR-090 — AI Studio

**Entry point.** Sidebar → `AI Studio` (`/ai-studio`).

**UI.** CONFIRMED `[APP AiStudioPage]`
- `AI Studio view` con botón/panel `How to use` / `How to use AI Studio`.
- Barra de prompt con placeholder `add specifics (optional)` y ejemplos `e.g. man selfie`, `e.g. woman selfie`.
- Control `Image count`.
- Slots de referencia: `composition reference`, `product image`, y referencia de persona.
- Indicador de créditos y `<N> more credits`.

**System behavior.** Máximo **10 generaciones en vuelo** simultáneas. Si tarda: *"Taking longer than expected. We'll keep working in the background."*

**States.** empty (*"No generations yet. Start generating with a prompt below."*) · generating · done · blocked.

**Errores literales.** `Not enough credits. Top up or upgrade to continue.` · `Your current plan doesn't include AI Studio. Upgrade to use it.` · `You have 10 generations in flight. Wait for some to finish before starting another.` · `Your prompt contains terms we don't allow. Try rephrasing.` · `Your prompt or image was blocked by the content filter. Try rephrasing or use a different image.` · `That reference image can't be used with the selected model.` · `We couldn't find that reference image. Pick another image and try again.` · `This character needs a person reference.` · `Some media in this set was deleted. Refresh and try again.` CONFIRMED

**Acceptance criteria.** (1) El límite de 10 en vuelo se aplica y se comunica. (2) El filtro de contenido produce los mensajes exactos según la causa. (3) Sin plan adecuado, el módulo se bloquea con CTA de upgrade.

---

## FR-100 — Library

### Tab `My Posts`
**UI.** CONFIRMED `[DOCS-6 t=21s]`, `[DOCS-2 t=345s]`
- Cabecera: `My Posts` · botón `⟳ Refresh Metrics` (primario) · botón `Select` · contador a la derecha (`101 posts`).
- Grid 5×N. Cada tarjeta:
  - Barra superior: badge de plataforma con icono (`Instagram`/`TikTok`/`YouTube`), handle truncado (`@seefutureba…`), icono de estado a la derecha (✓ verde = posted, calendario azul = scheduled, ✕ ámbar = failed/cancelled).
  - Thumbnail 9:16.
  - Pie: `Posted: DD/MM/YY` o `Scheduled: hh:mm am/pm, DD/MM/YY` + badge de tipo (`Video Hook`, `Green Screen`, `Wall of Text`, `Slideshow`).
  - Fila de métricas: `views N` · `likes N` · `comments N` (con iconos).
- Hover sobre un post programado: botones `📅 Reschedule` y `✕ Cancel`.

### Tab `My Content`
**UI.** CONFIRMED `[DOCS-6 t=27s]`
- Cabecera `My Content` + `Select` + contador (`78 items`).
- Tarjetas con thumbnail, `Created: DD/MM/YY` y badge de tipo. Sin métricas ni cuenta.

### Tab `My Media Bank`
**UI.** CONFIRMED `[DOCS-7 t=375s]`
- Tabs superiores `My Posts` · `My Content` · `My Media Bank` + botón `? What is this?`.
- Fila `INFLUENCER`: chips `All` · `<nombre de cada influencer>`.
- Fila `YOUR SETS ⓘ`: tile `+ New set` + tarjetas de set con badge de tipo (`SLIDESHOW`, `VIDEO`, `CURATED`) y nombre (`Ella POV shots + en…`, `POV selfies`, `Generic Lifestyle`, `Entrepreneur / Hus…`).
- Dropzone: `⬆ Drop images or videos here` / *"Click to browse your computer. Supports JPG, PNG, WebP, or MP4."*
- Barra de filtros: segmented `All` · `Images` · `Videos`; select `All categories`; icono ⓘ. A la derecha: contador (`41 items`), botón `⬆ Upload`, botón `Select`.
- Grid de assets: badge de categoría sobre la miniatura (`bg`, `hook`, `Demo`, `Uncategorized`), duración para videos (`0:05`), nombre de archivo truncado, `<size> MB · <fecha>`.

### Creación de un Set (modo `CREATING SET`) — CONFIRMED `[DOCS-7 t=237s]`
- Al pulsar `+ New set` la grid entra en modo selección: aparece un **checkbox circular** en la esquina superior izquierda de cada asset.
- Barra inferior fija con tres zonas:
  - Izquierda: etiqueta `CREATING SET` y contador de progreso — **`<N> selected (need <M> more)`**. El valor observado es `0 selected (need 5 more)`, lo que fija un **mínimo de 5 assets por set**.
  - Centro: input `Set name` con placeholder `Set name (e.g. 'Bedroom shots')`.
  - Derecha: `✕ Cancel` y `✓ Save` (el botón de guardado permanece **deshabilitado** hasta alcanzar el mínimo y tener nombre).
- Los assets muestran su badge de categoría durante la selección (p. ej. `slide`).

**FR-100.1 — Deep-linking con contexto de retorno.** CONFIRMED `[DOCS-7 t=237s]`
La Library acepta parámetros de contexto que permiten llegar desde otra pantalla y volver: `/library?influencerId=<id>&from=%2Fblitz%2Fsettings%3Ffocus%3D<influencerId>`. El clon debe soportar el mismo patrón (`from` URL-encoded + `focus`) para que los enlaces `Add images` / `Add video` de `/blitz/settings` lleven al Media Bank filtrado por ese influencer y devuelvan al usuario al punto exacto de origen.

**System behavior (Media Bank).** SUPPORTED `[DEV /media]`
- Subida en dos fases: reserva (`upload-url`) → PUT directo a storage → finalización.
- Tipos aceptados: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/quicktime`. Límites: **imágenes 10 MB**, **videos 50 MB**.
- Las imágenes quedan `ready` al instante; los videos quedan `processing` y se normalizan en background (MOV→MP4, HDR→SDR, faststart) hasta `ready` o `failed`.
- **Categorías válidas por tipo:** imágenes → `slideshow-image`, `green-screen-background`; videos → `background-video`, `hook-video`, `green-screen-video`. `green-screen-video` marca el clip como **foreground** superponible.
- Cambiar categorías es un **reemplazo total**. Lista vacía = el asset sale de todos los pools automáticos de Blitz. El contenido ya publicado/programado/guardado que lo referencia **no cambia**; las sugerencias de Blitz no aceptadas y los previews de automation no lanzados pueden descartarse o regenerarse.
- Borrado idempotente; se **rechaza** si el asset sigue referenciado por contenido no borrado, un influencer activo o un flujo de entrenamiento activo → `409 media_in_use`.
- Assets generados, de demo e internos **nunca** se listan.

**Search / filters.** `Search your images` (en pickers). Filtros por tipo y categoría en Media Bank; filtro por influencer. En `My Posts`, el filtrado por estado se infiere del API (`status` como lista separada por comas). INFERRED para la UI.

**Acceptance criteria.** (1) Las tres pestañas muestran conteos correctos. (2) `Refresh Metrics` actualiza views/likes/comments. (3) Subir un MOV lo convierte a MP4 y lo deja `ready`. (4) Borrar un asset en uso devuelve `media_in_use` con mensaje accionable.

---

## FR-110 — Calendar

**UI.** CONFIRMED `[DOCS-6 t=0s]`
- Cabecera: icono de alternancia de vista (azul, activo) · `‹` · `<Month> <Year>` · `›`. A la derecha, tres contadores con icono: `✓ 36` (publicados), `📥 0` (inbox), `📅 19` (programados).
- Cuadrícula semanal con cabeceras `Su Mo Tu We Th Fr Sa`.
- Celda de día: número + `(N posts)` cuando hay contenido; el día actual resaltado con fondo.
- Chip de post: punto/icono de estado + icono de plataforma + `Plataforma: Tipo` (p. ej. `TikTok: Slideshow`, `Instagram: Wall of Te…`, `YouTube: Green Scree…`) + hora (`11:56 PM`). Fondo tintado por plataforma (Instagram lila, TikTok verde, YouTube rojo).
- Vista alternativa `Grid view` / `Calendar view` (presente en el wizard de Automations). CONFIRMED `[APP]`

**System behavior.** Click en un chip abre el detalle del post (INFERRED). Navegación mensual sin recarga.

**States.** default · loading · empty (mes sin posts) · error.

**Acceptance criteria.** (1) Los contadores de cabecera coinciden con los estados reales. (2) Los chips se agrupan por día y se ordenan por hora.

---

## FR-120 — Analytics

**UI.** CONFIRMED `[APP AnalyticsPage]`
- Título + subtítulo `Track your content performance across all platforms.`
- Selector de rango en días (`<N> days`).
- Tarjetas de desglose por plataforma: `TikTok posts`, `Instagram posts`, `YouTube posts`, `LinkedIn posts`, `Reddit posts`.
- Desglose por tipo de contenido con leyenda de color: `Slideshow`, `Wall of Text`, `Green Screen`, `Hook & Demo`.
- Métrica `Social website views`.
- Skeletons de carga y estado `Loading lifetime post breakdowns`.

**System behavior.** Las métricas por post (`views`, `likes`, `comments`) reflejan la **última sincronización** con la plataforma; posts publicados hace minutos pueden devolver ceros hasta que el job de sync los alcance. Usar `postedAt` para distinguir un cero real de un pre-sync. SUPPORTED `[DEV]`

**Website analytics.** Script ligero activable: `Track visitor analytics on your website`, `Add a lightweight tracking script to monitor website traffic`. Desactivación con confirmación: `Are you sure you want to disable analytics tracking?`. Errores: `Failed to enable analytics:` / `Failed to disable analytics:`. Atribución de ads separada: `Ad attribution is off.`, `Could not turn off ad attribution. Please try again.` CONFIRMED

**Acceptance criteria.** (1) Cambiar el rango recalcula todas las tarjetas. (2) Un post recién publicado no se muestra como "0 views" sin indicar que está pre-sync.

---

## FR-130 — Warmed Accounts

**Purpose.** Publicar desde cuentas reales, creadas y calentadas por humanos en el mercado objetivo.

**Entry points.** Sidebar → `Warmed Accounts` (`/warmed-accounts`); `Settings → warmed-accounts`.

**Flujo de compra y provisión.** SUPPORTED `[WWW /tools/buy-tiktok-accounts]`
1. El cliente elige **plataforma** (TikTok o Instagram), **país** (US o EU) y **nicho + keywords**.
2. Una persona real crea la cuenta y la calienta **5 días** en un teléfono genuino, replicando comportamiento natural del nicho (scroll, ver, likes, follows).
3. La cuenta se vincula al workspace de Fastlane.
4. El cliente genera o sube contenido y programa posts nativos.

**Copy de UI observado.** CONFIRMED `[APP]`
`Payment received! Configure your new accounts below to begin warming.` · `These details are locked once the account is warmed.` · `Account Awaiting Approval` · `Account Status Being Checked` · `Account Unavailable` · `Posting is temporarily paused while we check this account. You do not need to do anything right now.`

**Modelo de datos expuesto.** SUPPORTED `[DEV GET /warmed-accounts]`
`warmedAccountId`, `accountType: "warmed"`, `platform`, `username`, `displayName`, `profilePictureUrl`, `status`, `postable`, `postingAvailability`, `minLeadTimeMs`, `createdAt`, `updatedAt`; más `replacementDecisions[]`, `slotBalance` y un `minLeadTimeMs` global (el más conservador, sólo por compatibilidad). Máximo **100 cuentas visibles**, sin cursor de paginación.

**`postingAvailability` (enum).** `available` · `checking` (publicación pausada mientras se verifica el estado) · `replacement_needed` (pausada hasta restaurar o reemplazar).

**`postable`** es `true` sólo si la cuenta está activa y completamente provisionada, el workspace tiene acceso a publicación warmed y la plataforma soporta publicación por API.

**Reemplazos.** Cuando una cuenta es baneada, se oculta pero permanece una `replacementDecision` que identifica la decisión pendiente del **owner** y las opciones disponibles. Hay que completar la elección en la página de Warmed Accounts **antes** de programar en la nueva cuenta. SUPPORTED

**Pricing.** $100/mes por cuenta + **$1,50 por post subido**. Requiere suscripción activa de Fastlane. SUPPORTED

**Restricciones.** No disponible en trial (`Warmed accounts are unavailable on trial`). Sólo `tiktok` e `instagram` en publicación por API. Lead time por cuenta (algunas horas a ~2 días). Máx. 30 días de antelación. SUPPORTED/CONFIRMED

**Acceptance criteria.** (1) Una cuenta no aprobada bloquea el scheduling con mensaje accionable. (2) `checking` y `replacement_needed` pausan la publicación sin marcarla como error. (3) El balance de slots se decrementa por post y bloquea cuando llega a 0 (`402 payment_required`).

---

## FR-140 — Engagement (Reddit lead generation)

**Purpose.** Encontrar conversaciones en Reddit donde la audiencia busca la solución que ofrece el producto, y responder con ayuda genuina sin quemar la cuenta.

> **Mecanismo.** El PRD especifica `Top Scored Leads` y el medidor de riesgo, pero no cómo se puntúa ni quién etiqueta cada respuesta. Eso se define en §25: **`DP-002` / `JV-2`** (scoring y priorización de leads) y **`DP-003` / `JV-5`** (clasificación del tono de cada respuesta, con el ratio calculado en código).

**Entry points.** Sidebar → `Engagement` → `/engagement/actions` (leads) y `/engagement/insights`.

**UI y capacidades.** CONFIRMED `[APP ActionsView]`
- **Conexión:** `Connect Reddit Account`; estado `No active Reddit connection`.
- **Configuración:** `Configure discovery subreddits`; `Reply Settings` con `Save Changes` y `Save Custom Rules`; opción de tono descrita como *"Proper capitalization, polished, business-appropriate"*.
- **Descubrimiento:** proceso en background — `Discovering new Reddit leads (started …)`, `Rate limited - will retry …`, `Scheduled …`, `- processing soon`, `- will process soon`.
- **Listado:** vistas `Most Engaged Leads` y `Top Scored Leads`; filtro `Unseen only`; badge `New activity`; búsqueda (`Open search`, `Close search`); `Back to All Leads` / `Back to Leads`; acción `Delete lead`.
- **Detalle:** `Post Details`, `Full post content and details`, `Content and activity`, `Why this lead?`, `View on Reddit`, `Activity Found!`.
- **Respuesta IA:** `Generate AI reply`, `Regenerate reply`.
- **Seguimiento:** `Sync with Reddit`, `Thread state verified and updated.`, `Tracking conversation now.`, `Engagement thread monitoring`. Aviso cuando hay actividad propia pero no respuestas directas: *"…from you on this post, but none are direct replies to this specific lead. Make sure you're replying to the right comment/post."*
- **Ban risk meter** (`Refresh ban meter`) con 4 niveles y recomendación literal por nivel:
  - `Safe - Healthy engagement pattern` → *"Keep up the good work. Continue providing value-first content."*
  - `Caution - Monitor engagement` → *"Your engagement shows some concerning patterns. Minor adjustments recommended."*
  - `Warning - High risk, reduce promotional content` → *"Balance promotional content with more value-add contributions. Monitor your visibility."*
  - `Danger - Very high risk, stop promotional engagement` → *"High risk detected. You're likely being spam-filtered on some subreddits."* + *"Stop replying through Fastlane. Focus only on normal Reddit activity — browse, upvote, and scroll to let your account reputation recover."*
  - Recomendación de ratio: *"…to maintain account health. We recommend at least 3-4 value-add replies for every promotional one."* y *"Aim for 60-70% value, 20-30% subtle, 10-20% direct."*
- **Ayuda:** `How it works`, `How to use this feature`, `Curate your Profile`.

**States.** no-connection · discovering · results · empty (*"Try adjusting your filters or fetch new leads to discover conversations where your audience is seeking solutions."*) · lead-loading (`Loading lead...`) · not-found (`Lead Not Found` / *"This lead may have been deleted or is no longer available."*) · unauthorized (`Access Denied` / *"You don't have permission to view this lead. It may belong to another account."*) · workspace-gone (`Workspace Unavailable` / *"The workspace containing this lead has been deleted."*).

**Acceptance criteria.** (1) Sin conexión de Reddit, el módulo muestra el CTA de conexión y nada más. (2) El ban meter recalcula con `Refresh ban meter` y cambia de nivel con el ratio de respuestas promocionales. (3) Las respuestas generadas respetan las reglas personalizadas guardadas.

---

## FR-150 — Automations (campañas multi-semana)

**Purpose.** Programar semanas de contenido de una sola vez, con revisión humana antes de publicar.

**Entry points.** Sidebar/`/automations` → `New automation`; `/automations/new`.

**Ciclo de vida (normativo).** SUPPORTED `[DEV MCP]`
`DRAFT → GENERATING → REVIEW → BUILDING → ACTIVE → COMPLETED` (o `CANCELLED` / `FAILED`).

**Estados de slot.** `PENDING_GEN` · `GENERATING` · `READY` · `REROLLING` · `FAILED_GEN` · `QUEUED_BUILD` · `BUILDING` · `SCHEDULED` · `FAILED` · `CANCELLED`.

**Configuración (todo en DRAFT; la config se bloquea al empezar a generar).** SUPPORTED

| Campo | Tipo | Regla |
|---|---|---|
| `name` | string | ≤ 100 caracteres; renombrable en **cualquier** estado |
| `accounts[]` | array | `{platform, accountType: oauth\|warmed, connectionId \| warmedAccountId}`. LinkedIn y YouTube son **sólo OAuth** |
| `perAccountPerDay` | int | 1–3 |
| `durationWeeks` | int | 1–4 |
| `startDateUtc` | number | ancla de publicación en ms UTC |
| `timezone` | string | IANA; default = timezone del owner |
| `postingMode` | string | `inbox` \| `direct` (TikTok) |
| `youtubePrivacyStatus` | string | `public` \| `private` \| `unlisted` |
| `discloseAsAds` | boolean | disclosure de paid partnership en posts warmed |
| `aiContentDisclaimer` | boolean | etiqueta AI; **no modificable tras el lanzamiento** |
| `prefsSnapshot` | object | pesos de tipo, `remixPercentage`, `angleWeights`, `textStyleWeights`, `videoHookAudioMix`, … |

**Reglas duras.** SUPPORTED
- Todo destino YouTube exige `prefsSnapshot.slideshowWeight = 0` **antes** de generar.
- Un tipo con peso 0 queda **excluido**, no es fallback: la generación y la recuperación nunca lo sustituyen. Una campaña cuyo único tipo con peso falla repetidamente entrega menos posts en lugar de cambiar de tipo.
- Errores de generación: `AUTOMATION_NO_CONTENT_TYPE_SELECTED` (todos los pesos a 0) y `AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO`.
- `FAILED_GEN` lleva `failureReason`: `no_unique_content` (todos los borradores repetían contenido ya usado) o `no_demo_video`. Los slots fallidos **no producen post**.

**Revisión.** Editar un slot en `REVIEW` con slot `READY`, en tres grupos independientes: (1) `suggestionData` + `generatedText` (deben ir juntos); (2) `captionsByPlatform` (reemplaza el mapa completo; una plataforma omitida se **borra**); (3) `scheduledAtUtc`. Para YouTube, `caption` = título y `description` = cuerpo; LinkedIn sólo acepta `caption`. SUPPORTED

**Re-roll.** Descarta la sugerencia actual y regenera (irrecuperable), consume una generación de la cuota de la campaña, pasa el slot a `REROLLING`. Permite forzar `contentType` (`slideshow` no está permitido en slots que publican a YouTube). SUPPORTED

**Launch.** Reserva todos los slots `READY`, cobra el presupuesto de contenido y el balance de post slots, y arranca los builds. **No reversible por edición**; después sólo se puede cancelar. Antes de lanzar hay que consultar `launchValidation`. SUPPORTED

**UI del wizard (copy literal).** CONFIRMED `[APP AutomationWizard]`
- `Automation setup progress`; `Campaign length in weeks`; `posts per account per day`; `Influencer frequency`; `Remix ratio`; `Own media percentage`; `Caption style`; `Set a caption style mix`; `TikTok posting mode`; `YouTube privacy`; `Calendar view` / `Grid view`; `Post details`; `Edit post`; `Adjust schedule`; `Re-roll this suggestion`; `Remove suggestion`; `Confirm remove`; `Won't post`; `Continue to launch`; `Launch campaign`; `Ready to launch`; `Everything checks out. Your posts will be reserved on launch.`; `Validating your campaign against your plan and accounts.`
- Gates y bloqueos: `More content saves needed` + `Buy saves`; `More warmed-account post slots needed` + `Buy posts`; `Posting limit conflicts`; `Content is still generating` + `Wait for generation or re-rolls to finish, then try again.`; `Couldn't finish checking this campaign` + `Try again. If this keeps happening, reduce the campaign size.`; `Reduce the length, posts per day, or accounts to continue.`; `Upgrade your plan or remove the warmed accounts before launch.`; `Warmed accounts not available on trial`; `Finish training at least one influencer to enable this.`; `No current campaign destination supports this label. Turn it off before launching.`
- Disclaimers de etiqueta IA: *"Adds Instagram's AI-generated content label to Ayrshare posts. This cannot be changed after launch."* · *"Adds TikTok's native AI-generated content label to connected direct-video posts. This cannot be changed after launch."* · *"Adds the AI-generated content label to eligible Instagram and TikTok posts. This cannot be changed after launch."*
- Post-lanzamiento: *"…in the background, no further action needed. You can follow progress and analytics on the campaign page, and cancel at any time."*

**Detalle de campaña.** CONFIRMED `[APP AutomationDetailPage]`: `Campaign name`, `Rename automation` / `Save name` / `Cancel rename`, `Manage accounts`, `Remove account`, `Cancel automation`, `Cancellation pending`, estado `building`.

**Cancel / Delete.** `cancel_automation` detiene toda publicación futura, revoca los posts programados y marca los slots restantes `CANCELLED`; es irreversible y los posts ya publicados siguen vivos; los posts warmed ya entregados al account manager **pueden publicarse igualmente**. `delete_automation` se rechaza mientras esté `BUILDING` o `ACTIVE`. SUPPORTED

**Disponibilidad.** Requiere que la feature esté liberada al workspace **y** un plan que la incluya; si no, los tools devuelven `forbidden`. SUPPORTED

**Acceptance criteria.** (1) Un destino YouTube con `slideshowWeight > 0` bloquea la generación con el error exacto. (2) `launchValidation` enumera todos los gates incumplidos antes de permitir lanzar. (3) Cancelar una campaña activa revoca los posts programados y deja los publicados intactos.

---

## FR-160 — Settings

### `account`
Perfil del usuario, email verificado (`Verified email sync failed`), y **borrado de cuenta**: `Permanently delete your account?`, confirmación por email (`The email address does not match your account.`), estados `Account deletion is already in progress.`, `Account deletion was rejected safely`, `Account deletion is temporarily unavailable. Contact support for help.`, `We couldn't start account deletion. Try again, or contact support if this continues.` CONFIRMED

### `workspaces`
`Switch workspace`, `Create another workspace`, `Use current workspace`, `Keep workspace`, `No other workspace available`. Aviso de borrado: *". You lose access to everything in this workspace."* y *"in this workspace will have their subscriptions cancelled and any unused post slots forfeited, and"*. Estados: `Workspace is still loading. Please try again in a moment.`, `Setting up your workspace with your company information`, `Workspace preparation progress`, `We encountered an issue while setting up your workspace`. CONFIRMED

### `integrations`
Conexión OAuth por plataforma: TikTok, Instagram, YouTube, LinkedIn, Reddit. `Add Account`, `+ Add another account`, `Connected accounts`, `Not connected`, `Connect backup`, `Connection limit reached`, `Configure connections and content sets`.
Reglas y avisos literales CONFIRMED:
- `Business or Creator account` / *". Personal accounts cannot use the publishing API."* / `professional account`
- `Connection Expired`, `Paused: reconnect needed`, `Connected Account Changed`, `Instagram account needs attention`, `Reconnect Instagram to keep posting`
- `LinkedIn connections last 60 days. Reconnect to keep posting without interruption.`
- `Permissions Missing`, `Reconnect to upgrade permissions`, `Reconnect a platform to enable new features`, `TikTok permissions are missing. Please disconnect and reconnect your account.`, `You declined a permission Fastlane needs. Please try again and approve all requested permissions.`
- `A different Instagram account was connected. Open the connect flow again and choose the matching account.`
- `Re-connect to enable direct posting with captions. Your current connection only supports inbox uploads.`
- `Private Account Required`, `Direct posting requires a private TikTok account. Your post was sent to your inbox instead.`
- Errores: `Failed to connect <Platform> account. Please try again.`, `Failed to initiate <Platform> OAuth:`, `Connecting isn't available right now.`, `Could not safely verify this connection request. Please retry.`, `We could not confirm the connection yet. Refresh the page to retry, or contact support if this keeps happening.`

### `warmed-accounts`
Ver `FR-130`.

### `notifications`
Preferencias de notificación con guardado (`Could not save notification settings.`, `Failed to save notification settings:`). Existe el concepto `System notifications`. El detalle del panel es **UNKNOWN**. CONFIRMED (existencia) / UNKNOWN (contenido)

### `preferences`
Timezone sincronizada automáticamente (`Failed to sync timezone:`), temas (`themes`). CONFIRMED

### `billing`
Ver `FR-170`.

### `api`
Ver `FR-180`.

---

## FR-170 — Billing & Plans

**UI (copy literal).** CONFIRMED `[APP]`
`Current Plan` / `Current plan` · `Manage Billing` / `Manage billing` · `Next Billing Date` · `Next regular invoice` · `Total next invoice` · `Plan upgrade (pro-rated)` · `Plan downgrade adjustment` · `Plan credits granted` · `Initial credits` · `Resets each billing cycle` · `Here's where your content saves stand this billing period.` · `Plan content usage` · `Trial content usage` · `Save limits` · `Limits cannot be negative`
Cancelación: `Cancel Subscription` · `Continue to cancellation` · `Keep my plan` · `Cancellation pending` · `Cancellation feedback submission failed:`
Compra de créditos: `Credit quantity input`, `Credit quantity slider`, `Buy saves`, `Buy posts`.
Bloqueos: `Plan content limit reached` · `This content isn't included in your plan.` · `Some items are not included in your plan` · `Your content is view-only. Upgrade to create and publish again.` · `Trial content allowance reached` · `Please add a payment method on the billing page before upgrading.` · `Plan switching is available once your subscription is active. Sort out your billing first and this will open back up.` · `Plan changes are temporarily unavailable. Please try again later.` · `There is no scheduled plan switch to cancel.` · `We couldn't process your payment. Please update your billing details and try again.` · `Couldn't start checkout. Please try again.` · `Unable to start checkout. Please try again.` · `Couldn't redirect to payment. Please try again.` · `We couldn't apply the discount. Please try again, or contact support.` · `Subscription activated!`

**Reglas de cuota.** SUPPORTED `[DEV]`
- El contador de saves incluidos se resetea en el **día ancla de facturación**, a las 00:00 UTC.
- Las asignaciones de **trial son de por vida por cuenta**, compartidas entre workspaces personales, y **no se resetean**.
- Orden de consumo: saves incluidos del mes → saves extra comprados → (si `API overage billing` está activo y la suscripción está viva) overage medido.
- El gate de content save se evalúa **antes** del cap diario de swipes: un `content_quota_exceeded` no consume swipe ni save adicional.

**Acceptance criteria.** (1) Al agotar saves, la UI pasa a view-only con CTA de upgrade. (2) Un downgrade programado se puede cancelar. (3) El desglose de la próxima factura incluye prorrateo.

---

## FR-180 — API keys, Developers & MCP

**UI.** CONFIRMED `[APP]` + SUPPORTED `[DEV]`
- `/settings → api` y `/developers`: `Create API key`, `Create partner API key` / `Create partner key`, `Revoke partner key`, confirmación `Revoke this partner API key? Requests using it will start failing with 401.`, ayuda `A short label so you can tell your partner keys apart later. Defaults to …`, límite `<N> active keys per workspace.`, uso `<N> connections used`.
- Copiado de la clave: `Couldn't copy to the clipboard. Select the key above and copy it manually.`
- `AI connectors` con acción `Use this workspace` para re-anclar el MCP connector.
- Toggle de `API overage billing` (`Could not update API overage billing. Please try again.`).

**Contrato de autenticación (normativo).** SUPPORTED
- Header `Authorization: Bearer fsln_live_<32 caracteres base62>`.
- Las keys son **workspace-scoped**: actúan sobre el workspace activo en el momento de crearlas y **no** siguen el cambio de workspace del usuario.
- La clave se muestra **una sola vez**, al crearla.
- Revocación inmediata → siguiente request devuelve `{"error":{"code":"unauthorized","message":"Invalid or revoked API key"}}`.
- Causas de 401: header ausente, esquema distinto de Bearer, token vacío o sin match de hash, key revocada/expirada, workspace soft-deleted.
- Todas las respuestas 401 incluyen `WWW-Authenticate: Bearer realm="api"`.

**Acceptance criteria.** (1) La clave sólo es visible en el momento de la creación. (2) Revocar invalida en el acto. (3) Las keys nunca cruzan workspaces.


---

# 7. End-to-End User Journeys

## FLOW-001 — De cero a primer post programado (journey canónico)

`Entry: landing → Sign up` → Clerk crea la cuenta → `/onboarding`
→ **acción:** pegar `https://miproducto.com` y pulsar `Analyse Website`
→ **backend:** job de scraping + LLM construye el Company Profile (identity, offering, benefits, problem, market)
→ **acción:** revisar/editar `Company Name`, `Company Description`, subir logo
→ **acción:** responder rol, tamaño de equipo, modelo de negocio, categorías, revenue, expectativas
→ **backend:** `Creating Workspace...` → siembra de content angles iniciales → arranque del relleno de la discovery queue (~5 sugerencias) → `Workspace ready!`
→ `Continue to Dashboard` → `/home` con quick-start
→ **acción:** `Settings → integrations` → conectar TikTok (OAuth) — *Business or Creator account requerido*
→ **acción:** sidebar → `Blitz`
→ **resultado:** tarjeta con chip de tipo, `Why This Content?` y `Remixed From`
→ **acción:** `→` (aprobar) → `M-04` → `Schedule Post`
→ **acción:** marcar `Tiktok` → `…` → `Posting Mode: Send to Inbox` → `Next`
→ **acción:** `Content Details` — revisar `Title` y `Description`, pulsar `Improve` si hace falta → `Next`
→ **acción:** `Schedule` — elegir hora y día → `Schedule Post`
→ **backend:** se crea `Post` en `SCHEDULED`; el `Content` pasa `BUILDING → CREATED`; job de publicación en la hora indicada; TikTok responde `IN_USER_INBOX`
→ **resultado:** toast `Building post! View in Library`; el post aparece en `/calendar` y en `Library → My Posts`
→ **acciones posteriores:** el usuario abre TikTok → `Inbox → System notifications → Post`; a las horas, `Refresh Metrics` trae views/likes/comments; `/analytics` refleja el desglose.

## FLOW-002 — Remix de un contenido en tendencia

`/home` o `/inspiration` → **acción:** filtrar por nicho → localizar una pieza con 1.3M views → `Remix this`
→ **sistema:** navega a `/content/<formato>` con `Mode = Remix` y la fuente preseleccionada
→ **acción:** `Directly mention your business? → No` → escribir prompt opcional → `Generate`
→ **backend:** LLM reescribe la copy replicando tono, estructura y encaje del producto; el media service compone el render
→ **estado:** `Generating your content...`
→ **resultado:** pestaña `Preview` con la pieza + inspector
→ **acción:** ajustar tipografía/posición, `Swap Image` si hace falta
→ **acción:** `Save` (a `My Content`) o `Schedule` (flujo `FR-060`).

## FLOW-003 — Crear y usar un AI influencer

`/influencers` → `+ New influencer`
→ **paso 1:** `Generate base image` · nombre `Emily` · gender · age 25 · ethnicity · detalles → `Next` (**−4 créditos**)
→ **backend:** genera la imagen base (~30–60 s)
→ **paso 2:** revisar; si no convence → instrucciones + `Regenerate · 4 credits` (persona **nueva**, no edición)
→ **paso 3:** confirmar `COST 250 credits` vs `YOUR BALANCE` → `Create influencer`
→ **backend:** `generating_variations` → `training` (~15–20 min, `progress` 0–100) → `ready`
→ **acción:** `/influencers/:id → Images` → prompt `at the gym, selfie` → `Generate` (**−4 créditos/imagen**)
→ **acción:** hover sobre una imagen → `Animate` → tab `Talking Head UGC` → escribir script (10–15 palabras para 5 s) → `Caption overlay` → `Generate`
→ **acción:** tab `Configuration` → marcar ángulos permitidos y cuentas de publicación por plataforma → auto-guardado (`All changes saved`)
→ **acción:** `Configure in Blitz →` → `/blitz/settings` → subir `INFLUENCER FREQUENCY` al 100 %
→ **resultado:** las siguientes sugerencias de Blitz muestran el chip `👤 Emily` y usan sus imágenes/videos; `green-screen` sigue siendo contenido regular.

## FLOW-004 — Campaña automatizada de 4 semanas

`/automations` → `New automation`
→ **acción:** nombrar la campaña; elegir cuentas destino (OAuth y/o warmed); `posts per account per day = 2`; `Campaign length in weeks = 4`; fecha de inicio y timezone
→ **acción:** ajustar `prefsSnapshot`: content mix, `Remix ratio`, `Influencer frequency`, `Caption style`, `Own media percentage`; si hay destino YouTube → `slideshowWeight = 0`
→ **acción:** `Generate`
→ **backend:** `DRAFT → GENERATING`; se crean N slots; cada sugerencia consume cuota de generación de la campaña; slots sin contenido único → `FAILED_GEN` con `no_unique_content`
→ **estado:** `REVIEW` — vistas `Calendar view` / `Grid view`
→ **acción:** por slot: `Edit post` (texto + captions por plataforma), `Adjust schedule`, `Re-roll this suggestion` o `Remove suggestion`
→ **acción:** `Continue to launch` → **backend** valida gates (`launchValidation`): content saves, post slots warmed, límite diario por cuenta, restricción de trial
→ **resultado:** `Ready to launch` + *"Everything checks out. Your posts will be reserved on launch."* → `Launch campaign`
→ **backend:** reserva slots, cobra presupuesto y post slots, `BUILDING` → `ACTIVE`; publica según cadencia
→ **acciones posteriores:** seguir totales en el detalle de campaña y por post en Library; `Cancel automation` detiene lo futuro sin tocar lo publicado.

## FLOW-005 — Publicar desde una cuenta warmed

`/warmed-accounts` → comprar cuenta ($100/mes)
→ **acción:** configurar plataforma, país (US/EU), nicho y keywords → `Payment received! Configure your new accounts below to begin warming.`
→ **backend/humano:** 5 días de warming en teléfono real; los detalles quedan bloqueados (*"These details are locked once the account is warmed."*)
→ **estado:** `Account Awaiting Approval` → **acción del owner:** aprobar
→ **sistema:** `Once you approve, you can schedule posts, with the earliest slot about two days out`
→ **acción:** crear contenido y programar eligiendo la cuenta warmed (en lugar de una conexión OAuth)
→ **validaciones:** lead time propio de la cuenta, máx. 30 días de antelación, slots disponibles
→ **backend:** el post se entrega al account manager; **$1,50 por post**
→ **resultado:** publicación *"that day or the morning after"*; analytics unificado por cuenta
→ **excepción:** ban → cuenta oculta + `replacementDecision` pendiente del owner → resolver antes de volver a programar.

## FLOW-006 — Lead de Reddit a conversación

`/engagement/actions` → `Connect Reddit Account` (OAuth)
→ **acción:** `Configure discovery subreddits`
→ **backend:** job periódico de descubrimiento (`Discovering new Reddit leads…`), con reintento ante rate limit
→ **resultado:** lista de leads con score; filtros `Unseen only`, `Most Engaged`, `Top Scored`
→ **acción:** abrir un lead → leer `Why this lead?` y el post completo
→ **acción:** `Generate AI reply` → revisar → (si no convence) `Regenerate reply`
→ **acción:** publicar la respuesta en Reddit → `Tracking conversation now.`
→ **backend:** monitorización del hilo; `Sync with Reddit` verifica y actualiza estado
→ **control de riesgo:** el ban meter recalcula el nivel; en `Danger` la recomendación es **dejar de responder** vía Fastlane
→ **resultado:** el contador `Engaged Leads` del Home sube; la tarea `Reply to leads 0/5` avanza.

## FLOW-007 — Un agente de IA opera Fastlane (MCP)

`/settings → api` → `Create API key` → guardar `fsln_live_…`
→ **acción:** registrar el servidor MCP en el cliente (Claude Code / Codex) con `https://api.usefastlane.ai/mcp` y el header Bearer
→ **agente:** `get_blitz_preferences` → `update_blitz_preferences` (ajusta el mix)
→ **agente:** `run_blitz` → recibe `contentId` inmediato
→ **agente:** hace polling con `get_build_status` hasta `CREATED`
→ **agente:** `list_connections` → `schedule_content` con `connectionId` y `utc_datetime`
→ **agente:** `get_post_analytics` a las 24 h para medir
→ **facturación:** las llamadas que crean contenido consumen el mismo pool de content saves que la app; programar **no** es usage-metered.

## FLOW-008 — Editar una pieza ya guardada

`Library → My Content` → abrir pieza → editor
→ **acción:** cambiar copy, tipografía o posición → guardar
→ **backend:** edición menor → **no** crea nueva fila, **no** consume save, **no** genera evento de facturación; `revision` +1; rebuild del mismo `contentId`
→ **excepción:** si la pieza tiene posts vinculados → `409 content_has_linked_posts`: hay que **borrar** los posts (cancelarlos no basta)
→ **excepción:** si otra edición está corriendo → `409 content_edit_in_progress`
→ **fallo de rebuild:** la versión anterior sigue usable y se reporta el `lastEdit` fallido.

## FLOW-009 — Alta sin página web, sólo con un perfil social (EXTENSION · EXT-001)

Este es el journey que justifica toda la extensión. Caso: una tienda que sólo existe en Instagram.

`Entry: landing → Sign up` → Clerk → `/onboarding`
→ **pantalla:** `Where can we learn about your brand?` con el input único y los chips de plataforma
→ **acción:** pegar `instagram.com/mitienda` (o simplemente `@mitienda` y elegir Instagram en el desambiguador)
→ **sistema:** detecta `sourceType: instagram`, normaliza el handle, resuelve nombre y avatar, muestra la tarjeta de confirmación
→ **acción:** `Analyse`
→ **backend (sin pedir OAuth — D-01):** intenta API pública → si hace falta y el flag está activo, fetch público → lee perfil (nombre, bio, categoría, link en bio, seguidores) → lee los últimos 24 posts → **OCR del texto en las imágenes** → sigue el link-in-bio un nivel → sintetiza con LLM
→ **UI durante:** `Reading profile` → `Reading recent posts` → `Reading on-screen text` → `Building your brand profile`  *(en Fase 2 se inserta `Transcribing videos`)*
→ **resultado:** perfil de marca con `CORE IDENTITY`, `toneOfVoice` y `targetAudience` en confianza alta; `PRODUCT OFFERING` en media; `PROBLEM SOLUTION` en baja
→ **pantalla de revisión:** los campos de baja confianza aparecen arriba bajo `Worth a quick check`, con el aviso *"We guessed these. Fix anything that's off — it shapes every post we write for you."*
→ **acción:** el usuario responde `In one line: what do you actually sell?` y corrige una frase
→ **oferta (después del análisis, nunca antes — D-01 + D-04):** `Connect @mitienda to publish from it — and bring your photos and videos with you.` + checkbox desmarcado `Also import my recent posts to my Media Bank`
→ **si acepta:** OAuth → la fuente sube a tier A (datos más ricos, se re-sintetiza el perfil) + import de sus posts al Media Bank
→ **si declina:** el onboarding **continúa sin interrupción**; la oferta reaparece en `Settings → integrations`
→ **acción:** completa el cuestionario de perfilado (rol, equipo, modelo de negocio, categorías, revenue, expectativas) — **idéntico al del camino web**
→ **backend:** `Creating Workspace...` → siembra de content angles **derivados de los temas con mejor engagement de su propia cuenta** → arranque de la discovery queue → `Workspace ready!`
→ **resultado si aceptó:** el Media Bank arranca con media real de la marca y `ownMediaPercentage` es útil desde el primer Blitz
→ **acción:** `Blitz` → aprobar → `Schedule Post`
→ **resultado:** primer post programado **sin que el usuario haya tenido nunca una página web**.

**Ruta degradada (cuenta privada).** En `Analyse`, el sistema responde `@mitienda is private, so we can't read it. Connect the account or paste your bio instead.` → el usuario conecta por OAuth (tier A, funciona) o pega su bio y sube dos capturas (tier D) → el alta continúa igual, con más preguntas de cierre de huecos.

---

# 8. Data Model

> Modelo inferido a partir del contrato público de la API (nombres de campo **literales** cuando están documentados) y de la UI observada. El original usa **Convex** como base de datos (los IDs se describen como *"valid Convex document ids"*) y **Cloudflare R2** como storage de objetos. SUPPORTED `[DEV]`

## DATA-001 — `User`
| Campo | Tipo | Notas |
|---|---|---|
| `_id` | id | |
| `clerkUserId` | string | identidad externa (Clerk) SUPPORTED |
| `email` | string | verificado |
| `fullName` | string | validación ≥ 2 caracteres |
| `timezone` | string | IANA, sincronizada automáticamente |
| `defaultWorkspaceId` | ref → Company | |
| `deletionStatus` | enum | `none` \| `in_progress` \| `rejected` |
| `createdAt` / `updatedAt` | ms epoch | |

**Relaciones.** 1 User → N `WorkspaceMembership`. **Lifecycle.** signup → active → (deletion requested) → deleted.

## DATA-002 — `Company` (Workspace)
| Campo | Tipo | Notas |
|---|---|---|
| `_id` | id | scope de todo el resto |
| `name` | string | |
| `websiteUrl` | string? | **único global** cuando existe (`This website is already registered.`). **EXTENSION:** deja de ser obligatorio — un workspace puede no tener web y derivar su identidad de una `BrandSource` social. Se mantiene como campo derivado de la fuente primaria cuando ésta es `website`, o del link-in-bio cuando se resolvió uno. |
| `primaryBrandSourceId` | ref? → BrandSource | **EXTENSION** — fuente que gana los empates de fusión |
| `logoUrl` | string? | |
| `ownerUserId` | ref → User | |
| `status` | enum | `draft` \| `preparing` \| `active` \| `soft_deleted` |
| `planId` | ref → Plan | |
| `subscriptionStatus` | enum | `trialing` \| `active` \| `past_due` \| `canceled` |
| `billingAnchorDay` | int | día de reset de saves incluidos |
| `timezone` | string | |
| `entitlements` | string[] | p. ej. `tiktokDirect`, `autoCaptions`, `warmedPosting`, `automations`, `aiStudio` SUPPORTED |
| `apiOverageEnabled` | boolean | |
| `partnerId` | ref? → Partner | si fue provisionado por un Partner |
| `createdAt` / `updatedAt` | ms | |

## DATA-003 — `WorkspaceMembership` (INFERRED)
`_id`, `companyId`, `userId`, `role` ∈ {`owner`, `member`}, `invitedBy`, `status` ∈ {`invited`, `active`, `removed`}, `createdAt`.

## DATA-004 — `CompanyProfile` (Brand)
| Campo | Tipo |
|---|---|
| `_id`, `companyId` | id / ref |
| `coreIdentity` | text |
| `productOffering` | text |
| `uniqueBenefits` | text |
| `problemSolution` | text |
| `marketAndCompetition` | text |
| `toneOfVoice`, `targetAudience` | text (INFERRED) |
| `businessModel`, `businessCategories[]`, `monthlyRevenueBand`, `teamSize`, `ownerRole`, `expectations[]` | del cuestionario de onboarding CONFIRMED |
| `brandRevision` | int | incrementa en cada guardado SUPPORTED |
| `status` | enum | `pending` \| `ready` \| `failed` \| `partial` (EXTENSION) |
| `fieldMeta` | map | **EXTENSION** — por cada campo del perfil: `{confidence: high\|medium\|low, sourceId, excerptRef, editedByUser: bool, conflictsWith?: [sourceId]}`. Es lo que alimenta los badges de origen y confianza de `FR-011.2` y la regla de no sobrescribir ediciones manuales de `FR-011.6`. |

## DATA-005 — `ContentAngle`
`_id`, `companyId`, `title` (≤200), `description` (≤2000), `targetAudience` (≤500), `isActive` (bool), `influencerIds[]` (máx. 10 por influencer), `createdAt`, `updatedAt`. Cap: 100 por workspace. SUPPORTED

## DATA-006 — `BlitzPreferences`
`companyId` (1:1), `slideshowWeight`, `wallOfTextWeight`, `greenScreenWeight`, `videoHookWeight` (suma 100), `remixPercentage`, `ownMediaPercentage`, `mentionBusinessPercentage`, `influencerChance`, `smartTextPositioning` (bool), `genderFilter` (`man`\|`woman`\|`null`), `angleWeights` (map), `textStyleWeights` (map). Sintetiza defaults si no existe fila. SUPPORTED

## DATA-007 — `Suggestion` (discovery queue)
`_id`, `companyId`, `contentType`, `generatedText`, `aiExplanation`, `remixSourceUrl?`, `sourceTrendingItemId?`, `influencerId?`, `angleId?`, `textStylePresetId?`, `status` ∈ {`queued`, `popped`, `discarded`}, `createdAt`. Objetivo ~5 en cola. SUPPORTED

## DATA-008 — `Content`
| Campo | Tipo | Notas |
|---|---|---|
| `_id` | id | |
| `companyId` | ref | |
| `type` | enum | `slideshow` \| `wall-of-text` \| `green-screen` \| `video-hook` \| `custom` |
| `status` | enum | `BUILDING` \| `CREATED` \| `FAILED` |
| `files` | string[] | URLs; múltiples para slideshow (una por slide), una para video |
| `thumbnailUrl` | string | |
| `generatedText` | string? | copy extraíble actual, normalizada, ≤ 2 000 caracteres |
| `remixSourceUrl` | string? | permalink público de la fuente |
| `revision` | int | concurrencia optimista de ediciones |
| `buildPayload` | json | **nunca** se devuelve por API |
| `studioState` | json | **nunca** se devuelve por API |
| `lastEdit` | object? | resultado de la última edición |
| `deletedAt` | ms? | soft-delete |

**Lifecycle.** `BUILDING` → `CREATED` \| `FAILED`. Edición → `BUILDING` → `CREATED` (mismo `_id`, `revision`+1). Borrado: soft-delete + limpieza best-effort de objetos en R2; **sin restore público**; borrar **no** devuelve el content save.

## DATA-009 — `ContentTextBox`
`id` (estable, p. ej. `slide-0-text-0`), `slideIndex?`, `text` (≤5000), `position{x,y}` (0–100), `widthPercent` (25–100), `font{family, weight, size 8–72}`, `color` (#RRGGBB), `stroke{width 0–8, color}`, `background{color, opacity 0–1, style: pill|full-width} | null`. SUPPORTED

## DATA-010 — `Media` (Media Bank)
`mediaId`, `companyId`, `mediaType` ∈ {`image`, `video`}, `filename`, `r2Url`, `storageKey`, `status` ∈ {`processing`, `ready`, `failed`}, `sizeMb`, `videoDurationSec?`, `categories[]`, `origin` ∈ {`manual_upload`, `generated`, `demo`, `internal`}, `uploadedAt`, `deletedAt?`. SUPPORTED

## DATA-011 — `MediaSet`
`_id`, `companyId`, `name`, `kind` ∈ {`SLIDESHOW`, `VIDEO`, `CURATED`}, `influencerId?`, `mediaIds[]`, `createdAt`. CONFIRMED (UI) / INFERRED (campos)

## DATA-012 — `AudioTrack` (librería compartida)
`audioId`, `url`, `description`, `sizeMb`, `durationSec?`, `library` ∈ {`wall-of-text`, `video-hook`}. Global, no por workspace. SUPPORTED

## DATA-013 — `Influencer`
`_id`, `companyId`, `name`, `gender`, `age` (18–60), `ethnicity`, `baseImageUrl`, `status` ∈ {`generating_variations`, `training`, `ready`, `failed`, `inactive`}, `progress` (0–100), `isActive`, `createdAt`, `updatedAt`. Campos internos nunca expuestos: `soulId`, `baseCharacterCmlId`, ids de media y de job. Cap: 50 activos/workspace. SUPPORTED

## DATA-014 — `InfluencerAsset`
`_id`, `influencerId`, `kind` ∈ {`image`, `video`}, `url`, `prompt`, `model`, `aspect`, `resolution`, `batch`, `creditsSpent`, `durationSec?`, `createdAt`. CONFIRMED (UI del drawer)

## DATA-015 — `InfluencerConfig`
`influencerId`, `angleIds[]`, `publishingAccounts[]` (`{platform, connectionId, enabled}`), `slideshowSetIds[]`, `videoSetIds[]`. CONFIRMED (UI)

## DATA-016 — `Connection` (OAuth)
`_id`, `companyId`, `platform` ∈ {`tiktok`, `instagram`, `youtube`, `linkedin`, `reddit`}, `platformUserId`, `platformUsername`, `scopes[]`, `publishable` (bool), `tokenExpiry` (ms), `accessToken`/`refreshToken` (**cifrados, nunca expuestos**), `status` ∈ {`active`, `expired`, `paused`, `revoked`}, `createdAt`, `updatedAt`. SUPPORTED

## DATA-017 — `WarmedAccount`
`warmedAccountId`, `companyId`, `accountType: "warmed"`, `platform` ∈ {`tiktok`, `instagram`}, `username`, `displayName`, `profilePictureUrl`, `status`, `postable`, `postingAvailability` ∈ {`available`, `checking`, `replacement_needed`}, `minLeadTimeMs`, `country` ∈ {`US`, `EU`}, `niche`, `keywords[]`, `approvedAt?`, `createdAt`, `updatedAt`. Campos internos nunca expuestos: ids de proveedor, bundle ids, campos de Stripe, ids de cuenta guardada, configuración deseada, secretos de provisión. SUPPORTED

## DATA-018 — `WarmedSlotBalance`
`companyId`, `slotBalance` (int). SUPPORTED

## DATA-019 — `ReplacementDecision`
`_id`, `companyId`, `warmedAccountId`, `options[]`, `status` ∈ {`pending`, `resolved`}, `decidedByUserId?`. SUPPORTED

## DATA-020 — `Post`
| Campo | Tipo | Notas |
|---|---|---|
| `_id`, `companyId`, `contentId` | ids | |
| `platform` | enum | `tiktok` \| `instagram` \| `youtube` \| `reddit` (+ `linkedin` en automations) |
| `accountType` | enum | `oauth` \| `warmed` |
| `connectionId?` / `warmedAccountId?` | ref | **mutuamente excluyentes** |
| `connectionUsername?` | string | |
| `scheduledAtUtc` | ms | |
| `caption`, `description` | string | copy original del usuario |
| `publishedCaption?` | string | copy realmente publicada si la plataforma exigió ajuste |
| `captionAdjustmentReason?` | enum | actualmente sólo `repeated_mention` |
| `postingMode?` | enum | `inbox` \| `direct` (TikTok OAuth) |
| `privacyLevel?` | enum | `PUBLIC_TO_EVERYONE` \| `MUTUAL_FOLLOW_FRIENDS` \| `FOLLOWER_OF_CREATOR` \| `SELF_ONLY` |
| `discloseAsAds?`, `aiContentDisclaimer?` | bool | |
| `instagramSlideshowFormat?` | enum | `carousel` \| `reel` |
| `tiktokSoundMode?` | enum | `audible` \| `silent` |
| `tiktokSoundId?` | string | |
| `status` | enum | ver §6 FR-060 |
| `cancellationPending?` | bool | |
| `tiktokProcessingDelayed?` | bool | |
| `errorCode?`, `errorMessage?` | string | neutrales respecto al proveedor |
| `postUrl?`, `postedAt?` | | |
| `views`, `likes`, `comments` | int | última sincronización |
| `automationSlotId?` | ref | |

## DATA-021 — `Automation`
`_id`, `companyId`, `name` (≤100), `status` ∈ {`DRAFT`,`GENERATING`,`REVIEW`,`BUILDING`,`ACTIVE`,`COMPLETED`,`CANCELLED`,`FAILED`}, `accounts[]`, `perAccountPerDay` (1–3), `durationWeeks` (1–4), `startDateUtc`, `timezone`, `postingMode`, `youtubePrivacyStatus`, `discloseAsAds`, `aiContentDisclaimer`, `prefsSnapshot`, `generationQuotaUsed`, `launchValidation?`, `createdAt`. SUPPORTED

## DATA-022 — `AutomationSlot`
`_id`, `automationId`, `status` ∈ {`PENDING_GEN`,`GENERATING`,`READY`,`REROLLING`,`FAILED_GEN`,`QUEUED_BUILD`,`BUILDING`,`SCHEDULED`,`FAILED`,`CANCELLED`}, `contentType`, `suggestionData` (json, forma variable por tipo), `generatedText`, `captionsByPlatform` (map), `scheduledAtUtc`, `failureReason?` ∈ {`no_unique_content`, `no_demo_video`}, `contentId?`, `postIds[]`. SUPPORTED

## DATA-023 — `TrendingItem`
`_id`, `platform`, `permalink`, `thumbnailUrl`, `mediaUrls[]`, `isSlideshow`, `slideCount`, `views`, `likes`, `niches[]`, `textOverlays[]`, `fetchedAt`. INFERRED (a partir de la UI de Inspiration y del campo `remixSourceUrl`).

## DATA-024 — `Lead` (Reddit)
`_id`, `companyId`, `redditPostId`, `subreddit`, `title`, `body`, `author`, `score`, `engagementScore`, `whyThisLead` (text), `seenAt?`, `repliedAt?`, `threadState`, `generatedReply?`, `deletedAt?`. CONFIRMED (UI) / INFERRED (campos)

## DATA-025 — `BanRiskAssessment`
`companyId`, `level` ∈ {`safe`, `caution`, `warning`, `danger`}, `promoRatio`, `recommendation` (text), `computedAt`. CONFIRMED (UI)

## DATA-026 — `ApiKey`
`_id`, `companyId`, `label`, `hash` (**nunca** el secreto en claro), `prefix` (`fsln_live_`), `kind` ∈ {`workspace`, `partner`}, `createdAt`, `revokedAt?`, `expiresAt?`. SUPPORTED

## DATA-027 — `IdempotencyRecord`
`key`, `companyId`, `endpoint`, `requestHash`, `responseSnapshot`, `state` ∈ {`in_flight`, `completed`, `released`}, `createdAt`. SUPPORTED — necesario para `POST /content`, `POST /influencers`, `PATCH /content/:id`, `POST /content/:id/regenerate`.

## DATA-028 — `UploadReservation`
`uploadId`, `companyId`, `apiKeyId?`, `filename`, `contentType`, `sizeBytes`, `durationSec?`, `storageKey`, `expiresAt`, `state` ∈ {`reserved`, `finalizing`, `committed`, `failed`, `expired`}. SUPPORTED

## DATA-029 — `QuotaLedger`
`companyId`, `period`, `contentSavesIncluded`, `contentSavesUsed`, `contentSavesPurchased`, `overageUnits`, `dailySwipesUsed`, `dailySwipeResetAt`, `aiCredits`, `warmedPostSlots`. SUPPORTED

## DATA-030 — `OnboardingRecord`
`_id`, `ownerUserId`, `draftCompanyId`, `step`, `payload` (json), `createdAt`. CONFIRMED (por los mensajes `Failed to store/retrieve/move/clear onboarding data`).

## DATA-031 — `BrandSource` (EXTENSION)

| Campo | Tipo | Notas |
|---|---|---|
| `_id`, `companyId` | id / ref | |
| `sourceType` | enum | `website` \| `instagram` \| `tiktok` \| `x` \| `youtube` \| `linkedin` \| `other_url` \| `manual` |
| `handle` | string? | normalizado sin `@` ni dominio |
| `canonicalUrl` | string? | forma canónica, sin parámetros de tracking |
| `displayName` | string? | nombre resuelto en la plataforma |
| `avatarUrl` | string? | |
| `isPrimary` | boolean | exactamente una por workspace |
| `acquisitionTier` | enum | `A_oauth` \| `B_public_api` \| `C_page_fetch` \| `D_assisted` — ver `FR-011.4` |
| `connectionId` | ref? → Connection | cuando el tier es `A_oauth` |
| `status` | enum | `pending` \| `analyzing` \| `ready` \| `partial` \| `failed` \| `stale` |
| `failureReason` | enum? | `not_found` \| `private` \| `insufficient_content` \| `rate_limited` \| `provider_unavailable` \| `unsupported_platform` \| `already_registered` |
| `lastAnalysedAt` | ms | `stale` a los 90 días |
| `analysisCount` | int | para el límite de re-análisis por día |
| `createdAt` / `updatedAt` | ms | |

**Unicidad:** `(sourceType, handle)` es único globalmente — misma regla que Fastlane aplica a `websiteUrl`. **Cap:** 5 por workspace.
**Lifecycle:** `pending` → `analyzing` → `ready` \| `partial` \| `failed`; `ready` → `stale` a los 90 días; `stale` → `analyzing` al refrescar.

## DATA-032 — `BrandSourceSnapshot` (EXTENSION)

`_id`, `brandSourceId`, `capturedAt`, `tier`, `profileSignals` (json: nombre, bio, categoría, links, contadores), `contentItems[]` (por ítem: `externalId`, `kind`, `caption`, `hashtags[]`, `transcript?`, `ocrText?`, `engagement{likes,comments,views}`, `postedAt`), `derivedFields` (map campo → `{value, confidence, excerpt}`), `conflicts[]`, `rawRetentionExpiresAt`.

**Retención.** El snapshot guarda **extractos citables**, no una copia completa del perfil ajeno. Los medios binarios de terceros **no se almacenan**: se procesan en memoria para ASR/OCR y se descartan. `rawRetentionExpiresAt` fuerza la purga del material crudo; los `derivedFields` sobreviven porque ya son datos del cliente. Ver `OQ-16`.

## DATA-033 — `JudgmentRecord` (EXTENSION · EXT-008)

`_id`, `companyId`, `decisionPoint` (`DP-001`…`DP-007`), `subjectType` + `subjectId` (a qué se le aplicó: trending item, lead, post, campo de perfil), `adapter` (`llm` \| `jev` \| `stub`), `model`, `answers` (map `questionId → {type, value, probabilities, confidence}`), `stateHash`, `inputTokens`, `latencyMs`, `createdAt`.

**Por qué se persiste.** Tres razones concretas: (1) cambiar un umbral o un peso recalcula sobre lo guardado sin volver a inferir; (2) permite comparar adaptadores sobre exactamente el mismo estado, que es la base del experimento de §25.3; (3) `latencyMs` e `inputTokens` son los únicos datos que van a permitir decidir con hechos en vez de con claims de fabricante.

**Retención.** `answers` y métricas son permanentes (son datos derivados del cliente). El estado crudo **no** se guarda: sólo `stateHash`, para poder detectar si cambió.

## Diagrama de relaciones (textual)

```
User ──< WorkspaceMembership >── Company (Workspace)
Company ── CompanyProfile (1:1)
Company ──< BrandSource ──< BrandSourceSnapshot        (EXTENSION)
Company ──< JudgmentRecord ──> (TrendingItem | Lead | Post | CompanyProfile.field)   (EXTENSION)
BrandSource ──> Connection (opcional, cuando tier = A_oauth)
BrandSource ──> CompanyProfile.fieldMeta[*].sourceId   (trazabilidad por campo)
Company ──< ContentAngle >──< Influencer          (N:M vía influencerIds, máx 10/influencer)
Company ── BlitzPreferences (1:1)
Company ──< Suggestion ──> Content               (pop → build)
Company ──< Content ──< Post ──> Connection | WarmedAccount
Content ──< ContentTextBox
Company ──< Media ──< MediaSet
Company ──< Influencer ──< InfluencerAsset
Influencer ── InfluencerConfig (1:1)
Company ──< Connection
Company ──< WarmedAccount ──< ReplacementDecision
Company ──< Automation ──< AutomationSlot ──> Content ──< Post
Company ──< Lead ── BanRiskAssessment (1:1 por company)
Company ──< ApiKey
Company ── QuotaLedger (1 por periodo)
AudioTrack / TrendingItem  →  globales (no workspace-scoped)
```

---

# 9. Backend Requirements

## 9.1 Authentication
- **Identidad de usuario:** Clerk (evidencia directa: `clerkTheme` chunk, `Clerk could not mint a fresh Convex token for account deletion`, `Native Clerk Convex authentication is required for account deletion`, ruta `/auth/sso-callback`). CONFIRMED. El clon puede usar Clerk o equivalente; el requisito es soportar email/password + SSO + sesiones + borrado de cuenta verificado.
- **Identidad máquina:** API keys `fsln_live_<32 base62>` almacenadas **hasheadas**, workspace-scoped, revocables al instante, mostradas una sola vez, con `WWW-Authenticate: Bearer realm="api"` en todos los 401. SUPPORTED
- **OAuth por plataforma:** TikTok, Instagram, YouTube, LinkedIn, Reddit, con refresh de tokens y estados de expiración/pausa.
- **MCP OAuth:** scopes `fastlane:read` y `fastlane:drafts:write`. SUPPORTED

## 9.2 Authorization
Todo recurso es workspace-scoped. El acceso cruzado devuelve `404 not_found`, nunca `403`, para no filtrar existencia. Los borrados idempotentes de media tratan ids ajenos/desconocidos como no-ops seguros que **no revelan si el registro existe**. SUPPORTED

## 9.3 API
- REST, JSON sobre HTTPS, server-to-server, versionada en la ruta: `https://api.usefastlane.ai/api/v1`.
- Content type: `application/json; charset=utf-8`.
- Envelope de éxito: `{"data": ...}`. Paginado: `{"data": [...], "pagination": {"cursor": "…"|null, "hasMore": bool}}`.
- Envelope de error: `{"error": {"code": "...", "message": "...", "details": {...}}}`.
- Cambios breaking → nueva versión mayor de ruta.

**Superficie completa v1 (29 endpoints).** SUPPORTED `[DEV]`

| Método | Ruta | Coste |
|---|---|---|
| POST | `/blitz` | usage |
| GET / PATCH | `/blitz/preferences` | free |
| GET / POST | `/blitz/angles` · GET `/blitz/angles/page` | free |
| PATCH / DELETE | `/blitz/angles/:id` | free |
| POST | `/blitz/angles/generate` | free |
| GET | `/influencers` | free |
| POST | `/influencers/base-image/upload-url` | free |
| POST | `/influencers` | usage |
| GET | `/influencers/:id` | free |
| GET | `/connections` | free |
| GET | `/warmed-accounts` | free |
| GET | `/tiktok/sounds?warmedAccountId=` | free |
| POST | `/content/custom/video/upload-url` | free |
| POST | `/content/custom/video` | usage |
| POST | `/media/upload-url` · POST `/media` · GET `/media` · GET `/media/:id` · PATCH `/media/:id` · DELETE `/media/:id` | free |
| POST | `/content` | usage |
| GET | `/audio?for=wall-of-text\|video-hook` | free |
| GET | `/content` · GET `/content/:id` · GET `/content/:id/editable` | free |
| PATCH | `/content/:id` · POST `/content/:id/regenerate` · DELETE `/content/:id` | free |
| GET | `/posts` · GET `/posts/:id` | free |
| POST | `/content/:id/schedule` | free |
| POST | `/posts/cancel` · POST `/posts/delete` | free |
| POST | `/analytics/posts` | free |

**Idempotencia.** Obligatoria (`Idempotency-Key`) en `POST /content`, `POST /influencers`, `PATCH /content/:id`, `POST /content/:id/regenerate`. Misma key + mismo body = replay de la respuesta original; misma key + body distinto = `409 conflict`; una petición que falla libera la key. SUPPORTED

## 9.4 Database
Convex en el original. **Requisitos reales para el clon** (tecnología libre, pero el comportamiento es obligatorio):
- Transacciones que abarquen mutación + reconcile (crear ángulo **y** reescribir `angleWeights` en la misma transacción).
- Soft-delete con exclusión por defecto en todos los listados.
- Concurrencia optimista por `revision` en contenido.
- Reservas atómicas de cuota antes de trabajo costoso (el original *"reserves content_angle_generation allowance before model generation"*, y libera si falla). SUPPORTED

## 9.5 Queues, jobs y background workers
Trabajos asíncronos identificados (todos SUPPORTED/CONFIRMED):
1. **Website analysis** (onboarding) — scraping + LLM → Company Profile.
2. **Discovery queue refill** — mantiene ~5 sugerencias; concurrente (puede exceder el objetivo transitoriamente).
3. **Content build** — composición de imágenes, render de video, dibujado de overlays, subida a storage. 30 s – 2 min.
4. **Content rebuild** — tras edición o regeneración.
5. **Influencer pipeline** — generación de variaciones + entrenamiento, 15–20 min, con `progress`.
6. **AI Studio generation** — imágenes/videos, máx. 10 en vuelo por workspace.
7. **Media normalization** — MOV→MP4, HDR→SDR, faststart.
8. **Publishing job** — ejecuta el post a la hora programada, con manejo de `AWAITING_RECONNECT`.
9. **TikTok slow-lane watcher** — reintenta hasta **72 h** cuando `tiktokProcessingDelayed`.
10. **Metrics sync** — refresca views/likes/comments por post.
11. **Automation generation** — genera slots; recuperación sin sustituir tipos con peso 0.
12. **Automation build & schedule** — tras `launch`.
13. **Reddit lead discovery** — periódico, con backoff ante rate limit.
14. **Reddit thread monitoring** — verifica estado de hilos.
15. **Ban risk computation** — recalcula el nivel de riesgo.
16. **Warmed account provisioning** — orquestación con el proveedor/equipo humano.
17. **Quota reset** — diario a 00:00 UTC (swipes) y en el día ancla (saves).
18. **Brand source analysis** (EXTENSION) — resuelve el tier de adquisición, recoge señales de perfil y contenido, ejecuta ASR y OCR, sintetiza con LLM y escribe `CompanyProfile.fieldMeta`. Ver §9.14.
19. **Brand source staleness sweep** (EXTENSION) — marca `stale` los snapshots de más de 90 días.
20. **Snapshot purge** (EXTENSION) — borra el material crudo al vencer `rawRetentionExpiresAt`.
21. **Own-post import** (EXTENSION, opt-in) — importa los posts propios del usuario al Media Bank (`FR-011.5.1`).

## 9.6 Rate limiting (valores normativos, SUPPORTED)
| Límite | Valor |
|---|---|
| REST por workspace | **60 req/min** (token bucket, refill uniforme en ventana de 60 s) |
| REST por workspace (límite legacy citado en varios endpoints) | 20 req/min — **conflicto documental**, ver §24 OQ-05 |
| Actualización de Blitz preferences | 3/min |
| Generación de ángulos | 5 sugerencias exitosas/min |
| Builds de contenido | 10/min |
| MCP | 30 req/min por usuario |
| Partner agregado | 5 000 req/min (salvo override) |

Respuesta 429 con header `Retry-After` y `details.retryAfterMs`. Si el sistema **no puede comprobar** el límite de forma segura, devuelve `503 service_unavailable` (no 429) — esto **no** significa cuota agotada. SUPPORTED

## 9.7 Partner API (opcional, fuera del alcance mínimo)
Superficie separada para provisionar workspaces en nombre de clientes, con facturación por evento. Usa `X-Fastlane-Workspace-Id` sobre los endpoints compartidos. Los workspaces de un Partner en estado `active` o `past_due` tienen **content-save, storage agregado y Blitz diario ilimitados**; siguen aplicando rate limits, facturación por uso y límites de tamaño por archivo. Capacidad exclusiva: `GET /content/:id/editable?include=media` para preview client-side (requiere Partner key habilitada). SUPPORTED

## 9.8 Uploads
Patrón obligatorio en tres pasos: **reserva** (`*/upload-url` → `{uploadId, uploadUrl, method:"PUT", headers, expiresAt}`) → **PUT directo** al storage → **finalización** (`POST /media` o `POST /content/custom/video`).
Límites: imágenes 10 MB (`image/jpeg`, `image/png`, `image/webp`); videos 50 MB (`video/mp4`, `video/quicktime`); base image de influencer 10 MB. La extensión del filename debe coincidir con el content type. Errores: `409 conflict` (objeto no alcanzable, finalización en curso, reserva previa fallida), `410 gone` (reserva expirada), `404` (reserva ajena). SUPPORTED

## 9.9 Realtime
La UI refleja estados asíncronos sin recarga (builds, progreso de influencer, auto-guardado `All changes saved`, aparición de nuevas sugerencias). Convex provee suscripciones reactivas nativas. **Requisito:** el clon debe ofrecer actualización en vivo (websockets/SSE) o, como mínimo, polling documentado (la API pública documenta polling cada ~10 s para builds). SUPPORTED

## 9.10 Caching, paginación y búsqueda
- Paginación por **cursor opaco** (`limit` 1–100, default 20) en content, posts, media, audio, angles, automation slots. Paginación por **página numerada** en la UI de pickers (`Page X of Y`). SUPPORTED/CONFIRMED
- Búsqueda: Inspiration y Media Bank tienen búsqueda textual; existe un servicio de búsqueda separado (`Search Service Unavailable`, `The search service is temporarily unavailable.`, `Retry Search`). CONFIRMED
- URLs de preview de media limpia y de preview de sonidos de TikTok son **firmadas y de vida corta** (1 hora para playback; refrescar al expirar). **No persistir ni loguear.** SUPPORTED

## 9.11 Storage
Cloudflare R2 en el original. Limpieza en borrado: **best-effort**, los fallos se loguean pero no bloquean el borrado de la fila. Cuota de storage agregada por workspace (`402 payment_required` cuando se excede). SUPPORTED

## 9.12 Audit logs
No hay evidencia de un log de auditoría expuesto al usuario. **Requisito INFERRED para el clon:** registrar toda acción destructiva o facturable (aceptación de Blitz, creación/borrado de contenido, cancelación/borrado de posts, lanzamiento/cancelación de automations, creación/revocación de API keys, aprobación de warmed accounts, cambios de plan) con actor, workspace, timestamp y resultado.

## 9.13 Observabilidad
El bundle instrumenta memoria de arranque (`__FASTLANE_STARTUP_MEMORY__` con `heap_used_bytes`, `heap_allocated_bytes`, `heap_limit_bytes`) y telemetría de cliente (`ClientTelemetryIdentity`). Hay una status page pública. CONFIRMED

## 9.14 Brand Source ingestion (EXTENSION · EXT-001)

Subsistema nuevo que no existe en Fastlane. Requisitos:

**Arquitectura.** Un **extractor por plataforma** detrás de una interfaz común `resolve(input) → BrandSourceSnapshot`, más un **sintetizador** único (`AI-016`) que consume cualquier snapshot. Añadir una plataforma nueva debe ser escribir un extractor, no tocar el resto del sistema.

**Endpoints propuestos** (extensión de la API v1; misma convención de envelope, cursor e idempotencia que el resto):

| Método | Ruta | Notas |
|---|---|---|
| POST | `/brand/sources/resolve` | Dado un texto libre, devuelve `{sourceType, handle, canonicalUrl, displayName, avatarUrl, available}` sin crear nada. Alimenta la detección en vivo del input. Idempotente y barato. |
| POST | `/brand/sources` | Crea la fuente y encola el análisis. Requiere `Idempotency-Key` porque el análisis tiene coste. Devuelve `202` con `brandSourceId`. |
| GET | `/brand/sources` · GET `/brand/sources/:id` | Listado y polling de estado (`status`, `failureReason`, sub-pasos completados). |
| POST | `/brand/sources/:id/reanalyse` | Sujeto al límite por fuente y día. |
| PATCH | `/brand/sources/:id` | Sólo `isPrimary`. |
| DELETE | `/brand/sources/:id` | Rechazado si es la única fuente y el perfil quedaría sin origen. |
| GET | `/brand/profile` · PATCH `/brand/profile` | Lectura y edición del perfil con `fieldMeta`; una edición manual marca `editedByUser: true`. |

**Cuotas y límites.**
- Máx. **5 fuentes** por workspace.
- Máx. **N re-análisis por fuente y día** (configurable por plan; default 3).
- El análisis consume presupuesto de cómputo, no `content saves`: no debe restar capacidad de creación de contenido.
- Límite de ítems analizados por fuente: **24 por defecto**, configurable; el coste de ASR/OCR crece linealmente con este número.

**Seguridad.**
- Mismas protecciones SSRF que la rama web (localhost, IPs privadas, hosts bloqueados) aplicadas a **todos** los orígenes, incluido el seguimiento de link-in-bio.
- Seguimiento de enlaces limitado a **1 nivel** y **5 destinos**, sin recursión.
- **Todo texto extraído de un perfil de terceros es dato, nunca instrucción.** El sintetizador debe recibirlo dentro de un contenedor claramente delimitado y con instrucción explícita de ignorar cualquier directiva incrustada. Debe existir un test de regresión con bios adversariales.
- Los binarios de terceros no se persisten: se procesan en memoria y se descartan.

**Degradación.** Si el nivel C está deshabilitado o falla, el sistema **degrada al nivel D** y lo dice; nunca bloquea el alta. Un fallo de ASR u OCR produce `partial`, no `failed`.

**Retención y borrado.** `rawRetentionExpiresAt` en cada snapshot fuerza la purga del material crudo. Borrar una `BrandSource` borra sus snapshots pero **no** revierte el `CompanyProfile` ya materializado.

## 9.15 Judgment layer — el puerto `Judgment` (EXTENSION · EXT-008 · decisión D-05)

Este PRD especifica decenas de decisiones con **salida finita** cuyo mecanismo queda sin definir: qué nicho tiene un video, si un post de Reddit es una oportunidad, si un campo del perfil está respaldado por su evidencia. Sin una capa declarada, cada una se resolvería por separado —un LLM parseado acá, un if-else de keywords allá— y el sistema acumularía decisiones semánticas sin contrato, sin umbrales y sin forma de cambiar de proveedor.

**Requisito:** todas esas decisiones pasan por un único puerto. Ningún módulo de producto llama a un proveedor de IA directamente para decidir.

### 9.15.1 Contrato

Tres primitivas, que cubren todo lo que el producto necesita decidir:

| Primitiva | Devuelve | Cuándo usarla |
|---|---|---|
| `choice(state, instructions, criteria: {id → descripción})` | `{value, probabilities, confidence}` | Una opción de un conjunto cerrado y enumerable |
| `score(state, instructions, levels: [descripción])` | `{value, probabilities, confidence}` | Posición en una dimensión ordenada (2–10 niveles) |
| `noul(state, instructions, criteria: {true, false})` | `{probability}` | Si una condición se cumple o no |

Reglas del contrato:
- El **espacio de salida se declara de antemano**. Si no se puede enumerar, no pasa por este puerto.
- Toda respuesta trae **probabilidad**. El consumidor decide qué hacer con ella; el puerto no decide por él.
- El puerto **no genera texto**. Si el resultado que hace falta es prosa, es trabajo de un LLM y no va por acá.

### 9.15.2 Adaptadores

| Adaptador | Estado | Notas |
|---|---|---|
| `LlmJudgmentAdapter` | **Por defecto** | LLM con salida estructurada. Es la implementación de referencia y la que define el baseline de calidad. |
| `JevJudgmentAdapter` | **Detrás de bandera, por punto de decisión** | TypeSafe `jev-1.13.0`. No se activa en ningún `DP` sin haber pasado su validación (§25.3). |
| `StubJudgmentAdapter` | Tests | Respuestas fijas, para tests deterministas sin red. |

La selección de adaptador es **por punto de decisión**, no global: `DP-001` puede correr con Jev mientras `DP-004` sigue con LLM. Sin esto, validar de a uno sería imposible.

### 9.15.3 Reglas de implementación

1. **El SDK del proveedor no sale del adaptador.** Ningún `import` de un SDK de IA fuera de `adapters/`. Es lo que hace que cambiar de proveedor sea un archivo y no una refactorización.
2. **Los pesos y umbrales viven en código de producto**, nunca en el prompt ni en el modelo. Cambiar un peso no puede requerir reinferir nada.
3. **Las respuestas crudas se persisten** (`DATA-033`). Si mañana cambia la política de un umbral, se recalcula sobre lo guardado.
4. **Sanitizar el estado antes de enviarlo.** Todo texto de terceros —bios, captions, posts de Reddit— pasa por la misma sanitización de `FR-011` antes de llegar al puerto. Aplica a cualquier adaptador: **un modelo de juicio no es un guardrail de inyección por sí solo**.
5. **Filtrar el estado.** Enviar sólo los campos que la pregunta necesita. Estado grande e irrelevante degrada la calidad y cuesta tokens.
6. **Nada de aritmética ni fechas por el puerto.** Ratios, conteos, cuotas, ventanas de publicación y lead times se calculan en código. Ver §25.2.
7. **Timeout y fallback obligatorios** en cualquier uso síncrono: si el puerto no responde a tiempo, el flujo continúa con el comportamiento por defecto declarado en ese `DP`.

### 9.15.4 Por qué esto vale aunque Jev nunca se adopte

Declarar el puerto obliga a **enumerar la taxonomía de cada decisión antes de escribir el código**: qué nichos existen, qué niveles tiene una señal de compra, qué significa exactamente "respaldado por la evidencia". Ese trabajo hay que hacerlo igual, y hacerlo tarde es de donde vienen los enums que crecen sin control. El puerto es el lugar donde esas definiciones quedan escritas una sola vez.

---

# 10. Integrations

## INT-001 — TikTok
- **Propósito:** publicación nativa (video y slideshow/foto), lectura de métricas, información del creador, sonidos comerciales.
- **Auth:** OAuth. Requiere cuenta **Business o Creator**; *"Personal accounts cannot use the publishing API."*
- **Datos enviados:** media renderizada, `title` (≤90), `description` (≤4000), `privacy_level`, `posting_mode`, flags de disclosure, `tiktok_sound_id`/`tiktok_sound_mode`.
- **Datos recibidos:** id de post, URL pública, views/likes/comments, valores permitidos de privacidad vía Creator Info API.
- **Modos:** `inbox` (default — borrador en la app del creador; el usuario publica manualmente) y `direct` (requiere entitlement `tiktokDirect` + `privacy_level`).
- **Peculiaridades:** carril lento de ingestión (`UPLOADING_TO_TIKTOK` + `tiktokProcessingDelayed`, publica solo en 24–48 h, watcher hasta 72 h). Direct posting con cuenta privada → el post cae al inbox. `Auto-Add Music` deja que TikTok añada música en tendencia a los slideshows. Disclaimer legal obligatorio: *"By posting, you agree to TikTok's Music Usage Confirmation."*
- **Errores:** `tiktok_post_limit_exceeded`, `503 tiktok_creator_info_unavailable`.
- **Reconnect:** `TikTok permissions are missing. Please disconnect and reconnect your account.`
- Evidencia: `[DEV]`, `[DOCS-5 t=96s]`, `[DOCS-2 t=318s]`, `[APP]` — CONFIRMED/SUPPORTED

## INT-002 — Instagram
- **Propósito:** publicación de Reels, imágenes y carruseles; métricas.
- **Auth:** OAuth. Cuenta profesional requerida.
- **Ruta doble:** publicación **nativa** y publicación **vía Ayrshare** (proveedor de terceros nombrado explícitamente en la documentación). Algunas capacidades (etiqueta de contenido IA en imágenes/videos/reels/carruseles) **sólo** están disponibles en la ruta Ayrshare. SUPPORTED
- **Formato de slideshow** (sólo warmed): `carousel` (por defecto, carrusel nativo deslizable) o `reel` (renderizado a video).
- **Ajuste de caption:** si Instagram obliga, `publishedCaption` difiere de `caption` y `captionAdjustmentReason = "repeated_mention"`; error asociado `instagram_repeated_mention`.
- **Errores/avisos:** `Instagram account needs attention`, `Reconnect Instagram to keep posting`, `A different Instagram account was connected. Open the connect flow again and choose the matching account.`, `Instagram connections are temporarily unavailable. Please try again later.`, `instagram_post_limit_exceeded`.

## INT-003 — YouTube (Shorts)
- **Propósito:** publicación de Shorts, métricas.
- **Auth:** OAuth, sólo conexión directa (no warmed).
- **Campos:** `caption` = **título** del video; `description` = cuerpo. `youtubePrivacyStatus` ∈ `public` \| `private` \| `unlisted`.
- **Restricción en automations:** cualquier destino YouTube exige `slideshowWeight = 0` (los slideshows no son publicables como Shorts).
- **Errores:** `youtube_post_limit_exceeded`.

## INT-004 — LinkedIn
- **Propósito:** publicación de posts.
- **Auth:** OAuth, sólo directo.
- **Campos:** sólo `caption` (texto del post).
- **Peculiaridad crítica:** *"LinkedIn connections last 60 days. Reconnect to keep posting without interruption."* CONFIRMED
- Aparece en Analytics (`LinkedIn posts`) y como destino de automations.

## INT-005 — Reddit
- **Propósito doble:** (a) destino de publicación (`platform: "reddit"` en schedule), (b) **motor de lead generation** del módulo Engagement.
- **Auth:** OAuth.
- **Restricción:** `enableCaptionGeneration: true` con Reddit devuelve `400 bad_request` (*"Reddit post-caption output is not supported"*).
- **Engagement:** descubrimiento por subreddits configurables, scoring de leads, generación de respuestas, monitorización de hilos, medidor de riesgo de baneo.
- Aparece en Analytics (`Reddit posts`).

## INT-006 — Ayrshare (proveedor de publicación de terceros)
- **Propósito:** enrutar publicaciones de Instagram (y posiblemente otras) cuando la ruta nativa no cubre una capacidad.
- Nombrado explícitamente en la documentación oficial en tres contextos distintos (etiqueta IA, tipos de post soportados, disclosure). SUPPORTED
- **Implicación para el clon:** la arquitectura de publicación debe soportar **múltiples proveedores por plataforma** con capacidades distintas, y exponer al usuario qué se puede y qué no según la ruta.

## INT-007 — Clerk (identidad)
Autenticación de usuarios, SSO, emisión de tokens hacia el backend (Convex). CONFIRMED

## INT-008 — Stripe (pagos) — INFERRED
Evidencia indirecta fuerte: `Manage Billing`, `Next regular invoice`, `Plan upgrade (pro-rated)`, `Couldn't start checkout`, `Internal provider ids, bundle ids, Stripe fields … are never returned` (mención literal de "Stripe fields" en la documentación de warmed accounts). SUPPORTED por esa mención; el uso exacto es INFERRED.

## INT-009 — Cloudflare R2 (storage)
Nombrado explícitamente: *"Fastlane verifies the R2 object"*, *"removes associated R2 storage objects"*. SUPPORTED

## INT-010 — PostHog (product analytics) — CONFIRMED
`Failed to set PostHog attribution properties:` `[APP]`.

## INT-011 — Affonso (programa de afiliados) — CONFIRMED
`Affonso attribution binding failed:` `[APP]`; programa público en `https://fastlane.affonso.io/` con 30 % recurrente de por vida `[WWW]`.

## INT-012 — Discord (comunidad)
Enlace directo `https://discord.gg/aaAQ9VzQ6j` desde el sidebar y el footer del Home. CONFIRMED

## INT-013 — MCP (Model Context Protocol)
Dos servidores, documentados en §11.

## INT-014 — Instagram / TikTok / X / YouTube / LinkedIn **como fuentes de lectura de marca** (EXTENSION)
- **Propósito:** leer perfil y contenido reciente para derivar identidad de marca (`FR-011`). Es un uso **distinto** del de publicación (`INT-001`…`INT-005`), aunque comparte el mismo OAuth cuando la cuenta es del usuario.
- **Auth:** preferentemente el OAuth ya existente del usuario (tier A). Si no, API pública / oEmbed (tier B) o fetch público (tier C).
- **Datos recibidos:** los listados en `FR-011.3`.
- **Datos enviados:** ninguno. Es estrictamente de lectura.
- **Sync:** puntual (al crear la fuente) y bajo demanda (`Re-analyse`); marcado `stale` a los 90 días. **No** hay sincronización continua.
- **Errores:** `not_found`, `private`, `insufficient_content`, `rate_limited`, `provider_unavailable`.
- **Permisos:** con tier A, los scopes de lectura de perfil y de contenido propio; con tier B/C, sólo datos públicos.
- **Requisito:** el alcance de lectura para marca debe poder concederse **sin** conceder publicación, para no obligar a comprometerse a publicar sólo para darse de alta.

## INT-015 — Proveedor de transcripción (ASR) (EXTENSION · **Fase 2** por D-03)
Transcribe reels, videos de TikTok y Shorts para extraer el tono real de la marca. Requisito: soporte multiidioma con detección automática, y devolución del idioma detectado para alimentar `toneOfVoice`. **Diferido a Fase 2**: sube de forma notable el coste por alta y su aporte incremental se concentra en cuentas de talking-head. El sistema debe funcionar completo sin él. No se elige proveedor aquí — es una decisión de implementación.

## INT-016 — Proveedor de OCR (EXTENSION · **Fase 1** por D-03)
Extrae el texto superpuesto de imágenes, carruseles y miniaturas. En short-form, gran parte del mensaje vive en el overlay, no en la caption: sin OCR el análisis pierde señal sustancial.

## INT-017 — Proveedor de extracción de páginas (EXTENSION, opcional)
Cubre el tier C. Debe ser **conmutable y desactivable** por configuración, y estar sujeto a la revisión legal de `OQ-16`. Si se desactiva, el sistema degrada al tier D sin romper ningún alta.

## INT-018 — Resolución de link-in-bio (EXTENSION)
Sigue **un** nivel de enlaces desde la bio (Linktree, Beacons y similares) hasta el destino real, con máximo 5 destinos y sin recursión, para recuperar la oferta de producto que en social suele vivir detrás del enlace.

**Requisitos transversales a todas las integraciones.**
1. Tokens cifrados en reposo, **nunca** devueltos por la API (*"Access tokens are never returned."*).
2. Estados de conexión explícitos: `active`, `expired`, `paused: reconnect needed`, `revoked`, `permissions missing`.
3. Flujo de reconexión que preserve la cuenta vinculada y avise si el usuario elige otra distinta.
4. Límite de conexiones por workspace (`Connection limit reached`).
5. Multi-cuenta por plataforma (`+ Add another account`), con resolución explícita en scheduling cuando hay ambigüedad.
6. Los errores de plataforma se traducen a **códigos estables neutrales respecto al proveedor** antes de mostrarse.
7. **EXTENSION** — separación estricta entre el permiso de **leer** una cuenta (para análisis de marca) y el de **publicar** en ella. Conectar para analizar no debe implicar conceder publicación, ni al revés.

---

# 11. AI & Automation

> Regla del PRD: **nunca** "usa IA". Cada comportamiento se especifica por inputs, contexto, trigger, procesamiento, outputs, configuración, estados, reintentos, revisión humana, límites y persistencia.

## AI-001 — Análisis de website → Company Profile
- **Inputs:** URL del sitio; alternativamente descripción libre de la marca (≤4 000 caracteres por respuesta). **EXTENSION:** en el clon la entrada se generaliza a cualquier `BrandSource` — ver `AI-016`.
- **Contexto:** contenido scrapeado del sitio.
- **Trigger:** botón `Analyse Website` en onboarding; re-análisis manual desde Brand.
- **Procesamiento:** extracción de contenido + LLM que produce campos estructurados: `CORE IDENTITY`, `PRODUCT OFFERING`, `UNIQUE BENEFITS`, `PROBLEM SOLUTION`, `Market & Competition`.
- **Outputs:** `CompanyProfile` persistido y editable campo a campo.
- **Configuración:** el usuario puede editar cualquier campo después.
- **Estados:** `Analyzing company profile...` → `Processing with AI...` → listo / fallido.
- **Reintentos:** *"Your company profile needs support before setup can finish."* + creación de ticket de soporte.
- **Revisión humana:** obligatoria — la pantalla pide explícitamente *"Please review your profile and make any changes."*
- **Límites:** URL pública; se rechazan localhost, IPs privadas y URLs bloqueadas; unicidad global de website.
- **Persistencia:** sí, versionada por `brandRevision`.
- Evidencia: `[APP OnboardingPage]`, `[DOCS-6 t=81s]` — CONFIRMED
- **Nota de alcance:** en el clon este comportamiento es el **extractor `website`** de `AI-016`, no un pipeline aparte. Su contrato de salida es idéntico al del resto de extractores.

## AI-016 — Extracción de identidad de marca desde un perfil social (EXTENSION · EXT-001)

- **Inputs:** una `BrandSource` resuelta (`sourceType` + `handle`/`canonicalUrl`) y, cuando existe, la `Connection` OAuth asociada.
- **Contexto:** el `BrandSourceSnapshot` — señales de perfil (nombre, bio, categoría, links, contadores) y hasta 24 ítems de contenido con caption, hashtags y **OCR del texto en pantalla**, más el engagement de cada ítem. La **transcripción ASR** se suma en Fase 2 (D-03).
- **Trigger:** `Analyse` en onboarding; `+ Add source` o `Re-analyse` en `/brand`; aceptar la oferta tras conectar una cuenta OAuth.
- **Procesamiento, en cuatro etapas:**
  1. **Recolección** — extractor por plataforma según el orden **B → C → A → D** de `FR-011.4` (D-01: sin pedir OAuth de entrada).
  2. **Enriquecimiento** — **Fase 1:** OCR sobre imágenes y miniaturas + resolución de link-in-bio (1 nivel, máx. 5 destinos). **Fase 2:** ASR sobre video (D-03).
  3. **Síntesis** — un LLM produce los campos estructurados del `CompanyProfile` **más, por cada campo, un nivel de confianza y el extracto exacto que lo justifica**. El prompt pondera el engagement: lo que más funcionó pesa más al inferir tono y audiencia.
  4. **Conciliación** — si ya hay otras fuentes, se fusionan con la precedencia de `FR-011.6`, registrando los conflictos.
- **Outputs:** `CompanyProfile` con `fieldMeta` (confianza + origen + extracto + `editedByUser`), `BrandSourceSnapshot` persistido, y una propuesta de **semilla de content angles** derivada de los temas recurrentes ordenados por engagement. La **confianza por campo** la produce `JV-4` (§25), no el LLM de síntesis: quien deriva un valor no es buen juez de su propia evidencia.
- **Configuración:** número de ítems a analizar; activación del tier C; opt-in de importación de posts al Media Bank.
- **Estados:** `queued` → `analyzing` (con sub-pasos visibles) → `ready` \| `partial` \| `failed`; `ready` → `stale` a los 90 días.
- **Reintentos:** un fallo de OCR (o de ASR en Fase 2) degrada a `partial`, **no** aborta. Un fallo del proveedor reintenta con backoff. Agotados los reintentos, se degrada al tier D pidiendo ayuda concreta al usuario.
- **Revisión humana: obligatoria y explícita.** El perfil derivado de social se presenta con los campos de baja confianza agrupados arriba bajo `Worth a quick check`. Es una diferencia importante con el origen web: una bio de Instagram da menos certeza que una página de producto, y el producto debe admitirlo en vez de disimularlo.
- **Límites:** 5 fuentes por workspace; N re-análisis por fuente y día; 24 ítems por análisis (configurable); seguimiento de enlaces de 1 nivel.
- **Guardarraíles:**
  - **Nunca inventar.** Un campo sin señal suficiente queda vacío y genera una pregunta al usuario (`FR-011.3`), no un relleno plausible. Este es el guardarraíl más importante de toda la extensión: un `PRODUCT OFFERING` inventado contamina cada pieza de contenido que el sistema genere después.
  - **Contenido de terceros = dato, nunca instrucción.** Bios y captions van en un contenedor delimitado; el modelo tiene instrucción explícita de ignorar directivas incrustadas. Test de regresión con bios adversariales obligatorio.
  - **Sin traducción de la voz.** El tono se analiza y registra en el idioma original.
- **Persistencia:** `CompanyProfile` (permanente, es dato del cliente), `BrandSourceSnapshot` (extractos citables, con purga del material crudo por `rawRetentionExpiresAt`), binarios de terceros **no se persisten**.
- Evidencia: **EXTENSION** — decisión de producto del clon, no observada en Fastlane.

## AI-002 — Generación de sugerencias (discovery queue)
- **Inputs:** Company Profile, content angles activos con sus pesos, `BlitzPreferences` (mix de tipos, remix ratio, own-media ratio, mention-business, influencer chance, gender filter, caption style mix), catálogo de trending, Media Bank del workspace.
- **Trigger:** automático en background para mantener ~5 items en cola; también bajo demanda al forzar un `contentType`.
- **Procesamiento:** decide (a) remix vs. original según `remixPercentage`; (b) tipo de contenido según los 4 pesos; (c) ángulo según `angleWeights`; (d) si intenta influencer, mediante una **tirada independiente** con probabilidad `influencerChance`; (e) fuente de media según `ownMediaPercentage`; (f) preset de estilo de caption según `textStyleWeights`; y genera la copy más una **explicación** de la elección.
- **Outputs:** `Suggestion` con `contentType`, `generatedText`, `aiExplanation`, `remixSourceUrl?`.
- **Configuración:** toda vía `/blitz/settings` (`FR-055`).
- **Estados:** `queued` → `popped` → build.
- **Reintentos:** si no hay influencer activo/entrenado elegible, **fallback a contenido regular**. `green-screen` nunca usa influencer.
- **Revisión humana:** el swipe **es** la revisión. Además, `Edit` permite corrección previa.
- **Límites:** cola objetivo 5; refills concurrentes pueden excederla transitoriamente.
- **Persistencia:** la explicación se **almacena con la sugerencia** (no se regenera al abrirla).
- Evidencia: `[DEV]`, `[DOCS-B t=21s]` — SUPPORTED/CONFIRMED

## AI-003 — Remix de contenido en tendencia
- **Inputs:** item de trending (video/slideshow + overlays de texto + métricas), Company Profile, toggle `mention business`, prompt opcional.
- **Trigger:** `Remix` / `Remix this`, o selección automática por la discovery queue.
- **Procesamiento:** según la narración oficial del producto, se remixa *"the tone, the structure, the way it's been written and where it's plugged the app"* recreándolo con el contexto del negocio, **incluyendo la colocación de emojis** en posiciones análogas. `[DOCS-B narración]` CONFIRMED
- **Outputs:** copy nueva + composición de media.
- **Persistencia:** se guarda `remixSourceUrl` (permalink público de la fuente) y se muestra en Blitz, en el contenido y en la API. No se infiere si no se almacenó.

## AI-004 — Regeneración de copy (`Regenerate Text`)
- **Inputs:** contenido existente, prompt opcional (≤500 caracteres), toggle `mention business`.
- **Trigger:** botón en el editor de Blitz/Studio.
- **Procesamiento:** reescribe **todas** las cajas de texto preservando media, estructura de cajas, layout y estilo; en slideshows mantiene el número exacto de slides y cajas.
- **Outputs:** nueva copy + rebuild del mismo `contentId`, `revision`+1.
- **Estados:** `202 Accepted` → polling hasta `CREATED`.
- **Límites:** usa la cuota normal de generación de copy del workspace; **no** consume content save ni genera evento de facturación de Partner.
- **Errores:** `402 payment_required` si el acceso de pago terminó; `429 rate_limited` si se agota la cuota de copy o de render.
- Evidencia: `[DEV POST /content/:id/regenerate]`, `[DOCS-B t=99s→114s]` — SUPPORTED/CONFIRMED

## AI-005 — Generación de ángulos de contenido
- **Inputs:** ninguno (body vacío `{}`).
- **Contexto:** perfil del workspace + **contexto RAG** + títulos de ángulos existentes (para evitar repetición). *Nota: existe una página interna `/admin/rag`, lo que confirma un pipeline RAG.*
- **Outputs:** `{title, description, targetAudience, brandRevision}` **sin persistir**.
- **Revisión humana:** obligatoria — hay que persistir explícitamente.
- **Límites:** 5 sugerencias exitosas/min; la reserva se **libera** si la generación falla (no consume cuota).
- **No idempotente:** cada llamada puede devolver algo distinto. No registra evento de facturación ni crea contenido.
- **Guardarraíl de consistencia:** al persistir hay que enviar `expectedBrandRevision`; si la marca cambió entre generar y guardar, se rechaza.
- Evidencia: `[DEV]` — SUPPORTED

## AI-006 — Generación de captions al programar
- **Inputs:** contenido, plataformas destino, campos de copy existentes.
- **Trigger:** `enableCaptionGeneration: true`, o los botones `Improve` / `Regenerate` por campo en `Content Details`.
- **Procesamiento:** rellena **sólo** campos vacíos u omitidos; los valores explícitos no vacíos siempre ganan. Si todos los campos aplicables ya están, **no** se genera nada ni se consume cuota.
- **Outputs:** copy almacenada en el `Post`; **no** se devuelve en la respuesta de schedule (hay que leer el post).
- **Límites:** requiere entitlement `autoCaptions`; cuota de generación de captions con detalles de reset/límite en el 429. Reddit no soportado.
- Evidencia: `[DEV]`, `[DOCS-7 t=429s]` — SUPPORTED/CONFIRMED

## AI-007 — Creación y entrenamiento de influencers
- **Inputs:** nombre, género, edad (18–60), etnia, detalles adicionales; o imagen base subida (≤10 MB).
- **Procesamiento en 2 fases:** (1) generación de imagen base (~30–60 s, 4 créditos); (2) pipeline de **agentes** que generan variaciones y entrenan el modelo del personaje (~15–20 min, 250 créditos). Copy literal: *"Our agents will go and create <Name> for you now."*
- **Outputs:** `Influencer` con `status` y `progress`.
- **Regeneración:** produce **una persona nueva**, no una edición del mismo personaje — regla de producto explícita.
- **Estados:** `generating_variations` → `training` → `ready` \| `failed` \| `inactive`.
- **Límites:** 50 activos/workspace; idempotencia obligatoria.
- **Persistencia:** el personaje es propiedad del workspace y reutilizable indefinidamente (*"Yours, forever"* en marketing).
- Evidencia: `[DOCS-7 t=15s/48s/81s]`, `[DEV]` — CONFIRMED/SUPPORTED

## AI-008 — Generación de imágenes de influencer
- **Inputs:** prompt (`e.g. her at the beach`), plantilla opcional (`Template`), influencer entrenado.
- **Parámetros observados:** `MODEL` (identificado en UI como `Fastlane V8` — modelo propietario o alias interno), `ASPECT 9:16`, `RESOLUTION 1080p`, `BATCH 1`, `CREDITS 4`.
- **Tiempo:** ~30–60 s. **Coste:** 4 créditos/imagen.
- **Outputs:** imagen descargable, persistida en la galería del influencer y disponible para el Media Bank/Blitz.
- Evidencia: `[DOCS-7 t=111s/138s]` — CONFIRMED

## AI-009 — Generación de video de influencer
- **Inputs:** imagen de referencia opcional, prompt de movimiento (*"describe the motion (optional, e.g. slow zoom on the face)"*), plantilla, duración `5s` / `10s`.
- **Modelo:** seleccionable; valor observado **`Kling v3 Pro`**. CONFIRMED `[DOCS-7 t=156s]`
- **Coste/tiempo:** 60 créditos · ~1–3 min.
- **Outputs:** video en la pestaña `Videos` del influencer.

## AI-010 — Talking Head UGC
- **Inputs:** imagen del personaje + `Script` de texto.
- **Configuración:** `Duration` (`5s`), `Language` (`English`), `Caption overlay` (checkbox, por defecto activo).
- **Validación en vivo:** *"0 words may be too short for 5s - Target 10-15 words"* — la guía de longitud se ajusta a la duración.
- **Outputs:** video con voz sincronizada y subtítulos opcionales.
- **Notificación:** `Talking Head UGC generating. Check the Videos tab.`
- Evidencia: `[DOCS-7 t=138s]`, `[APP]` — CONFIRMED

## AI-011 — AI Studio (generación libre)
- **Inputs:** prompt + hasta tres tipos de referencia (`composition reference`, `product image`, referencia de persona), `Image count`.
- **Guardarraíles:** filtro de contenido en prompt **y** en imagen, con mensajes diferenciados; restricción de compatibilidad modelo↔referencia; validación de que el personaje necesita referencia de persona.
- **Límites:** 10 generaciones en vuelo; gating por plan.
- Evidencia: `[APP AiStudioPage]` — CONFIRMED

## AI-012 — Generación de campañas (Automations)
- **Inputs:** `prefsSnapshot` congelado, cuentas destino, cadencia, duración, fecha de inicio.
- **Procesamiento:** genera N slots; cada sugerencia consume cuota de generación de la campaña; evita repetir contenido ya usado por el workspace.
- **Regla dura:** un tipo con peso 0 está **excluido**, no es fallback. Si el único tipo con peso falla repetidamente, la campaña entrega **menos** posts en lugar de sustituirlo.
- **Fallos por slot:** `no_unique_content`, `no_demo_video` → slot `FAILED_GEN`, sin post.
- **Revisión humana:** obligatoria — la campaña pasa por `REVIEW` con edición y re-roll antes de poder lanzarse.
- **Re-roll:** destructivo e irrecuperable, consume cuota.
- **Snapshot:** cambiar las preferencias del workspace **no** altera una campaña existente.
- Evidencia: `[DEV MCP Automations]` — SUPPORTED

## AI-013 — Reddit: scoring de leads y generación de respuestas
- **Inputs:** posts/comentarios de los subreddits configurados, Company Profile, reglas personalizadas del usuario.
- **Outputs:** lead con score, explicación (`Why this lead?`) y respuesta sugerida.
- **Configuración:** `Reply Settings`, `Save Custom Rules`, tono (*"Proper capitalization, polished, business-appropriate"*).
- **Revisión humana:** obligatoria; el usuario puede regenerar.
- **Guardarraíl de seguridad:** el **ban risk meter** clasifica el patrón de engagement en 4 niveles y, en `Danger`, recomienda explícitamente **dejar de responder** a través de la plataforma.
- **Ratio recomendado:** 60-70 % valor / 20-30 % sutil / 10-20 % directo; al menos 3-4 respuestas de valor por cada promocional.
- Evidencia: `[APP ActionsView]` — CONFIRMED

## AI-014 — Smart text positioning
- **Qué hace:** varía la colocación de las captions entre piezas en lugar de fijarlas siempre en el mismo sitio. **Activo por defecto.** En ambos casos las captions permanecen dentro del *safe area*.
- **Configuración:** `smartTextPositioning` (boolean) en `BlitzPreferences`.
- Evidencia: `[DEV]` — SUPPORTED

## AI-015 — MCP: dos superficies de agente

### A. OAuth connector — `https://api.usefastlane.ai/connector/mcp`
- **Clientes:** ChatGPT y las apps Claude hospedadas (web, desktop, móvil). **No** autentica Claude Code.
- **Auth:** sign-in de Fastlane vía Clerk OAuth. Scopes: `fastlane:read`, `fastlane:drafts:write`.
- **Acceso:** sólo el **owner de pago** de un workspace directo. Se ancla al workspace actual en el primer uso; para moverlo: `Settings → API → AI connectors → Use this workspace`.
- **8 tools:** `list_content`, `get_content`, `get_build_status`, `list_blitz_angles_page`, `get_blitz_preferences` (read) · `create_blitz_angle`, `update_blitz_angle`, `update_blitz_preferences` (write, **requieren confirmación**; `create_blitz_angle` exige `idempotencyKey`).
- **No puede:** generar ni publicar contenido, programar posts, gestionar automations o influencers, acceder a archivos de media, ni tocar billing.

### B. API-key server — `https://api.usefastlane.ai/mcp`
- **Clientes:** Claude Code, OpenAI Codex y otros clientes MCP de desarrollo. JSON-RPC 2.0 sobre un único POST HTTPS **stateless**.
- **Auth:** misma API key de workspace como Bearer. **No** acepta Partner keys.
- **34 tools: 16 de lectura y 18 que modifican.**
  - *Read:* `list_content`, `get_content`, `get_build_status`, `list_posts`, `get_post`, `get_post_analytics`, `list_connections`, `list_tiktok_sounds`, `list_blitz_angles`, `list_blitz_angles_page`, `get_blitz_preferences`, `list_influencers`, `get_influencer`, `list_automations`, `get_automation`, `list_automation_slots`.
  - *Action:* `run_blitz`, `schedule_content`, `create_blitz_angle`, `update_blitz_angle`, `update_blitz_preferences`, `delete_blitz_angle`, `create_influencer`, `cancel_posts`ᴰ, `delete_posts`ᴰ, `delete_content`ᴰ, `create_automation`, `update_automation`, `generate_automation`, `update_automation_slot`, `reroll_automation_slot`ᴰ, `launch_automation`, `cancel_automation`ᴰ, `delete_automation`ᴰ. (ᴰ = marcadas como destructivas; el asistente debe confirmar.)
- **Asimetría deliberada:** las **Automations son sólo MCP**; las subidas al Media Bank, la librería de audio, la subida de video custom y el listado de warmed accounts son **sólo REST**. Ninguna superficie es superconjunto de la otra.
- **Rate limit:** 30 req/min por usuario, independiente de la cuota REST.
- **Facturación:** los tools que crean contenido usan el mismo pool de content saves que la app; programar **no** es usage-metered.
- Evidencia: `[DEV MCP servers]` — SUPPORTED

---

# 12. Search / Filters / Sorting

| Pantalla | Campos buscables | Filtros | Operadores | Sorting | Combinación | Reset | Persistencia | No-results |
|---|---|---|---|---|---|---|---|---|
| **Inspiration** | texto libre (`Search inspiration`) | `Filter by niche` (multi-chip) | contiene (texto); OR dentro de nicho | por defecto trending/recency (INFERRED) | búsqueda + nicho combinables | `Clear search`, `Clear all` | INFERRED: no persiste entre sesiones | `No results` + *"Try a different search or clear your filters."* CONFIRMED |
| **Select Video (modal)** | — | chips `Activity`, `Neutral/Filler`, `Reaction`, `Man`, `Woman` | OR intra-dimensión, AND inter-dimensión (INFERRED del uso `Reaction`+`Woman`) | — | sí | `Clear` | no | estado vacío (UNKNOWN el copy) |
| **Trending Content (Studio)** | — | chips de nicho mostrados sobre la tarjeta | — | orden del carrusel | — | — | — | — |
| **Library → My Posts** | — | por estado (INFERRED a partir del parámetro `status` del API: `BUILDING, CREATED, SCHEDULED, UPLOADING_TO_TIKTOK, IN_USER_INBOX, POSTED, FAILED, DELETED, AWAITING_RECONNECT`) | lista separada por comas | newest first (API) | — | — | — | `No posts` CONFIRMED |
| **Library → My Content** | — | por `type` (`slideshow`, `video-hook`, `green-screen`, `wall-of-text`, `custom`) y `status` (`BUILDING`, `CREATED`, `FAILED`) SUPPORTED | lista separada por comas | newest first | sí | — | — | estado vacío |
| **Library → My Media Bank** | `Search your images` | segmented `All`/`Images`/`Videos`; select `All categories`; chips `INFLUENCER: All / <nombre>` | `type` = `image`\|`video`; categorías por tipo de media | newest first (API) | sí | — | — | `No images uploaded yet` CONFIRMED |
| **Engagement → Leads** | búsqueda (`Open search` / `Close search`) | `Unseen only`; vistas `Most Engaged Leads` / `Top Scored Leads` | — | por engagement o por score | sí | — | `Failed to mark leads as seen:` implica estado persistido de "visto" | *"Try adjusting your filters or fetch new leads to discover conversations where your audience is seeking solutions."* CONFIRMED |
| **Calendar** | — | navegación mensual | — | por día y hora | — | — | — | mes vacío |
| **Analytics** | — | rango en días | — | — | — | — | — | — |
| **Automation slots** | — | `status` (uno de los 10 estados de slot) | igualdad | — | — | — | — | — |

**Paginación.** Dos patrones conviven y ambos deben implementarse:
- **UI de pickers y grids legacy:** páginas numeradas — `‹ Previous` · `Page X of Y` · `Next ›` (`Page 1 of 2`, `Page 1 of 5`, `Page 1 of 7`, `Page 1 of 40`). CONFIRMED
- **API y listados modernos:** cursor opaco con `limit` (1–100, default 20) y `hasMore`. SUPPORTED

**Servicio de búsqueda.** Componente separado con su propio modo de fallo: `Search Service Unavailable`, `The search service is temporarily unavailable.`, `Retry Search`. CONFIRMED

---

# 13. Notifications

> **Confianza mixta.** La existencia del subsistema está CONFIRMED; el detalle del panel de preferencias es UNKNOWN (ver OQ-03).

## 13.1 Canales

| Canal | Evidencia | Confianza |
|---|---|---|
| **Toast in-app** | Múltiples toasts observados con enlace de acción | CONFIRMED |
| **Banner in-app persistente** | `All changes saved`, banners de conexión caducada, de plan | CONFIRMED |
| **Badge en navegación** | Punto rojo en `Settings` del sidebar | CONFIRMED |
| **Email** | `Verified email sync failed`, confirmación de borrado de cuenta por email | CONFIRMED (al menos transaccional) |
| **Preferencias de notificación** | Sección `notifications` en Settings + `Could not save notification settings.` | CONFIRMED (existencia) |

## 13.2 Triggers y contenido (catálogo normativo)

| ID | Trigger | Canal | Contenido | Acción / deep link |
|---|---|---|---|---|
| N-01 | Contenido aceptado en Blitz y build iniciado | toast | `Building post!` | `View in Library` → `/library` |
| N-02 | Contenido guardado sin programar | toast | `Content saved!` | `View in Library` |
| N-03 | Post programado con salida inminente | toast | `Posting in ~5 minutes!` | `View in Library` |
| N-04 | Post enviado a TikTok | toast | `Building post! It may take a few minutes to appear on TikTok.` | `View in Library` |
| N-05 | Auto-guardado de configuración | banner | `All changes saved` | — |
| N-06 | Suscripción activada | toast | `Subscription activated!` | — |
| N-07 | Feedback enviado | toast | `Thanks for your feedback!` | — |
| N-08 | Workspace listo | pantalla | `Workspace ready!` | `Continue to Dashboard` |
| N-09 | Conexión expirada | banner | `Connection Expired` / `Paused: reconnect needed` | `/settings` → integrations |
| N-10 | LinkedIn cerca de los 60 días | banner | `LinkedIn connections last 60 days. Reconnect to keep posting without interruption.` | reconnect |
| N-11 | Instagram necesita atención | banner | `Instagram account needs attention` / `Reconnect Instagram to keep posting` | reconnect |
| N-12 | Permisos faltantes | banner | `Permissions Missing` / `Reconnect to upgrade permissions` | reconnect |
| N-13 | Warmed account esperando aprobación | banner/tarjeta | `Account Awaiting Approval` | `/warmed-accounts` |
| N-14 | Warmed account en verificación | tarjeta | `Account Status Being Checked` + *"You do not need to do anything right now."* | — |
| N-15 | Decisión de reemplazo pendiente | tarjeta | decisión + opciones | `/warmed-accounts` |
| N-16 | Cuota de contenido agotada | banner | `Plan content limit reached` / `Your content is view-only. Upgrade to create and publish again.` | `/upgrade` |
| N-17 | Créditos insuficientes | inline | `Not enough credits. Top up or upgrade to continue.` | compra de créditos |
| N-18 | Pago fallido | banner | `We couldn't process your payment. Please update your billing details and try again.` | `Manage Billing` |
| N-19 | Post fallido | tarjeta en Library | `errorMessage` seguro + `errorCode` | reintentar/reprogramar |
| N-20 | Talking Head UGC listo para revisar | toast | `Talking Head UGC generating. Check the Videos tab.` | tab `Videos` |
| N-21 | Nueva actividad en un lead | badge | `New activity` / `Activity Found!` | detalle del lead |
| N-22 | Automation lista para revisar | INFERRED | estado `REVIEW` | `/automations/:id` |

## 13.3 Read / unread
El módulo de Engagement implementa explícitamente el concepto de "visto": filtro `Unseen only`, badge `New activity`, y persistencia (`Failed to mark leads as seen:`, `Failed to update lead last viewed timestamp:`). CONFIRMED. Para el resto del producto, un centro de notificaciones con read/unread es **INFERRED** y se recomienda implementarlo.

## 13.4 Preferencias
Sección `notifications` en Settings con guardado; contenido exacto **UNKNOWN**. **Requisito para el clon:** permitir activar/desactivar por categoría (publicación, fallos, cuota/billing, leads, automations) y por canal (in-app, email).

---

# 14. Settings

Ver `FR-160` para el detalle completo de copy y comportamiento. Resumen de las 8 secciones (ids literales del bundle):

| Sección | Contiene |
|---|---|
| `account` | Perfil, nombre, email verificado, borrado permanente de cuenta con confirmación por email |
| `workspaces` | Listado, cambio, creación adicional, borrado con advertencias sobre suscripciones y post slots |
| `integrations` | OAuth de TikTok/Instagram/YouTube/LinkedIn/Reddit; multi-cuenta; estados de conexión; reconexión; límite de conexiones; `Configure connections and content sets` |
| `warmed-accounts` | Compra, configuración (plataforma/país/nicho/keywords), aprobación, estado, slots, decisiones de reemplazo |
| `notifications` | Preferencias de notificación (contenido exacto UNKNOWN) |
| `preferences` | Timezone (auto-sincronizada), tema, idioma |
| `billing` | Plan actual, cambio/programación de cambio, próxima factura con prorrateo, portal de facturación, compra de créditos/saves/posts, cancelación con feedback |
| `api` | Creación y revocación de API keys (workspace y partner), toggle de API overage billing, AI connectors (`Use this workspace`), documentación embebida |

**Roles/members:** no existe una sección `members` en el bundle. La invitación existe (`Failed to create special user from invite:`) pero su UI es **UNKNOWN**. Para el clon se recomienda añadir `members` dentro de `workspaces`. INFERRED


---

# 15. Authentication & Onboarding

## 15.1 Signup
`/signup` y `/signup/*` (Clerk). Email/password + SSO. Enlace `Already have an account?` → `/login`; en login, `Create an account` → `/signup`. CONFIRMED

## 15.2 Login
`/login`, `/login/*`, `/auth/sso-callback`. Saludo `Welcome back`. Fallo de sesión: `We couldn't verify your session. Try again, or sign in again if this continues.` CONFIRMED

## 15.3 Password recovery
Delegado al proveedor de identidad (Clerk). No se observó UI propia. INFERRED

## 15.4 Workspace creation
- Primer workspace: durante el onboarding.
- Adicionales: `Create another workspace` → repite el wizard con `/onboarding`.
- Límite: `You've reached your workspace creation limit. Please try again later.` CONFIRMED
- Abandono: `Failed to abort new workspace:`; opciones `Keep workspace` / `Use current workspace`.
- Estados: `Setting up your workspace with your company information`, `Workspace preparation progress`, `Workspace is still loading. Please try again in a moment.`, `We encountered an issue while setting up your workspace`.

## 15.5 Invitations
Existe un flujo de invitación que crea un "special user" (`Failed to create special user from invite:`). Su UI y su modelo de permisos son **UNKNOWN**. CONFIRMED (existencia) / UNKNOWN (detalle)

## 15.6 Onboarding
Ver `FR-010` para la especificación completa (pasos, campos, validaciones, estados, copy literal) y **`FR-011` para el análisis de perfiles sociales como origen de marca (EXTENSION · EXT-001)**, que elimina el requisito de tener página web para darse de alta.

## 15.7 Integrations setup
Tras el onboarding, el camino crítico es conectar al menos una cuenta social. Requisitos por plataforma:
- **TikTok:** cuenta Business o Creator; direct posting requiere además entitlement y (para direct) cuenta no privada.
- **Instagram:** cuenta profesional; verificar que la cuenta elegida coincide con la esperada.
- **YouTube:** cuenta de marca o personal (la FAQ explica la diferencia).
- **LinkedIn:** reconexión cada 60 días.
- **Reddit:** necesaria para Engagement.
CONFIRMED

## 15.8 Configuración inicial recomendada (primer día)
0. **(EXTENSION)** Si el alta se hizo con una sola fuente social, conectar la cuenta por OAuth para subirla a tier A y, si interesa, importar los posts propios al Media Bank.
1. Revisar y corregir `/brand`, prestando atención a los campos marcados con confianza baja.
2. Revisar `Voice & angles` en `/blitz/settings` y crear 3–8 ángulos.
3. Ajustar `Content mix` al formato que la cuenta va a priorizar.
4. Subir `demo video` del producto al Media Bank con categoría `hook-video` (habilita `video-hook`).
5. Conectar al menos una cuenta por plataforma objetivo.
6. (Opcional) Crear un influencer y subir `INFLUENCER FREQUENCY`.

## 15.9 Primer workflow exitoso
Definición de "activación" para el clon: **el usuario programa su primer post desde Blitz en la misma sesión de onboarding.** El producto original optimiza explícitamente para esto: la cola ya tiene contenido cuando el usuario llega al dashboard, y desde Blitz hasta `Schedule Post` hay 4 clics. CONFIRMED por el diseño observado.

---

# 16. Billing & Plans

> **Todos los precios y límites de esta sección están tomados literalmente de la página de precios oficial y de `llms-full.txt`. No se ha inventado ningún valor.** Verificado el 2026-09-21. SUPPORTED `[WWW]`

## 16.1 Planes

### Free — $0
*"Test the waters"*
- No credit card
- Access to Blitz (Tinder mode)
- 10 AI Studio credits
- Limited content
- Browse features

### Starter — $29 / month
*"If you're just starting out"*
- 20 content saves
- 250 AI studio credits
- TikTok, Instagram, YT + LinkedIn
- 1 workspace
- 25 AI UGC characters
- Blitz mode

### Growth — $49 / month
*"If you're looking to grow fast"*
- 100 content saves
- 500 AI studio credits
- Unlimited socials
- 3 workspaces
- 500+ AI UGC characters
- 100 human UGC videos
- Blitz mode

### Pro — $149 / month
*"If you want to 10x your marketing"*
- Unlimited content saves
- 2000 AI studio credits
- Unlimited scheduling
- 10 workspaces
- 2000+ human UGC videos
- Early access to new features
- Multi-language content

### Warmed Accounts — $100 / month por cuenta
- Cuentas reales de TikTok o Instagram creadas y calentadas por humanos
- **+ $1,50 por post subido**
- Requiere suscripción activa de Fastlane

**Nota de discrepancia.** Una fuente secundaria (análisis de terceros) menciona precios anuales con 20 % de descuento (Starter $232,80 / Growth $392 / Pro $1 192). La página oficial de precios consultada **no** los expone. Se marca como **UNKNOWN** — no implementar sin confirmar. Ver OQ-07.

## 16.2 Dimensiones de cuota

| Cuota | Unidad | Reset | Notas |
|---|---|---|---|
| **Content saves** | por pieza de contenido creada | día ancla de facturación, 00:00 UTC | Orden de consumo: incluidos → comprados → overage medido (si está habilitado). Un build fallido **reembolsa**. Borrar contenido **no** reembolsa. |
| **Trial content allowance** | por pieza | **nunca** (de por vida, por cuenta) | Compartida entre workspaces personales. Error sin `resetAt`. |
| **Daily Blitz swipes** | por aceptación | diario 00:00 UTC | `resetAt` en el error. El gate de saves se evalúa **antes**. |
| **AI Studio credits** | por generación | mensual por plan | 4 créditos/imagen · 60 créditos/video · 250 créditos/influencer · 4 créditos/base image. Recargables. |
| **Workspaces** | 1 / 3 / 10 según plan | — | |
| **AI UGC characters** | 25 / 500+ / 2000+ según plan | — | Cap técnico separado: 50 influencers activos por workspace. |
| **Human UGC videos** | 100 (Growth) / 2000+ (Pro) | — | |
| **Warmed post slots** | por post publicado | compra | `402 payment_required` al agotarse. |
| **API keys activas** | `<N> active keys per workspace.` | — | Valor exacto UNKNOWN. |
| **Connections** | `Connection limit reached` | — | Valor exacto UNKNOWN. |
| **Content angles** | 100 por workspace | — | SUPPORTED |
| **Angles por influencer** | 10 | — | SUPPORTED |
| **Storage agregado** | por plan | — | `402 payment_required` al excederse. |

## 16.3 Upgrades y downgrades
- Upgrade: prorrateado (`Plan upgrade (pro-rated)`), requiere método de pago (`Please add a payment method on the billing page before upgrading.`).
- Downgrade: ajuste (`Plan downgrade adjustment`), programable y cancelable (`There is no scheduled plan switch to cancel.`).
- Bloqueo: `Plan switching is available once your subscription is active. Sort out your billing first and this will open back up.`
- Al bajar de plan: `Some items are not included in your plan`, `This content isn't included in your plan.`, y el modo view-only.
CONFIRMED

## 16.4 Portal de facturación
`Manage Billing` abre el portal externo del proveedor de pagos. Se muestran `Next Billing Date`, `Next regular invoice`, `Total next invoice`, `Plan credits granted`, `Initial credits`, `Resets each billing cycle`, `Here's where your content saves stand this billing period.` CONFIRMED

## 16.5 Cancelación
`Cancel Subscription` → `Continue to cancellation` → formulario de feedback → `Cancellation pending`. Salida: `Keep my plan`. Error: `Cancellation feedback submission failed:`. CONFIRMED

## 16.6 API overage billing
Toggle en `Settings → API`. Cuando está activo y la suscripción está viva, las llamadas de creación de contenido continúan por encima de la cuota como **user API content-save overage** medido. Cuando está desactivado, devuelven `content_quota_exceeded`. Programar y publicar desde keys de workspace **no** es usage-metered. SUPPORTED

## 16.7 Restricciones de trial
- `Warmed accounts are unavailable on trial` / `Warmed accounts not available on trial`
- *"Your trial can only post to your own connected accounts. Remove the warmed accounts or upgrade to launch."*
- Trial allowance de por vida, sin reset.
CONFIRMED/SUPPORTED

## 16.8 Programa de afiliados
30 % de comisión recurrente por venta, de por vida, gestionado con Affonso. Entrada in-app: `Refer & Earn`. SUPPORTED

---

# 17. Non-Functional Requirements

| ID | Requisito | Especificación | Evidencia |
|---|---|---|---|
| **NFR-001** | Latencia de Blitz | Aceptar una sugerencia devuelve `202` **inmediatamente**; el build corre en background 30 s–2 min. La UI nunca bloquea al usuario esperando un render. | SUPPORTED |
| **NFR-002** | Polling documentado | Cualquier trabajo asíncrono expone estado consultable; la cadencia recomendada oficial es **10 s** para builds. | SUPPORTED |
| **NFR-003** | Disponibilidad de la cola | La discovery queue se rellena sola; un 404 por cola vacía debe ser transitorio y recuperable sin intervención. | SUPPORTED |
| **NFR-004** | Idempotencia | Toda operación facturable acepta `Idempotency-Key`; el reintento con la misma key replica la respuesta sin duplicar cargos. | SUPPORTED |
| **NFR-005** | No-reintentar-no-idempotente | Las operaciones explícitamente no idempotentes (`POST /blitz`, generación de ángulos) **no** deben reintentarse automáticamente ante timeout o 5xx. El cliente debe consultar estado. | SUPPORTED |
| **NFR-006** | Aislamiento por workspace | Todo recurso lleva `companyId`; el acceso cruzado responde `404`. Los borrados idempotentes no revelan existencia. | SUPPORTED |
| **NFR-007** | Secretos | Access tokens OAuth, secretos de API key, credenciales de proveedor, storage keys e ids internos **nunca** se devuelven por la API. La API key se muestra una sola vez. | SUPPORTED |
| **NFR-008** | URLs efímeras | Las URLs de playback de media limpia y de preview de sonidos son capacidades bearer firmadas con **1 hora** de vida: no loguear, no persistir, refrescar al expirar. | SUPPORTED |
| **NFR-009** | Rate limiting | Token bucket por workspace con refill uniforme en ventana de 60 s; `Retry-After` + `details.retryAfterMs`; `503` cuando el límite no puede comprobarse de forma segura. | SUPPORTED |
| **NFR-010** | Degradación segura | Un fallo del servicio de búsqueda degrada sólo la búsqueda (`Retry Search`), no la pantalla. Un layer de media no resoluble devuelve `status: "unavailable"` manteniendo el resto de la respuesta usable. | SUPPORTED |
| **NFR-011** | Consistencia transaccional | Mutaciones de ángulos + reconcile de pesos en la misma transacción. Cancel/delete de posts en lote: **todo o nada**. | SUPPORTED |
| **NFR-012** | Límites de lote | Máx. 100 ids por llamada en cancel, delete y analytics de posts; ids duplicados deduplicados antes de aplicar el cap. | SUPPORTED |
| **NFR-013** | Límites de subida | Imágenes 10 MB · videos 50 MB · base image 10 MB; tipos restringidos; extensión coherente con content type. | SUPPORTED |
| **NFR-014** | Normalización de media | MOV→MP4, HDR→SDR, faststart, en background, con estado consultable. | SUPPORTED |
| **NFR-015** | Resiliencia de publicación | Watcher de TikTok hasta 72 h; `AWAITING_RECONNECT` con reanudación automática; **nunca** duplicar un post en carril lento. | SUPPORTED |
| **NFR-016** | Frescura de métricas | Documentar explícitamente que las métricas reflejan la última sincronización y usar `postedAt` para distinguir cero real de pre-sync. | SUPPORTED |
| **NFR-017** | Seguridad de URLs de onboarding | Rechazar localhost, IPs privadas y URLs bloqueadas (protección SSRF). | CONFIRMED |
| **NFR-018** | Filtro de contenido | Bloqueo en prompt y en imagen, con mensajes diferenciados por causa. | CONFIRMED |
| **NFR-019** | Responsive | La UI usa breakpoints `sm:`/`md:`/`lg:` extensivamente y tamaños adaptativos (`size-4 sm:size-3`). Debe funcionar en móvil. | CONFIRMED |
| **NFR-020** | Accesibilidad | Se observan `aria-label` (p. ej. `aria-label="Download Markdown"`), `aria-hidden` en iconos decorativos, estados `disabled` explícitos y navegación por teclado en Blitz (←/→). **Requisito para el clon:** WCAG 2.1 AA — foco visible, roles correctos, contraste, alternativas textuales a los controles de swipe. | CONFIRMED (parcial) / INFERRED (nivel) |
| **NFR-021** | Tema | Soporte de claro y oscuro; el host `os.usefastlane.ai` fuerza oscuro con pre-pintado para evitar flash blanco. El clon debe evitar el mismo flash. | CONFIRMED |
| **NFR-022** | Observabilidad | Telemetría de cliente (identidad + memoria de arranque con heap), status page pública, y códigos de error estables y neutrales. | CONFIRMED |
| **NFR-023** | Privacidad | Los datos de un workspace no se mezclan entre workspaces, ni siquiera para el mismo usuario. El trial allowance sí se comparte entre workspaces personales (excepción documentada). | SUPPORTED |
| **NFR-024** | Cumplimiento de plataformas | Respetar disclosure de contenido IA, disclosure de partnership pagado, confirmación de uso de música de TikTok, y los límites de publicación de cada plataforma (con códigos diferenciados). | SUPPORTED |
| **NFR-025** | Escalabilidad de render | El render es server-side y cuellea; debe encolarse con límites por workspace (10 builds/min) y por usuario (10 generaciones de AI Studio en vuelo). | SUPPORTED/CONFIRMED |

---

# 18. Analytics & Events

> Se separan **eventos observados** (instrumentación evidenciada en el original) de **eventos recomendados** (necesarios para instrumentar los workflows y no evidenciados).

## 18.1 Observados

| Evento | Evidencia |
|---|---|
| `page_view` / navegación | PostHog presente (`Failed to set PostHog attribution properties:`) CONFIRMED |
| `engagement_page_visit` | `Failed to record engagement page visit:` CONFIRMED |
| `marketing_attribution_recorded` | `Failed to record marketing attribution:` CONFIRMED |
| `affiliate_attribution_bound` | `Affonso attribution binding failed:` CONFIRMED |
| `lead_marked_seen` | `Failed to mark leads as seen:` CONFIRMED |
| `lead_last_viewed_updated` | `Failed to update lead last viewed timestamp:` CONFIRMED |
| `startup_memory_checkpoint` | `__FASTLANE_STARTUP_MEMORY__` con heap CONFIRMED |
| `cancellation_feedback_submitted` | `Cancellation feedback submission failed:` CONFIRMED |

Contexto común (INFERRED a partir de la arquitectura): todo evento debe llevar `user_id`, `workspace_id`, `plan`, `subscription_status`, `is_trial`, `timestamp`, `surface` (`app` \| `api` \| `mcp`).

## 18.2 Recomendados (normativos para el clon)

### Onboarding
- `onboarding_started` — trigger: entra a `/onboarding`. props: `entry` (`signup` \| `additional_workspace`).
- `onboarding_source_submitted` — props: `source_type` (`website`\|`instagram`\|`tiktok`\|`x`\|`youtube`\|`linkedin`\|`other_url`\|`manual`), `input_form` (`url`\|`handle`\|`chip`), `used_description_fallback` (bool). **EXTENSION** — sustituye a `onboarding_website_submitted` y es el evento que permite medir si `EXT-001` funciona.
- `brand_source_resolved` — props: `source_type`, `detected_automatically` (bool), `needed_disambiguation` (bool).
- `brand_source_analysis_completed` — props: `source_type`, `tier` (`B_public_api`\|`C_page_fetch`\|`A_oauth`\|`D_assisted`), `duration_ms`, `status` (`ready`\|`partial`\|`failed`), `failure_reason?`, `items_analysed`, `ocr_ok`, `transcripts_ok` (sólo Fase 2), `fields_high`, `fields_medium`, `fields_low`. **Métrica clave de D-01:** la distribución de `tier` dice cuántas altas se resuelven sin OAuth. Si la cola de `D_assisted` es alta, la cobertura pública no alcanza y hay que revisar `OQ-19`.
- `brand_gap_question_answered` — props: `field`, `was_skipped` (bool).
- `brand_field_edited` — props: `field`, `previous_confidence`, `source_type`.
- `brand_source_added_post_signup` / `brand_source_reanalysed` / `brand_source_removed` — props: `source_type`, `sources_total`.
- `oauth_source_upgrade_offered` / `oauth_source_upgrade_accepted` — props: `platform`, `surface` (`onboarding`\|`settings`). El ratio entre ambos mide si la oferta post-análisis de D-04 funciona sin haber metido OAuth en el camino crítico.
- `own_posts_imported` — props: `platform`, `count`, `size_mb`, `truncated_by_quota` (bool).
- `onboarding_analysis_completed` — props: `duration_ms`, `success` (bool), `failure_reason?`.
- `onboarding_questionnaire_completed` — props: `role`, `team_size`, `business_model`, `categories[]`, `revenue_band`, `expectations[]`.
- `workspace_created` — props: `workspace_id`, `is_first`.
- `onboarding_completed` — props: `total_duration_ms`, `steps_skipped[]`.

### Integraciones
- `connection_started` — props: `platform`.
- `connection_completed` — props: `platform`, `account_type` (`business`\|`creator`\|`personal`), `scopes[]`.
- `connection_failed` — props: `platform`, `error_code`.
- `connection_expired_banner_shown` / `connection_reconnected` — props: `platform`, `days_since_connect`.

### Blitz (el bucle más importante)
- `blitz_opened` — props: `queue_depth`.
- `blitz_card_viewed` — props: `content_type`, `is_remix`, `has_influencer`, `angle_id`, `text_style_preset`.
- `blitz_why_this_content_opened`.
- `blitz_card_rejected` — props: `content_type`, `time_on_card_ms`, `input_method` (`swipe`\|`button`\|`keyboard`).
- `blitz_card_accepted` — props: idem + `swipes_remaining`.
- `blitz_edit_opened` / `blitz_edit_saved` — props: `changes[]` (`text`, `font`, `color`, `position`, `asset_swap`, `slide_added`, `slide_deleted`).
- `blitz_text_regenerated` — props: `had_prompt` (bool), `prompt_length`.
- `blitz_asset_swapped` — props: `asset_kind` (`video`\|`audio`\|`image`), `source` (`library`\|`own`).
- `blitz_quota_blocked` — props: `quota_type` (`swipes`\|`saves`), `reset_at`.
- `blitz_queue_empty_shown`.

### Contenido
- `content_build_started` — props: `content_type`, `origin` (`blitz`\|`studio`\|`api`\|`mcp`\|`automation`), `content_id`.
- `content_build_completed` — props: `content_id`, `duration_ms`, `status` (`CREATED`\|`FAILED`), `failure_reason?`.
- `content_saved_to_library` / `content_deleted`.
- `studio_format_opened` — props: `format_id`.
- `studio_generate_clicked` — props: `format_id`, `mode` (`remix`\|`create_new`), `mention_business`, `has_prompt`, `style?`.
- `media_uploaded` — props: `media_type`, `size_mb`, `categories[]`.

### Publicación
- `schedule_flow_started` — props: `origin` (`blitz`\|`studio`\|`library`).
- `platforms_selected` — props: `platforms[]`, `account_types[]`.
- `caption_ai_action` — props: `action` (`improve`\|`regenerate`), `platform`, `field`.
- `post_scheduled` — props: `post_id`, `platform`, `account_type`, `lead_time_minutes`, `posting_mode?`, `privacy_level?`, `ai_disclaimer`, `disclose_as_ads`.
- `post_published` — props: `post_id`, `platform`, `delay_from_scheduled_ms`.
- `post_failed` — props: `post_id`, `platform`, `error_code`.
- `post_cancelled` / `post_rescheduled` / `post_deleted`.
- `tiktok_slow_lane_detected` — props: `post_id`, `hours_pending`.

### Influencers y AI Studio
- `influencer_wizard_started` / `influencer_base_image_generated` (props: `credits_spent`, `duration_ms`) / `influencer_base_image_regenerated` / `influencer_created` (props: `credits_spent: 250`) / `influencer_ready` (props: `training_duration_ms`) / `influencer_failed`.
- `influencer_image_generated` — props: `credits_spent`, `has_template`, `model`.
- `influencer_video_generated` — props: `credits_spent`, `duration_s`, `model`.
- `talking_head_generated` — props: `script_words`, `duration_s`, `language`, `caption_overlay`.
- `ai_studio_generation_started` / `ai_studio_blocked` — props: `reason` (`credits`\|`plan`\|`in_flight_limit`\|`content_filter`).

### Automations
- `automation_created` / `automation_configured` (props: `accounts_count`, `per_account_per_day`, `duration_weeks`) / `automation_generation_started` / `automation_review_reached` (props: `slots_ready`, `slots_failed`) / `automation_slot_edited` / `automation_slot_rerolled` / `automation_launch_blocked` (props: `gate`) / `automation_launched` (props: `slots_reserved`, `content_budget_spent`) / `automation_cancelled`.

### Engagement
- `reddit_connected` / `subreddits_configured` (props: `count`) / `leads_discovered` (props: `count`) / `lead_opened` / `ai_reply_generated` / `ai_reply_regenerated` / `reply_posted` / `ban_meter_refreshed` (props: `level`, `promo_ratio`).

### Monetización
- `paywall_shown` — props: `trigger` (`quota`\|`feature`\|`plan_gate`), `feature`.
- `upgrade_clicked` / `checkout_started` / `subscription_activated` (props: `plan`, `mrr`) / `credits_purchased` (props: `quantity`) / `saves_purchased` / `warmed_account_purchased` / `cancellation_started` / `subscription_cancelled` (props: `reason`).

### Judgment layer (EXT-008)
- `judgment_requested` — props: `decision_point` (`DP-001`…`DP-007`), `adapter` (`llm`\|`jev`\|`stub`), `model`, `input_tokens`, `state_size_bucket`.
- `judgment_completed` — props: idem + `latency_ms`, `confidence_bucket` (`high`\|`medium`\|`low`), `fell_back` (bool). **`latency_ms` por adaptador es el dato que falta para decidir con hechos**: ningún proveedor de juicio publica cifras de latencia verificables.
- `judgment_low_confidence` — props: `decision_point`, `confidence`, `action_taken` (`escalated_human`\|`fallback_rule`\|`fallback_llm`\|`default_value`).
- `judgment_overridden_by_user` — props: `decision_point`, `predicted`, `corrected`. **Es la fuente de verdad para medir calidad real en producción**, y con el tiempo el dataset para ajustar umbrales.
- `preflight_blocked_post` / `preflight_warned` — props: `platform`, `policy_risk`, `user_action` (`edited`\|`published_anyway`\|`abandoned`). Mide si `JV-3` ayuda o estorba.

### API / MCP
- `api_key_created` / `api_key_revoked` / `api_request` (props: `endpoint`, `status`, `surface`) / `mcp_tool_called` (props: `tool`, `server` (`oauth`\|`api_key`), `status`).

### North-star y funnel
- **North star sugerido:** *posts publicados por workspace y semana*.
- **Funnel de activación:** `onboarding_started` → `onboarding_source_submitted` → `brand_source_analysis_completed` → `workspace_created` → `connection_completed` → `blitz_card_accepted` → `post_scheduled` → `post_published`.
- **Métrica que decide si `EXT-001` valió la pena:** tasa de activación **segmentada por `source_type`**. La hipótesis es que el segmento sin web (`instagram`/`tiktok`) hoy no existiría; si su activación es comparable a la de `website`, la extensión está cumpliendo su función. Si es mucho peor, el problema está en la calidad del perfil derivado, no en el alta — y se mide con `fields_low` y `brand_field_edited`.

---

# 19. Error & Empty States

> Copy literal del original entre comillas. Cada estado indica qué puede hacer el usuario.

## 19.1 Empty states

| ID | Contexto | Copy | Acción del usuario |
|---|---|---|---|
| ERR-E01 | AI Studio sin generaciones | `No generations yet. Start generating with a prompt below.` | escribir un prompt |
| ERR-E02 | Inspiration sin resultados | `No results` + *"Try a different search or clear your filters."* | limpiar filtros / otra búsqueda |
| ERR-E03 | Inspiration no disponible aún | `Inspiration is being set up` + *"The library is not available yet. Check back soon."* | esperar |
| ERR-E04 | Media Bank vacío | `No images uploaded yet` | subir archivos |
| ERR-E05 | Sin posts | `No posts` | crear contenido |
| ERR-E06 | Sin imágenes disponibles en picker | `No available images.` | subir o cambiar filtro |
| ERR-E07 | Sin audio | `No audio` | elegir una pista |
| ERR-E08 | Leads sin resultados | *"Try adjusting your filters or fetch new leads to discover conversations where your audience is seeking solutions."* | ajustar filtros / refrescar |
| ERR-E09 | Sin cuentas warmed | ⚠️ **copy incompleto** — `<N> accounts yet` / `<...> account in Settings or buy a warmed account.` El comienzo de la descripción se perdió en la captura y **no se reconstruye acá**: inventarlo lo haría indistinguible del copy verificado. Quien lo implemente usa un texto propio y lo marca como tal. | comprar o conectar |
| ERR-E10 | Sin otros workspaces | `No other workspace available` | crear workspace |
| ERR-E11 | Blitz con cola vacía | (API `404 not_found`) — *"discovery queue has no ready items yet. Try again shortly."* | esperar / forzar un tipo |
| ERR-E12 | **EXTENSION** — sin Brand Sources en `/brand` | `No sources yet. Add your website or a social profile so we can learn your brand.` | `+ Add source` |
| ERR-E13 | **EXTENSION** — perfil social sin contenido suficiente | `@<handle> doesn't have enough posts yet. Add another source or describe your brand.` | añadir fuente / rama manual |

## 19.2 Loading states

| ID | Contexto | Copy / patrón |
|---|---|---|
| ERR-L01 | Studio generando | `Generating your content...` + spinner; botón `Generating...` deshabilitado |
| ERR-L02 | Blitz/Studio cargando trending | `Loading...` + spinner |
| ERR-L03 | Analytics | skeletons + `Loading lifetime post breakdowns` |
| ERR-L04 | Lead | `Loading lead...` |
| ERR-L05 | Inspiration video | `Preparing video` |
| ERR-L06 | Onboarding | `Analyzing company profile...` → `Processing with AI...` → `Creating Workspace...` → `Setting up your workspace...` → `Preparing workspace` → `Completing Setup...` |
| ERR-L07 | Cambio de workspace | `Switching workspace...` |
| ERR-L08 | Content Details generando captions | spinner inline por campo |
| ERR-L09 | AI Studio lento | *"Taking longer than expected. We'll keep working in the background."* |
| ERR-L10 | Slideshow en cola | `Slideshow preparation is waiting to start.` |

## 19.3 Errores genéricos

`Something went wrong` · `Something went wrong while preparing your content. Please try again.` · `Something went wrong with this run. Please try again.` · `Try Again` / `Try again`.

## 19.4 Unauthorized / not found

| ID | Copy | Acción |
|---|---|---|
| ERR-U01 | `Access Denied` + *"You don't have permission to view this lead. It may belong to another account."* | volver a la lista |
| ERR-U02 | `Lead Not Found` + *"This lead may have been deleted or is no longer available."* | volver |
| ERR-U03 | `Workspace Unavailable` + *"The workspace containing this lead has been deleted."* | cambiar de workspace |
| ERR-U04 | `No company selected` | seleccionar workspace |
| ERR-U05 | `We couldn't find this influencer. It may have been deleted.` | volver a la lista |
| ERR-U06 | API: `{"error":{"code":"unauthorized","message":"Invalid or revoked API key"}}` + `WWW-Authenticate` | regenerar key |

## 19.5 Integraciones desconectadas / credenciales expiradas

| ID | Copy | Acción |
|---|---|---|
| ERR-D01 | `Connection Expired` | reconectar |
| ERR-D02 | `Paused: reconnect needed` | reconectar |
| ERR-D03 | `Permissions Missing` / `Reconnect to upgrade permissions` | reconectar aprobando todos los permisos |
| ERR-D04 | `You declined a permission Fastlane needs. Please try again and approve all requested permissions.` | reintentar |
| ERR-D05 | `TikTok permissions are missing. Please disconnect and reconnect your account.` | desconectar + reconectar |
| ERR-D06 | `Connected Account Changed` / `A different Instagram account was connected. Open the connect flow again and choose the matching account.` | reconectar la cuenta correcta |
| ERR-D07 | `LinkedIn connections last 60 days. Reconnect to keep posting without interruption.` | reconectar |
| ERR-D08 | `No active Reddit connection` | conectar Reddit |
| ERR-D09 | `Couldn't load TikTok posting options. Reconnect TikTok in Settings, or retry.` | reconectar o reintentar |
| ERR-D10 | `Instagram connections are temporarily unavailable. Please try again later.` | esperar |
| ERR-D11 | `We could not confirm the connection yet. Refresh the page to retry, or contact support if this keeps happening.` | refrescar |
| ERR-D12 | `Connecting isn't available right now.` | reintentar |
| ERR-D13 | `Connection limit reached` | desconectar otra o subir de plan |
| ERR-D14 | `Private Account Required` / `Direct posting requires a private TikTok account. Your post was sent to your inbox instead.` | publicar desde el inbox |
| ERR-D15 | `Re-connect to enable direct posting with captions. Your current connection only supports inbox uploads.` | reconectar |
| ERR-D16 | `The selected privacy level is not available for your account. Your post was sent to your inbox instead.` | usar inbox o cambiar privacidad |

## 19.5.1 Brand Sources (EXTENSION)

| ID | Copy | Acción |
|---|---|---|
| ERR-B01 | `Add a website or a social profile to continue` | introducir una fuente o usar la rama manual |
| ERR-B02 | `We couldn't tell what this is. Paste a website URL or a social profile link.` | corregir la entrada |
| ERR-B03 | `Which platform is @<handle> on?` | elegir plataforma en el desambiguador |
| ERR-B04 | `We couldn't find @<handle> on <Platform>. Check the spelling.` | corregir el handle |
| ERR-B05 | `@<handle> is private, so we can't read it. Connect the account or paste your bio instead.` | conectar por OAuth (tier A) o rama asistida (tier D) |
| ERR-B06 | `This profile is already connected to another workspace.` | usar otra fuente o el otro workspace |
| ERR-B07 | `<Platform> isn't responding right now. Try again in a few minutes or add a different source.` | reintentar / otra fuente |
| ERR-B08 | `We're reading a lot of profiles right now. We'll keep trying in the background.` | esperar (no bloquea) |
| ERR-B09 | `We got the basics but not much else. A couple of quick answers will fix that.` | responder las preguntas de cierre de huecos |
| ERR-B10 | `You can analyse up to 5 sources per workspace.` | eliminar una fuente |
| ERR-B11 | `You've refreshed this source recently. Try again in <N> hours.` | esperar |
| ERR-B12 | `We'll analyse the whole @<handle> profile, not just that post.` (aviso, no error) | continuar |
| ERR-B13 | `Your posts cover a lot of ground. Tell us which part is the business.` | acotar el foco |
| ERR-B14 | `This source suggests a different answer — replace?` | aceptar o conservar la edición manual |

**Principio rector de todos estos estados:** ninguno bloquea el alta. Como mucho degradan al tier D y piden ayuda concreta. El coste de perder a alguien en el paso 1 del onboarding es mayor que el de arrancar con un perfil de marca imperfecto y corregirlo después.

## 19.6 Fallos de procesamiento

| ID | Copy / código | Acción |
|---|---|---|
| ERR-P01 | Content `FAILED` | borrar y reintentar; el save se reembolsa |
| ERR-P02 | `409 content_still_building` (< 15 min) | esperar; pasados 15 min se puede borrar para recuperar |
| ERR-P03 | `409 content_edit_in_progress` | esperar a que termine |
| ERR-P04 | `409 stale_revision` | recargar la representación editable |
| ERR-P05 | `422 content_not_editable` | tipo/origen no soportado |
| ERR-P06 | `409 content_has_linked_posts` | borrar los posts vinculados (cancelar no basta) |
| ERR-P07 | `422 content_unavailable_for_type` | elegir otro tipo o subir un demo video |
| ERR-P08 | `409 company_profile_not_ready` | completar el perfil en Brand |
| ERR-P09 | `No content files were found. Please try scheduling again.` | reprogramar |
| ERR-P10 | `Could not prepare the training set. Please try again.` | reintentar |
| ERR-P11 | `We couldn’t read this video’s details. Try re-exporting it as MP4 or choose another file.` | reexportar |
| ERR-P12 | `Slideshow preparation is waiting to start.` | esperar |

## 19.7 Fallos parciales

| ID | Situación | Comportamiento |
|---|---|---|
| ERR-F01 | Batch de cancel/delete con un id inválido | **Todo o nada**: no se cancela/borra nada; `details.failures` con motivo por id (`not_found`, `not_cancellable_status:<status>`, `invalid_id`, `past_cutoff`, `cancellation_pending`, `provider_operation_in_progress`, `past_submit_cutoff`, `task_lookup_truncated`, `task_running`) |
| ERR-F02 | Analytics batch con ids desconocidos | Éxito parcial: `{"_id":"…","notFound":true}` por id; ids malformados **sí** fallan toda la request con `invalidIds` |
| ERR-F03 | Layer de media no resoluble en preview | `status: "unavailable"` sin URL; el resto de la respuesta sigue usable |
| ERR-F04 | Manifest legacy no parseable | Se omite `media`, se mantienen `canvas` y texto editable |
| ERR-F05 | Limpieza de R2 fallida | Se loguea, no bloquea el borrado de la fila; objetos huérfanos aceptados |
| ERR-F06 | Automation con slots `FAILED_GEN` | La campaña continúa con menos posts; no se sustituye el tipo |

## 19.8 Rate limits y cuotas

| ID | Código | Copy / detalles | Acción |
|---|---|---|---|
| ERR-R01 | `429 rate_limited` | `API rate limit exceeded` + `Retry-After` + `details.retryAfterMs` | esperar |
| ERR-R02 | `429 blitz_quota_exceeded` | `Daily blitz swipe limit reached` + `details.resetAt` | esperar al reset o subir de plan |
| ERR-R03 | `429 content_quota_exceeded` | `Monthly content quota reached for your plan` + `count`, `limit`, `resetAt` | comprar saves / activar overage / subir de plan |
| ERR-R04 | Trial agotado | `Trial content allowance reached` (**sin** `resetAt`) | upgrade |
| ERR-R05 | `tiktok_post_limit_exceeded` / `youtube_post_limit_exceeded` / `instagram_post_limit_exceeded` | límite de la plataforma | reprogramar |
| ERR-R06 | `503 service_unavailable` | el límite no pudo comprobarse — **no** significa cuota agotada | reintentar |
| ERR-R07 | `You have 10 generations in flight. Wait for some to finish before starting another.` | AI Studio | esperar |
| ERR-R08 | `Not enough credits. Top up or upgrade to continue.` / `Not enough credits to generate the remaining images.` | créditos | recargar |

## 19.9 Estados de billing / plan

`Plan content limit reached` · `This content isn't included in your plan.` · `Some items are not included in your plan` · `Your content is view-only. Upgrade to create and publish again.` · `Requires a Site plan` · `Limited scheduling` · `Limited total content` · `Save unlimited content to your library` · `Upgrade to unlock`.

## 19.10 Media en uso

`409 media_in_use` — *"the asset is still referenced. Remove the dependency or delete the content before retrying."* Acción: borrar el contenido dependiente o desvincular el influencer.

---

# 20. Feature Dependency Map

```
NIVEL 0 — Identidad
  Authentication (Clerk/SSO)
      │
NIVEL 1 — Tenencia
  └─> Workspace / Company
         ├─> Roles & membership
         └─> Plan & Quotas (content saves · swipes · credits · storage · slots)
                │
NIVEL 2 — Conocimiento de marca
  └─> Brand Sources  (website | instagram | tiktok | x | youtube | linkedin | other_url | manual)   [EXT-001]
         │   tier A usa la Connection OAuth del NIVEL 3 cuando existe (dependencia opcional, no bloqueante)
         └─> Brand analysis (AI-016) ──> Company Profile (brandRevision + fieldMeta)
         ├─> Content Angles ──────────────────────┐
         └─> Blitz Preferences                    │
                │                                 │
NIVEL 3 — Insumos de media                        │
  ├─> Social Connections (OAuth) ────────┐        │
  ├─> Warmed Accounts (compra + warming) ─┤        │
  ├─> Media Bank (uploads + categorías)  │        │
  │      └─> Media Sets                  │        │
  ├─> Shared Audio Library (global)      │        │
  ├─> Trending Library (global)          │        │
  └─> Influencers (créditos → training)  │        │
         └─> Influencer Config ──────────┼────────┘
                │                        │
NIVEL 4 — Generación                     │
  └─> Discovery Queue (usa perfil + ángulos + prefs + media + influencers + trending)
         ├─> Blitz (swipe)               │
         ├─> Content Studio (manual)     │
         ├─> AI Studio (libre)           │
         └─> Automations (campañas)      │
                │                        │
NIVEL 5 — Artefacto                      │
  └─> Content (BUILDING → CREATED/FAILED)│
         └─> Content editing / regeneration
                │                        │
NIVEL 6 — Distribución                   │
  └─> Scheduling ──────────────────────> Post ──> Connection | WarmedAccount
         ├─> Calendar
         └─> Library (My Posts)
                │
NIVEL 7 — Medición
  └─> Metrics sync ──> Analytics ──> (realimenta Blitz Preferences)
         └─> Website analytics / Ad attribution

RAMA PARALELA — Adquisición
  Social Connections (Reddit) ──> Engagement
         ├─> Lead Discovery ──> AI replies ──> Thread monitoring
         └─> Ban risk meter (gobierna el volumen de respuestas)

RAMA PARALELA — Programabilidad
  Workspace ──> API Keys ──> REST API v1
                      └────> MCP API-key server (34 tools, incl. Automations)
  Workspace owner (paid) ──> MCP OAuth connector (8 tools, read + drafts)
```

## Dependencias duras (bloqueantes)

| Feature | Requiere | Si falta |
|---|---|---|
| Blitz | Company Profile listo | `409 company_profile_not_ready` |
| Company Profile | **≥ 1 Brand Source** (`website`, social o `manual`) — EXTENSION | el onboarding no puede completarse |
| Brand Source tier A | Connection OAuth de esa plataforma | degrada a tier B/C/D, nunca bloquea |
| Importar posts al Media Bank | Brand Source tier A + cuota de storage | la opción no se ofrece |
| Blitz con influencer | Influencer `ready` + activo + tipo compatible | fallback a contenido regular |
| `video-hook` | Demo video en el workspace | `422 content_unavailable_for_type` / `AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO` |
| Scheduling | ≥1 conexión activa en la plataforma | `400 connection_ambiguous` o bloqueo |
| TikTok direct posting | Entitlement `tiktokDirect` + `privacy_level` + cuenta no privada | `403 forbidden` / cae al inbox |
| Caption generation | Entitlement `autoCaptions` | `402 payment_required` |
| Warmed scheduling | Cuenta aprobada, `postable`, slots disponibles, lead time respetado | `409 conflict` / `402 payment_required` |
| Automations | Feature liberada + plan que la incluya | `forbidden` |
| YouTube en automation | `slideshowWeight = 0` | generación bloqueada |
| MCP OAuth connector | Owner de pago de workspace directo | acceso denegado |
| AI Studio | Plan que lo incluya + créditos | bloqueo con CTA |
| Engagement | Conexión de Reddit | `No active Reddit connection` |
| Borrar contenido | Sin posts vinculados | `409 content_has_linked_posts` |
| Borrar media | Sin referencias activas | `409 media_in_use` |

---

# 21. Implementation Phases

> Las fases se derivan del mapa de dependencias, no de una estimación arbitraria de esfuerzo. **No se reduce scope**: la Fase 5 cierra la paridad completa.

## Phase 1 — Foundation (arquitectura imprescindible)
1. Autenticación (email/password + SSO) y sesiones.
2. Modelo multi-workspace con aislamiento estricto por `companyId` y `404` en acceso cruzado.
3. Roles owner/member y comprobación server-side de permisos.
4. Motor de cuotas: content saves (incluidos/comprados/overage), daily swipes con reset 00:00 UTC, créditos, storage, slots.
5. Storage de objetos + patrón de subida en 3 fases (reserva → PUT → finalización) con límites y normalización de media.
6. Cola de trabajos y workers con estado consultable; contrato de polling.
7. Envelope de API (`data` / `error` / `pagination`), cursores, idempotencia, rate limiting con `Retry-After`.
8. Onboarding completo con Company Profile (`FR-010`, `FR-020`) y **Brand Sources multi-origen (`FR-011`, EXT-001)**, según las decisiones cerradas de §2.7:
   - **D-02** — los **cinco** extractores sociales (Instagram, TikTok, X, YouTube, LinkedIn) más `website`, `other_url` y `manual`. Nada de extractores diferidos.
   - **D-01** — orden de resolución B → C → A → D. **El signup no pide OAuth.** El tier C se construye detrás de un flag apagado, pendiente de `OQ-16`.
   - **D-03** — texto + **OCR**. El ASR se difiere a Fase 2.
   - **D-04** — importación opt-in de posts propios al Media Bank, ofrecida **después** del análisis.
   - Además: detección automática de plataforma, síntesis con `fieldMeta` (confianza + origen + extracto), preguntas de cierre de huecos y pantalla de revisión.
   - Pueden diferirse a Fase 2: multi-source con fusión y precedencia, gestión de fuentes en `/brand` y staleness a 90 días.

   > **Nota de dimensionamiento.** D-02 + D-04 cargan la Fase 1 de forma apreciable: cinco extractores, OCR, e importación de media con sus cuotas de storage. Si hay que recortar para llegar a un primer release, lo que menos duele es reducir el número de extractores — el resto de la extensión no depende de cuántas plataformas haya, sólo de que haya al menos una.
9. Layout de la app: sidebar, rutas, tema claro/oscuro sin flash, responsive.
10. Observabilidad: logs estructurados, telemetría de cliente, status page.
11. **Puerto `Judgment` (EXT-008, D-05)** — §9.15. Sólo la interfaz, el `LlmJudgmentAdapter` y el `StubJudgmentAdapter`, más `DATA-033`. **Ninguna feature de juicio todavía.** Entra en Fase 1 porque declararlo ahora cuesta un archivo y retrofitearlo después es una refactorización transversal; y porque obliga a enumerar las taxonomías de §25 antes de escribir el código que las consume.

**Criterio de salida:** un usuario nuevo se registra, introduce **una URL de web o un perfil de Instagram/TikTok**, obtiene un Company Profile y entra a un dashboard vacío pero funcional. El camino social debe completarse **sin pedir en ningún momento una URL de sitio web**.

## Phase 2 — Core Product (el bucle que define el producto)
1. Content Angles (CRUD + caps + auto-reconcile de pesos) y generador asistido de ángulos.
2. Blitz Preferences completas (`FR-055`) con todas las reglas de validación.
3. Discovery queue con relleno en background y objetivo de ~5 items.
4. Motor de render server-side de los **4 formatos base** (slideshow, wall-of-text, green-screen, video-hook) con el contrato de payload de §6.
5. Blitz: deck, swipe, teclado, `Why This Content?`, `Remixed From`, mute.
6. Editor inline completo (`FR-051`) con concurrencia optimista por `revision`.
7. Content Studio para los 4 formatos, en modos Remix y Create New, con los modales `Select Video`, `Select Audio`, `Swap image for slide N`.
8. Library: `My Posts`, `My Content`, `My Media Bank` con Sets y categorías.
9. Calendar mensual con chips y contadores.
10. Trending/Inspiration: ingestión propia del catálogo, búsqueda, filtro por nicho, remix.
11. **EXT-001, resto:** **ASR** (D-03, `INT-015`); multi-source con fusión y precedencia; gestión de fuentes en `/brand`; staleness a 90 días; reutilización de cuentas OAuth como fuente desde `Settings` (`FR-011.5`).
12. **Judgment layer, primeras features (§25):** `JV-1` (clasificador del catálogo — desbloquea `F-041`, prerequisito de Inspiration y de la cola de Blitz) y `JV-4` (verificador de campos de marca — hace verificable la regla *"nunca inventar"* de `AI-016`). Ambas corren con `LlmJudgmentAdapter`; el experimento de §25.4 decide si alguna pasa a otro adaptador.

**Criterio de salida:** el usuario aprueba una pieza en Blitz y la guarda en Library; crea otra a mano en el Studio.

## Phase 3 — Integrations & Automation (distribución real)
1. OAuth de TikTok, Instagram, YouTube, LinkedIn y Reddit, con multi-cuenta, estados de conexión y reconexión.
2. Flujo de scheduling de 3–4 pasos con opciones nativas por plataforma (`FR-060`).
3. Worker de publicación, máquina de estados de `Post` completa, watcher de TikTok de 72 h, `AWAITING_RECONNECT`.
4. Sincronización de métricas y Analytics (`FR-120`).
5. Website analytics script y atribución.
6. Warmed Accounts: compra, configuración, aprobación, slots, lead times, disponibilidad, reemplazos.
7. Automations completas: wizard, generación, review, re-roll, `launchValidation`, launch, monitorización, cancel/delete.
8. Batch cancel/delete atómicos y analytics por lote.

**Criterio de salida:** un post creado en Fastlane aparece publicado en TikTok e Instagram y sus métricas vuelven al dashboard.

## Phase 4 — Advanced Features
1. Influencers completo: wizard de 3 pasos, training asíncrono, galerías de imagen y video, `Animate`, Talking Head UGC, Configuration, caps y créditos.
2. AI Studio con referencias, filtros de contenido y límite de generaciones en vuelo.
3. Los **17 formatos IA adicionales** del catálogo (claymation, lego, felt, skeleton, news anchor, street interview, talking objects, product spokesperson, character swap, etc.).
4. Engagement: conexión de Reddit, discovery configurable, scoring, respuestas IA con reglas, monitorización de hilos, ban risk meter.
5. Billing completo: planes, upgrades/downgrades prorrateados, compra de créditos/saves/posts, cancelación con feedback, portal.
6. API REST v1 completa + gestión de API keys + API overage billing.
7. Servidor MCP con API key (34 tools) y connector OAuth (8 tools, scopes y confirmaciones).
8. **EXT-001, avanzado:** activación del tier C de extracción, si la revisión legal de `OQ-16` lo habilita. *(La importación de posts al Media Bank se adelantó a Fase 1 por D-04.)*
9. **Judgment layer, resto (§25):** `JV-2` (scoring de leads — desbloquea el motor de `FR-140`), `JV-5` (tono de respuesta → ban meter), `JV-3` (pre-flight de publicación, EXT-007) y `JV-6` (rerank marca↔candidato, requiere `JV-1`).

**Criterio de salida:** un agente externo crea y publica contenido vía MCP; un influencer entrenado aparece en Blitz.

## Phase 5 — Functional Parity
1. Centro de notificaciones con preferencias por categoría y canal.
2. Invitaciones y gestión de miembros con matriz de permisos.
3. Refer & Earn, Guide, Roadmap, Changelog, Feedback, Status.
4. Audit log de acciones destructivas y facturables.
5. Accesibilidad WCAG 2.1 AA completa, incluida alternativa no-gestual al swipe.
6. Responsive pulido en móvil y tablet.
7. Suite de eventos de analytics de §18.
8. Todos los estados de error/vacío de §19 con su copy exacto.
9. Multi-language content (feature de plan Pro).
10. Human UGC library (2 000+ videos humanos) y AI UGC character library (1 000+ personajes preconstruidos) — requieren estrategia propia de contenido licenciado.
11. Partner API (si se quiere revender).

**Criterio de salida:** la Parity Matrix de §23 no tiene filas sin cubrir.

---

# 22. Traceability Matrix

| ID | Feature | Source | Evidence | Confidence |
|---|---|---|---|---|
| F-001..003 | Auth (signup/login/logout) | Fastlane app | rutas `/signup`, `/login`, `/logout`, `/auth/sso-callback`; chunk `clerkTheme` | CONFIRMED |
| F-004..010 | Onboarding con análisis de website | Fastlane app | `OnboardingPage-CkGMzzCf.js`: `Analyse Website`, `Analyzing company profile...`, cuestionario completo | CONFIRMED |
| **F-012..017** | **Brand Sources: alta desde perfil social** | — | **Ninguna.** Verificado por búsqueda dirigida en `OnboardingPage-CkGMzzCf.js` y en el corpus de ~1.300 strings de UI: Fastlane sólo acepta `Company Website` y ofrece `Use description instead` como único fallback. No hay ninguna traza de handles, perfiles sociales ni análisis de redes en el alta. | **EXTENSION** (decisión de producto del clon) |
| **F-024..026** | **Gestión de fuentes, trazabilidad por campo, staleness** | — | Idem | **EXTENSION** |
| **DATA-031/032** | `BrandSource`, `BrandSourceSnapshot` | — | Idem | **EXTENSION** |
| **AI-016** | Extracción de identidad desde social | — | Idem | **EXTENSION** |
| **INT-014..018** | Lectura social, ASR, OCR, page fetch, link-in-bio | — | Idem | **EXTENSION** |
| F-011 | Borrado de cuenta | Fastlane app | `Permanently delete your account?`, `Account deletion is already in progress.` | CONFIRMED |
| F-020..021 | Company Profile | docs/features/demo/6-calendar-library.mp4 | 01:21–01:35 (`/profile`, secciones `CORE IDENTITY`…`PROBLEM SOLUTION`, `Edit`) | CONFIRMED |
| F-022 | brandRevision | developers.usefastlane.ai | Endpoints → `POST /blitz/angles/generate` | SUPPORTED |
| F-030..033 | Home KPIs / Tasks / Views History | docs/features/demo/6-calendar-library.mp4 | 01:12–01:20 | CONFIRMED |
| F-034 | Trending Content en Home | docs/features/demo/compressed-intro-homepage-guide.mov | 01:21–01:27 | CONFIRMED |
| F-035..036 | Performance + Weekly Posts (legacy) | docs/features/demo/compressed-intro-homepage-guide.mov | 00:09–00:27 | CONFIRMED |
| F-037 | Home FAQ | docs/…/compressed-intro-homepage-guide.mov + `Home-DaV293aW.js` | 02:06–02:27; strings de preguntas | CONFIRMED |
| F-040..045 | Inspiration | Fastlane app | `InspirationPage-D3IUSAN0.js`: `Search inspiration`, `Filter by niche`, `Remix this`, `Updated daily` | CONFIRMED |
| F-050 | Discovery queue | developers.usefastlane.ai | Endpoints → `POST /api/v1/blitz` ("How the queue works") | SUPPORTED |
| F-051..057 | Blitz deck y controles | docs/features/demo/compressed-blitz-guide.mov | 00:03 (tarjeta, X/Edit/Unmute/✓, `Wall of Text`, `Why This Content?`, `Remixed From`) | CONFIRMED |
| F-054 | Chips de influencer y ángulo | docs/features/demo/7-ai-influencers.mp4 | 05:42 (`Slideshow` · `👤 Ella` · `One Idea, Everywhere`) | CONFIRMED |
| F-055 | Why This Content | docs/features/demo/compressed-blitz-guide.mov | 00:21 (bullets de explicación) | CONFIRMED |
| F-058..061 | Editor inline | docs/features/demo/compressed-blitz-guide.mov | 01:24–02:21 (`ASSETS`, `MENTION YOUR BUSINESS?`, `PROMPT`, `Regenerate Text`, panel de texto) | CONFIRMED |
| F-058 | Editor de slideshow (Add Text/Slide) | docs/features/demo/7-ai-influencers.mp4 | 06:03 (`Apply to all text boxes`, `Add Text`, `Add Slide`, `Delete Slide`) | CONFIRMED |
| F-061 | Modal `Select Video` | docs/features/demo/compressed-blitz-guide.mov | 01:24 (tabs `Library`/`My Videos`, chips, `Page 1 of 2`) | CONFIRMED |
| F-062 | Preferences drawer (legacy) | docs/features/demo/compressed-blitz-guide.mov | 02:30 (`CONTENT TYPES`, `REMIX RATIO`, `Mention Business`, `Save Preferences`) | CONFIRMED |
| F-063 | Blitz Settings | docs/features/demo/7-ai-influencers.mp4 | 04:51 (`INFLUENCER FREQUENCY`, `Voice & angles`, `Visual sources`, `Content mix`) | CONFIRMED |
| F-064..065 | Save to Library / Schedule Post | docs/features/demo/compressed-blitz-guide.mov | 02:54 (`What would you like to do?` `Step 1 of 3`) | CONFIRMED |
| F-066..068 | Cuotas y overrides de Blitz | developers.usefastlane.ai | Endpoints `POST /blitz`; Rate limits | SUPPORTED |
| F-070 | Catálogo de 22 formatos | Fastlane app | `AppRoot.js`: objetos `{id,label,description,path}` | CONFIRMED |
| F-071..077 | Studio wizard y preview | docs/features/demo/5-slideshows.mp4 | 00:00 (wizard), 00:12 (`3 / 72`), 00:39 (preview + inspector), 01:15 (`Swap image for slide 2`) | CONFIRMED |
| F-078 | Wall-of-text styles | docs/features/demo/3-wall-of-text.mp4 | 01:42 (`Select a style`), 02:18 (`Storytime`) | CONFIRMED |
| F-079 | Demo video + guía de grabación | docs/features/demo/4-hook-demo.mp4 | 00:06 (`Select your demo video`, `Need help recording? See how ↗`) | CONFIRMED |
| F-080 | Modal `Select Audio` | docs/features/demo/4-hook-demo.mp4 | 01:12 (lista de pistas) | CONFIRMED |
| F-081..082 | Save / Schedule desde Studio | docs/features/demo/2-green-screen.mp4 | 03:24 (`Save`, `Schedule`), 05:18 (`Schedule` `Step 3 of 3`) | CONFIRMED |
| F-083 | Custom upload | developers.usefastlane.ai | `POST /content/custom/video/upload-url` + `/content/custom/video` | SUPPORTED |
| F-090..095 | Influencers list + wizard | docs/features/demo/7-ai-influencers.mp4 | 00:00 (lista), 00:15 (1/3), 00:48 (2/3), 01:21 (3/3, 250 credits, 15–20 min) | CONFIRMED |
| F-096..100 | Imágenes y videos de influencer | docs/features/demo/7-ai-influencers.mp4 | 01:51 (prompt bar, 4 credits), 02:18 (drawer: `Fastlane V8`, `Animate`), 02:36 (`Kling v3 Pro`, 60 credits, 5s/10s) | CONFIRMED |
| F-101..104 | Influencer Configuration | docs/features/demo/7-ai-influencers.mp4 | 03:18 (`Content angles`, `Publishing accounts`, `Slideshow sets`, `Video sets`) | CONFIRMED |
| F-110..115 | AI Studio | Fastlane app | `AiStudioPage-QwhtlWM8.js` (strings de créditos, filtros, límite de 10) | CONFIRMED |
| F-120..124 | Library My Posts / My Content | docs/features/demo/6-calendar-library.mp4 | 00:21 (`My Posts`, `Refresh Metrics`, `101 posts`), 00:27 (`My Content`, `78 items`) | CONFIRMED |
| F-123 | Reschedule / Cancel | docs/features/demo/2-green-screen.mp4 | 05:45 | CONFIRMED |
| F-125..130 | Media Bank | docs/features/demo/7-ai-influencers.mp4 | 06:15 (`My Media Bank`, `YOUR SETS`, dropzone, `41 items`) | CONFIRMED |
| F-129 | Categorías de media | developers.usefastlane.ai | `POST /media` (lista de categorías válidas por tipo) | SUPPORTED |
| F-140..143 | Calendar | docs/features/demo/6-calendar-library.mp4 | 00:00 (mes, chips por plataforma, contadores ✓/📥/📅) | CONFIRMED |
| F-150..152 | Select Platforms + posting mode | docs/features/demo/5-slideshows.mp4 | 01:36 (`Select Platforms` `Step 1 of 2`, `Send to Inbox`/`Post Directly`) | CONFIRMED |
| F-153..155 | Content Details multi-plataforma | docs/features/demo/7-ai-influencers.mp4 | 07:09 (IG `Caption 0/2200`, TikTok `Title 0/90`, `Description 0/4000`, `Privacy Level`, `Auto-Add Music`) | CONFIRMED |
| F-156 | Date & time picker | docs/features/demo/compressed-blitz-guide.mov | 03:30 (`Select Time`, `Select Date`) | CONFIRMED |
| F-158..163 | Opciones avanzadas de publicación | developers.usefastlane.ai | `POST /content/:id/schedule` (body completo) | SUPPORTED |
| F-170..177 | Analytics | Fastlane app | `AnalyticsPage-C6js6B6f.js` (`Track your content performance across all platforms.`, breakdowns) | CONFIRMED |
| F-180..188 | Warmed Accounts | usefastlane.ai `/tools/buy-tiktok-accounts` + developers | 4 pasos, $100/mes, $1,50/post, 5 días de warming; `GET /warmed-accounts` | SUPPORTED |
| F-190..201 | Engagement (Reddit) | Fastlane app | `ActionsView-GEuYGk_0.js` (ban meter de 4 niveles, `Generate AI reply`, `Configure discovery subreddits`) | CONFIRMED |
| F-210..220 | Automations | developers.usefastlane.ai + app | MCP → Automations (ciclo de vida, tools); `AutomationWizard-CX2ySZFL.js` (copy de gates) | SUPPORTED/CONFIRMED |
| F-230..243 | Settings + Billing + API | Fastlane app + developers | ids de sección; strings de billing; `Authentication` y `Rate limits` | CONFIRMED/SUPPORTED |
| F-250..258 | Growth & Support | Fastlane app + docs | rutas `/refer-and-earn`, `/guide`, `/roadmap`, `/changelog`, `/feedback`, `/status`; footer del Home 02:27 | CONFIRMED |
| DATA-001..030 | Modelo de datos | developers.usefastlane.ai | Schemas de request/response de los 29 endpoints | SUPPORTED |
| AI-001..015 | Comportamientos de IA | ver §11 | timestamps y secciones citadas por item | CONFIRMED/SUPPORTED |
| INT-001..013 | Integraciones | ver §10 | citadas por integración | CONFIRMED/SUPPORTED |
| NFR-001..025 | No funcionales | developers + app | ver tabla §17 | SUPPORTED/CONFIRMED |


---

# 23. Fastlane Parity Matrix

> Objetivo: detectar funcionalidad de Fastlane **no cubierta** por este PRD. Columna "Original entendido" = sabemos cómo se comporta. Columna "Requisito de clon definido" = este PRD especifica qué construir.

| Module | Feature | Original entendido | Requisito de clon definido | Confidence |
|---|---|:--:|:--:|---|
| Auth | Signup / login / SSO | ✅ | ✅ FR-*, §15 | CONFIRMED |
| Auth | Password recovery | ⚠️ delegado al IdP | ✅ §15.3 | INFERRED |
| Auth | Account deletion | ✅ | ✅ FR-160 | CONFIRMED |
| Auth | Invitations / members | ⚠️ existe, UI desconocida | ⚠️ §14, §4 (INFERRED) | UNKNOWN |
| Onboarding | Website analysis | ✅ | ✅ FR-010 | CONFIRMED |
| Onboarding | Manual brand fallback | ✅ | ✅ FR-010 | CONFIRMED |
| Onboarding | **Social profile analysis (IG/TikTok/X/YT/LinkedIn)** | **n/a — no existe en Fastlane** | ✅ FR-011 | **EXTENSION** |
| Brand | **Multi-source, fusión y trazabilidad por campo** | n/a | ✅ FR-011.6, FR-020 | **EXTENSION** |
| Brand | **Importación de posts propios al Media Bank** | n/a | ✅ FR-011.5.1 | **EXTENSION** |
| Onboarding | Profiling questionnaire | ✅ | ✅ FR-010 | CONFIRMED |
| Onboarding | Quick start guide | ✅ | ✅ F-010 | CONFIRMED |
| Brand | Profile view + edición por sección | ✅ | ✅ FR-020 | CONFIRMED |
| Brand | brandRevision / stale-guard | ✅ | ✅ FR-020, AI-005 | SUPPORTED |
| Brand | Re-analyse website | ⚠️ inferido de strings | ✅ F-023 | INFERRED |
| Home | KPI tiles | ✅ | ✅ FR-030 | CONFIRMED |
| Home | Tasks / suggested actions | ✅ | ✅ F-033 | CONFIRMED |
| Home | Views History + website analytics CTA | ✅ | ✅ FR-030 | CONFIRMED |
| Home | Trending feed | ✅ | ✅ F-034 | CONFIRMED |
| Home | FAQ (5 categorías, **39** preguntas) | ✅ | ✅ FR-030 | CONFIRMED |
| Inspiration | Búsqueda + filtro por nicho | ✅ | ✅ FR-040 | CONFIRMED |
| Inspiration | Remix this | ✅ | ✅ F-042 | CONFIRMED |
| Inspiration | Ingesta del catálogo de 25 000 videos | ❌ método desconocido | ⚠️ F-041 (estrategia propia requerida) | UNKNOWN |
| Blitz | Discovery queue (~5) | ✅ | ✅ FR-050 | SUPPORTED |
| Blitz | Swipe + teclado + botones | ✅ | ✅ FR-050 | CONFIRMED |
| Blitz | Why This Content | ✅ | ✅ F-055 | CONFIRMED |
| Blitz | Remixed From | ✅ | ✅ F-056 | CONFIRMED |
| Blitz | Chips de influencer/ángulo | ✅ | ✅ F-054 | CONFIRMED |
| Blitz | Editor inline completo | ✅ | ✅ FR-051 | CONFIRMED |
| Blitz | Regenerate Text con prompt | ✅ | ✅ AI-004 | CONFIRMED |
| Blitz | Preferences / Settings | ✅ | ✅ FR-054, FR-055 | CONFIRMED |
| Blitz | Swipe cap diario | ✅ | ✅ F-066 | SUPPORTED |
| Blitz | Forzar contentType / aspectRatio | ✅ | ✅ F-067, F-068 | SUPPORTED |
| Studio | 4 formatos base, modos Remix/Create New | ✅ | ✅ FR-070 | CONFIRMED |
| Studio | Trending picker + preview + inspector | ✅ | ✅ FR-070 | CONFIRMED |
| Studio | Swap image por slide | ✅ | ✅ FR-071 | CONFIRMED |
| Studio | Wall-of-text styles | ✅ nombres parciales (`Storytime`, `Quick Thought`) | ⚠️ catálogo completo desconocido | UNKNOWN (OQ-08) |
| Studio | 17 formatos IA adicionales | ✅ label + descripción | ⚠️ pipeline interno desconocido | SUPPORTED (qué) / UNKNOWN (cómo) |
| Studio | Custom upload | ✅ | ✅ F-083 | SUPPORTED |
| Influencers | Wizard 3 pasos + créditos | ✅ | ✅ FR-080 | CONFIRMED |
| Influencers | Upload own base image | ✅ | ✅ F-092 | CONFIRMED |
| Influencers | Training asíncrono con progress | ✅ | ✅ AI-007 | CONFIRMED |
| Influencers | Galería de imágenes + templates | ✅ | ✅ FR-081 | CONFIRMED |
| Influencers | Galería de videos + modelos | ✅ | ✅ FR-082 | CONFIRMED |
| Influencers | Talking Head UGC | ✅ | ✅ AI-010 | CONFIRMED |
| Influencers | Configuration (ángulos, cuentas, sets) | ✅ | ✅ FR-083 | CONFIRMED |
| Influencers | Catálogo de `Template` (prompts preconstruidos) | ⚠️ existe el selector, contenido desconocido | ⚠️ UNKNOWN | UNKNOWN (OQ-09) |
| AI Studio | Generación libre + referencias | ✅ | ✅ FR-090 | CONFIRMED |
| AI Studio | Filtros de contenido | ✅ | ✅ F-113 | CONFIRMED |
| Library | My Posts + métricas + acciones | ✅ | ✅ FR-100 | CONFIRMED |
| Library | My Content | ✅ | ✅ FR-100 | CONFIRMED |
| Library | Media Bank + categorías | ✅ | ✅ FR-100, F-129 | CONFIRMED |
| Library | Media Sets | ✅ UI | ⚠️ API no documentada | CONFIRMED (UI) / UNKNOWN (API) |
| Library | Bulk select | ✅ existe el botón | ⚠️ acciones masivas exactas desconocidas | UNKNOWN (OQ-04) |
| Calendar | Vista mes + chips + contadores | ✅ | ✅ FR-110 | CONFIRMED |
| Calendar | Vista alternativa (grid) | ✅ en Automations | ⚠️ en Calendar global: parcial | INFERRED |
| Calendar | Drag & drop para reprogramar | ❌ no observado | ❌ no especificado | UNKNOWN |
| Scheduling | Select Platforms + opciones nativas | ✅ | ✅ FR-060 | CONFIRMED |
| Scheduling | Copy por plataforma + Improve/Regenerate | ✅ | ✅ F-153, F-154 | CONFIRMED |
| Scheduling | Date/time picker + post now | ✅ | ✅ F-156, F-157 | CONFIRMED |
| Scheduling | Máquina de estados completa de Post | ✅ | ✅ FR-060 | SUPPORTED |
| Scheduling | TikTok slow lane (72 h) | ✅ | ✅ NFR-015 | SUPPORTED |
| Scheduling | Batch cancel/delete atómicos | ✅ | ✅ F-162 | SUPPORTED |
| Analytics | Breakdown por plataforma y tipo | ✅ | ✅ FR-120 | CONFIRMED |
| Analytics | Website analytics + ad attribution | ✅ | ✅ F-174, F-175 | CONFIRMED |
| Analytics | Atribución de signups/ventas por post | ⚠️ afirmado en marketing, no observado | ⚠️ INFERRED | UNKNOWN (OQ-06) |
| Warmed | Compra + configuración + warming | ✅ | ✅ FR-130 | SUPPORTED |
| Warmed | Aprobación, slots, lead time, reemplazos | ✅ | ✅ FR-130 | SUPPORTED |
| Warmed | TikTok commercial sounds | ✅ | ✅ F-159 | SUPPORTED |
| Warmed | Instagram carousel vs reel | ✅ | ✅ F-158 | SUPPORTED |
| Engagement | Conexión + discovery + leads | ✅ | ✅ FR-140 | CONFIRMED |
| Engagement | AI replies + reglas custom | ✅ | ✅ AI-013 | CONFIRMED |
| Engagement | Ban risk meter (4 niveles) | ✅ | ✅ FR-140 | CONFIRMED |
| Engagement | Insights (`/engagement/insights`) | ⚠️ ruta existe, contenido desconocido | ⚠️ UNKNOWN | UNKNOWN (OQ-10) |
| Automations | Ciclo de vida completo | ✅ | ✅ FR-150 | SUPPORTED |
| Automations | Review con edición y re-roll | ✅ | ✅ FR-150 | SUPPORTED |
| Automations | launchValidation y gates | ✅ | ✅ FR-150 | CONFIRMED |
| Settings | 8 secciones | ✅ ids | ✅ FR-160 | CONFIRMED |
| Settings | Panel de notificaciones | ⚠️ existe | ⚠️ contenido UNKNOWN | UNKNOWN (OQ-03) |
| Billing | Planes y límites | ✅ | ✅ §16 | SUPPORTED |
| Billing | Upgrades/downgrades prorrateados | ✅ | ✅ §16.3 | CONFIRMED |
| Billing | Compra de créditos/saves/posts | ✅ | ✅ F-237, F-238 | CONFIRMED |
| Billing | Precios anuales | ❌ contradicción entre fuentes | ❌ no implementar sin confirmar | UNKNOWN (OQ-07) |
| API | REST v1 (29 endpoints) | ✅ | ✅ §9.3 | SUPPORTED |
| API | Keys + overage + docs embebidas | ✅ | ✅ FR-180 | CONFIRMED |
| API | Webhooks salientes | ❌ no existen en v1 | ❌ no especificar | UNKNOWN (OQ-11) |
| MCP | OAuth connector (8 tools) | ✅ | ✅ AI-015 | SUPPORTED |
| MCP | API-key server (34 tools) | ✅ | ✅ AI-015 | SUPPORTED |
| Partner | Provisión multi-tenant + billing por evento | ✅ a alto nivel | ⚠️ §9.7 (opcional, sin endpoints documentados) | SUPPORTED (concepto) / UNKNOWN (detalle) |
| Growth | Refer & Earn | ✅ | ✅ F-250 | CONFIRMED |
| Growth | Guide / Roadmap / Changelog / Feedback / Status | ✅ rutas | ⚠️ contenido específico no observado | CONFIRMED (existencia) |
| Libraries | 1 000+ AI UGC characters preconstruidos | ⚠️ afirmado en marketing | ⚠️ estrategia propia requerida | SUPPORTED (existencia) / UNKNOWN (implementación) |
| Libraries | 2 000+ human UGC videos | ⚠️ afirmado, filtrable por estilo y género | ⚠️ estrategia propia requerida | SUPPORTED / UNKNOWN |
| Libraries | Shared audio library | ✅ API documentada | ✅ F-080, DATA-012 | SUPPORTED |
| Multi-language | Contenido multi-idioma (plan Pro) | ⚠️ sólo en pricing; en UI sólo `Language: English` en Talking Head | ⚠️ parcial | UNKNOWN (OQ-12) |
| V2 / Fastlane OS | `agent`, `genesis`, `strategy`, `activity` | ❌ | ❌ fuera de alcance §2.5 | UNKNOWN |
| Admin interno | 17 rutas de back-office | ✅ existencia | ❌ fuera de alcance §2.5 | CONFIRMED (existencia) |

**Conclusión de la matriz:** todo lo que el producto expone al cliente y que pudo observarse tiene un requisito definido en este PRD. Las 12 filas marcadas ⚠️/❌ están recogidas en §24 con hipótesis y plan de verificación. Ninguna de ellas bloquea las fases 1–4.

**Sobre las filas EXTENSION:** no son huecos de paridad sino **superávit** — funcionalidad que el clon tendrá de más. No afectan al cálculo de paridad con Fastlane y pueden eliminarse sin tocar nada más, porque `EXT-001` está diseñada como aditiva (§2.6).

---

# 24. Open Questions

> Sólo aquello que **no** pudo determinarse. Para cada una: qué falta, por qué importa, fuentes revisadas, hipótesis y qué habría que observar.

### OQ-01 — Matriz exacta de permisos owner vs. member
- **Qué falta:** qué puede hacer un `member` frente al `owner` (¿puede conectar cuentas? ¿crear API keys? ¿gastar créditos? ¿lanzar automations?).
- **Por qué importa:** determina el modelo de autorización del backend y qué se oculta en la UI. Un error aquí es un agujero de seguridad o una fricción innecesaria.
- **Fuentes revisadas:** bundle completo de la app (no hay sección `members` ni strings de rol), documentación de developers (sólo distingue owner/member para el connector OAuth y para `replacementDecisions`), páginas públicas.
- **Hipótesis:** (a) member = todo salvo billing, borrado de workspace, aprobación de warmed accounts y gestión de keys; (b) member = sólo lectura + Blitz; (c) no existen realmente miembros y el "member" del docs se refiere a usuarios de workspaces de Partner.
- **Qué observar:** una cuenta con un segundo usuario invitado; la pantalla de invitación; la respuesta de la API a acciones privilegiadas con una sesión de member.

### OQ-02 — Flujo de invitación ("special user")
- **Qué falta:** UI, canal (email/link), qué datos recoge, qué rol asigna.
- **Por qué importa:** es el único camino a la colaboración multi-usuario.
- **Fuentes revisadas:** bundle (`Failed to create special user from invite:` es la única traza).
- **Hipótesis:** invitación por email con token, que crea el usuario y lo adjunta al workspace con rol fijo.
- **Qué observar:** `Settings → workspaces` en una cuenta de pago; el email de invitación.

### OQ-03 — Contenido del panel de notificaciones
- **Qué falta:** qué categorías y canales se pueden configurar.
- **Por qué importa:** §13.4 queda incompleta y el clon podría notificar de más o de menos.
- **Fuentes revisadas:** bundle (sólo el id de sección y los mensajes de error de guardado).
- **Hipótesis:** toggles por categoría (publicación, fallos, cuota, leads) × canal (in-app, email).
- **Qué observar:** `Settings → notifications` autenticado.

### OQ-04 — Acciones masivas disponibles tras `Select`
- **Qué falta:** qué operaciones ofrece el modo de selección múltiple en Library (¿borrar? ¿cancelar? ¿reprogramar? ¿añadir a set? ¿cambiar categoría?).
- **Por qué importa:** la API soporta cancel y delete en lotes de 100, pero no sabemos qué expone la UI.
- **Fuentes revisadas:** videos (el botón `Select` aparece pero nunca se pulsa), bundle, docs.
- **Hipótesis:** al menos `Delete` y `Cancel` en My Posts; `Delete` y asignación de categoría/set en Media Bank.
- **Qué observar:** pulsar `Select` en cada pestaña de Library.

### OQ-05 — Rate limit REST real: ¿60/min o 20/min?
- **Qué falta:** la documentación se contradice: la sección `Rate limits` dice **"60 requests per minute by default limit per workspace"**, mientras que múltiples endpoints individuales dicen *"per-company API rate limit tripped (20 req/min)"*.
- **Por qué importa:** define el dimensionado del rate limiter y el comportamiento esperado de los clientes.
- **Fuentes revisadas:** developers.usefastlane.ai, secciones `Rate limits` y `Endpoints`.
- **Hipótesis:** 60/min es el valor vigente y las menciones a 20/min son documentación desactualizada de una versión anterior; o bien 20/min aplica a endpoints de escritura y 60/min al total.
- **Qué observar:** cabeceras de rate limit en respuestas reales, o un test de saturación con una key propia.
- **Decisión provisional para el clon:** implementar **60/min configurable por workspace**, exponer cabeceras de límite y documentar el valor.

### OQ-06 — Atribución de signups y ventas por post
- **Qué falta:** el marketing afirma *"signups and sales attributed to each post"*, pero en el producto sólo se observan `views`, `likes`, `comments` y `Social website views`.
- **Por qué importa:** es una de las promesas de valor principales; si existe, requiere un modelo de atribución completo (UTM, link-in-bio, pixel, deduplicación).
- **Fuentes revisadas:** páginas de tools, llms-full.txt, `AnalyticsPage`, strings de atribución (`Failed to record marketing attribution:`, `Ad attribution is off.`).
- **Hipótesis:** el script de website analytics correlaciona visitas con el post que las originó por referrer/UTM y atribuye conversiones; la parte de "sales" puede depender de una integración adicional.
- **Qué observar:** la pantalla de Analytics con website analytics activado y tráfico real; la documentación del script.

### OQ-07 — Precios anuales
- **Qué falta:** si existen planes anuales con descuento y cuál es el importe exacto.
- **Por qué importa:** no se deben inventar precios.
- **Fuentes revisadas:** página oficial `/pricing` (sólo mensual), `llms-full.txt` (sólo mensual). Una fuente de terceros menciona anuales con 20 % de descuento.
- **Hipótesis:** existió o existe un toggle anual no presente en la versión consultada.
- **Qué observar:** la página de precios con el toggle anual, o el checkout.

### OQ-08 — Catálogo completo de "styles" de wall of text
- **Qué falta:** la lista completa del selector `Select a style`. Observados: `Storytime`, `Quick Thought`.
- **Por qué importa:** cada estilo condiciona la estructura de la copy generada.
- **Fuentes revisadas:** videos 3 y manual-creation (sólo dos valores visibles), bundle.
- **Hipótesis:** 5–8 estilos narrativos (storytime, quick thought, listicle, confession, hot take, …).
- **Qué observar:** abrir el dropdown en `/content/wall-of-text`.

### OQ-09 — Catálogo de `Template` en Influencers y AI Studio
- **Qué falta:** qué plantillas de prompt ofrece el selector `✨ Template`.
- **Por qué importa:** es el atajo principal para generar imágenes/videos consistentes.
- **Fuentes revisadas:** video 7 (el selector aparece pero no se abre), bundle.
- **Hipótesis:** presets de escena/pose/encuadre (POV selfie, mirror selfie, gym, car, café, …), coherentes con los nombres de sets observados (`POV selfies`, `Generic Lifestyle`, `Entrepreneur / Hus…`).
- **Qué observar:** abrir el dropdown en la barra de generación.

### OQ-10 — Contenido de `/engagement/insights`
- **Qué falta:** qué muestra la pestaña Insights del módulo de Engagement.
- **Por qué importa:** completa el módulo de leads.
- **Fuentes revisadas:** bundle (la ruta existe; el chunk `ActionsView` cubre `actions`), videos.
- **Hipótesis:** métricas agregadas de engagement (replies enviadas, tasa de respuesta, subreddits más productivos, evolución del ban meter).
- **Qué observar:** la ruta autenticada con Reddit conectado.

### OQ-11 — Webhooks salientes
- **Qué falta:** si Fastlane puede notificar a sistemas externos (p. ej. "post publicado", "build terminado").
- **Por qué importa:** integraciones de clientes; hoy la única opción documentada es polling.
- **Fuentes revisadas:** documentación completa de developers (no hay ninguna sección de webhooks).
- **Hipótesis:** no existen en v1; el patrón oficial es polling cada ~10 s.
- **Qué observar:** `Settings → API` autenticado; cualquier mención en changelog.
- **Decisión para el clon:** implementar polling como contrato principal y **añadir webhooks como mejora explícita**, documentada como divergencia.

### OQ-12 — Alcance real de "Multi-language content"
- **Qué falta:** el plan Pro incluye `Multi-language content`, pero en la UI sólo se observa un selector `Language: English` en Talking Head UGC.
- **Por qué importa:** afecta a todo el pipeline de generación de copy y a los límites de caracteres por plataforma.
- **Fuentes revisadas:** pricing oficial, video 7, bundle.
- **Hipótesis:** una preferencia de idioma a nivel de workspace que se propaga a la generación de copy y captions.
- **Qué observar:** `Settings → preferences` en una cuenta Pro.

### OQ-13 — Origen y licenciamiento del catálogo de trending
- **Qué falta:** cómo se obtienen y con qué derechos se usan los 25 000+ videos en tendencia y los 2 000+ videos UGC humanos.
- **Por qué importa:** es un riesgo legal y operativo de primer orden para el clon; determina si el producto es viable tal cual.
- **Fuentes revisadas:** marketing (`Browse and remix 25,000+ trending videos, tagged by niche and analytics`), FAQ (`What are the platform rules around copyright?` — la respuesta no es pública), documentación.
- **Hipótesis:** mezcla de contenido licenciado a creadores, contenido propio y metadatos públicos; el "remix" recrea el formato, no redistribuye el original (el original se enlaza mediante `remixSourceUrl`).
- **Qué observar:** la respuesta completa de esa FAQ dentro de la app; los términos de servicio.
- **Nota de riesgo:** el clon **no** debe copiar el catálogo. Debe definir su propia estrategia de adquisición de referencias en tendencia y su propia política de derechos antes de la Fase 2.

### OQ-14 — Valores exactos de varios caps
- **Qué falta:** número de API keys activas por workspace, límite de conexiones por plataforma, cap diario de swipes por plan, cuota de generación por campaña de Automation.
- **Por qué importa:** son parámetros de configuración del clon.
- **Fuentes revisadas:** bundle (strings con placeholders: `<N> active keys per workspace.`, `Connection limit reached`), documentación (los caps existen pero no se numeran salvo 100 ángulos, 10 ángulos/influencer, 50 influencers, 20 slides, 100 ids por lote, 100 warmed accounts).
- **Hipótesis:** varían por plan.
- **Qué observar:** la UI autenticada en cada plan, o los errores con `details.limit`.
- **Decisión para el clon:** hacerlos **configurables por plan** desde el inicio, no hardcodearlos.

### OQ-15 — Comportamiento del `Select` de plataformas cuando hay varias cuentas de la misma
- **Qué falta:** cómo elige la UI entre varias cuentas conectadas de la misma plataforma (la API lo resuelve con `connectionId` obligatorio y `400 connection_ambiguous`).
- **Por qué importa:** la UI observada sólo muestra una fila por plataforma.
- **Fuentes revisadas:** videos (siempre una cuenta por plataforma), documentación de API.
- **Hipótesis:** la fila se expande a un selector de cuenta, o cada cuenta aparece como fila propia.
- **Qué observar:** `Select Platforms` en un workspace con dos cuentas de TikTok.

### OQ-16 — Base legal y de ToS para leer perfiles sociales de terceros (EXT-001) — **BLOQUEANTE para el tier C**
- **Qué falta:** por cada plataforma (Instagram, TikTok, X, YouTube, LinkedIn): qué permiten sus términos respecto a leer un perfil público de forma automatizada; qué cubre su API oficial sin OAuth; qué base legal aplica al tratamiento de datos de la cuenta analizada; y qué retención es defendible para el snapshot.
- **Por qué importa:** es la única parte de `EXT-001` que puede ser inviable. Los tiers A (OAuth propio), B (API pública oficial) y D (asistido) son seguros. El **tier C (fetch de página pública)** es el que necesita cobertura legal antes de activarse, y es justamente el que hace que funcione el caso "pego el Instagram de mi negocio sin conectar nada".
- **Fuentes revisadas:** ninguna — está fuera del alcance de la investigación de producto realizada; requiere revisión legal, no técnica.
- **Hipótesis:** el producto es viable con A+B+D para la gran mayoría de casos, porque el usuario **normalmente analiza su propia cuenta** y va a conectarla igualmente para publicar. El tier C sería una conveniencia de onboarding, no un requisito estructural.
- **Qué habría que hacer:** revisión legal por plataforma antes de habilitar el tier C; entre tanto, **construir el tier C detrás de un flag desactivado por defecto** (ya especificado así en `FR-011.4` e `INT-017`).
- **Mitigación ya incorporada al diseño:** no se persisten binarios de terceros; sólo extractos citables; purga forzada por `rawRetentionExpiresAt`; y degradación automática al tier D.
- **Impacto tras D-01:** la decisión de no pedir OAuth en el alta **sube la importancia de esta pregunta**. Con OAuth obligatorio, el tier C era prescindible; con la ruta pública como camino por defecto, el tier C es lo que determina cuántas altas se resuelven sin fricción. Sigue siendo no bloqueante para construir (el flag apagado degrada a D), pero sí lo es para que `EXT-001` cumpla su promesa.

### OQ-19 — Cobertura real de cada plataforma sin OAuth (EXT-001, consecuencia de D-01 + D-02)
- **Qué falta:** para cada una de las cinco plataformas, qué se puede leer de un perfil público **sin autenticar**: qué expone su API pública, qué devuelve su oEmbed, cuántos ítems de contenido son alcanzables y con qué campos.
- **Por qué importa:** D-01 convierte la ruta pública en el camino por defecto y D-02 exige las cinco plataformas en Fase 1. Si la cobertura pública de alguna es muy pobre, sus altas caerán sistemáticamente al tier D (asistido) — es decir, el usuario tendrá que pegar su bio a mano, que es justo lo que la extensión venía a evitar. El síntoma en producción es una cola alta de `D_assisted` en `brand_source_analysis_completed`.
- **Fuentes revisadas:** ninguna — queda fuera del alcance de la investigación de Fastlane realizada; es trabajo de descubrimiento técnico sobre las APIs de cada plataforma.
- **Hipótesis:** la cobertura será **desigual entre las cinco**, y no todas darán la misma calidad sin OAuth. Conviene saberlo **antes** de escribir los cinco extractores, no después.
- **Qué habría que hacer:** un spike corto por plataforma — resolver un perfil público real y documentar qué campos y cuántos ítems se obtienen por cada vía. Es el primer trabajo a hacer dentro de la Fase 1 de `EXT-001`, porque su resultado puede reordenar la prioridad de los extractores o reabrir D-02.

### OQ-17 — Calidad real del perfil derivado de social vs. web (EXT-001)
- **Qué falta:** medir cuánto peor (o mejor) es un `CompanyProfile` derivado de un perfil de Instagram frente a uno derivado de una web, campo por campo.
- **Por qué importa:** determina cuántas preguntas de cierre de huecos hay que hacer y, por tanto, cuánta fricción reintroduce la extensión justo en el paso que pretendía simplificar. Si acaba pidiendo seis respuestas, no hemos quitado fricción: la hemos movido.
- **Hipótesis:** `toneOfVoice` y `targetAudience` salen **mejor** desde social; `PRODUCT OFFERING` y `PROBLEM SOLUTION` salen claramente peor.
- **Qué observar:** un benchmark con 30–50 marcas que tengan **ambas** cosas, comparando el perfil derivado de cada origen contra una anotación humana. Los eventos `fields_low` y `brand_field_edited` de §18 miden esto en producción.

### OQ-18 — Número óptimo de ítems a analizar (EXT-001)
- **Qué falta:** si 24 ítems es el punto correcto entre calidad y coste (ASR + OCR + tokens crecen linealmente).
- **Por qué importa:** es el principal driver de coste unitario del alta.
- **Hipótesis:** la curva de información satura pronto, alrededor de 15–20 ítems, salvo en cuentas con temática muy dispersa.
- **Efecto de D-03:** al diferir el ASR, el coste por ítem en Fase 1 baja mucho (sólo OCR + tokens), así que el N óptimo de Fase 1 es probablemente **mayor** que el de Fase 2. Conviene reevaluarlo al incorporar el ASR.
- **Qué observar:** ablación sobre el mismo benchmark de `OQ-17` variando N ∈ {6, 12, 24, 48}.

---

### OQ-20 — ¿Se sostiene la calibración de un modelo de juicio en este dominio? (EXT-008)
- **Qué falta:** si las probabilidades que devuelve un adaptador no-LLM significan algo sobre los datos de FastGram — es decir, si de los items con confianza 0,9 acierta efectivamente ~90 %.
- **Por qué importa:** **todos** los umbrales de §25.3 dependen de esto. Si la calibración no se sostiene, `> 0.75 → Top Scored Leads` o `policyRisk > 0.7 → bloquea` son números arbitrarios disfrazados de política. Es la pregunta más importante de toda la capa de juicio, por encima del acierto bruto.
- **Fuentes revisadas:** la documentación del proveedor evaluado describe bandas de confianza recomendadas pero **no afirma calibración contra benchmarks externos**; sus propios docs recomiendan *"empezar con umbrales conservadores, testear con tus datos y ajustar"*.
- **Hipótesis:** se sostiene razonablemente en inglés y se degrada en español, donde hay menos evidencia pública de rendimiento.
- **Qué observar:** diagrama de fiabilidad sobre el dataset de §25.4, con corte por idioma. Es parte del experimento, no un trabajo aparte.

---

### OQ-21 — El tarifario de créditos no sigue al costo real (consecuencia de `P1-INFRA-001`)
- **Qué falta:** decidir si el clon hereda el tarifario de AI Studio de Fastlane (4 créditos/imagen · 60 créditos/video · 250/influencer · 4/base image) o lo recalibra contra el costo del proveedor.
- **Qué se midió** (2026-09-21, `docs/COST-MODEL.md`): **un crédito gastado en video cuesta 15,6× uno gastado en imagen.** El tarifario cobra 15×, así que la proporción casi coincide — pero el problema es otro: **un video de 10 s cuesta los mismos 60 créditos que uno de 5 s, pagando el doble de GPU.** El crédito no mide lo que cuesta.
- **Por qué importa:** la generación de video en GPU es el **driver de costo dominante**, y por dos órdenes de magnitud: un usuario Pro que gaste sus 2.000 créditos en video consume $23,33 sobre un plan de $149 (**15,7 %**), mientras que egress, render, LLM, storage y OCR **sumados** no llegan a $0,50/usuario/mes. Cualquier error en este tarifario se multiplica por todo el volumen del producto; un error en los otros drivers no se nota.
- **Riesgo asociado y sin mitigación escrita:** *"Unlimited content saves"* en el plan Pro (§16.1) deja el COGS **sin techo**. Es el mayor riesgo de margen del modelo y hoy no hay nada en el PRD que lo acote.
- **Opciones:**
  1. Heredar el tarifario tal cual (paridad con Fastlane; asume el riesgo de margen en videos largos).
  2. Cobrar el video **por segundo generado** en vez de por pieza. Es lo que sigue al costo, pero cambia la promesa de la UI y hay que explicarlo.
  3. Mantener el precio por pieza y **acotar la duración** que una pieza puede generar.
- **Qué observar:** distribución real de duración de los videos generados una vez haya volumen. Si la mediana se pega al máximo, la opción 1 no se sostiene.
- **Nota:** es un defecto de **diseño de producto heredado**, no de infraestructura. No se puede resolver optimizando el render.

---

# 25. Judgment Layer: puntos de decisión y features de juicio

> **EXTENSION · EXT-008 · decisión D-05.** Esta sección no describe comportamiento observado en Fastlane: define **cómo el clon resuelve las decisiones semánticas** que el resto del PRD especifica sin decir con qué. Nace de la evaluación de arquitectura `EVAL-JEV.md` (2026-09-21).
>
> **Nomenclatura:** `DP-XXX` = punto de decisión (dónde el sistema decide). `JV-X` = feature de juicio (qué se construye sobre él). No confundir `DP-001` con `D-01`: las `D-0X` son las decisiones de producto de §2.7.

## 25.1 Puntos de decisión

Cada `DP` distingue tres cosas, para no perder la disciplina de evidencia del documento: **qué establece el PRD** (con su nivel de confianza), **qué queda sin definir**, y **qué se propone**.

### DP-001 — Clasificación del catálogo de tendencias
- **El PRD establece:** la librería de trending está *"tagged by niche and analytics"* y se actualiza a diario. `F-040`, `F-041`, `FR-040`. SUPPORTED `[WWW]` + CONFIRMED (chips de nicho en la UI: `B2C App`, `B2B App`, `Productivity`, `Relationships`, `Personal Brand`, `Course/Digital Product`, `E-Commerce`, `Self Improvement`, `Travel`, `Study`).
- **Sin definir:** cómo se asigna esa taxonomía. El PRD marca `F-041` como gap y como riesgo legal/operativo.
- **Decide:** nicho, formato, estilo de hook, aptitud para remix, seguridad de marca — por item.
- **Volumen:** 25.000+ inicial, ~1.000/día incremental (derivado de *"Updated daily"*).
- **Hoy:** nada. Es prerequisito de Inspiration y de la cola de Blitz.
- **Latencia:** offline, sin usuario esperando.
- **Feature:** `JV-1`.

### DP-002 — Scoring de leads de Reddit
- **El PRD establece:** existen `Most Engaged Leads`, `Top Scored Leads`, `Why this lead?` y un filtro `Unseen only`. `FR-140`, `AI-013`. CONFIRMED `[APP ActionsView]`.
- **Sin definir:** **cómo se puntúa un lead.** Sin motor, el módulo no existe.
- **Decide:** si un post es una oportunidad y con qué prioridad.
- **Volumen:** miles de posts/día por workspace.
- **Hoy:** nada.
- **Latencia:** batch, tolerante.
- **Feature:** `JV-2`.

### DP-003 — Clasificación del tono de una respuesta (insumo del ban meter)
- **El PRD establece:** el medidor de riesgo tiene cuatro niveles y una recomendación de ratio (*"Aim for 60-70% value, 20-30% subtle, 10-20% direct"*, *"at least 3-4 value-add replies for every promotional one"*). `FR-140`. CONFIRMED.
- **Sin definir:** quién etiqueta cada respuesta como valor / sutil / promoción directa.
- **Decide:** la etiqueta de **una** respuesta. **El ratio y el nivel los calcula código.**
- **Volumen:** 1 por respuesta enviada. Bajo.
- **Feature:** `JV-5`.

### DP-004 — Verificación de campos del perfil de marca
- **El PRD establece:** `fieldMeta` con `confidence: high|medium|low` por campo, badge de origen, extracto citado, y la regla dura **"nunca inventar"**. `AI-016`, `DATA-004`, `FR-011.2`. EXTENSION (parte de EXT-001).
- **Sin definir:** **cómo se calcula esa confianza.** Sin mecanismo, `high/medium/low` es decorativo y la regla "nunca inventar" no es verificable.
- **Decide:** si el extracto respalda el valor derivado, y qué tan específico es.
- **Volumen:** ~8 campos × cada análisis de marca.
- **Latencia:** dentro del alta → sensible.
- **Feature:** `JV-4`.

### DP-005 — Selección de qué tendencia remixar para una marca
- **El PRD establece:** Blitz remixa contenido en tendencia y guarda `remixSourceUrl`; `remixPercentage` y `ownMediaPercentage` gobiernan las proporciones. `FR-050`, `FR-055`. CONFIRMED/SUPPORTED.
- **Sin definir:** **cuál** item concreto se elige para *esta* marca. Los pesos dicen *cuánto* remix, no *qué* remixar.
- **Decide:** orden de los candidatos por encaje con la marca.
- **Volumen:** cada sugerencia encolada.
- **Hoy:** filtro por nicho + recencia.
- **Feature:** `JV-6`. **Depende de `DP-001`.**

### DP-006 — Normalización de errores de plataforma
- **El PRD establece:** *"Los errores de plataforma se traducen a códigos estables neutrales respecto al proveedor antes de mostrarse"*, con ejemplos como `instagram_repeated_mention`. §10, `FR-060`. SUPPORTED `[DEV]`.
- **Sin definir:** el mecanismo de traducción. Hecho a mano es un if-else sobre strings de proveedor: frágil por diseño, porque los proveedores cambian sus mensajes sin avisar.
- **Decide:** `errorCode` de un enum cerrado, a partir del error crudo.
- **Volumen:** cada fallo de publicación. Bajo.
- **Nota:** aquí **una tabla de mapeo determinística debe ser la primera línea**; el juicio sólo entra para lo que no matchea. Ver §25.2.

### DP-007 — Pre-flight de publicación (EXTENSION · EXT-007)
- **El PRD establece:** los fallos y ajustes de plataforma son todos **post-mortem**: `captionAdjustmentReason: "repeated_mention"`, `instagram_repeated_mention`, `tiktok_post_limit_exceeded`, el carril lento de TikTok. CONFIRMED/SUPPORTED.
- **Nuevo:** detectar el problema **antes** de programar. No existe en Fastlane.
- **Decide:** riesgo de política, riesgo de ajuste de caption, necesidad de etiqueta de IA, calidad del hook.
- **Volumen:** cada post programado.
- **Latencia:** **síncrona, bloquea al usuario** → es el único `DP` con requisito duro de latencia.
- **Feature:** `JV-3`.

## 25.2 Dónde **no** entra el puerto

Tan importante como el inventario. Estos lugares se resuelven en código y no deben pasar por la capa de juicio **con ningún adaptador**:

| Área | Por qué |
|---|---|
| Mezcla de contenido, `angleWeights`, `influencerChance`, `remixPercentage` (`FR-055`) | Muestreo ponderado determinístico que el usuario controla con sliders y espera exacto. Un modelo acá **pierde** la propiedad que lo hace útil. |
| Ratio promocional del ban meter, cuotas, `content saves`, contadores de caracteres | Aritmética. Se calculan sobre las etiquetas de `DP-003`, no en lugar de ellas. |
| `minLeadTimeMs`, ventanas de publicación, techo de 30 días, `resetAt`, día ancla de facturación | Fechas y comparaciones ordenadas. Código. |
| Detección de plataforma desde URL/handle (`FR-011.1`) | Parseo de host. Una regex no falla y es auditable. |
| `launchValidation` de Automations (`FR-150`) | Estado y cuotas. Código. |
| Validación de esquemas, unicidad, límites | Código. |
| Toda generación de texto: captions, hooks, ángulos, `Improve`/`Regenerate`, `aiExplanation`, `Why this lead?` | El puerto no genera texto. Eso es trabajo de un LLM. |
| Guardrail de inyección de prompts como **única** capa | La sanitización determinística va primero y es obligatoria (`FR-011.9`, §9.15.3). |

**Regla de oro:** si el resultado se puede calcular, buscar o enumerar con certeza, es código. El puerto es sólo para lo que requiere entender qué *significa* un texto.

## 25.3 Features de juicio

Ordenadas por impacto × facilidad. Todas consumen el puerto `Judgment` de §9.15; ninguna llama a un proveedor directamente.

---

### JV-1 — Clasificador del catálogo de tendencias · `DP-001` · **S/M**

Etiquetar cada item de la librería en la ingesta.

**Estado:** `{caption, hashtags[], ocrText, transcript?, platform, metrics{views,likes}, durationSec, isSlideshow}`.
**Dependencia dura:** OCR (`INT-016`, Fase 1). ASR opcional (`INT-015`, Fase 2). *Un adaptador basado en un modelo text-only no puede ver el video: todo lo visual debe llegar ya convertido a texto.*

**Preguntas** (una sola llamada, en paralelo):

| id | tipo | definición |
|---|---|---|
| `niche` | choice | Taxonomía cerrada observada en la UI de Fastlane + `none` |
| `format` | choice | `slideshow`, `wall-of-text`, `green-screen`, `talking-head`, `demo`, `other` |
| `hookStyle` | choice | `curiosity_gap`, `pov`, `listicle`, `confession`, `hot_take`, `tutorial`, `none` |
| `remixable` | noul | ¿Se puede recrear el formato con otra marca sin depender de la persona o el producto original? |
| `brandSafe` | noul | ¿Libre de política, tragedia, contenido sexual, claims médicos o financieros? |

**Umbrales.** `niche` con confianza < 0,5 → `none`: el item sigue disponible en búsqueda general pero queda fuera del filtro por nicho. `brandSafe < 0,8` → **cuarentena + revisión humana**. `remixable < 0,6` → visible en Inspiration, **no** elegible para la cola automática de Blitz.
**Qué hace el LLM:** nada.
**Métrica:** acierto contra 200 items etiquetados a mano. Tasa de cuarentena > 5 % ⇒ los `criteria` están mal escritos, no el modelo.

---

### JV-2 — Motor de scoring de leads · `DP-002` · **M**

**Estado:** `{post{title, body, subreddit, author, postedAt, score, numComments}, brand{coreIdentity, productOffering, targetAudience}}`.
*Filtrar el estado: no enviar el perfil de marca completo.*

| id | tipo | definición |
|---|---|---|
| `hasProblem` | noul | ¿Describe un problema que este producto resuelve? |
| `buyingSignal` | score (4) | `solo comenta` / `frustrado con su solución actual` / `evaluando alternativas` / `pide recomendación explícita` |
| `fitToAudience` | score (3) | `fuera del público` / `adyacente` / `exactamente el público` |
| `replyWelcome` | noul | ¿El subreddit y el post admiten una respuesta con mención de producto sin ser spam? |
| `alreadyAnswered` | noul | ¿Ya hay una respuesta que resuelve lo que pide? |

**Composición — los pesos viven en código, no en el modelo:**
```
leadScore = 0.35·buyingSignal + 0.30·fitToAudience + 0.20·hasProblem + 0.15·replyWelcome
veto: alreadyAnswered > 0.7  →  el lead no se muestra
```
Cambiar un peso **no** reinfiere nada: se recalcula sobre `DATA-033`.

**Umbrales.** `> 0.75` → `Top Scored Leads`. `0.4–0.75` → lista general. `< 0.4` → no se muestra.
**Qué hace el LLM:** `Why this lead?` y `Generate AI reply` siguen siendo LLM. El juicio decide **cuáles** merecen ese gasto.
**Métrica:** de los leads del decil superior, ¿en cuántos el usuario responde efectivamente? Baseline: orden cronológico.

---

### JV-3 — Pre-flight de publicación · `DP-007` · **M** · EXTENSION EXT-007

**Entry point:** entre `Content Details` y `Schedule` en el flujo de `FR-060`.
**Estado:** `{caption, description?, platform, contentType, hasAiContent, disclosesPartnership, accountType}`.

| id | tipo | definición |
|---|---|---|
| `repeatedMention` | noul | ¿Repite la misma mención o handle de forma que Instagram suele recortar? |
| `policyRisk` | choice | `none`, `medical_claim`, `financial_claim`, `undisclosed_promotion`, `restricted_topic` |
| `needsAiLabel` | noul | ¿Parece contenido generado por IA que requiere etiqueta según la política vigente? |
| `hookQuality` | score (4) | Sobre los primeros 2 segundos de copy |

**Umbrales.** `policyRisk ≠ none` con confianza > 0,7 → **bloquea** con explicación y ofrece editar. 0,4–0,7 → advierte, deja publicar. `hookQuality` bajo → sugerencia blanda, **nunca** bloqueo.
**Requisito de latencia (único `DP` síncrono):** timeout duro. Si el puerto no responde, **se publica igual**. Un pre-flight caído no puede impedir que el usuario use el producto.
**Qué hace el LLM:** si el usuario acepta corregir, el LLM reescribe. El juicio detecta; el LLM arregla.
**Riesgo propio:** falsos positivos que bloqueen publicaciones legítimas. Por eso sólo `policyRisk` bloquea y con umbral alto.
**Métrica:** caída en posts con `errorCode` de plataforma y en `captionAdjustmentReason`.

---

### JV-4 — Verificador de campos de marca · `DP-004` · **M**

**Estado:** `{fieldName, derivedValue, sourceExcerpt, sourceType}` — un juicio por campo.

| id | tipo | definición |
|---|---|---|
| `supported` | noul | ¿El extracto respalda esta afirmación, sin suponer nada que no esté ahí? |
| `specificity` | score (3) | `genérico` / `parcialmente específico` / `específico de este negocio` |

**Mapeo a `fieldMeta.confidence`:** `supported > 0.85` y `specificity ≥ 2` → `high`. `supported > 0.6` → `medium`. Resto → `low` ⇒ el campo entra en `Worth a quick check` (`FR-011.2`) o dispara la pregunta de cierre de huecos (`FR-011.3`).
**División de trabajo:** el LLM **deriva** el campo; el juicio **verifica** que esté respaldado.
**Por qué importa más de lo que parece:** es lo que convierte la regla *"nunca inventar"* de `AI-016` en algo verificable en vez de una aspiración.
**Métrica:** sobre 50 perfiles etiquetados a mano, ¿coincide el `low` con los campos que un humano marcaría como flojos?

---

### JV-5 — Clasificador de tono de respuesta · `DP-003` · **S**

**Estado:** `{replyText, threadContext, brandName}`.
**Pregunta:** `promoLevel` → choice: `value_add`, `subtle_mention`, `direct_promo`.

**El punto es la división de trabajo.** El juicio etiqueta **una** respuesta. El ratio, el histórico y el nivel del medidor (`Safe` / `Caution` / `Warning` / `Danger`) los calcula **código**. Es el ejemplo más limpio de la frontera de §25.2: contar no es juzgar.
**Esfuerzo:** el más bajo de la lista — una pregunta, tres valores.
**Métrica:** acuerdo con etiquetado humano sobre 100 respuestas.

---

### JV-6 — Rerank marca ↔ candidato · `DP-005` · **M/L**

Ordenar candidatos por encaje real con la marca en vez de filtrar por nicho.

**Diseño:** shortlist por código (nicho + recencia + engagement, ~30 candidatos) → un juicio por par marca-candidato → ordenar.
**Pregunta:** `fits` → noul: ¿el formato y el ángulo de este contenido funcionarían para esta marca sin forzar la relación?
**Dependencia:** **requiere `JV-1`** — sin taxonomía no hay shortlist.

**El mismo mecanismo aplica a tres librerías distintas**, y esto es lo que lo hace valioso:
1. Contenido en tendencia a remixar (`DP-005`).
2. **Personajes AI UGC** (1.000+ según `[WWW]`) — hoy el PRD los selecciona con `genderFilter` y sets, o sea casi al azar.
3. **Videos UGC humanos** (2.000+) — mismo problema.

**Métrica:** tasa de aceptación en Blitz (swipe derecha) contra el método de pesos actual. Es A/B limpio.

---

### Resumen y orden sugerido

| Feature | DP | Esfuerzo | Habilita algo nuevo | Depende de | Fase |
|---|---|---|---|---|---|
| JV-1 | DP-001 | S/M | ✅ desbloquea `F-041` | OCR | 2 |
| JV-2 | DP-002 | M | ✅ desbloquea `FR-140` | OAuth Reddit | 4 |
| JV-3 | DP-007 | M | ✅ EXT-007 | — | 4 |
| JV-4 | DP-004 | M | ✅ hace verificable `AI-016` | `AI-016` | 2 |
| JV-5 | DP-003 | S | mejora previsto | JV-2 | 4 |
| JV-6 | DP-005 | M/L | mejora previsto | **JV-1** | 4 |

`DP-006` no tiene feature propia: se resuelve con tabla determinística y sólo escala al puerto lo que no matchea.

## 25.4 Validación antes de activar cualquier adaptador no-LLM

El `LlmJudgmentAdapter` es el baseline y no necesita validación previa. **Activar `JevJudgmentAdapter` en un `DP` exige pasar este experimento, por punto de decisión.**

**Primero `DP-001`**, no por ser el de mayor impacto —`DP-002` y `DP-007` lo son— sino porque es **el único validable sin que el producto exista**: offline, sin usuarios, sin frontend, sin restricción de latencia.

| | |
|---|---|
| **Dataset** | 250 items en tendencia procesados a texto (caption, hashtags, OCR, métricas). **50 en español.** Etiquetado humano: nicho, formato, remixable, brand-safe. ~1 día. |
| **Baselines** | (a) reglas por keywords sobre hashtags — el piso; (b) `LlmJudgmentAdapter` — el techo de calidad y el costo a batir. |
| **Medir** | acierto por dimensión · **calibración** (diagrama de fiabilidad) · costo/1.000 items · latencia p50/p95 · **español vs. inglés** · sensibilidad al tamaño del estado. |
| **Esfuerzo** | 2–3 días. |

**Criterios para activar** — las cuatro:
1. Acierto en `niche` y `format` ≥ baseline LLM − 5 pp.
2. Costo ≤ 1/10 del baseline LLM, **medido**.
3. **La calibración se sostiene.** Sin esto, todos los umbrales de §25.3 son humo. Es el criterio más importante.
4. Brecha español↔inglés < 10 pp.

**Parar si:** la calibración no se sostiene, o el acierto queda por debajo de las reglas por keywords, o la latencia p95 supera 1 s en batch.

Ver `EVAL-JEV.md` para el análisis completo del proveedor evaluado, sus claims verificados y no verificados, y los riesgos con sus mitigaciones.

---

# Auditoría final de completitud

Verificado antes de la entrega:

1. **Inventario de `/docs`** — los 9 archivos están listados en §0.2 con duración, resolución, audio y marca; **los 9 fueron analizados** (633 frames extraídos, 284 distintos revisados visualmente + 8 transcripciones de narración; `manual-creation-demo.mp4` no tiene pista de audio).
2. **Cada video está citado con timestamps** en §5, §6, §7 y §22.
3. **Inventario de features de Fastlane** — 130 features (`F-001`…`F-258`) agrupadas en 17 módulos; todas aparecen en la Traceability Matrix (§22) con fuente y evidencia.
4. **Rutas** — las 80+ rutas del bundle están en el sitemap (§3.1), incluidas las internas marcadas fuera de alcance.
5. **Catálogo de formatos** — los 22 formatos con su `id`, `label`, `description` y `path` literales.
6. **API** — los 29 endpoints REST, los 8 tools del connector OAuth y los 34 tools del servidor MCP están enumerados.
7. **Enums** — estados de Content (3), Post (10), Automation (8), Slot (10), influencer (5), media (3), posting availability (3), privacy level (4), categorías de media (5), presets de caption (7), familias tipográficas (12).
8. **Precios y límites** — transcritos literalmente de la fuente oficial; las discrepancias se marcaron UNKNOWN en lugar de resolverse por invención.
9. **Parity Matrix** (§23) — recorrida entera; las 12 filas con hueco tienen su Open Question correspondiente.
10. **Ninguna inferencia se presenta como hecho:** cada afirmación lleva CONFIRMED, SUPPORTED, INFERRED o UNKNOWN.

**Divergencias deliberadas del clon respecto a Fastlane.** Todas están indexadas en **§2.6** con su ID `EXT-XXX`, marcadas `EXTENSION` allí donde se especifican, y listadas en las matrices de trazabilidad (§22) y de paridad (§23) para que no se confundan con omisiones ni con hallazgos:

- **`EXT-001` — Brand Sources multi-origen (la principal).** El alta deja de exigir una página web: la identidad de marca puede extraerse de un perfil de **Instagram, TikTok, X, YouTube o LinkedIn**, o de cualquier enlace público. Especificada en `FR-011` (+ `FR-010`, `FR-020`, `DATA-031/032`, `AI-016`, `INT-014`…`INT-018`, §9.14, `FLOW-009`), con su propio conjunto de estados de error (§19.5.1), eventos (§18) y preguntas abiertas (`OQ-16`…`OQ-18`).
- `EXT-002` — webhooks salientes además del polling (OQ-11).
- `EXT-003` — sección `members` en Settings con matriz de permisos explícita (OQ-01, OQ-02).
- `EXT-004` — audit log visible para acciones destructivas y facturables (§9.12).
- `EXT-005` — caps configurables por plan en vez de hardcodeados (OQ-14).
- `EXT-006` — recorte inteligente en slideshows en lugar de `stretch-to-canvas` (el original documenta la distorsión como limitación conocida de su v1).
- **`EXT-007` — pre-flight de publicación** (`JV-3`): avisar antes de programar en vez de descubrir el fallo después de publicar. §25.
- **`EXT-008` — Judgment layer** (decisión D-05): puerto `Judgment` en §9.15 y catálogo de puntos de decisión `DP-001`…`DP-007` con sus features `JV-1`…`JV-6` en **§25**. Es el mecanismo que faltaba para las decisiones semánticas que este PRD especificaba sin motor: `F-041` (etiquetado del catálogo), `FR-140` (scoring de leads), `AI-016` (confianza por campo). El análisis del proveedor evaluado —claims verificados, no verificados y riesgos— está en `EVAL-JEV.md`.

**Decisiones de producto cerradas** (D-01…D-04) en **§2.7**, con su log y la resolución explícita de la tensión entre D-01 (el alta no pide OAuth) y D-04 (importar media, que sí lo requiere). Están propagadas a `FR-011`, `AI-016`, `INT-015`/`INT-016`, `FLOW-009`, §18, §21 y §24.

**Verificación de la disciplina de evidencia tras incorporar las extensiones:** se comprobó por búsqueda dirigida sobre `OnboardingPage-CkGMzzCf.js` y sobre el corpus completo de strings de UI que Fastlane **no** tiene análisis de perfiles sociales en el alta — sus únicos caminos son `Company Website` y `Use description instead`. Por tanto `EXT-001` se etiqueta como extensión y **en ningún punto del documento se presenta como observación del original**.

---

*Fin del PRD. Generado el 2026-09-21 a partir de investigación directa del producto (bundle de producción de `app.usefastlane.ai`), documentación oficial (`developers.usefastlane.ai`, `usefastlane.ai/llms-full.txt`, páginas de producto y precios) y el análisis frame a frame y de narración de los 9 videos de `/docs`.*
