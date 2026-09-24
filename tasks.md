# tasks.md — FastGram

Checklist ejecutable de todas las fases. **Cada agente tacha lo que termina.**

- **Qué** construir → [`PRD.md`](PRD.md)
- **Cómo** → [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md)
- **Dónde está parado el proyecto** → [`docs/HANDOFF.md`](docs/HANDOFF.md)

---

## Cómo usar este archivo

### Estados

| Marca | Significado |
|---|---|
| `- [ ]` | pendiente |
| `- [~]` | en curso — **agregá tu identificador y la fecha**: `- [~] **P1-EPIC-000** … · @agente-3 2026-09-22`  ← `P1-EPIC-000` es un ID de ejemplo, no existe |
| `- [x]` | terminado y mergeado |
| `- [!]` | **bloqueado** — agregá el motivo en una línea indentada debajo |

### Reglas

1. **Reclamá antes de empezar.** Poné `[~]` con tu identificador en el mismo commit en que arrancás. Evita que dos agentes hagan la misma tarea.
2. **Una tarea = un PR.** El título del PR arranca con el ID: `P1-EPIC-000: título corto`.
3. **No tachés sin la Definition of Done** (abajo). Un `[x]` mentiroso hace que nadie confíe en el archivo, y entonces el archivo no sirve para nada.
4. **Respetá las dependencias** (`dep:`). Si una dependencia está abierta, la tarea no está lista para empezar.
5. **Si una tarea resulta mal definida, corregila acá** en vez de improvisar en el código. Este archivo también se mantiene.
6. **Si encontrás algo que el PRD no cubre, no lo inventes:** abrí una `OQ-XX` nueva en el PRD §24 y dejá la tarea `[!]`.
7. **Al cerrar tu sesión**, seguí el protocolo de `docs/HANDOFF.md` §0: session doc, handoff, y actualizar el general.

### Definition of Done (aplica a toda tarea de código)

- [ ] Tests que fijan **los números del PRD** cuando la tarea tiene alguno (caps, rangos, enums, estados)
- [ ] Tipos estrictos, sin `any` sin justificar
- [ ] Errores de proveedor traducidos a códigos estables (nunca se propaga el crudo)
- [ ] Todo acceso a datos con scope de `companyId`; cross-tenant devuelve **404**
- [ ] CI en verde: lint, typecheck, unit, integración, `dependency-cruiser`
- [ ] Si toca contrato público: `packages/contracts` actualizado y OpenAPI regenerado
- [ ] Si toca UI: estados `empty`, `loading`, `error` implementados (PRD §19)
- [ ] Sin secretos en el código ni en los docs

### Convención de IDs

`P<fase>-<ÉPICA>-<nnn>`. Los IDs son **estables**: si una tarea se cancela se marca `~~tachada~~` con el motivo, no se reutiliza el número.

La sección **PU** usa `PU-<ÉPICA>-<nnn>` y **va primero en el orden de trabajo** (decisión del dueño, 2026-09-24).

---

# PU — Uso personal (prioridad actual)

> **Plan completo y porqué:** [`docs/PLAN-USO-PERSONAL.md`](docs/PLAN-USO-PERSONAL.md) · decisiones `D-06`…`D-16` en PRD §2.7.
> **Criterio de salida:** levanto la app con un comando, doy de alta varias marcas, la IA llena
> Blitz, apruebo (o la marca va en piloto), y cada pieza se publica sola en IG/Threads/FB/X y queda
> como borrador en TikTok, en su horario.
>
> Cuando una tarea `PU` cubre una tarea `P*` existente, se cita (`= P2-BLITZ-001`) y **se tachan las dos juntas**.

## Sprint 1 — Arranca y genera

- [x] **PU-RUN-001** `pnpm start`: levanta infra, migra, render (con fuentes), API, worker y web **en orden**, con el secreto de render efímero y compartido; un solo Ctrl+C baja todo
- [x] **PU-RUN-002** Modo `personal` (`FASTGRAM_MODE=personal`): sin cuotas ni rate limiting, API y web atadas a `127.0.0.1` · `D-06`
- [x] **PU-RUN-003** La web obtiene su key sola al arrancar (sin copiar `FASTGRAM_API_KEY` a mano); vive sólo en el entorno del proceso de la web, nunca en disco
- [x] **PU-MODEL-001** Registro de modelos **por tarea** (texto, juicio, visión, imagen, video, recorte) con presets OpenRouter / DeepSeek / Groq / Cerebras / Gemini / Ollama / LM Studio; keys sólo en entorno o `~/.fastgram/` · `D-14`, `ADR-009`
- [x] **PU-MODEL-002** Pantalla `Settings → Modelos`: elegir proveedor y modelo por tarea, probar conexión, ver gasto estimado del mes
- [x] **PU-UI-001** Shell 2026: sidebar compacta con **selector de marca**, `⌘K`, oscuro por defecto, transiciones · ⚠️ dependencias nuevas las instala el coordinador
  > Hecho (`88fc15f`) y visto con capturas el 2026-09-24 (Brands, Blitz, Calendar, Brand).
- [x] **PU-BRAND-001** Crear / cambiar / borrar marcas (workspaces) sin auth · `D-07` · cubre parte de `P1-TENANT-001/002/005`
- [x] **PU-BLITZ-001** Deck de Blitz con gestos, teclado y chips · `= P2-BLITZ-001…006`, `P2-BLITZ-013`
- [x] **PU-BLITZ-002** Aceptar en Blitz → pieza construida y visible en Library · `= P2-BLITZ-012`, cierra `P2-BLITZ-014`
  > **Verificado de punta a punta el 2026-09-24:** Ollama qwen2.5 7B configurado desde `/settings/models` → refill de 5 sugerencias → deck → `→` → Save to Library → build `CREATED` → slide 1080×1350 legible. Sin simular nada.
- [x] **PU-MEDIA-001** **Subir media desde la UI** (Library → Media Bank): drag & drop de varias imágenes y videos, progreso, categorías · ⚠️ sin esto una marca nueva no tiene con qué generar
- [x] **PU-MEDIA-002** **Fondos de marca generados localmente**, sin keys: imágenes (degradés y formas con la paleta de la marca) y videos cortos en loop para wall-of-text, categorizados solos · para que Blitz funcione desde cero

## Sprint 2 — Edito y agendo

- [x] **PU-EDIT-001** **Decidir y documentar en el PRD el mapeo editor→px** (decidido 2026-09-24, PRD FR-051) (propuesta: posición y ancho en % del lienzo; fuente y contorno × `canvas.width/360`) · cierra `P2-CONTENT-004`
- [x] **PU-EDIT-002** Las ediciones llegan al video (rebuild con las cajas editadas) · dep: PU-EDIT-001
- [x] **PU-EDIT-003** Editor inline: caption, texto, fondo, música, meme/asset · `= P2-BLITZ-007…011`
- [x] **PU-EDIT-004** Preview en vivo en el cliente con la misma escala que el render (lo que ves es lo que sale)
- [x] **PU-BLITZ-003** **Crear desde prompt**: tema → pieza de cualquier formato, incluido green-screen con meme de la biblioteca + fondo de marca · `EXT-009`
- [x] **PU-CAL-001** Aprobar → **auto-slot** en el próximo horario libre de la estrategia de la marca
- [x] **PU-CAL-002** Calendario semana/mes, drag & drop, filtro por marca o todas · completa `P2-CAL-001…003`
- [x] **PU-BRAND-002** Estrategia por marca: redes, piezas/día por red, horarios, mix de formatos, idioma, **autonomía manual/piloto** · `D-08`
- [x] **PU-BRAND-003** Alta de marca de punta a punta (web + perfiles → revisión) · usa `P1-ONB-*` existentes

## Sprint 3 — Se publica solo

- [x] **PU-RUN-005** **URL pública para la media** con **Cloudflare Tunnel** (`D-17`) · ⚠️ IG y las fotos de TikTok la traen por URL
- [x] **PU-PUB-001** Tokens de redes cifrados en reposo · `= P3-OAUTH-007`
- [x] **PU-PUB-002** App de Meta: conectar IG (Instagram Login) y FB/Threads (Facebook Login) por marca · `= P3-OAUTH-003`
- [x] **PU-PUB-003** Adaptador Instagram: reel, carrusel e imagen · `= P3-SCHED-008`
- [x] **PU-PUB-004** Adaptadores Threads y Facebook Pages (reels)
- [x] **PU-PUB-005** Adaptador X (pago por uso; sin links en el texto por defecto)
- [x] **PU-PUB-006** TikTok **Upload → `IN_USER_INBOX`** + aviso "terminalo en la app" + marcar hecho · `D-10` · `= P3-OAUTH-002`
- [x] **PU-PUB-007** Guardas anti-bot: tope por red y día (default 3), jitter ±7 min, separación entre cuentas, nunca la misma pieza en dos marcas · `D-11`
- [x] **PU-PUB-008** Reintentos, reconexión y aviso de fallo · `= P3-PUB-002`, `P3-OAUTH-008`
- [x] **PU-UI-002** Pantalla **Hoy**: lo que se publica hoy, lo que espera aprobación, fallos y borradores de TikTok

## Sprint 4 — Memes e IA generativa

- [x] **PU-MEME-001** Importar video o audio por link (`yt-dlp`) al Media Bank · `D-12`
- [x] **PU-MEME-002** Recorte de fondo: chromakey local si es verde; BiRefNet (fal) → video con alfa si no; el render compone el alfa
- [x] **PU-MEME-003** Etiquetado automático de clips (emoción, situación, duración) con un modelo con visión
- [x] **PU-MODEL-003** Puerto `ImageGen` + adaptadores Higgsfield y fal · copiar el resultado a storage propio (Higgsfield lo guarda 7 días)
- [x] **PU-MODEL-004** Puerto `VideoGen` + adaptadores Higgsfield y fal (Kling/Wan/Seedance/LTX)
- [x] **PU-MODEL-005** Costo estimado antes de generar + **tope mensual** que corta la generación
- [x] **PU-SCRAPE-001** Extractores IG / TikTok / X con el scraper open source elegido, **auditado a mano**, **sin cuentas logueadas** · `D-13` · `= P1-BRAND-007…009`
- [x] **PU-SCRAPE-002** IG Business Discovery como vía oficial cuando la cuenta califica


> **Estado 2026-09-24 (sprints 1–4, `1465d07`):** todo lo `[x]` de arriba tiene tests y `verify`/`test:int` verdes.
> **Verificado en el navegador con la app real:** marcas, modelos (Ollama), análisis de web, kit de fondos automático, Blitz (deck, prompt, Edit, Schedule Post), editor (la edición llega al video), calendario, Today, Integrations, Connections, AI Studio (estado sin key), Regenerate (LLM real).
> **Sin probar contra el mundo real** (faltan credenciales del dueño): OAuth y publicación en IG/Threads/FB/X/TikTok, Higgsfield, fal, túnel `pnpm start --tunnel` completo.

## Sprint 5 — Piloto automático

- [x] **PU-AUTO-001** Generación continua por marca: mantiene la cola según la frecuencia de su estrategia
- [x] **PU-AUTO-002** Piloto: pre-chequeo (`JV-3`) → aprobación automática → calendario · `= P4-JV-001/002`
- [x] **PU-AUTO-003** Resumen diario (qué se generó, qué se publicó, qué falló)
- [x] **PU-AUTO-004** Métricas de vuelta y ajuste de pesos de formatos y ángulos · `= P3-METRIC-001`


> **Estado 2026-09-24, sprints 5–6 (`d368a42`, `327c721`):** piloto, métricas, extractores, deploy.
> **Verificado con la app real:** X por FxTwitter lee el perfil público (20 posts → perfil `partial`); **Instagram anónimo falla (401 "login required")** → cae a tier D (pegar la bio). La vía estable para IG es Business Discovery (necesita conexión de Facebook Login). Deploy: stack completo en Docker, render con fuentes en Linux (32/32) y restore probados.
> **Hallazgo del piloto:** con qwen2.5 7B, "¿menciona otra marca?" deja pasar "Skip the Starbucks line…": usar un modelo de `judgment` más grande antes de poner marcas en piloto.

## Sprint 6 — 24/7

- [x] **PU-RUN-004** Docker Compose completo para un VPS (incluye verificar las fuentes del render en Linux)
- [x] **PU-RUN-006** Backups de Postgres y del bucket, **con un restore probado**

## Después

- [x] **PU-LATER-001** YouTube Shorts (pedir la auditoría de Google **al empezar el sprint 3**, porque tarda)
- [x] **PU-LATER-002** LinkedIn
- [x] **PU-LATER-003** Modelos locales: endpoint compatible con OpenAI (ya funciona) + adaptador ComfyUI
- [x] **PU-LATER-004** Influencers, **sólo si** Higgsfield expone personajes consistentes por API (no verificado)
- [x] **PU-LATER-005** AI Studio sobre `ImageGen` / `VideoGen`
- [x] **PU-LATER-006** Engagement Reddit e Inspiration · `D-15`

## Sprint 7 — Cerrar los huecos contra Fastlane (2026-09-24)

> Una auditoría del backlog P1–P5 contra el código (4 lecturas en paralelo, 96 filas de la Parity
> Matrix) encontró huecos que el uso diario pega de frente. Las tareas `P*` de abajo se cerraron con
> la nota `(s7-X)`; ésta es la vista por feature.

- [x] **PU-S7-001** Todo post sale con caption (derivado por red desde la copy) + captions con IA · agente A
- [x] **PU-S7-002** Programar a mano: redes, caption por red, fecha/hora, Post now, Reel/carrusel; retry/cancel/reschedule; selección masiva · agente A
- [x] **PU-S7-003** Música: biblioteca de audio por marca, mezcla en el render, Blitz pone pista · agente B · verificado en la app
- [x] **PU-S7-004** Memes desde un prompt: ranking por tema (JV-6), **búsqueda automática en YouTube** con palabras de reacción, preview recortada, meme entero abajo, loop a ≥5 s · agente C + coordinador · verificado en la app
- [x] **PU-S7-005** Marca: JV-4, juicio por punto de decisión, link-in-bio, ángulos, OCR de capturas, perfilado, logo, propuestas · agente D
- [x] **PU-S7-006** Avisos: campana, ntfy/Telegram, banner de conexiones, salud de colas; borrar marca apaga todo · agente E
- [x] **PU-S7-007** Content Studio, custom video, Media Bank con búsqueda/tags/sets, importar posts propios · agente F
- [x] **PU-S7-008** Formatos IA (7/17), influencers (config, templates, regenerar, video), AI Studio con picker, lectores YouTube/LinkedIn · agente G
- [x] **PU-S7-009** Segunda tanda: sub-pasos del análisis, oferta post-análisis, Remixed From en el refill, extraer audio
- [x] **PU-S7-010** Segunda tanda: validación de URLs en `POST /content`, config del influencer en Blitz, formatos IA desde el prompt, miniaturas de video
- [x] **PU-S7-011** Segunda tanda: estados de error de PRD §19 y WCAG AA

---

# P0 — Bootstrap

> No es una fase del PRD. Es lo que tiene que existir antes de poder empezar la Fase 1.

## P0-REPO — Repositorio y tooling

- [x] **P0-REPO-001** `git init`, rama `main`, primer commit con el estado actual (PRD, EVAL, docs, videos)
- [x] **P0-REPO-002** `.gitignore` (node, build, `.env*`, `handoffs/`) · dep: P0-REPO-001
- [x] **P0-REPO-003** Monorepo pnpm + Turborepo con el layout de IMPLEMENTATION-PLAN §2.2 · `ADR-001`
- [x] **P0-REPO-004** **Decidir y documentar el build de FFmpeg** (componentes GPL vs LGPL) y el modelo de licencia del render · `ADR-007` · ⚠️ legal, no sólo técnico · **BLOQUEADO: lo decide una persona, no un agente** · **cerrada 2026-09-24:** decisión del dueño: uso personal, el software **no se distribuye**, así que la licencia del build (GPL o LGPL) no impone obligaciones. Si algún día se distribuye, se reabre
- [x] **P0-REPO-005** `tsconfig` base compartido con `strict: true` · `ADR-002`
- [x] **P0-REPO-006** ESLint + Prettier + `dependency-cruiser` con la regla `core ↛ adapters` que **rompe el build** · IMPL §2.1
- [x] **P0-REPO-007** Vitest configurado en todos los paquetes
- [x] **P0-REPO-008** GitHub Actions: lint, typecheck, test, boundaries. Obligatorio en PR
- [x] **P0-REPO-009** Validación de entorno con Zod: si falta una variable, el proceso **no levanta**
- [x] **P0-REPO-010** `CLAUDE.md` con las reglas del repo y el protocolo de handoff
- [x] **P0-REPO-011** Plantilla de PR que exige el ID de tarea y la checklist de DoD
- [x] **P0-REPO-012** `docker-compose` de desarrollo: Postgres + MinIO (S3 local) + el servicio de visión
- [x] **P0-REPO-013** Los paquetes internos emiten `dist`; `node dist/main.js` arranca
  > Cerrada como pedía la tarea: **corriendo el binario**, no con que `tsc` no se queje. `GET /health` → 200, `GET /api/v1/content` sin credencial → 401, con credencial → 200, y un `POST /content` que crea la fila **y deja el job en `pgboss.job`**.
  > **La complicación de `packages/db` tenía una cuarta salida que la tarea no listaba** y es mejor que las tres: apuntar drizzle-kit al **schema compilado** (`dist/schema/index.js`). Verificado — drizzle-kit lo carga sin problema, porque ahí ya es JavaScript. Así `db` y `contracts` pueden llevar `.js` en sus imports como el resto y no hace falta ni bundling ni CJS.
  > `@fastgram/ui` es la única excepción y sigue exportando fuente: su único consumidor es Next, que empaqueta. La razón está escrita en su `index.ts`.
  > **Trampa que dejó, y es la parte que casi pasa inadvertida:** con `exports` apuntando a `dist` —que está excluido del cruise— dependency-cruiser dejó de ver el grafo entre paquetes. Las dependencias cruzadas cayeron de 1019 a 949 y **`pnpm boundaries` siguió en verde**, con todas las reglas sin comprobar nada. Se arregla con los alias **pelados** en `tsconfig.base.json` y lo cubre un invariante nuevo de consistencia.

---

# P1 — Foundation

> **Criterio de salida:** un usuario nuevo se registra, introduce una web **o un perfil de Instagram/TikTok**, obtiene Company Profile y entra a un dashboard funcional. El camino social se completa **sin pedir OAuth en ningún momento** (`D-01`).

## P1-INFRA — Infraestructura y costos

- [x] **P1-INFRA-001** **Modelo de costos medido**: egress, CPU de render, GPU, tokens, ASR/OCR. Resultado fechado en `docs/HANDOFF.md` · IMPL §5 · ⚠️ ninguna cifra se asume
- ~~**P1-INFRA-002** Entornos `dev` / `staging` / `prod` con IaC~~ · **fuera de alcance:** D-16 (Mac → VPS con Compose, sin IaC multi-entorno)
- [x] **P1-INFRA-003** Postgres gestionado + backups verificados (**probar un restore, no sólo configurarlo**) · **cerrada 2026-09-24:** self-hosted (D-16): backup + restore probado, `deploy/backup/` (PU-RUN-006)
- ~~**P1-INFRA-004** Bucket R2 + CDN + política de ciclo de vida · `ADR-006`~~ · **fuera de alcance:** D-16/D-17 (MinIO + Cloudflare Tunnel)
- [x] **P1-INFRA-005** Pipeline de deploy con rollback · **cerrada 2026-09-24:** `deploy/update.sh` (backup → tag por commit → `--wait`) y `deploy/rollback.sh [--restore]`; sin probar contra un VPS real
- [x] **P1-INFRA-006** Gestión de secretos (no en el repo) · **cerrada 2026-09-24:** `~/.fastgram` 0600, `<VAR>_FILE`, `.env.local` ignorado (PU-RUN-001/004)

## P1-DATA — Modelo de datos

- [x] **P1-DATA-001** Drizzle + primera migración + repositorios base · `ADR-004`
- [x] **P1-DATA-002** `User`, `Company`, `WorkspaceMembership` · `DATA-001`…`DATA-003`
- [x] **P1-DATA-003** `CompanyProfile` con `fieldMeta` · `DATA-004`
- [x] **P1-DATA-004** `BrandSource` + `BrandSourceSnapshot` · `DATA-031`, `DATA-032`
- [x] **P1-DATA-005** `QuotaLedger` · `DATA-029`
- [x] **P1-DATA-006** `IdempotencyRecord` · `DATA-027`
- [x] **P1-DATA-007** `UploadReservation` · `DATA-028`
- [x] **P1-DATA-008** `OnboardingRecord` · `DATA-030`
- [x] **P1-DATA-009** `JudgmentRecord` · `DATA-033`
- [x] **P1-DATA-010** **Row Level Security** por `companyId` en todas las tablas de cliente · IMPL §2.4
- [x] **P1-DATA-011** Índices `(companyId, createdAt)` y helper de paginación por cursor · PRD §9.10
- [x] **P1-DATA-012** Soft-delete transversal, excluido por defecto de todo listado · PRD §9.4
- [x] **P1-DATA-013** Habilitar `pgvector` (lo usa `FR-150` en P3) · `ADR-003`
- [x] **P1-DATA-014** **Métodos de escritura con scope en los repositorios** · desbloqueó los 16 endpoints
  > `create` / `createMany` / `update` / `upsert` / `hardDelete` en `repositories/base.ts`, más `filters.ts` (filtro declarativo, **data y no SQL**, porque `drizzle-orm` no es alcanzable desde `apps/api`), `catalog.ts` (`audio_tracks`, el único repositorio sin scope del sistema) y `listByPage` para el `Page X of Y` de §9.10.
  > La propiedad que lo sostiene: **`companyId` no está en el tipo de los valores**. `create` lo inyecta desde el scope, `update` lo rechaza. No es que no debas escribir en otro workspace: no tenés dónde poner el campo.
  > 19 tests de integración corriendo **como `fastgram_app`**, cada aserción de acceso cruzado con su pareja que relee la fila víctima — el bug que importa no es "devolvió lo que no era", es "devolvió `null` **y** escribió". Verificados rompiendo el `setWhere`, el `deletedAt is null` del update y el `in: []`.
- [x] **P1-DATA-015** Unificar el formato de cursor entre `packages/db` y `apps/api`
  > Borrado `apps/api/src/http/pagination.ts` (+ sus 7 tests). No estaba en uso, pero era un cursor plausible a un import de distancia, con otro payload interno (`{createdAtMs, id}` contra `"<ISO>|<id>"`). Gana el de `db`, que es el que los repositorios saben decodificar.

## P1-AUTH — Identidad

- ~~**P1-AUTH-001** Puerto `Identity` + adaptador Better Auth · `ADR-008`~~ · **fuera de alcance:** D-06 (un usuario, sin auth; queda la rama `auth-y-suscripciones`)
- ~~**P1-AUTH-002** Signup / login / logout · `F-001`…`F-003`~~ · **fuera de alcance:** D-06 (un usuario, sin auth; queda la rama `auth-y-suscripciones`)
- ~~**P1-AUTH-003** SSO + callback `/auth/sso-callback` · `F-002`~~ · **fuera de alcance:** D-06 (un usuario, sin auth; queda la rama `auth-y-suscripciones`)
- ~~**P1-AUTH-004** Sesiones, refresh, revocación~~ · **fuera de alcance:** D-06 (un usuario, sin auth; queda la rama `auth-y-suscripciones`)
- ~~**P1-AUTH-005** Recuperación de contraseña · `§15.3`~~ · **fuera de alcance:** D-06 (un usuario, sin auth; queda la rama `auth-y-suscripciones`)
- ~~**P1-AUTH-006** Borrado de cuenta con confirmación por email y sus estados · `F-011`, `FR-160`~~ · **fuera de alcance:** D-06 (un usuario, sin auth; queda la rama `auth-y-suscripciones`)

## P1-TENANT — Workspaces

- [x] **P1-TENANT-001** Creación de workspace + límite por usuario · `F-008` · **cerrada 2026-09-24:** PU-BRAND-001; el límite por usuario no aplica (D-06)
- [x] **P1-TENANT-002** Cambio de workspace y contexto activo · `F-009` · **cerrada 2026-09-24:** PU-BRAND-001: `BrandSwitcher` + `X-Fastgram-Workspace`
- ~~**P1-TENANT-003** Roles `owner` / `member`, comprobados **en el servidor** · PRD §4, `FR-002`~~ · **fuera de alcance:** D-06 (un usuario)
- [x] **P1-TENANT-004** Test de contrato: acceso cruzado devuelve **404**, no 403 · `NFR-006`
- [x] **P1-TENANT-005** Borrado de workspace con sus advertencias · `FR-160` · **cerrada 2026-09-24:** borrar marca cancela posts, slots, piloto y campañas en la misma transacción (s7-E, test que falla sin el arreglo)

## P1-QUOTA — Cuotas y rate limiting

- [x] **P1-QUOTA-001** Motor de content saves: incluidos → comprados → overage · PRD §16.2
- [x] **P1-QUOTA-010** **Cablear el cobro a `POST /content`** — el motor existía y ninguna ruta cobraba
  > Faltaban tres piezas, no el motor: de dónde sale el plan (`companyRepository`), qué clave identifica el período, y dónde se guarda el bucket.
  > **`quota_ledgers.period` = `YYYY-MM-DD`, la fecha UTC de inicio del ciclo.** El schema lo dejaba pendiente y lo decide `billingPeriodKey`. No es `YYYY-MM`: §16.2 resetea en el **día ancla**, así que con ancla 15 el ciclo cruza dos meses calendario y la clave tiene que decir *qué ciclo*, no *qué mes*. 14 tests, incluido un barrido de 400 días × 6 anclas que comprueba que todo instante cae en exactamente un período.
  > **`contents.save_bucket` y `save_period`** (migración `0005`), con CHECK de que estén los dos o ninguno: `refundSave` devuelve **al bucket del que salió** y al ledger que lo cobró, y los tres buckets tienen precio distinto.
  > El cobro va **antes** de crear y de encolar, y dentro de la misma transacción. `quotaLedgerStore.lockPeriod` usa `SELECT … FOR UPDATE`; sus dos tests de concurrencia se ponen rojos si se le quita.
- [x] **P1-QUOTA-002** Swipes diarios con reset 00:00 UTC · `F-066`
- [x] **P1-QUOTA-003** Créditos de AI Studio
- [x] **P1-DATA-016** **Columnas del cargo de créditos en `influencers`** + `posts.external_post_id` · `FR-080`, `NFR-015`
  > Tres CHECK, uno más de los dos pedidos: `credits_charged > 0`, porque un cargo de cero no es un cargo y uno negativo **le quita** créditos al cliente cuando se "devuelve".
  > **`claimCreditsRefund` marca y devuelve el cargo en la misma sentencia**, que es una respuesta directa a la trampa 24: no hay "preguntar" antes de "devolver", así que no se puede escribir el camino en el orden equivocado. Verificado: reemplazándolo por `SELECT`+`UPDATE`, el test de concurrencia da `expected [Array(2)] to have a length of 1`.
  > **Hallazgo grande: los tests de cross-tenant del paquete medían RLS, no el `WHERE`.** Corren como `fastgram_app` con el GUC puesto, así que la capa 1 tapa el agujero y la capa 2 nunca se mide. Confirmado sobre `lockContent`, que era mío: sin el `companyId`, los 146 tests siguieron verdes. Los tres repositorios nuevos y `content-build` ganan un test que corre **sin RLS de por medio**.
  > `posts.external_post_id` sin índice a propósito: todo acceso entra por `company_id`, y un índice invitaría a buscar sin tenant.
- ~~**P1-QUOTA-011** **Cablear el cobro de créditos a `POST /influencers`** (250, `AI_STUDIO_COST.influencer`) · `FR-080`, §9.4 · **parcial:** cobra y libera; lo que falta es el saldo~~ · **fuera de alcance:** D-06 (sin créditos)
  > **Dos afirmaciones de esta nota murieron y conviene saber cuáles.** Decía que «nadie libera todavía — el handler de `influencer-pipeline` no existe»: existe desde `058668e`, devuelve los 250 con `claimCreditsRefund` y tiene test de integración. Y decía que el cargo vivía en `internal_refs` de forma interina: la migración `0007` le puso columnas tipadas con tres CHECKs.
  > **Lo que sigue en pie:** `ai_credits` cuenta consumidos y no saldo, falta `ai_credits_purchased`, y `inFlightCount` cuenta sólo influencers.
  > **`ai_credits` cuenta consumidos, no saldo.** La fila del período la crea quien llega primero y dos de los tres caminos la crean con el default `0`; con semántica de saldo, un workspace Growth que guardó contenido antes arrancaría el período en 0 y **todo influencer daría 402**, sin poder distinguir "nunca se sembró" de "se gastó todo". Falta `ai_credits_purchased` para el `Buy more`.
  > **`inFlightCount` es parcial y está dicho como tal:** `NFR-025` acota imágenes + videos + influencers juntos y sólo se puede contar el tercero (no hay tabla de generaciones). Se cuenta la mitad que más cuesta; un `0` silencioso habría vuelto el cap decorativo.
  > El cargo se anota en `internal_refs` (jsonb) y **es interino**: faltan columnas tipadas con CHECK en `influencers`. Riesgo concreto: `update(..., {internalRefs})` **reemplaza** el jsonb entero, así que el worker que escriba `soulId` ahí borra el registro del cargo sin que nada falle.
- [x] **P1-QUOTA-004** Trial allowance **de por vida**, compartida entre workspaces personales, sin reset · PRD §16.2
- [x] **P1-QUOTA-005** **Reembolso de content save cuando el build falla** · `FR-050` · ⚠️ regla de negocio explícita
- [x] **P1-QUOTA-012** **El saldo comprado se arrastra entre períodos** — §16.2 dice que no caduca · `FR-050`
  > Lo arrastra `lockPeriod` al crear el período, **no** el job de reset: si lo hiciera el cron, el saldo de un cliente dependería de que el cron haya corrido (decisión 7 de §5). Así depende de la primera petición del ciclo, que es la que lo va a usar.
  > **El arrastre va dentro del INSERT.** El `ON CONFLICT DO NOTHING` es lo único que serializa a dos creadores concurrentes; fuera de esa sentencia, las dos suman. Medido: con el arrastre en un paso aparte, tres transacciones concurrentes dan `expected 15 to be 5`.
  > `NewPeriodDefaults.contentSavesPurchased` **se eliminó** en vez de cablearse: era un opcional que nadie pasaba y mantenía abierta la única forma de volver a perder el saldo. Por eso `apps/api` no necesitó ningún cambio.
  > **Ventana residual, documentada y sin pagar:** el período anterior se lee sin bloquear, así que un reembolso a `purchased` del ciclo viejo que se confirme entre el snapshot del INSERT y su commit no viaja al nuevo. El arreglo cuesta un lock más en **toda** creación de contenido.
- [x] **P1-QUOTA-013** Handler de `quota-reset` (§9.5 #17): barrido de `dailySwipesUsed` vencido
  > **`withoutCompany` NO alcanzaba — trampa 16 por cuarta vez.** `quota_ledgers` tiene `FORCE ROW LEVEL SECURITY`; sin el GUC, `app.current_company()` es NULL y un `UPDATE` pelado afecta **cero filas sin error**. En desarrollo la conexión es superusuaria, saltea RLS y el barrido *parece* andar. Verificado contra la base: `UPDATE` pelado como `fastgram_app` → 0 filas; la función `SECURITY DEFINER` → 1 fila.
  > Barre **un** contador y la lista de lo que NO hace está escrita: no reinicia content saves (su reset *es* la clave del período; un `UPDATE` sobre la fila vieja reescribiría una factura cerrada), no arrastra saldo, no crea el período siguiente, y **ignora el payload** para que nadie apunte un barrido cross-tenant desde la cola.
  > Los dos instantes son parámetros porque `date_trunc('day', ts)` sobre `timestamptz` trunca en la zona de la **sesión**, no en UTC.
  > **Sin verificar:** que el cron *dispare* el handler (la programación queda en `pgboss.schedule` en UTC, pero nadie esperó un 00:00). Y el barrido no encuentra nada hoy: `writeDailySwipes` no tiene ni un llamador.
- [x] **P1-QUOTA-006** Orden de evaluación: el gate de saves **antes** que el cap de swipes · PRD §16.2
- [x] **P1-QUOTA-007** Rate limiting token-bucket por workspace, con `Retry-After` y `details.retryAfterMs` · `NFR-009`
- [x] **P1-QUOTA-008** `503 service_unavailable` cuando el límite no se puede comprobar (≠ 429) · `NFR-009`
- [x] **P1-QUOTA-009** Caps **configurables por plan**, no hardcodeados · `EXT-005`, `OQ-14`
  > `capsForPlan(planId)` + `PLAN_CAP_OVERRIDES`, y las aserciones de `workspace/caps.ts` y `angles/angles.ts` aceptan los caps como parámetro **opcional y último**, para no romper las ~30 llamadas que hoy no conocen el plan.
  > **`PLAN_CAP_OVERRIDES` está vacío y hay un test que exige que siga vacío.** `EXT-005` pide el mecanismo; `OQ-14` dice que los números por plan se desconocen y que "varían por plan" es una *hipótesis*. Llenarlo con valores plausibles borraría la diferencia entre "no lo sabemos" y "lo inventamos". Cuando haya evidencia: override + `OQ-14` actualizada en el PRD + test ajustado, los tres pasos.

## P1-QUEUE — Colas y jobs

- [x] **P1-QUEUE-001** Puerto `Queue` + adaptador pg-boss · `ADR-005`
- [x] **P1-QUEUE-002** **Encolar dentro de la transacción de negocio** + test que lo prueba · IMPL §2.3 · es la razón de ADR-005
  > 9 tests de integración en `packages/adapters/src/queue/pg-boss-transaction.int.test.ts`, por la vía real (Drizzle sobre postgres.js) y no por el ejecutor interno de pg-boss.
  > **Por esa vía no funcionaba.** Tres causas, todas medidas: (1) pg-boss deja parámetros `undefined` que postgres.js rechaza —arreglado adentro—; (2) `drizzle()` le pone la identidad a los serializadores de `jsonb` del cliente **compartido**, y el handle de la transacción no expone `.options`, así que no se puede autodetectar; (3) el bridge por defecto no reconocía el handle de Drizzle, que es el que `core` propaga.
  > (2) y (3) se resuelven con un puente **con nombre** que el cableado elige a mano: `drizzleTransactionToExecutor`.
- [x] **P1-QUEUE-007** **Verificar que `fastgram_app` puede encolar** dentro de `withCompany`
  > **No podía.** `ERROR: permission denied for schema pgboss`, reproducido a mano. Las cuatro rutas que encolan fallaban en producción y andaban en desarrollo, que es la tercera vez que aparece esta clase de bug en el proyecto.
  > Arreglado en la migración `0004_queue_grants.sql`, con `ALTER DEFAULT PRIVILEGES` y no `GRANT ON ALL TABLES`: pg-boss crea sus tablas después y en otro proceso, así que un grant sobre "todas" no encontraría ninguna y **no fallaría**. 4 tests, verificados rompiendo el `ALTER`.
- [x] **P1-QUEUE-003** Estado de job consultable + contrato de polling de ~10 s · `NFR-002`, `ADR-014`
- [x] **P1-QUEUE-004** Reintentos con backoff y dead-letter queue
- [x] **P1-QUEUE-005** Idempotencia: `Idempotency-Key`, replay de respuesta, `409` con body distinto, liberación al fallar · `NFR-004` · cableada a las cuatro rutas que §9.3 exige (`POST /content`, `PATCH /content/:id`, `POST /content/:id/regenerate`, `POST /influencers`)
  > La nota que vivía acá decía que «el replay nunca se ejerció de punta a punta». **Era falsa** (auditoría del 2026-09-22): `apps/api/test/write-routes.int.test.ts:111` hace exactamente eso, y cubre además el 409 con body distinto (`:136`) y la liberación de la key al fallar (`:155`). Se suman `quota.int.test.ts:117` e `influencer-credits.int.test.ts:184`.
- [x] **P1-QUEUE-006** Scaffold del `apps/worker`
- [x] **P1-QUEUE-008** Handler de `content-build` en `apps/worker`: construye, sube y cierra `BUILDING → CREATED|FAILED` **con reembolso del save** · `FR-050`, IMPL §2.3 · **parcial:** el pipeline corre de punta a punta contra los binarios compilados, pero **con `MemoryMediaRenderer`**: el artefacto son bytes sintéticos. El render real es `services/render` y sigue sin adaptador (`P2-RENDER-002`). Tampoco construye `custom` —la fila no guarda la clave del objeto subido— ni aplica `prompt`/`mentionBusiness` de `AI-004`. · **cerrada 2026-09-24:** la rama `custom` normaliza y cierra `CREATED` (s7-F); el render real está montado desde PU
  > **El círculo cierra.** `POST /content` cobraba el save y encolaba, y del otro lado no había nadie: la pieza quedaba en `BUILDING` para siempre y el save cobrado no se devolvía nunca. `pnpm smoke:binary` levanta ahora los **dos** procesos y espera a que la pieza llegue a `CREATED`.
  > Siete mecanismos verificados **rompiéndolos**: la guarda de doble reembolso, el chequeo de `revision` al leer, al escribir y al fallar, el corte del último intento, el `FOR UPDATE` de `lockContent` y el filtro de soft-delete. Dos de mis tests pasaban por la razón equivocada y lo encontré así.

## P1-STORAGE — Objetos y subidas

- [x] **P1-STORAGE-001** Puerto `Storage` + adaptador S3-compatible (R2 / MinIO) · `ADR-006`
- [x] **P1-STORAGE-002** Subida en 3 fases: reserva → PUT directo → finalización · PRD §9.8
- [x] **P1-STORAGE-003** Límites y tipos: imagen 10 MB, video 50 MB, extensión coherente con content-type · `NFR-013`
- [x] **P1-STORAGE-004** URLs firmadas de vida corta (1 h), **nunca logueadas ni persistidas** · `NFR-008`
- [x] **P1-STORAGE-005** Errores de reserva: `409` no alcanzable, `410` expirada, `404` ajena · PRD §9.8
- [x] **P1-STORAGE-007** **`S3Storage` montado en las dos apps** · `ADR-006`, §9.8
  > Verificado contra MinIO con el **binario compilado**: reserva → `PUT` directo → finalización. `POST /media` pasa de `409` **siempre** a `201`. Y el PUT con el `Content-Type` cambiado da **403**: la firma cubre la cabecera, de punta a punta.
  > **Las cinco `S3_*` son obligatorias, sin fallback.** El camino intermedio —caer a memoria si faltan— *es* el bug que esto cierra: responde 200 a la reserva y 409 para siempre, en silencio. Un interruptor para apagar el storage es uno que alguien deja apagado en producción.
  > El worker también, por una razón propia: con la API sobre S3 y el worker sobre memoria, `contents.files` guardaría `memory://bucket/...`. Medido: `content/…/1/0` de 64 B en MinIO, puesto por el `put()` del worker.
  > **Diferencia real entre los dos lados:** la API nunca hace `put()` —los bytes van directo al bucket— y el worker sí. Ahí entra la deuda del adaptador: sin `@aws-sdk/lib-storage` no hay multipart y `put` acumula en memoria hasta el tope.
  > **Queda abierto el hueco del CDN:** `canonicalObjectUrl` firma y quita la query, así que con R2 detrás de un CDN las URLs persistidas apuntan al endpoint de firma. Hoy en desarrollo coinciden (MinIO firma y sirve por el mismo host) y el arranque avisa si divergen.
- [x] **P1-STORAGE-006** Limpieza best-effort que **no bloquea** el borrado de la fila · `ERR-F05` · **parcial:** el caso de uso existe en el worker; falta en la API y falta el test · **cerrada 2026-09-24:** DELETE de media borra el objeto después del commit, best-effort (s7-E)
  > La nota decía que «falta el caso de uso que loguea y sigue». Existe: `apps/worker/src/content/build-handler.ts:332-341` descarta los objetos ya subidos cuando el build falla, best-effort como pide §9.11.
  > **Lo que de verdad falta:** ese camino **no tiene test**, y `DELETE /media/:id` no borra el objeto — `apps/api/src/routes/v1/media.ts:322-341` sólo hace soft-delete de la fila, así que cada borrado deja un objeto huérfano en el bucket.

## P1-API — Contrato y API

- [x] **P1-API-001** Scaffold Fastify + estructura de `apps/api`
- [x] **P1-API-002** `packages/contracts` con Zod → tipos + OpenAPI · `ADR-015`
- [x] **P1-API-003** Envelopes `{data}` / `{error:{code,message,details}}` / `pagination{cursor,hasMore}` · PRD §9.3
- [x] **P1-API-004** Versionado en la ruta `/api/v1`
- [x] **P1-API-005** API keys `fsln_live_*`: hash en reposo, mostradas una sola vez, revocación inmediata · `FR-180`
- [x] **P1-API-006** `WWW-Authenticate: Bearer realm="api"` en todos los 401 · `FR-180`
- [x] **P1-API-007** Middleware de scope: toda ruta resuelve `companyId` desde la key o la sesión
- [x] **P1-API-008** **Arnés de tests de ruta** — `apps/api/test/helpers/harness.ts`
  > Los 16 endpoints se escribieron y **ninguno se había ejecutado**: lo verificado eran funciones puras y tipos. Los cuatro agentes lo reportaron por separado como su limitación principal.
  > `startApi()` monta la app con Postgres real y `SET LOCAL ROLE fastgram_app`, y agrega las dos cosas que faltaban: una **cola que se puede inspeccionar** —sin ella lo único comprobable de las rutas que encolan era el status— y poder montar la app **sin** cola, que es el otro camino real (`503` sin escribir).
  > 21 tests nuevos sobre los caminos que nadie había ejercido: los códigos de estado, el **replay de idempotencia** y el encolado. Verificados rompiendo la ruta dos veces: encolando en otra cola (2 rojos) y quitando el `guard.fail` que libera la key (1 rojo, `409` donde debía ir `201`).

## P1-JUDGE — Puerto Judgment · `EXT-008`, `D-05`

- [x] **P1-JUDGE-001** Puerto `Judgment`: `choice` / `score` / `noul` · PRD §9.15.1
- [x] **P1-JUDGE-002** `LlmJudgmentAdapter` con decodificación restringida por JSON-schema · `ADR-009`
- [x] **P1-JUDGE-003** `StubJudgmentAdapter` para tests deterministas
- [x] **P1-JUDGE-004** Selección de adaptador **por punto de decisión**, no global · PRD §9.15.2 · **cerrada 2026-09-24:** `judgment.autopilot` / `.brand` / `.engagement` con fallback a `judgment` (s7-D)
- [x] **P1-JUDGE-005** Persistencia de `JudgmentRecord` con `latencyMs` e `inputTokens` · `DATA-033` · **cerrada 2026-09-24:** `recording-judgment.ts`
- [x] **P1-JUDGE-006** **Evaluación de modelos y precios**, con resultado fechado en `HANDOFF.md` · `ADR-009` · ⚠️ nada de precios de memoria
- [x] **P1-JUDGE-007** Sanitización obligatoria del estado antes del puerto · PRD §9.15.3
- [x] **P1-JUDGE-008** Suite de contrato única que corre contra **todos** los adaptadores · IMPL §4
  > Las 37 aserciones de `asr`, `media-renderer`, `payments`, `social-publisher` y `social-reader` **nunca se habían ejecutado** porque no existía ningún adaptador de esos puertos. Ahora corren contra implementaciones en memoria: 37 de 37 verdes, y la corrida encontró **cuatro aserciones que no medían lo que prometían** (ver el commit `308e30d`). Cinco de las 37 no pueden fallar contra un adaptador en memoria y están anotadas como tales.

## P1-VISION — Servicio de visión

- [x] **P1-VISION-001** Scaffold `services/vision` (Python, HTTP, sin estado)
- [x] **P1-VISION-002** Puerto `Ocr` + adaptador PaddleOCR · `ADR-011` · **la nota anterior quedó vieja:** el puerto (`packages/ports/src/ocr.ts`) y el adaptador HTTP (`VisionOcr`) existen desde hace tiempo, con la suite de contrato corriendo contra un `services/vision` falso pero real como servidor · **cerrada 2026-09-24:** OCR de capturas en `/brand/ocr` vía `services/vision` o el modelo de visión (s7-D); **sin probar contra PaddleOCR real**
  > Lo que sigue faltando es otra cosa, y está escrito en la cabecera de `vision-ocr.test.ts`: **nadie comprobó nunca que PaddleOCR lea un overlay de TikTok de verdad.** Necesita el servicio levantado con el extra `ocr` (`docker compose --profile vision up`, que no corre por defecto porque la imagen pesa) y una imagen real. Hasta entonces, lo verificado es el rodeo del adaptador —bytes → URL publicada → descarga → traducción de la respuesta—, no el motor.
- [x] **P1-VISION-003** OCR sobre imagen y sobre frames de video
- [x] **P1-VISION-004** Detección de idioma del texto extraído
- [x] **P1-VISION-005** Fallo de OCR degrada a `partial`, **nunca** aborta · `AI-016`

## P1-BRAND — Brand Sources · `EXT-001`

- [x] **P1-BRAND-001** Puerto `SocialReader` con una implementación por plataforma · **cerrada 2026-09-24:** IG, TikTok, X, YouTube y LinkedIn (s7-G); YouTube y LinkedIn opt-in (`YOUTUBE_READER`, `LINKEDIN_READER`)
- [x] **P1-BRAND-002** **Spike de cobertura pública por plataforma (las 5)** · `OQ-19` · ⚠️ **hacer ANTES de escribir los extractores**; puede reabrir `D-02` · **cerrada 2026-09-24:** IG/TikTok/X en `docs/AUDITORIA-SCRAPERS.md`; YouTube (yt-dlp) y LinkedIn (página pública) probados en real por s7-G
- [x] **P1-BRAND-003** Resolución y normalización de entrada: URL, `@handle`, limpieza de tracking, `x.com`≡`twitter.com` · `FR-011.1`
- [x] **P1-BRAND-004** Desambiguador de plataforma, con preselección de la cuenta ya conectada · `FR-011.1` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P1-BRAND-005** Link a post concreto → resuelve al perfil del autor + aviso · `FR-011.1` · **cerrada 2026-09-24:** posts de TikTok/X/YouTube/LinkedIn resuelven autor; IG da 400 con la salida a pegar el perfil (s7-D)
  > Resuelto en TikTok y X, donde el handle está en la URL. En **Instagram, YouTube y LinkedIn** hay que preguntarle a la plataforma y no hay `SocialReader` montado: responde `503`. El aviso de `ERR-B12` viaja en `resolvedFromPost`, un campo nuevo y opcional — la forma literal de PRD:2368 no traía ningún canal para él.
- [x] **P1-BRAND-006** Extractor `website` / `other_url` (OpenGraph + contenido) · `AI-001`
  > **Se evaluó montar el handler de `brand-source-analysis` sin extractor, y se decidió NO hacerlo.** El criterio de la trampa 30 dice que entre no registrar un handler y registrarlo sin proveedor gana registrarlo **si lo que escribe es verdad** — y acá no hay ningún valor del enum que lo sea.
  > `BRAND_SOURCE_FAILURE_REASON` tiene siete motivos y el más cercano, `provider_unavailable`, se le muestra al usuario como `ERR-B07`: *«{platform} isn't responding right now. Try again in a few minutes or add a different source.»*. Las dos mitades son falsas: la plataforma no tiene nada que ver, y **ninguna otra fuente va a funcionar** porque no hay extractor para ninguna. Es el mismo consejo falso que apareció con `ERR-B10`.
  > Consecuencia hoy, y hay que saberla: **ninguna fuente sale nunca de `pending`.** Lo que la destraba es este extractor, no un handler que mienta. Si hiciera falta cerrar el estado antes, el enum necesita un motivo que hoy no tiene — algo como `no_extractor_configured`, que además es una migración.
  > **Hecho en `6f68221` (2026-09-23).** `WebsiteReader` en `packages/adapters/src/social-reader/`: GET + parseo propio (sin JS), SSRF con DNS resuelto y **todas** las IPs clasificadas, cada redirect revalidado, socket fijado a la IP validada (anti-rebinding), plazo total y tope de cuerpo post-descompresión. Toda la config numérica, los puertos y los hosts bloqueados son **obligatorios y sin default**: el PRD no da ningún número. Reporta **tier B** (OpenGraph, sin render); si se decide que un GET de la web es tier C (D-01 lo llama «fetch público»), es una línea — y hay que sumar `robots.txt`, que hoy no se consulta. Sin verificar: HTTPS real (SNI + certificado con IP fijada), sitios reales, charset sólo en `<meta>`. Baja la home dos veces por análisis.
  > Lo de arriba sobre el handler quedó **superado en `62b91cb`**: con el extractor, el handler existe y es verdadero. Para las sociales usa `unsupported_platform` + `D_assisted` — literal: esta instalación no lee esa plataforma, y no culpa a la plataforma como `provider_unavailable`.
- [x] **P1-BRAND-007** Extractor Instagram · `D-02` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P1-BRAND-008** Extractor TikTok · `D-02` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P1-BRAND-009** Extractor X · `D-02` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P1-BRAND-010** Extractor YouTube · `D-02` · **cerrada 2026-09-24:** `youtube-reader.ts` (Data API o yt-dlp) (s7-G)
- [x] **P1-BRAND-011** Extractor LinkedIn · `D-02` · **cerrada 2026-09-24:** `linkedin-reader.ts` (página pública; authwall → tier D) (s7-G)
- [x] **P1-BRAND-012** Orden de tiers **B → C → A → D**; el signup **no pide OAuth** · `D-01`, `FR-011.4`
- [x] **P1-BRAND-013** Tier C **detrás de bandera apagada** hasta `OQ-16` · `FR-011.4` · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **Los enums del tier C no coinciden entre paquetes:** `ports`/`core` dicen `C_rendered_fetch`, `db`/`contracts` dicen `C_page_fetch`. `acquisitionPlan()` puede devolver un valor que Postgres rechaza. Hoy no explota porque el tier está apagado; el día que se encienda, sí. Hay un traductor explícito en la ruta, pero la unificación es de `ports` + `db`.
- [x] **P1-BRAND-014** Tier D asistido: pegar bio, subir capturas · `FR-011.4` · **cerrada 2026-09-24:** subir 1–5 capturas → OCR → mismo camino que la bio pegada (s7-D)
- [x] **P1-BRAND-015** Resolución de link-in-bio: 1 nivel, máx. 5 destinos, sin recursión · `INT-018` · **cerrada 2026-09-24:** 1 nivel, máx. 5, sin recursión, con la guarda SSRF del lector web (s7-D)
- [x] **P1-BRAND-016** `AI-016`: síntesis con `fieldMeta` (confianza + origen + extracto) · **cerrada 2026-09-24:** JV-4 calibra `fieldMeta.confidence` por campo (s7-D)
  > `fieldMetaSchema` exigía `sourceId` y `excerptRef`, y una edición manual no tiene ni fuente ni extracto: era **imposible marcar `editedByUser`** en un campo que la síntesis nunca escribió — y `FR-011.6` depende de esa marca para no pisarlo. Ahora son nullable.
  > **Cableada en `62b91cb`:** `packages/core/src/brand/analysis.ts` arma el pedido (texto de terceros **sólo** en `untrusted`, doble delimitación), exige que el extracto esté **textual** en lo que recibió el modelo, y vacía un campo si valor o cita parecen una orden. Falta `JV-4`: sin él, `materializeField` recorta todo a `low` y cada campo sintetizado sale como `Worth a quick check`. Sin LLM real: nunca se probó el esquema estricto contra un gateway.
- [x] **P1-BRAND-017** Preguntas de cierre de huecos · `FR-011.3` · ⚠️ **nunca inventar** un campo sin señal
- [x] **P1-BRAND-018** Protección SSRF en **todos** los orígenes, incluido el seguimiento de link-in-bio · `NFR-017`
  > No se reimplementó en la ruta: `detectBrandSource` llama a `assertHostAllowed` por dentro. Dos definiciones de «URL segura» se desincronizan.
  > **Matiz medido:** la rama `/^\d+$/` es inalcanzable vía `detectBrandSource` — `new URL("http://2130706433/")` normaliza el host a `127.0.0.1` antes, así que entra por la rama de IP privada. Queda bloqueado igual; esa rama sólo la ejercita el test unitario de `core`.
- [x] **P1-BRAND-019** **Suite de regresión con bios adversariales** (prompt injection) · `FR-011.9` · ⚠️ exigida por el PRD · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **Parcial (`62b91cb`):** un test adversarial mira el **cuerpo HTTP real** que el adaptador manda: la bio sólo dentro de `<untrusted>`, un único cierre aunque la bio intente cerrar el bloque, y campo vacío si el modelo «obedece» y cita la orden. No es una suite. **Límite conocido y documentado en un test:** un modelo que obedece y cita un fragmento sin marcas pasa, con confianza `low`.
- [x] **P1-BRAND-020** Unicidad `(sourceType, handle)` global · `FR-011.7`
  > El choque con **otro** workspace no se puede consultar: RLS esconde la fila ajena de cualquier `SELECT` con scope, así que lo único que lo sabe es el índice al fallar el `INSERT`. La rama `ERR-B06` del dominio es **inalcanzable desde HTTP**, y el 409 se traduce del `23505`.
  > El cuerpo es **byte a byte idéntico** choques con una fuente tuya o con la de otro: el literal del PRD («already connected to another workspace») convierte el alta en un buscador de clientes.
- [x] **P1-BRAND-021** Retención del snapshot + purga por `rawRetentionExpiresAt`; binarios de terceros **no se persisten** · `DATA-032`
  > El circuito de la omisión: sin handler, `main.ts` **no programa el cron** —a propósito, porque un cron sin consumidor acumula jobs mientras el log dice que está programado—, así que ninguna fuente envejecía nunca.
  > `SECURITY DEFINER` medido: sin él, con `fastgram_app` y sin GUC el `UPDATE` afecta **cero filas y sin error** (`expected 0 to be greater than or equal to 1`). Un test que corra como superusuario no puede ver la diferencia.
- [x] **P1-BRAND-022** Estados y errores completos de `FR-011.8` / `FR-011.9` (14 mensajes) · `ERR-B01`…`ERR-B14` · **cerrada 2026-09-24** (auditoría: ya implementada)
  > Los 14 mensajes existen y las rutas los emiten, pero **ninguna fuente sale nunca de `pending`**: el handler de `brand-source-analysis` no existe, así que `ready`, `partial`, `failed` y `stale` no los produce nada.
  > **Actualizado (`62b91cb`):** las fuentes salen de `pending` **cuando el handler está montado** — y sólo se monta con `LLM_*` (4), las 7 `BRAND_WEBSITE_*` y `BRAND_SNAPSHOT_RAW_RETENTION_DAYS`. Hoy ningún entorno las trae, así que en la práctica sigue igual. Y había un bug que lo habría vuelto a colgar: la clave del re-análisis repetía `:1` al vencer la ventana (arreglado en `2687ba9`).
- [x] **P1-BRAND-023** Semilla de content angles desde los temas con mejor engagement · `AI-016` · **cerrada 2026-09-24:** el generador de ángulos usa los posts con mejor engagement cuando hay métricas (s7-D)
- ~~**P1-BRAND-024** **Iniciar la revisión legal `OQ-16`** · ⚠️ bloquea el tier C, no es tarea de ingeniería~~ · **fuera de alcance:** D-13 (uso personal; se reabre si la app se abre a terceros)

## P1-ONB — Onboarding

- ~~**P1-ONB-001** Wizard multi-paso con progreso persistido y reanudable · `FR-010`~~ · **fuera de alcance:** D-07: el alta de marca es Settings → Brands + `/brand` (PU-BRAND-003); `/onboarding` no aplica en modo personal
  > **Las rutas existen y el progreso se reanuda**, pero el paso no se persiste: se **deriva** caminando `advanceOnboarding` sobre lo que sí está guardado. `packages/db` no expone repositorio de `onboarding_records` — es la única tabla sin uno. La lógica de los gates no se reimplementa, así que no puede desincronizarse.
  > Falta la UI entera.
- [x] **P1-ONB-002** Paso 1: input único de Brand Source + chips de plataforma · `FR-011.2` · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **Hecho en jsdom, no en un navegador (`01a32df`).** Literales de FR-011.2, detección vía `POST /brand/sources/resolve` (debounce 500 ms, no se duplica `detectBrandSource`: `@fastgram/core` no está en el `package.json` de `apps/web`), ERR-B03 con preselección, alta con `Idempotency-Key` estable por cuerpo. `/resolve` ya acepta `hint: "website"` (`a8cebb7`), pero la UI todavía lo rodea del lado del cliente.
- [x] **P1-ONB-003** Paso 2: `Company Name`, `Company Description`, logo · `FR-010` · **cerrada 2026-09-24:** nombre, descripción y **logo** (`/brand/logo`, se ve en el selector) (s7-D)
  > **No tiene endpoint, y no es olvido:** escribe `companies.name` y `companies.logo_url`, y `companies` **no tiene escritura** (`companyRepository` es sólo lectura por decisión explícita). Un `POST /onboarding/details` que guardara la descripción y descartara en silencio nombre y logo sería peor que no existir.
  > La descripción sí se escribe, por `PATCH /brand/profile` → `company_profiles.core_identity`.
- [x] **P1-ONB-004** Paso 3: cuestionario de perfilado (6 preguntas) · `F-006` · **cerrada 2026-09-24:** tarjeta de perfilado en `/brand` (s7-D)
  > **Cerrada la mitad que se podía.** El hueco era más chico: `assertValidProfiling` tiene dos bucles y el de los 4 000 caracteres ya recorría **todo lo que se le pasara** — faltaba que alguien pasara `expectations`. Ahora se recoge, se persiste y se acota, medido rompiéndolo.
  > **No se hizo obligatoria, a propósito:** la lista de Validation de `FR-010` trae mensaje para las otras cinco preguntas y **ninguno** para expectativas. Rechazarla vacía exigiría inventar copy CONFIRMED.
- [x] **P1-ONB-005** Paso 4: estados de procesamiento con sub-pasos por tipo de fuente · `FR-011.2` · **cerrada 2026-09-24:** `analysis_phase` real (0031), pasos con check en `BrandSourcesCard`; verificado en la app (fase `verifying` vista) (s7-H)
  > **Parcial (`01a32df`):** estado por fuente con ERR-B* traducidos, polling de 10 s mientras haya `pending`/`analyzing`. **Los sub-pasos no se pueden mostrar**: la API no expone progreso por sub-paso, así que se listan sin marcar (sólo los de Instagram, los únicos que da el PRD). `pending`-para-siempre dicho con honestidad: `Queued`, y a los 3 min (FR-011.12 crit. 9) «hasn't started yet»; nunca `Workspace ready!`.
- [x] **P1-ONB-006** **Pantalla de revisión** con `Worth a quick check` para los campos de confianza baja · `FR-011.2` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P1-ONB-007** Oferta post-análisis de conectar + importar media, **después** del análisis · `D-04`, `FR-011.5.1` · **cerrada 2026-09-24:** tarjeta post-análisis descartable: conectar cuentas + importar posts (opt-in) (s7-H); verificada en la app
- [x] **P1-ONB-008** Importación opt-in de posts propios al Media Bank, checkbox desmarcado · `FR-011.5.1` · **cerrada 2026-09-24:** `POST /media/own-posts/import` opt-in (IG Graph, YouTube, perfil público con yt-dlp; TikTok falla, X no soportado) (s7-F)
- [x] **P1-ONB-009** Todas las validaciones literales de `FR-010` · **cerrada 2026-09-24:** validaciones del logo por bytes y tamaño (s7-D)
  > Las validaciones del cuestionario y del alta están y son las literales del PRD. Falta las de los pasos sin endpoint (ver `P1-ONB-003`).
- [x] **P1-ONB-010** Rama `Use description instead` → `BrandSource` tipo `manual`
- [x] **P1-ONB-011** **E2E: alta completa con sólo un perfil de Instagram, sin un solo consentimiento OAuth** · `FR-011.12` crit. 11 · ⚠️ criterio de salida de la fase · **cerrada 2026-09-24 (adaptada):** sin OAuth, el alta desde Instagram funciona pegando bio y captions o **subiendo capturas (OCR)**. Instagram anónimo da 401 y **ManyChat no lo resuelve**: su API automatiza DMs con quienes escriben a tu cuenta y no lee perfiles ni posts (verificado 2026-09-24)

## P1-BRANDPG — Página Brand

- [x] **P1-BRANDPG-001** `/brand` con secciones editables · `FR-020` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P1-BRANDPG-002** Tarjeta `Brand sources`: listar, añadir, re-analizar, primaria, eliminar · `F-024` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P1-BRANDPG-003** Badges de origen y confianza por campo · `F-025` · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **001–003 hechas en jsdom, sin navegador (`262fb25`).** El `PATCH` manda **sólo los campos cambiados**: la API marca `editedByUser` cada clave del cuerpo, y mandar la sección entera congelaba campos que el usuario ni miró. Un campo editado no muestra badge de confianza: la API conserva la confianza y la fuente viejas (`markEditedByUser`), y mostrar «low, from @x» sobre texto del usuario sería falso. El header dice `Company Profile` sin nombre: ningún endpoint de brand devuelve el nombre de la empresa.
- [x] **P1-BRANDPG-004** `brandRevision` + `expectedBrandRevision` en las escrituras · `F-022` · **cerrada 2026-09-24:** `expectedBrandRevision` en `PATCH /brand/profile` → 409 "changed in another tab" (s7-D)
  > **Sólo un aviso, no una guarda.** `updateCompanyProfileRequestSchema` es `.strict()` y no tiene `expectedBrandRevision`: mandarlo da 400. El PRD lo pide para guardar sugerencias generadas, no para editar el perfil. La pantalla muestra la revisión y avisa si cambió en el servidor con una sección abierta; dos pestañas que editan el mismo campo se pisan en silencio.
- [x] **P1-BRANDPG-005** Re-análisis respeta `editedByUser`: propone, no pisa · `FR-020` · **cerrada 2026-09-24:** propuestas del re-análisis con Replace / Keep mine por campo (s7-D)
  > **Lo que se ve, sí; las propuestas, no.** Los campos editados se marcan y la tarjeta dice que el re-análisis no los pisa. Pero la propuesta del re-análisis sobre un campo editado vive sólo en el snapshot, ningún endpoint la devuelve, y no hay forma de aceptarla (ERR-B14). Hace falta API.
- [x] **P1-BRANDPG-006** `stale` a los 90 días + oferta de refrescar · `F-026` · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **El barrido está**: marca `stale` a los 90 días, con el mismo borde que el dominio («89 no, 90 sí»). Falta la **oferta de refrescar**, que es UI y necesita las rutas de brand.

## P1-UI — Shell de aplicación

- [x] **P1-UI-001** Next.js + Tailwind + shadcn/ui, tokens y tema
- [x] **P1-UI-002** Tema claro/oscuro **sin flash** en la carga · `NFR-021`
- [x] **P1-UI-003** Sidebar colapsable con las 10 entradas + bloque secundario · `FR-001`
- [x] **P1-UI-004** Rutas de PRD §3.1 con sus guards
- [x] **P1-UI-005** Sistema de toasts con enlace de acción · PRD §3.5
- [x] **P1-UI-006** Primitivas de estado: `empty`, `loading`, `error`, skeletons · PRD §19
- [x] **P1-UI-007** TanStack Query + capa de cliente de API tipada
- [x] **P1-UI-008** Responsive: móvil y tablet · `NFR-019`
- [x] **P1-UI-012** **Cablear las páginas al cliente tipado** · **parcial: una tajada vertical (Library → My Content) contra la API, con los cuatro estados de §19, cursor real y polling de 10 s** — quedan 39 páginas · **cerrada 2026-09-24:** Content Studio y formatos reemplazan los placeholders de `/content/*`; Guide/Feedback/Roadmap/Changelog quedan ocultos en modo personal (s7-E/F)
  > **Primera vez que alguien abre un navegador en el proyecto**, y lo primero que apareció es que nada había funcionado nunca: `pnpm dev` no arrancaba **ninguna pantalla** (`--turbopack` no lee el `extensionAlias` de webpack, y el `layout.tsx` raíz importa `@fastgram/ui`), y el `KpiRow` del Home venía recibiendo **401 desde siempre**.
  > **La credencial**: el navegador no habla con `apps/api`. Habla con un route handler de la propia app que lee la key del entorno y reenvía — sólo `GET`, con la sesión exigida, headers de salida por lista blanca y el cuerpo tal cual **con su status**, porque reempaquetarlo haría que el `402` deje de distinguirse del `500`. **Provisorio**: una key por despliegue es un workspace para todo el que llegue. Lo que corresponde es P1-AUTH.
  > **Sin verificar, y es lo que importa:** la Library se ejercitó contra un **stub**, no contra la API sirviendo datos — las 4 keys de desarrollo están hasheadas. Sigue pendiente y necesita una key de desarrollo, que la da una persona.
  > La segunda mitad de esta nota decía que no había ni un test de componente por falta de `jsdom` y `@testing-library/react`. **Caducó el 2026-09-22**: `e8b59d2` los instaló y `f5f25cf` escribió los primeros 19. Ver `P1-UI-014`.
  > **Escrituras abiertas (`91a43d9`).** El proxy acepta `POST/PUT/PATCH/DELETE` si el `Origin` coincide **exacto** con el propio (`FASTGRAM_APP_ORIGIN`; fuera de producción `http://<Host>`; en producción sin la variable, 503), `Sec-Fetch-Site` es `same-origin` cuando viene, y trae `x-fastgram-csrf`. **No es autenticación**: `fg_session` no está firmada (P1-AUTH-002). Sin probar en navegador. La subida del Studio sigue cayéndose en el PUT firmado: no hay CORS del bucket de producción (P1-INFRA-004; MinIO de desarrollo no se probó).
- [x] **P1-UI-014** **Arnés de test de componentes** (vitest + jsdom + Testing Library) y los primeros 19 · `f5f25cf`
  > jsdom va **sólo** para `src/components/**` y `src/app/**`. Ponerlo para todo apagaba en silencio la rama `typeof window === "undefined"` de `client.ts`: los tests seguían verdes midiendo la otra mitad.
  > `@fastgram/contracts` queda sin alias a propósito — resuelve a su `dist`, que es lo que `next build` empaqueta; aliasearlo a `src` haría validar contra un contrato distinto del que corre.
  > **Trampa cara:** `waitFor` de Testing Library no sabe avanzar los fake timers de vitest (detecta `typeof jest`), así que espera con el reloj parado y muere por timeout. Y `advanceTimersByTimeAsync(0)` no alcanza: TanStack Query agenda la notificación con `setTimeout(cb, 0)` en el mismo tick. Con 1 ms sale.
  > **Sin verificar:** `--coverage` no corre en `apps/web` — falta `@vitest/coverage-v8` en sus devDependencies, y `packages/ui` tiene el mismo agujero.
- [x] **P1-UI-013** **`pnpm dev` arranca** — `packages/ui` dejó de escribir la extensión `.js` en sus imports internos
  > El parche estaba del lado equivocado: `next.config.ts` le enseñaba la regla a **webpack**, y el script `dev` corre turbopack. `packages/ui` podía dejar de escribirla porque su `package.json` apunta `main` a `./src/index.ts` — **no tiene `dist` y nadie lo corre por Node**. `packages/contracts` sí las conserva y tiene que conservarlas.
  > Medido antes (`HTTP 500`, `Can't resolve './cn.js'`) y después (`/library` → **200**, cero `Module not found`).
- [x] **P1-UI-009** Home con KPIs, Tasks y Views History · `FR-030`
- [x] **P1-UI-010** FAQ del Home: 5 categorías, 37 preguntas, copy literal · `FR-030`
- [x] **P1-UI-011** **`text-subtle` en modo oscuro no cumple AA para texto normal** · `NFR-019` · **cerrada 2026-09-24:** `neutral-450`, `tokens.contrast.test.ts` (637bf5d)
  > Medido el 2026-09-21: 3,65:1 sobre `surface` y 3,16:1 sobre `raised`, contra el 4,5:1 que exige AA. Cumple el 3:1 de texto grande y nada más. Hoy eso significa que **en oscuro `text-subtle` no se puede usar en tamaño normal**.
  > No se arregla subiéndolo a `neutral-400`, que es donde vive `muted`: se perdería la distinción entre los dos niveles. Es una decisión de paleta. `packages/ui/src/tokens.contrast.test.ts` fija los valores medidos, así que la limitación no puede empeorar en silencio.

## P1-OBS — Observabilidad

- [x] **P1-OBS-001** Logs estructurados con `companyId` y `requestId` en todo
- ~~**P1-OBS-002** OpenTelemetry: trazas y métricas~~ · **fuera de alcance:** D-06
- ~~**P1-OBS-003** Sentry (errores) + PostHog (producto) · `INT-010`~~ · **fuera de alcance:** D-06
- [x] **P1-OBS-004** Health checks y status page · `F-255`
  > Las tres mitades: `/health` de la API comprueba Postgres, storage y cola; la status page redacta **en el servidor**; y el worker expone su propia sonda, con la semántica invertida (liveness sirve, readiness frena un rollout en vez de sacar de rotación).
  > **Cerradas las dos mitades que se podían:** `/health` de la API comprueba Postgres, storage y cola de verdad (y `degraded` devuelve 200 a propósito), y la status page de `F-255` existe y redacta **en el servidor** — no renderizar no es no publicar.
  > Falta: **`apps/worker` no expone ninguna sonda.** Un worker con la base caída no lo dice en ningún lado.
- [x] **P1-OBS-005** Alertas: cola atascada, tasa de fallo de build, saturación de rate limit · **cerrada 2026-09-24:** cola atascada y dead-letter → notificación (s7-E); la parte de rate limit no aplica (D-06)

---

# P2 — Core Product

> **Criterio de salida:** el usuario aprueba una pieza en Blitz y la guarda; crea otra a mano en el Studio.

## P2-ANGLE — Content Angles

- [x] **P2-ANGLE-001** `DATA-005` + CRUD · `FR-056`
- [x] **P2-ANGLE-002** Caps: 100 por workspace, 10 por influencer, con sus códigos de error · `FR-056`
- [x] **P2-ANGLE-003** **Auto-reconcile de `angleWeights` en la MISMA transacción** que la mutación · `FR-055` · ⚠️ test de integración obligatorio
- [x] **P2-ANGLE-004** Soft-delete reversible; desactivar limpia links y reactivar **no** los restaura · `FR-056`
- [x] **P2-ANGLE-005** Generador de ángulos (no persiste) + límite 5/min + liberación de reserva al fallar · `AI-005` · **cerrada 2026-09-24:** generador montado con el modelo `text` + `AnglesCard` (s7-D)

## P2-PREFS — Blitz Settings

- [x] **P2-PREFS-001** `DATA-006` con defaults sintetizados · `FR-055`
- [x] **P2-PREFS-002** Validación: los 4 pesos como unidad, suma exacta 100 · `FR-055`
- [x] **P2-PREFS-003** `angleWeights` y `textStyleWeights` con sus reglas de suma y pertenencia · `FR-055`
- [x] **P2-PREFS-004** 7 presets de estilo de caption · `FR-055`
- [x] **P2-PREFS-005** **Los cambios aplican sólo a generaciones futuras; la cola no se vacía** · `FR-055` · ⚠️ regla explícita
- [x] **P2-PREFS-006** Rate limit dedicado de 3/min
- [x] **P2-PREFS-007** UI `/blitz/settings` con auto-guardado y banner `All changes saved` · `FR-055`

## P2-DISC — Discovery queue

- [x] **P2-DISC-001** `DATA-007` + relleno en background, objetivo ~5 · `F-050` · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **El handler existe y está montado; el productor no.** `discovery-refill` no lo encola nadie — el nombre sólo aparece en el catálogo y en `queues.ts`. Con el consumidor arriba y sin productor, la cola sigue vacía, así que `FR-030`/`AI-002` («automático en background») no se cumple todavía. **Es el próximo tapón.**
  > La guarda contra la reentrega es un **advisory lock** por workspace, no la sentencia atómica: un `INSERT` no bloquea contra nada, así que escribir conteo e inserción juntos da atomicidad entre sí y ningún aislamiento. Lo que la sentencia única aporta es que no se puedan escribir en transacciones distintas por descuido.
  > **Trampa medida:** el primer test de tres entregas concurrentes pasaba sin guarda porque las tres **no se solapaban** — `postgres.js` conecta bajo demanda y las dos últimas perdían ~8 ms montando el TCP. Medía `connect(2)`. El único que mide la guarda es el que sostiene una transacción abierta a mano.
- [x] **P2-DISC-002** Selección ponderada: tipo, ángulo, remix/original, own-media, estilo · `AI-002`
- [x] **P2-DISC-003** `influencerChance` como **tirada independiente**, no ratio de lote · `FR-055`
- [x] **P2-DISC-004** Fallback a contenido regular si no hay influencer elegible; `green-screen` nunca usa influencer · `FR-055`
- [x] **P2-DISC-005** `aiExplanation` **persistida con la sugerencia**, no regenerada al abrir · `AI-002` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-DISC-006** Generación on-demand por `contentType` forzado · `F-067` · **cerrada 2026-09-24** (auditoría: ya implementada)

## P2-RENDER — Motor de render

- [x] **P2-RENDER-001** Scaffold `services/render` (FFmpeg + sharp, sin estado) · `ADR-007`
- [x] **P2-RENDER-002** Puerto `MediaRenderer` + adaptador HTTP contra `services/render` · **parcial: el adaptador existe y rinde video real, pero NO está montado** — montarlo hoy rompería todos los builds; ver `P2-RENDER-015`. · **cerrada 2026-09-24** (auditoría: ya implementada)
  > Al escribir el handler apareció que `audio` era **obligatorio** en `WallOfTextJob` y `VideoHookJob`, y `FR-053.1` (PRD:1234) dice que *No audio* omite el bloque. El contrato público ya lo tenía opcional: una pieza válida de `POST /content` no se podía ni escribir como `RenderJob`. Corregido en el puerto.
  > La nota decía que «`services/render` todavía lo exige (`payload.ts`)». **Era falsa las dos veces**: ese archivo es `src/domain/payload.ts` —el `render/payload.ts` que citaba no existe— y ahí `audio` es opcional desde `P2-RENDER-014`, tres líneas más abajo en este mismo documento. Sirve de recordatorio de que una nota envejece peor que una casilla.
  > **Cerrado en `7cb8dd9`:** el puerto lleva `MediaAuthorization` (obligatoria), tiene `renderAll` para los N artefactos de un slideshow, y `probe`/`normalize`/`thumbnail` llaman a los endpoints reales en vez de lanzar. Falta montarlo: ver `P2-RENDER-015`.
- [x] **P2-RENDER-003** Esquema de text-object compartido por los 4 formatos · `FR-070`
- [x] **P2-RENDER-004** Render `slideshow` (hasta 20 slides, 4 aspect ratios) · `FR-070`
- [x] **P2-RENDER-005** Render `wall-of-text` · `FR-070`
- [x] **P2-RENDER-006** Render `green-screen` (chromakey sobre fondo) · `FR-070`
- [x] **P2-RENDER-007** Render `video-hook` (hook + demo apilados + audio) · `FR-070`
- [x] **P2-RENDER-008** 12 familias tipográficas con sus pesos permitidos · `FR-051` · **11 de 12 (2026-09-24):** `tiktok` pasó a **TikTok Sans** (OFL 1.1, Google Fonts); 37 `.ttf` bajan con `fonts:fetch` · **cerrada 2026-09-24:** las 12 con archivo: `tiktok` = TikTok Sans (OFL) y `snapchat` = **Inter** (sustituto elegido por el dueño, pensado en bold); 42 `.ttf` con `fonts:fetch`
  > **32 de 42 verifican** (`835628e`): `fonts:fetch` baja las 10 familias OFL fuera del repo y el servicio las activa por proceso. Siguen `tiktok`/`snapchat` sin archivo (licencia). Bug encontrado de paso: `"Montserrat 700 42px"` Pango lo leía como familia inexistente — ahora `"Familia, Peso NNpx"`.
- [x] **P2-RENDER-009** **Validación de que toda URL de media pertenece al workspace o a la librería compartida** · `FR-070` · ⚠️ se rechaza antes de iniciar el build · **cerrada 2026-09-24:** `POST /content` rechaza con 400 media/audio que no es de la marca antes de cobrar y encolar (s7-I)
- [x] **P2-RENDER-010** **Cache por hash del payload**: no re-encodear si sólo cambió el texto · IMPL §5
- [x] **P2-RENDER-011** Golden-file tests por formato · IMPL §4
- [x] **P2-RENDER-012** Recorte inteligente en vez de `stretch-to-canvas` · `EXT-006`
- [x] **P2-RENDER-014** **`audio` opcional en `wall-of-text` y `video-hook`** (`FR-053.1`) + `GET /artifact/<clave>` · `FR-070`
  > Sin pista, **MP4 sin stream de audio** (`-an`), no pista de silencio. Lo que cerró el criterio no fue el PRD —que igual lo dice literal— sino la consistencia interna: `planGreenScreenBase` ya emitía `-an` desde `P2-RENDER-006`, y con silencio la misma elección del usuario daría contenedores distintos según el formato.
  > La defensa del endpoint contra path traversal **rechaza en vez de sanear**: sólo sha256 hex + índice + extensión de lista cerrada toca el disco. El shard de `FileCacheStore` no protege nada (`key.slice(0,2)` de `../../etc/passwd` es `..`). Sondeado con 16 formas: acepta 3, rechaza 13. Verificado rompiéndolo: sin el validador, el endpoint **sirve un archivo de fuera del root de la cache**.
  > **Restricción de despliegue:** la cache es local. Con varias réplicas y sin volumen compartido, el `GET` del href puede caer en una réplica sin el archivo — y ahí el 404 es *correcto*. Hay que bajar el artefacto en el mismo flujo, no guardarse el link.
- [x] **P2-RENDER-016** **`POST /probe`, `/normalize`, `/thumbnail`** + versión del motor + canvas impar como `bad_request` · `NFR-014`, `ERR-P11`
  > POST y no GET porque la URL del medio es firmada y lleva token en la query, y una query string va a **todos** los access logs. Los bytes salen por el `GET /artifact` que ya existía: una sola ruta que sirve bytes es una sola que auditar.
  > **La versión del motor se deriva del hash del árbol de código** más ffmpeg, sharp, libvips, Pango, FreeType y el registro de fuentes. Era `ENGINE_VERSION = "1"`, o sea el número a mano. **Invalida la cache existente: el primer deploy re-encodea todo.**
  > Canvas impar: **rechazar, no redondear.** El canvas es la forma declarada del artefacto y el adaptador devuelve sus dimensiones sin medir el archivo; redondear introduciría justo el sesgo de 1 px que el adaptador verificó que no existe.
- [x] **P2-RENDER-015** **Montar `HttpMediaRenderer` en `apps/worker`** — hoy monta el de memoria, y cambiarlo sin esto rompe **todos** los builds
  > **Estado al 2026-09-22, tras `7cb8dd9`.** Eran cuatro bloqueos y quedan dos, con una corrección de bulto sobre cómo estaban contados.
  > **(1) Las 42 fuentes — VIGENTE, y es el único que necesita a una persona.** Archivos de fuente en la máquina: **cero**. El `fontLoader` los busca en `RENDER_FONT_DIR` con el nombre exacto `${family}-${weight}.ttf`, y esa variable **no está en `.env.example`, ni en `docker-compose.yml` —que ni define el servicio de render—, ni en ningún script**. Sin directorio, `available === false` → `strict` (default `true`) → `font_unavailable`.
  > Corrección: **no es «el default `inter`»**. `family` no tiene default; fallan las 12 familias igual, porque el fallo es por directorio ausente y no por familia. Y el tamaño real del problema es menor de lo que decía: **32 de los 42 archivos son de 10 familias con licencia OFL** y se bajan. Sólo los 10 de `tiktok`/`snapchat` (5 pesos × 2) esperan una decisión de licencia.
  > **(2) El grant firmado — CERRADO.** El puerto lleva `MediaAuthorization` obligatoria y el adaptador la firma. Verificado contra el servicio real: el grant se acepta, la firma manipulada y el vencido dan `media_grant_invalid`, y una URL de otro workspace da `media_url_not_allowed`.
  > **(3) `RENDER_ALLOWED_MEDIA_PREFIXES` — nunca fue un bloqueo independiente.** El rechazo pide que falten **las dos** cosas: `if (!hasConfig && grant === null)`. Un grant válido alcanza solo; la config es un piso opcional que, si está, se aplica como intersección. Cerrando (2) se cerró esto.
  > **(4) El slideshow multi-slide — CERRADO a medias.** `renderAll` subió al puerto con artefactos perezosos. Falta que `build-handler` lo use y suba los N objetos; hoy sigue llamando a `render()`, que acepta uno solo.
  > **(5) Un quinto que no estaba listado — CERRADO.** `build-handler` llama a `thumbnail()` en **cada** build, dentro de un `try/catch` que loguea y sigue. Con el adaptador de antes eso era un stub que lanzaba: montarlo habría dejado **todas** las piezas sin miniatura, con una línea de warning por build y nada más.
  > **(6) Nuevo, abierto: el audio no tiene origen.** `FR-070` exige que venga de la librería compartida y **en todo el repo no hay una sola pista de dónde vive** — ni clave, ni variable, ni endpoint. `workspaceMediaAuthorization` deja `sharedPrefixes` vacío en vez de inventar un prefijo. Consecuencia: con el adaptador montado, un `wall-of-text` o un `video-hook` **con** audio se rechaza con `audio_fuera_de_libreria`.
  > **(7) La normalización NO necesita esto (`dc20938`).** `media-normalization` se monta con **su propia** instancia de `HttpMediaRenderer` cuando están `RENDER_SERVICE_URL` + `RENDER_MEDIA_GRANT_SECRET` (las dos o ninguna; una sola = el worker no arranca). `content-build` sigue en memoria. Probado a mano contra `services/render`: probe de un `.mov` y normalize a mp4. Un test de cableado ve si alguien le pasa el renderer de `content-build`: los de `handlers.test.ts` no lo veían.
  > **Cerrado (`835628e`, `af8d80d`), verificado de punta a punta a mano el 2026-09-23:** subida real al Media Bank → `POST /content` → cola → worker con `HttpMediaRenderer` → `services/render` con fuentes activadas → dos slides JPEG 1080×1350 y thumbnail en MinIO, con Inter Bold legible. **Lo que destrabó las fuentes no fue fontconfig**: en macOS el Pango de sharp sólo tiene backend CoreText, así que se registran los archivos con `CTFontManagerRegisterFontsForURL` en scope de proceso (`node:ffi`, `NODE_OPTIONS=--experimental-ffi`). En Linux el mecanismo es `FONTCONFIG_FILE` (generado al arrancar) y **no está verificado**. El texto escala por `canvas.width / 360` (decisión del dueño, PRD). Detalle menor: el worker muere al arrancar si el servicio de render todavía no contesta (hay que levantar el render primero).
- [x] **P2-RENDER-013** Normalización de media: MOV→MP4, HDR→SDR, faststart · `NFR-014` · **parcial: MOV→MP4 y faststart ahora sí corrieron sobre archivos reales y aparecieron dos bugs**; HDR→SDR sigue sin poder probarse · **cerrada 2026-09-24:** MOV→MP4 y faststart andan sobre archivos reales. **HDR→SDR queda fuera por decisión del dueño (2026-09-24)**: un video HDR se conserva como está (`hdr_kept_original`)
  > **Los dos bugs se cancelaban entre sí.** `isMp4Compatible` daba `true` para un `.mov` —MOV y MP4 comparten demuxer: ffprobe emite `mov,mp4,m4a,3gp,3g2,mj2` para los dos y el discriminador real es `major_brand` (`qt ` vs `isom`)— y `needsRemux` daba `true` siempre. Uno decía "ya está bien" y el otro "hay que convertir", así que **en el único caso que alguien miró el resultado era correcto**. El test unitario pasaba fabricando `["mov","quicktime"]`, una lista que ffprobe **no emite jamás**.
  > **HDR→SDR exitoso NUNCA corrió**: este ffmpeg no trae `zscale` ni `libplacebo`, así que la cadena de tonemapping sólo existe como string en un test de plan. Falla cerrado sobre un PQ real, que es lo único verificable en esta máquina.
  > **El productor y el handler existen (`2757f86`, `dc20938`):** `POST /media` encola cada video en la misma transacción; el handler normaliza sólo si no es mp4, es HDR o no tiene faststart, y cierra con un `UPDATE` condicionado. Quedan: el MOV original huérfano en el bucket (el PRD no dice qué hacer), el custom video del Studio **no entra** (no guarda `storageKey` en ningún lado — decisión de schema), y HDR→SDR sigue sin haber corrido nunca con ffmpeg.

## P2-CONTENT — Entidad Content

- [x] **P2-CONTENT-001** `DATA-008` + `DATA-009` + ciclo `BUILDING → CREATED|FAILED` · `FR-050`
- [x] **P2-CONTENT-002** Concurrencia optimista por `revision`; `409 stale_revision` · `FR-051`
- [x] **P2-CONTENT-003** Edición menor: **no** crea fila, **no** consume save, **no** factura · `FR-051`
  > **Estaba roto en el camino de fallo hasta `eab8fa5`.** Las ediciones se encolaban en `content-build`, cuyo cierre de fallo es `FAILED` + reembolso; la pieza editada lleva el `saveBucket` del build original, así que **cada edición fallida devolvía un save** y mataba una pieza que PRD:1204 dice que sigue usable. Ahora van a `content-rebuild`: el fallo vuelve a `CREATED` con los archivos anteriores y `lastEdit` fallido, sin reembolso. `PATCH` y `regenerate` leen con lock (dos `PATCH` con la misma `revision` escribían los dos).
- [x] **P2-CONTENT-004** Regeneración de copy preservando estructura y nº de slides · `AI-004` · **parcial:** `POST /content/:id/regenerate` valida, sube la revisión y encola; el modelo lo llama el worker, que no existe · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **Hoy ninguna edición llega al video (`eab8fa5`).** El render lee sólo `buildPayload`; `PATCH` escribe `content_text_boxes`. El mapeo de cajas del editor (0–100) a píxeles del payload **no lo da el PRD**, y `regenerate` necesita un modelo de copy que el worker no tiene. Una pieza con cajas cierra el rebuild con `edit_not_renderable` sin llamar al renderer — honesto, no aplicado. Decisiones de una persona: el mapeo, el modelo, y el contrato del swap de media (F-061, sin ruta).
- [x] **P2-CONTENT-005** Todas las validaciones de rango de `FR-051`
- [x] **P2-CONTENT-006** Borrado: soft-delete + `409 content_has_linked_posts` (cancelar no basta) · `FR-051` · **parcial:** el 409 está en `PATCH`; el `DELETE` no lo comprueba
- [x] **P2-CONTENT-007** `409 content_still_building` con la ventana de 15 min · `ERR-P02`
- [x] **P2-CONTENT-008** `buildPayload` y `studioState` **nunca** salen por la API · `DATA-008`
  > No es una omisión que haya que recordar: el tipo de retorno del serializador es explícito, así que agregarlos sería un error de compilación.

## P2-BLITZ — Blitz

- [x] **P2-BLITZ-001** Deck con stack de tarjetas y swipe · `FR-050` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-002** Teclado ← / → equivalentes a los botones · `F-052` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-003** Chips de tipo, influencer y ángulo · `F-053`, `F-054` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-004** Panel `Why This Content?` · `F-055` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-005** Panel `Remixed From` con likes y views · `F-056` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-006** Mute/unmute con indicador sobre la tarjeta · `F-057` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-007** Editor inline: panel ASSETS + inspector de texto · `FR-051` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-008** `Regenerate Text` con prompt opcional (≤500) · `F-059` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-009** Swap de video/audio/imagen con sus modales · `F-061` · **cerrada 2026-09-24:** swap de imagen, video y **audio** (biblioteca de la marca) (s7-B)
- [x] **P2-BLITZ-010** Modal `Select Video` con filtros, tags y paginación · `FR-052` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-011** Modal `Select Audio` con opción `No audio` y catálogos por tipo · `FR-053` · **cerrada 2026-09-24:** `AudioPickerDialog` con No audio, búsqueda, preview y subida (s7-B); verificado en la app: la música llega al video
- [x] **P2-BLITZ-012** Flujo de aceptación: `What would you like to do?` · `F-064`, `F-065` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-BLITZ-013** Estados: cola vacía, cuota agotada, perfil no listo, view-only · `FR-050` · **cerrada 2026-09-24:** la parte de cuota/view-only no aplica (D-06)
- ~~**P2-BLITZ-014** Aceptar descuenta **1 swipe + 1 save**; fallo de build reembolsa · `FR-050`~~ · **fuera de alcance:** D-06 (sin cuotas)
  > **En `main` (sin auth):** el accept cobra 1 save + 1 swipe (swipes sin límite, decisión del dueño), arma el `buildPayload` desde la sugerencia **antes de cobrar** (`a914d47`) y encola. Una sugerencia necesita copy del LLM: **sin `LLM_*` la cola queda vacía**. El workspace de desarrollo es plan pro (`pnpm dev:workspace`); el trial de Free sin número responde 503 honesto.

## P2-STUDIO — Content Studio

- [x] **P2-STUDIO-001** Hub `/content` con las 22 tarjetas de formato · `F-070`
  > **Ya estaba hecho; lo que faltaba era el test que lo fija.** Las 22 tarjetas están, cada una es un `<a>` real y su id coincide con el segmento del PRD. Lo único de `F-070` que no está son el póster y el video de ejemplo, que son **assets** que el repo no tiene y que nadie decidió de dónde salen.
- [x] **P2-STUDIO-002** Wizard con pasos, checks y `Generate` deshabilitado hasta completar · `F-073` · **cerrada 2026-09-24:** Content Studio por formato con pasos (s7-F)
- [x] **P2-STUDIO-003** Modos Remix y Create New · `F-071`, `F-072` · **cerrada 2026-09-24:** Create New y Remix (s7-F)
- ~~**P2-STUDIO-004** Picker de trending con carrusel paginado y chips de nicho · `F-074`~~ · **fuera de alcance:** D-15/OQ-13 (sin catálogo de terceros; lo reemplaza Inspiration)
- [x] **P2-STUDIO-005** Preview + inspector por formato · `F-075` · **cerrada 2026-09-24:** vía el editor (PU-EDIT-003/004)
- [x] **P2-STUDIO-006** Modal `Swap image for slide N` · `FR-071` · **cerrada 2026-09-24:** vía el editor (PU-EDIT-003)
- [x] **P2-STUDIO-007** Estilos de wall-of-text · `F-078` · ⚠️ catálogo completo en `OQ-08` · **cerrada 2026-09-24:** estilos de `textStylePresetSchema` en el Studio (s7-F); el catálogo completo sigue en `OQ-08`
- [x] **P2-STUDIO-008** Demo video + enlace a la guía de grabación · `F-079` · **cerrada 2026-09-24:** adaptado: slot de demo con texto de consejo (no hay URL de guía de grabación) (s7-F)
- [x] **P2-STUDIO-009** Subida de video custom (MP4/MOV ≤50 MB) · `F-083` · **cerrada 2026-09-24:** custom video normalizado → `CREATED` (s7-F)
  > La pantalla está completa —tres pasos de §9.8, progreso real por `XMLHttpRequest`, política de reintento que sigue al costo— y **no puede completar una sola subida**. Ver el bloqueo del proxy más abajo.
- [x] **P2-STUDIO-010** `Save` / `Schedule` / `Clear` · `F-081`, `F-082` · **cerrada 2026-09-24:** Save/Clear en el Studio y Schedule en el detalle y el editor (s7-A/F)

## P2-MEDIA — Media Bank

- [x] **P2-MEDIA-001** `DATA-010` + subida y finalización · `FR-100`
- [x] **P2-MEDIA-002** Categorías válidas por tipo de media · `F-129`
- [x] **P2-MEDIA-003** PATCH de categorías = reemplazo total; lista vacía saca del pool · `FR-100`
- [x] **P2-MEDIA-004** Borrado idempotente + `409 media_in_use` · `FR-100` · **cerrada 2026-09-24:** `409 media_in_use` + borrado del objeto (s7-E)
- [x] **P2-MEDIA-005** `DATA-011` Media Sets con **mínimo 5 assets** · `F-127` · **cerrada 2026-09-24:** `/media/sets` con mínimo 5 (s7-F)
- [x] **P2-MEDIA-006** Modo `CREATING SET` con contador y validación · `FR-100` · **cerrada 2026-09-24:** modo CREATING SET con contador (s7-F)
- [x] **P2-MEDIA-007** Filtros: tipo, categoría, influencer + búsqueda · PRD §12 · **cerrada 2026-09-24:** búsqueda, categoría y tags (incluidos los automáticos) (s7-F + coordinador)
- [x] **P2-MEDIA-008** Deep-linking con `from` y `focus` · `FR-100.1` · **cerrada 2026-09-24:** `?from=&focus=&tab=` con `from` validado (s7-F)
- [x] **P2-MEDIA-009** Assets generados, demo e internos **nunca** se listan · `FR-100` · **cerrada 2026-09-24** (auditoría: ya implementada)

## P2-LIB — Library

- [x] **P2-LIB-001** Tab `My Posts` con estado, tipo y métricas · `F-120`
- [x] **P2-LIB-002** Tab `My Content` · `F-124`
- [x] **P2-LIB-003** Tab `My Media Bank` · `F-125`
  > Se construyó pidiendo `P2-MEDIA-006` por error del coordinador: esa tarea es el modo `CREATING SET`, que **no** está. Lo que se hizo es esta tab — lista, los cuatro estados de §19 y filtro por `type`, que es el único filtro que `GET /media` tiene hoy.
  > **Sin polling a propósito**, aunque un asset nazca `processing`: no hay handler de normalización en el worker, así que se quedaría así para siempre y el intervalo sería una petición cada 10 s sin ver cambiar nada.
- [x] **P2-LIB-004** `Refresh Metrics` · `F-121` · **cerrada 2026-09-24:** Refresh Metrics en My Posts (s7-A)
- [x] **P2-LIB-005** Modo `Select` y acciones masivas · `F-122` · ⚠️ alcance exacto en `OQ-04` · **cerrada 2026-09-24:** modo Select con cancel/delete masivo (s7-A)

## P2-CAL — Calendar

- [x] **P2-CAL-001** Vista mes con navegación · `F-140` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-CAL-002** Chips de post por plataforma, tipo y hora · `F-141` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P2-CAL-003** Contador por día y contadores de cabecera · `F-142`, `F-143` · **cerrada 2026-09-24** (auditoría: ya implementada)
  > **Las tres, parciales por la API (`1e2c19d`).** `GET /posts` **no filtra por fecha** y ordena por creación, así que nunca se sabe que un mes está completo: se piden hasta 5 páginas de 100 y, si hay más, la pantalla lo dice (`5+`, «may not be empty»). `Post` no trae el tipo de contenido: se cruza con `GET /content` (otras 5 páginas como mucho). La zona es la del navegador, nombrada en pantalla: el PRD guarda `timezone` en usuario y workspace, pero ningún endpoint la publica — y la Library fija UTC, así que un post puede caer en días distintos en cada pantalla. Sin navegador real.

## P2-TREND — Catálogo de tendencias

- ~~**P2-TREND-001** **Decisión de derechos y estrategia de adquisición del catálogo** · `F-041`, `OQ-13` · ⚠️ **bloquea el resto de la épica; no es tarea de ingeniería**~~ · **fuera de alcance:** D-15: tablero propio en vez de catálogo
- [x] **P2-TREND-002** `DATA-023` + pipeline de ingesta · `F-041` · **cerrada 2026-09-24:** tablero propio (D-15): `0022_inspiration_references`
- [x] **P2-TREND-003** Extracción a texto: caption, hashtags, OCR, métricas · `JV-1` dep · **cerrada 2026-09-24:** `reference-reader.ts` (yt-dlp + OCR)
- [x] **P2-TREND-004** `/inspiration`: búsqueda, filtro por nicho, `Remix this` · `FR-040` · **cerrada 2026-09-24:** `InspirationBoard.tsx` (PU-LATER-006)
- [x] **P2-TREND-005** Estados: `No results`, `Inspiration is being set up`, error · `FR-040` · **cerrada 2026-09-24:** "being set up" no aplica a un tablero propio

## P2-JV — Judgment features

- ~~**P2-JV-001** **`JV-1`** clasificador del catálogo: 5 preguntas, umbrales, cuarentena · PRD §25.3 · dep: P2-TREND-003~~ · **fuera de alcance:** D-15: clasificador del catálogo de terceros que no existe
- [!] **P2-JV-002** Dataset de 250 items etiquetados a mano (**50 en español**) · PRD §25.4
  > bloqueada: dataset etiquetado a mano: tarea de una persona
- [!] **P2-JV-003** **Experimento de validación `DP-001`**: acierto, **calibración**, costo, latencia, es↔en · `OQ-20` · ⚠️ la calibración es el criterio de corte
  > bloqueada: depende de P2-JV-002
- [x] **P2-JV-004** **`JV-4`** verificador de campos de marca → `fieldMeta.confidence` · PRD §25.3 · **cerrada 2026-09-24:** JV-4 (s7-D)

---

# P3 — Integrations & Automation

> **Criterio de salida:** un post creado en FastGram aparece publicado en TikTok e Instagram y sus métricas vuelven al dashboard.

## P3-OAUTH — Conexiones sociales

- [x] **P3-OAUTH-001** Puerto `SocialPublisher` + `DATA-016`
- [x] **P3-OAUTH-002** OAuth TikTok (Business/Creator) · `INT-001` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-OAUTH-003** OAuth Instagram (nativo + Ayrshare) · `INT-002`, `INT-006` · **cerrada 2026-09-24:** la mitad Ayrshare queda fuera (D-15)
- [x] **P3-OAUTH-004** OAuth YouTube · `INT-003` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-OAUTH-005** OAuth LinkedIn + **aviso de caducidad a 60 días** · `INT-004` · **cerrada 2026-09-24:** aviso de LinkedIn a 60 días en el banner y la campana (s7-E)
- [x] **P3-OAUTH-006** OAuth Reddit · `INT-005` · **cerrada 2026-09-24:** para Engagement (PU-LATER-006)
- [x] **P3-OAUTH-007** Tokens cifrados en reposo, **nunca** devueltos por la API · `NFR-007` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-OAUTH-008** Estados de conexión y flujo de reconexión · PRD §19.5 · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-OAUTH-009** Multi-cuenta por plataforma + `400 connection_ambiguous` · `FR-060`
- [x] **P3-OAUTH-010** **Separar permiso de lectura (marca) del de publicación** · §10 regla 7, `EXT-001` · **cerrada 2026-09-24:** lectura sin login (D-13); `publishScopesOf` separa publicar de leer
- [x] **P3-OAUTH-011** Los 16 estados de error de integración de PRD §19.5 · **cerrada 2026-09-24:** estados de conexión en el banner global y la campana (s7-E); D14–D16 (direct post) no aplican por D-10

## P3-SCHED — Scheduling

- [x] **P3-SCHED-001** `DATA-020` con la máquina de estados completa (10 estados) · `FR-060`
- [x] **P3-SCHED-002** Paso `Select Platforms` con opciones por plataforma · `F-150` · **cerrada 2026-09-24:** `ScheduleDialog` (s7-A)
- [x] **P3-SCHED-003** Paso `Content Details` multi-plataforma con contadores · `F-153` · **cerrada 2026-09-24:** caption por red con contador (s7-A)
- [x] **P3-SCHED-004** `Improve` / `Regenerate` por campo · `F-154`, `AI-006` · **cerrada 2026-09-24:** Improve/Regenerate por red con el modelo `text` (s7-A)
- [x] **P3-SCHED-005** Paso `Schedule` con time + date picker y disclaimers · `F-156` · **cerrada 2026-09-24:** fecha y hora en la zona de la marca (s7-A)
- [x] **P3-SCHED-006** TikTok: `posting_mode` + `privacy_level` + entitlement `tiktokDirect` · `F-151`, `F-152`
- [x] **P3-SCHED-007** `Auto-Add Music` · `F-155` · **cerrada 2026-09-24:** adaptado: Blitz le pone una pista de la biblioteca de la marca a cada pieza de video (s7-B); ninguna API de publicación ofrece auto-music
- [x] **P3-SCHED-008** Instagram slideshow `carousel` / `reel` · `F-158` · **cerrada 2026-09-24:** Reel vs carrusel; el Reel lo arma el worker con FFmpeg (s7-A)
- [x] **P3-SCHED-009** AI content label y paid partnership disclosure · `F-160`, `F-161` · **cerrada 2026-09-24:** etiqueta IA sólo donde la red la soporta (YouTube) (s7-A)
- [x] **P3-SCHED-010** Post now · `F-157` · **cerrada 2026-09-24:** Post now (+30 s) (s7-A)
- [x] **P3-SCHED-011** Cancel / delete por lote, **atómicos**, máx. 100 ids · `F-162`, `ERR-F01`

## P3-PUB — Publicación

- [x] **P3-PUB-001** Worker de publicación en la hora programada
- [x] **P3-PUB-002** `AWAITING_RECONNECT` con reanudación automática · `FR-060` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-PUB-003** `IN_USER_INBOX` como estado normal, **no error** · `FR-060`
- [x] **P3-PUB-004** **Watcher de carril lento de TikTok hasta 72 h; nunca duplicar** · `NFR-015` · ⚠️ regla explícita · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-PUB-005** `publishedCaption` + `captionAdjustmentReason` · `FR-060`
- [x] **P3-PUB-006** Traducción a `errorCode` estable y neutral · `DP-006` · tabla determinística primero · **cerrada 2026-09-24:** fallback `publish_failed` para lo no mapeado (s7-A)
  > **Tabla determinística hecha y cableada (`382f82d`, `3118b48`).** 7 motivos × 5 plataformas, las 35 celdas escritas; sólo cambia la fila cuando el PRD tiene un código literal. `uncoded` (el PRD clasifica sin código: `permissions_missing`, etc.) deja el motivo neutral del puerto. **Falta la rama `escalate`**: `unknown` va a DP-006, que no tiene adaptador de `Judgment`. Decisión mía, revisable: límites de LinkedIn y Reddit → `rate_limited` (PRD:1398, «límite de plataforma»).
- [x] **P3-PUB-007** Límites de plataforma diferenciados · `FR-060`
  > **Estaba marcada hecha y no se cumplía hasta `3118b48`:** el worker escribía `failure.reason` tal cual, así que un límite de TikTok quedaba `post_limit_exceeded` y un test lo fijaba así. Ahora pasa por la tabla de DP-006.

## P3-METRIC — Métricas

- [x] **P3-METRIC-001** Job de sync de views/likes/comments · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-METRIC-002** Batch analytics ≤100 ids con éxito parcial · `ERR-F02`
- [x] **P3-METRIC-003** **Distinguir cero real de pre-sync con `postedAt`** · `NFR-016`

## P3-ANALYT — Analytics

- [x] **P3-ANALYT-001** `/analytics` con selector de rango · `FR-120` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P3-ANALYT-002** Desglose por plataforma y por tipo de contenido · `F-171`, `F-172` · **cerrada 2026-09-24** (auditoría: ya implementada)
- ~~**P3-ANALYT-003** Script de website analytics activable · `F-174`~~ · **fuera de alcance:** D-15 (growth)
- ~~**P3-ANALYT-004** Atribución de ads · `F-175` · ⚠️ alcance real en `OQ-06`~~ · **fuera de alcance:** D-15 (sin ads; OQ-06)

## P3-WARM — Warmed Accounts

> **Fuera de alcance por `D-15` (2026-09-24, uso personal).** Las tareas quedan como referencia; no se trabajan salvo que el dueño lo reabra.

- [x] **P3-WARM-001** `DATA-017`…`DATA-019` · `FR-130`
- ~~**P3-WARM-002** Compra y configuración (plataforma, país, nicho) · `F-181`~~ · **fuera de alcance:** D-15
- ~~**P3-WARM-003** Flujo de aprobación por el owner · `F-183`~~ · **fuera de alcance:** D-15
- ~~**P3-WARM-004** `postingAvailability` y `postable` · `F-186`~~ · **fuera de alcance:** D-15
- [x] **P3-WARM-005** Lead time **por cuenta** + techo de 30 días · `F-185`
- ~~**P3-WARM-006** Slot balance + `402` al agotarse · `F-184`~~ · **fuera de alcance:** D-15
- ~~**P3-WARM-007** Replacement decisions · `F-187`~~ · **fuera de alcance:** D-15
- ~~**P3-WARM-008** TikTok commercial sounds · `F-159`~~ · **fuera de alcance:** D-15

## P3-AUTO — Automations

> **Hecho 2026-09-24 (uso personal):** las 13 tareas. Verificado con Ollama real en una base aparte: campaña de 1 semana → 7 piezas construidas → launch con 14 slots → cancel. Web sin pasada visual del agente (la hace el coordinador).


- [x] **P3-AUTO-001** `DATA-021` + `DATA-022` con sus dos máquinas de estados · `FR-150`
- [x] **P3-AUTO-002** Wizard de configuración · `F-211`
- [x] **P3-AUTO-003** `prefsSnapshot` **congelado**: cambiar prefs del workspace no altera la campaña · `F-212`
- [x] **P3-AUTO-004** Generación de slots + cuota por campaña · `F-213`
- [x] **P3-AUTO-005** **Tipo con peso 0 queda excluido, nunca es fallback** · `AI-012` · ⚠️ regla dura
- [x] **P3-AUTO-006** `FAILED_GEN` con `no_unique_content` / `no_demo_video` · `AI-012`
- [x] **P3-AUTO-007** Dedup de contenido con pgvector + juicio sólo en borderline · `ADR-003`
- [x] **P3-AUTO-008** Review: editar slot, captions por plataforma, re-roll · `F-214`, `F-215`
- [x] **P3-AUTO-009** `launchValidation` con todos los gates · `F-216`
- [x] **P3-AUTO-010** Launch: reserva slots y cobra · `F-217`
- [x] **P3-AUTO-011** YouTube exige `slideshowWeight = 0` · `FR-150`
- [x] **P3-AUTO-012** Cancel / delete con sus restricciones · `F-219`
- [x] **P3-AUTO-013** Vistas Calendar y Grid · `F-220`

---

# P4 — Advanced Features

> **Criterio de salida:** un agente externo crea y publica por MCP; un influencer entrenado aparece en Blitz.

## P4-INFL — Influencers

- [x] **P4-INFL-001** `DATA-013`…`DATA-015` · `FR-080`
- [x] **P4-INFL-002** Wizard de 3 pasos con costos visibles · `F-091` · **cerrada 2026-09-24:** adaptado: Higgsfield Soul ID, sin créditos (D-06)
- [x] **P4-INFL-003** Generación de imagen base con **FLUX.1 [schnell]** · `ADR-010` · **cerrada 2026-09-24:** adaptado: imagen base por texto con el `ImageGen` configurado, no FLUX fijo (s7-G)
- [x] **P4-INFL-004** Subida de imagen base propia · `F-092`
- [x] **P4-INFL-005** **Pipeline de entrenamiento LoRA** (el "training" de 15–20 min del PRD) · `ADR-010`, `AI-007` · **cerrada 2026-09-24:** reemplazado por Higgsfield Soul ID (PU-LATER-004)
- [x] **P4-INFL-006** Regenerar = **persona nueva**, no edición · `F-093` · ⚠️ regla de producto · **cerrada 2026-09-24:** Regenerate crea otro personaje con `regeneratedFromId` (s7-G)
- [x] **P4-INFL-007** Estados y `progress` 0–100 · `F-094` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-INFL-008** Cap de 50 activos + idempotencia obligatoria · `FR-080`
- [x] **P4-INFL-009** Galería de imágenes + barra de generación con templates · `FR-081` · **cerrada 2026-09-24:** galería + templates editables por marca (s7-G)
- [x] **P4-INFL-010** Galería de videos + selección de modelo y duración · `FR-082` · **cerrada 2026-09-24:** adaptado: "Animate this image" con image-to-video de Higgsfield (s7-G); sin probar contra Higgsfield real
- [~] **P4-INFL-011** Talking Head UGC con validación de longitud de script · `AI-010` · @s8-L 2026-09-24
- [x] **P4-INFL-012** Tab Configuration: ángulos, cuentas, sets · `FR-083` · **cerrada 2026-09-24:** tab Configuration con auto-guardado (s7-G)
- [x] **P4-INFL-013** Integración con Blitz: `influencerChance`, chips, fallback · `FR-055` · **cerrada 2026-09-24:** JV-6 elige entre varios influencers (s7-C)

## P4-AISTUDIO — AI Studio

- [x] **P4-AISTUDIO-001** `/ai-studio` con prompt, referencias y contador · `FR-090` · **cerrada 2026-09-24:** picker del Media Bank + contador (s7-G)
- [x] **P4-AISTUDIO-002** Cap de **10 generaciones en vuelo** · `F-112`
- [x] **P4-AISTUDIO-003** Filtro de contenido con mensajes diferenciados · `F-113` · **cerrada 2026-09-24** (auditoría: ya implementada)
- ~~**P4-AISTUDIO-004** Gating por plan · `F-115`~~ · **fuera de alcance:** D-06 (sin planes)

## P4-FORMAT — Formatos IA adicionales

- [x] **P4-FORMAT-001** Pipeline genérico de formato generativo · `F-084` · **cerrada 2026-09-24:** pipeline declarativo sobre `VideoGen` (s7-G)
- [~] **P4-FORMAT-002** Los 17 formatos del catálogo · `F-070` tabla · dep: P4-FORMAT-001 · @s8-L 2026-09-24 · 7/17 hechos en el sprint 7; los 10 restantes sobre fal (TTS, OmniHuman, lip-sync, Wan Animate Replace): la nota anterior "ningún proveedor lo ofrece" era falsa para fal

## P4-ENGAGE — Engagement

- [x] **P4-ENGAGE-001** `DATA-024` + `DATA-025` · `FR-140` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-002** Configuración de subreddits · `F-192` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-003** Job de descubrimiento con backoff · `F-191` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-004** **`JV-2`** scoring de leads: 5 preguntas + composición en código · PRD §25.3 · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-005** Pesos y umbrales en código, recalculables sin reinferir · `JV-2` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-006** Listado, filtros y vistas · `F-193` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-007** Detalle + `Why this lead?` (LLM) · `F-194` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-008** Generación y regeneración de respuesta con reglas propias · `F-195`, `F-196` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-009** **`JV-5`** clasificador de tono → ban meter · PRD §25.3 · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-010** **Ratio y nivel del ban meter calculados en CÓDIGO** · `DP-003` · ⚠️ nunca por el modelo · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-011** Monitorización de hilos + `Sync with Reddit` · `F-198`, `F-199` · **cerrada 2026-09-24** (auditoría: ya implementada)
- [x] **P4-ENGAGE-012** Estados de error del módulo · PRD §19.4 · **cerrada 2026-09-24** (auditoría: ya implementada)

## P4-JV — Judgment features restantes

- [x] **P4-JV-001** **`JV-3`** pre-flight de publicación · `EXT-007`, `DP-007` · **cerrada 2026-09-24:** adaptado: corre en el piloto (PU-AUTO-002)
- [x] **P4-JV-002** Pre-flight con **timeout duro: si no responde, se publica igual** · `JV-3` · ⚠️ no puede bloquear el producto · **cerrada 2026-09-24:** desvío deliberado: si no responde, **retiene** (nunca aprueba sin juzgar, PU-AUTO-002)
- [x] **P4-JV-003** **`JV-6`** rerank marca↔candidato · `DP-005` · dep: P2-JV-001 · **cerrada 2026-09-24:** JV-6 para meme, fondo, influencer y referencia de remix (s7-C)
- [~] **P4-JV-004** `JV-6` aplicado a personajes AI UGC y videos UGC humanos · PRD §25.3 · @s8-K 2026-09-24

## P4-BILL — Billing

> **Fuera de alcance por `D-15` (2026-09-24, uso personal).** Las tareas quedan como referencia; no se trabajan salvo que el dueño lo reabra.

- ~~**P4-BILL-001** Puerto `Payments` + adaptador · `INT-008`~~ · **fuera de alcance:** D-15
- [x] **P4-BILL-002** Los 4 planes con sus límites · PRD §16.1
- ~~**P4-BILL-003** Upgrade prorrateado / downgrade programable · PRD §16.3~~ · **fuera de alcance:** D-15
- ~~**P4-BILL-004** Compra de créditos, saves y post slots · `F-237`, `F-238`~~ · **fuera de alcance:** D-15
- ~~**P4-BILL-005** Cancelación con feedback · PRD §16.5~~ · **fuera de alcance:** D-15
- ~~**P4-BILL-006** Modo view-only al agotar cuota · PRD §16~~ · **fuera de alcance:** D-15
- ~~**P4-BILL-007** API overage billing · `F-240`~~ · **fuera de alcance:** D-15
- ~~**P4-BILL-008** Restricciones de trial · PRD §16.7~~ · **fuera de alcance:** D-15

## P4-PUBAPI — API pública

> **Fuera de alcance por `D-15` (2026-09-24, uso personal).** Las tareas quedan como referencia; no se trabajan salvo que el dueño lo reabra.

- ~~**P4-PUBAPI-001** Los 29 endpoints de PRD §9.3 · dep: P1-API-002~~ · **fuera de alcance:** D-15
- ~~**P4-PUBAPI-002** Gestión de API keys en Settings · `F-239`~~ · **fuera de alcance:** D-15
- ~~**P4-PUBAPI-003** Documentación embebida `/developers` · `F-243`~~ · **fuera de alcance:** D-15
- ~~**P4-PUBAPI-004** Tests de contrato por endpoint contra el OpenAPI~~ · **fuera de alcance:** D-15
- ~~**P4-PUBAPI-005** Webhooks salientes · `EXT-002`, `OQ-11`~~ · **fuera de alcance:** D-15

## P4-MCP — Servidor MCP

> **Fuera de alcance por `D-15` (2026-09-24, uso personal).** Las tareas quedan como referencia; no se trabajan salvo que el dueño lo reabra.

- ~~**P4-MCP-001** `apps/mcp` con JSON-RPC 2.0 stateless · `AI-015`~~ · **fuera de alcance:** D-15
- ~~**P4-MCP-002** Los 16 tools de lectura · `AI-015`~~ · **fuera de alcance:** D-15
- ~~**P4-MCP-003** Los 18 tools de acción, con los destructivos marcados · `AI-015`~~ · **fuera de alcance:** D-15
- ~~**P4-MCP-004** Rate limit propio de 30/min por usuario · `AI-015`~~ · **fuera de alcance:** D-15
- ~~**P4-MCP-005** Connector OAuth con scopes y confirmaciones · `AI-015`~~ · **fuera de alcance:** D-15

---

# P5 — Functional Parity

> **Criterio de salida:** la Parity Matrix del PRD §23 no tiene filas sin cubrir.

## P5-NOTIF — Notificaciones

- [x] **P5-NOTIF-001** Centro de notificaciones con read/unread · PRD §13.3 · **cerrada 2026-09-24:** campana con leído/no leído (s7-E)
- [x] **P5-NOTIF-002** Preferencias por categoría y canal · `F-234` · ⚠️ contenido exacto en `OQ-03` · **cerrada 2026-09-24:** Settings → Notifications por categoría y canal (s7-E)
- ~~**P5-NOTIF-003** Email transaccional~~ · **fuera de alcance:** reemplazado por ntfy y Telegram (s7-E): un solo usuario no necesita email transaccional
- [x] **P5-NOTIF-004** Los 22 triggers de PRD §13.2 · **cerrada 2026-09-24:** adaptado: los eventos que aplican a uso personal (publicado, fallo, borrador de TikTok, conexión, rechazo del piloto, campaña, resumen, cola) (s7-E)

## P5-MEMBER — Miembros y permisos

- ~~**P5-MEMBER-001** Invitaciones · `F-005`, `OQ-02`~~ · **fuera de alcance:** D-06 (un usuario)
- ~~**P5-MEMBER-002** Sección `members` en Settings · `EXT-003`~~ · **fuera de alcance:** D-06 (un usuario)
- ~~**P5-MEMBER-003** Matriz de permisos completa · PRD §4.2, `OQ-01`~~ · **fuera de alcance:** D-06 (un usuario)

## P5-GROWTH — Crecimiento y soporte

> **Fuera de alcance por `D-15` (2026-09-24, uso personal).** Las tareas quedan como referencia; no se trabajan salvo que el dueño lo reabra.

- ~~**P5-GROWTH-001** Refer & Earn · `F-250`~~ · **fuera de alcance:** D-15
- ~~**P5-GROWTH-002** Guide · `F-251`~~ · **fuera de alcance:** D-15
- ~~**P5-GROWTH-003** Roadmap y Changelog · `F-252`, `F-253`~~ · **fuera de alcance:** D-15
- ~~**P5-GROWTH-004** Feedback · `F-254`~~ · **fuera de alcance:** D-15
- ~~**P5-GROWTH-005** Páginas SEO: comparativas, `/for`, `/tools` · PRD §3~~ · **fuera de alcance:** D-15

## P5-QUALITY — Calidad transversal

- ~~**P5-AUDIT-001** Audit log de acciones destructivas y facturables · `EXT-004`, PRD §9.12~~ · **fuera de alcance:** D-06 (un usuario, sin billing; `judgment_records` cubre las decisiones de IA)
- [x] **P5-A11Y-001** WCAG 2.1 AA · `NFR-020` · **cerrada 2026-09-24:** contraste AA del texto de color (31 usos), `aria-describedby` en Dialog/Drawer/Checkbox, foco visible, regiones vivas, calendario con `E`, reducir movimiento en videos (s7-J + coordinador); sin lector de pantalla real ni `axe-core` (no instalado)
- [x] **P5-A11Y-002** **Alternativa no gestual al swipe de Blitz** · `NFR-020` · ⚠️ el swipe no puede ser el único camino · **cerrada 2026-09-24:** botones + `aria-keyshortcuts` + flechas en `BlitzDeck.tsx`
- ~~**P5-EVENT-001** Suite completa de eventos de PRD §18~~ · **fuera de alcance:** D-06 (un usuario)
- ~~**P5-EVENT-002** Funnel de activación **segmentado por `source_type`** · PRD §18 · ⚠️ es la métrica que decide si `EXT-001` funcionó~~ · **fuera de alcance:** D-06 (un usuario)
- [x] **P5-ERR-001** Auditoría: los ~90 estados de error y vacío de PRD §19 con su copy literal · **cerrada 2026-09-24:** estados de PRD §19 que aplican en modo personal: E06, E10, L01, L09 agregados; el resto ya estaba o es de SaaS (s7-J)
- [x] **P5-I18N-001** Contenido multi-idioma del plan Pro · `OQ-12` · **cerrada 2026-09-24:** adaptado: `language` por marca en la estrategia (el copy lo respeta desde el sprint 7, @s7-C)
- [~] **P5-LIBR-001** Estrategia de librería de personajes AI UGC · `OQ-13` · @s8-K 2026-09-24
- [~] **P5-LIBR-002** Estrategia de librería de UGC humano · `OQ-13` · @s8-K 2026-09-24
- ~~**P5-PERF-001** Pruebas de carga k6: rate limits, cuotas, fan-out de publicación~~ · **fuera de alcance:** D-06 (un usuario)
- [x] **P5-PARITY-001** **Recorrer la Parity Matrix de PRD §23 y cerrar cada fila** · **cerrada 2026-09-24:** `docs/PARIDAD-FASTLANE.md`: cada fila Anda, Adaptado, Fuera o Bloqueado

---

## Preguntas abiertas que bloquean tareas

Ninguna se resuelve escribiendo código. Si tu tarea depende de una, marcala `[!]` y escalá.

| OQ | Bloquea | Tipo |
|---|---|---|
| `OQ-16` | P1-BRAND-013 (tier C) | **Legal** |
| `OQ-19` | P1-BRAND-007…011 (extractores) | Descubrimiento técnico |
| `OQ-20` | P2-JV-003 (activar otro adaptador) | Experimento |
| `OQ-13` | P2-TREND-001, P5-LIBR-001/002 | **Legal + producto** |
| `OQ-01`, `OQ-02` | P5-MEMBER-* | Producto |
| `OQ-03` | P5-NOTIF-002 | Producto |
| `OQ-04` | P2-LIB-005 | Producto |
| `OQ-06` | P3-ANALYT-004 | Producto |
| `OQ-08` | P2-STUDIO-007 | Producto |
| `OQ-11` | P4-PUBAPI-005 | Producto |
| `OQ-12` | P5-I18N-001 | Producto |
| `OQ-14` | P1-QUOTA-009 | Producto |
