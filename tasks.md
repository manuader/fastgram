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

---

# P0 — Bootstrap

> No es una fase del PRD. Es lo que tiene que existir antes de poder empezar la Fase 1.

## P0-REPO — Repositorio y tooling

- [x] **P0-REPO-001** `git init`, rama `main`, primer commit con el estado actual (PRD, EVAL, docs, videos)
- [x] **P0-REPO-002** `.gitignore` (node, build, `.env*`, `handoffs/`) · dep: P0-REPO-001
- [x] **P0-REPO-003** Monorepo pnpm + Turborepo con el layout de IMPLEMENTATION-PLAN §2.2 · `ADR-001`
- [!] **P0-REPO-004** **Decidir y documentar el build de FFmpeg** (componentes GPL vs LGPL) y el modelo de licencia del render · `ADR-007` · ⚠️ legal, no sólo técnico · **BLOQUEADO: lo decide una persona, no un agente**
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
- [ ] **P1-INFRA-002** Entornos `dev` / `staging` / `prod` con IaC
- [ ] **P1-INFRA-003** Postgres gestionado + backups verificados (**probar un restore, no sólo configurarlo**)
- [ ] **P1-INFRA-004** Bucket R2 + CDN + política de ciclo de vida · `ADR-006`
- [ ] **P1-INFRA-005** Pipeline de deploy con rollback
- [ ] **P1-INFRA-006** Gestión de secretos (no en el repo)

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

- [ ] **P1-AUTH-001** Puerto `Identity` + adaptador Better Auth · `ADR-008`
- [ ] **P1-AUTH-002** Signup / login / logout · `F-001`…`F-003`
- [ ] **P1-AUTH-003** SSO + callback `/auth/sso-callback` · `F-002`
- [ ] **P1-AUTH-004** Sesiones, refresh, revocación
- [ ] **P1-AUTH-005** Recuperación de contraseña · `§15.3`
- [ ] **P1-AUTH-006** Borrado de cuenta con confirmación por email y sus estados · `F-011`, `FR-160`

## P1-TENANT — Workspaces

- [ ] **P1-TENANT-001** Creación de workspace + límite por usuario · `F-008`
- [ ] **P1-TENANT-002** Cambio de workspace y contexto activo · `F-009`
- [ ] **P1-TENANT-003** Roles `owner` / `member`, comprobados **en el servidor** · PRD §4, `FR-002`
- [ ] **P1-TENANT-004** Test de contrato: acceso cruzado devuelve **404**, no 403 · `NFR-006`
- [ ] **P1-TENANT-005** Borrado de workspace con sus advertencias · `FR-160`

## P1-QUOTA — Cuotas y rate limiting

- [x] **P1-QUOTA-001** Motor de content saves: incluidos → comprados → overage · PRD §16.2
- [x] **P1-QUOTA-010** **Cablear el cobro a `POST /content`** — el motor existía y ninguna ruta cobraba
  > Faltaban tres piezas, no el motor: de dónde sale el plan (`companyRepository`), qué clave identifica el período, y dónde se guarda el bucket.
  > **`quota_ledgers.period` = `YYYY-MM-DD`, la fecha UTC de inicio del ciclo.** El schema lo dejaba pendiente y lo decide `billingPeriodKey`. No es `YYYY-MM`: §16.2 resetea en el **día ancla**, así que con ancla 15 el ciclo cruza dos meses calendario y la clave tiene que decir *qué ciclo*, no *qué mes*. 14 tests, incluido un barrido de 400 días × 6 anclas que comprueba que todo instante cae en exactamente un período.
  > **`contents.save_bucket` y `save_period`** (migración `0005`), con CHECK de que estén los dos o ninguno: `refundSave` devuelve **al bucket del que salió** y al ledger que lo cobró, y los tres buckets tienen precio distinto.
  > El cobro va **antes** de crear y de encolar, y dentro de la misma transacción. `quotaLedgerStore.lockPeriod` usa `SELECT … FOR UPDATE`; sus dos tests de concurrencia se ponen rojos si se le quita.
- [x] **P1-QUOTA-002** Swipes diarios con reset 00:00 UTC · `F-066`
- [x] **P1-QUOTA-003** Créditos de AI Studio
- [~] **P1-QUOTA-011** **Cablear el cobro de créditos a `POST /influencers`** (250, `AI_STUDIO_COST.influencer`) con liberación si el pipeline falla · `FR-080`, §9.4 · agente C
- [x] **P1-QUOTA-004** Trial allowance **de por vida**, compartida entre workspaces personales, sin reset · PRD §16.2
- [x] **P1-QUOTA-005** **Reembolso de content save cuando el build falla** · `FR-050` · ⚠️ regla de negocio explícita
- [~] **P1-QUOTA-012** **El saldo comprado no se arrastra entre períodos** — §16.2 dice que no caduca y `lockPeriod` crea el período nuevo en 0 · agente D
- [~] **P1-QUOTA-013** Handler de `quota-reset` (§9.5 #17): barrido de períodos vencidos · agente D
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
- [~] **P1-QUEUE-005** Idempotencia: `Idempotency-Key`, replay de respuesta, `409` con body distinto, liberación al fallar · `NFR-004` · **parcial:** cableada a las cuatro rutas que §9.3 exige (`POST /content`, `PATCH /content/:id`, `POST /content/:id/regenerate`, `POST /influencers`); **el replay nunca se ejerció de punta a punta** — no hay test que haga dos peticiones con la misma key contra la base
- [x] **P1-QUEUE-006** Scaffold del `apps/worker`
- [~] **P1-QUEUE-008** Handler de `content-build` en `apps/worker`: construye, sube y cierra `BUILDING → CREATED|FAILED` **con reembolso del save** · `FR-050`, IMPL §2.3 · **parcial:** el pipeline corre de punta a punta contra los binarios compilados, pero **con `MemoryMediaRenderer`**: el artefacto son bytes sintéticos. El render real es `services/render` y sigue sin adaptador (`P2-RENDER-002`). Tampoco construye `custom` —la fila no guarda la clave del objeto subido— ni aplica `prompt`/`mentionBusiness` de `AI-004`.
  > **El círculo cierra.** `POST /content` cobraba el save y encolaba, y del otro lado no había nadie: la pieza quedaba en `BUILDING` para siempre y el save cobrado no se devolvía nunca. `pnpm smoke:binary` levanta ahora los **dos** procesos y espera a que la pieza llegue a `CREATED`.
  > Siete mecanismos verificados **rompiéndolos**: la guarda de doble reembolso, el chequeo de `revision` al leer, al escribir y al fallar, el corte del último intento, el `FOR UPDATE` de `lockContent` y el filtro de soft-delete. Dos de mis tests pasaban por la razón equivocada y lo encontré así.

## P1-STORAGE — Objetos y subidas

- [x] **P1-STORAGE-001** Puerto `Storage` + adaptador S3-compatible (R2 / MinIO) · `ADR-006`
- [x] **P1-STORAGE-002** Subida en 3 fases: reserva → PUT directo → finalización · PRD §9.8
- [x] **P1-STORAGE-003** Límites y tipos: imagen 10 MB, video 50 MB, extensión coherente con content-type · `NFR-013`
- [x] **P1-STORAGE-004** URLs firmadas de vida corta (1 h), **nunca logueadas ni persistidas** · `NFR-008`
- [x] **P1-STORAGE-005** Errores de reserva: `409` no alcanzable, `410` expirada, `404` ajena · PRD §9.8
- [~] **P1-STORAGE-006** Limpieza best-effort que **no bloquea** el borrado de la fila · `ERR-F05` · **parcial:** el puerto deja la política al llamador (correcto); falta el caso de uso que loguea y sigue

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
- [ ] **P1-JUDGE-004** Selección de adaptador **por punto de decisión**, no global · PRD §9.15.2
- [ ] **P1-JUDGE-005** Persistencia de `JudgmentRecord` con `latencyMs` e `inputTokens` · `DATA-033`
- [ ] **P1-JUDGE-006** **Evaluación de modelos y precios**, con resultado fechado en `HANDOFF.md` · `ADR-009` · ⚠️ nada de precios de memoria
- [x] **P1-JUDGE-007** Sanitización obligatoria del estado antes del puerto · PRD §9.15.3
- [x] **P1-JUDGE-008** Suite de contrato única que corre contra **todos** los adaptadores · IMPL §4
  > Las 37 aserciones de `asr`, `media-renderer`, `payments`, `social-publisher` y `social-reader` **nunca se habían ejecutado** porque no existía ningún adaptador de esos puertos. Ahora corren contra implementaciones en memoria: 37 de 37 verdes, y la corrida encontró **cuatro aserciones que no medían lo que prometían** (ver el commit `308e30d`). Cinco de las 37 no pueden fallar contra un adaptador en memoria y están anotadas como tales.

## P1-VISION — Servicio de visión

- [x] **P1-VISION-001** Scaffold `services/vision` (Python, HTTP, sin estado)
- [~] **P1-VISION-002** Puerto `Ocr` + adaptador PaddleOCR · `ADR-011` · **la nota anterior quedó vieja:** el puerto (`packages/ports/src/ocr.ts`) y el adaptador HTTP (`VisionOcr`) existen desde hace tiempo, con la suite de contrato corriendo contra un `services/vision` falso pero real como servidor
  > Lo que sigue faltando es otra cosa, y está escrito en la cabecera de `vision-ocr.test.ts`: **nadie comprobó nunca que PaddleOCR lea un overlay de TikTok de verdad.** Necesita el servicio levantado con el extra `ocr` (`docker compose --profile vision up`, que no corre por defecto porque la imagen pesa) y una imagen real. Hasta entonces, lo verificado es el rodeo del adaptador —bytes → URL publicada → descarga → traducción de la respuesta—, no el motor.
- [x] **P1-VISION-003** OCR sobre imagen y sobre frames de video
- [x] **P1-VISION-004** Detección de idioma del texto extraído
- [x] **P1-VISION-005** Fallo de OCR degrada a `partial`, **nunca** aborta · `AI-016`

## P1-BRAND — Brand Sources · `EXT-001`

- [ ] **P1-BRAND-001** Puerto `SocialReader` con una implementación por plataforma
- [ ] **P1-BRAND-002** **Spike de cobertura pública por plataforma (las 5)** · `OQ-19` · ⚠️ **hacer ANTES de escribir los extractores**; puede reabrir `D-02`
- [ ] **P1-BRAND-003** Resolución y normalización de entrada: URL, `@handle`, limpieza de tracking, `x.com`≡`twitter.com` · `FR-011.1`
- [ ] **P1-BRAND-004** Desambiguador de plataforma, con preselección de la cuenta ya conectada · `FR-011.1`
- [ ] **P1-BRAND-005** Link a post concreto → resuelve al perfil del autor + aviso · `FR-011.1`
- [ ] **P1-BRAND-006** Extractor `website` / `other_url` (OpenGraph + contenido) · `AI-001`
- [ ] **P1-BRAND-007** Extractor Instagram · `D-02`
- [ ] **P1-BRAND-008** Extractor TikTok · `D-02`
- [ ] **P1-BRAND-009** Extractor X · `D-02`
- [ ] **P1-BRAND-010** Extractor YouTube · `D-02`
- [ ] **P1-BRAND-011** Extractor LinkedIn · `D-02`
- [ ] **P1-BRAND-012** Orden de tiers **B → C → A → D**; el signup **no pide OAuth** · `D-01`, `FR-011.4`
- [ ] **P1-BRAND-013** Tier C **detrás de bandera apagada** hasta `OQ-16` · `FR-011.4`
- [ ] **P1-BRAND-014** Tier D asistido: pegar bio, subir capturas · `FR-011.4`
- [ ] **P1-BRAND-015** Resolución de link-in-bio: 1 nivel, máx. 5 destinos, sin recursión · `INT-018`
- [ ] **P1-BRAND-016** `AI-016`: síntesis con `fieldMeta` (confianza + origen + extracto)
- [ ] **P1-BRAND-017** Preguntas de cierre de huecos · `FR-011.3` · ⚠️ **nunca inventar** un campo sin señal
- [ ] **P1-BRAND-018** Protección SSRF en **todos** los orígenes, incluido el seguimiento de link-in-bio · `NFR-017`
- [ ] **P1-BRAND-019** **Suite de regresión con bios adversariales** (prompt injection) · `FR-011.9` · ⚠️ exigida por el PRD
- [ ] **P1-BRAND-020** Unicidad `(sourceType, handle)` global · `FR-011.7`
- [ ] **P1-BRAND-021** Retención del snapshot + purga por `rawRetentionExpiresAt`; binarios de terceros **no se persisten** · `DATA-032`
- [ ] **P1-BRAND-022** Estados y errores completos de `FR-011.8` / `FR-011.9` (14 mensajes) · `ERR-B01`…`ERR-B14`
- [ ] **P1-BRAND-023** Semilla de content angles desde los temas con mejor engagement · `AI-016`
- [ ] **P1-BRAND-024** **Iniciar la revisión legal `OQ-16`** · ⚠️ bloquea el tier C, no es tarea de ingeniería

## P1-ONB — Onboarding

- [ ] **P1-ONB-001** Wizard multi-paso con progreso persistido y reanudable · `FR-010`
- [ ] **P1-ONB-002** Paso 1: input único de Brand Source + chips de plataforma · `FR-011.2`
- [ ] **P1-ONB-003** Paso 2: `Company Name`, `Company Description`, logo · `FR-010`
- [ ] **P1-ONB-004** Paso 3: cuestionario de perfilado (6 preguntas) · `F-006`
- [ ] **P1-ONB-005** Paso 4: estados de procesamiento con sub-pasos por tipo de fuente · `FR-011.2`
- [ ] **P1-ONB-006** **Pantalla de revisión** con `Worth a quick check` para los campos de confianza baja · `FR-011.2`
- [ ] **P1-ONB-007** Oferta post-análisis de conectar + importar media, **después** del análisis · `D-04`, `FR-011.5.1`
- [ ] **P1-ONB-008** Importación opt-in de posts propios al Media Bank, checkbox desmarcado · `FR-011.5.1`
- [ ] **P1-ONB-009** Todas las validaciones literales de `FR-010`
- [ ] **P1-ONB-010** Rama `Use description instead` → `BrandSource` tipo `manual`
- [ ] **P1-ONB-011** **E2E: alta completa con sólo un perfil de Instagram, sin un solo consentimiento OAuth** · `FR-011.12` crit. 11 · ⚠️ criterio de salida de la fase

## P1-BRANDPG — Página Brand

- [ ] **P1-BRANDPG-001** `/brand` con secciones editables · `FR-020`
- [ ] **P1-BRANDPG-002** Tarjeta `Brand sources`: listar, añadir, re-analizar, primaria, eliminar · `F-024`
- [ ] **P1-BRANDPG-003** Badges de origen y confianza por campo · `F-025`
- [ ] **P1-BRANDPG-004** `brandRevision` + `expectedBrandRevision` en las escrituras · `F-022`
- [ ] **P1-BRANDPG-005** Re-análisis respeta `editedByUser`: propone, no pisa · `FR-020`
- [ ] **P1-BRANDPG-006** `stale` a los 90 días + oferta de refrescar · `F-026`

## P1-UI — Shell de aplicación

- [x] **P1-UI-001** Next.js + Tailwind + shadcn/ui, tokens y tema
- [x] **P1-UI-002** Tema claro/oscuro **sin flash** en la carga · `NFR-021`
- [x] **P1-UI-003** Sidebar colapsable con las 10 entradas + bloque secundario · `FR-001`
- [x] **P1-UI-004** Rutas de PRD §3.1 con sus guards
- [x] **P1-UI-005** Sistema de toasts con enlace de acción · PRD §3.5
- [x] **P1-UI-006** Primitivas de estado: `empty`, `loading`, `error`, skeletons · PRD §19
- [x] **P1-UI-007** TanStack Query + capa de cliente de API tipada
- [ ] **P1-UI-008** Responsive: móvil y tablet · `NFR-019`
- [x] **P1-UI-009** Home con KPIs, Tasks y Views History · `FR-030`
- [x] **P1-UI-010** FAQ del Home: 5 categorías, 37 preguntas, copy literal · `FR-030`
- [ ] **P1-UI-011** **`text-subtle` en modo oscuro no cumple AA para texto normal** · `NFR-019`
  > Medido el 2026-09-21: 3,65:1 sobre `surface` y 3,16:1 sobre `raised`, contra el 4,5:1 que exige AA. Cumple el 3:1 de texto grande y nada más. Hoy eso significa que **en oscuro `text-subtle` no se puede usar en tamaño normal**.
  > No se arregla subiéndolo a `neutral-400`, que es donde vive `muted`: se perdería la distinción entre los dos niveles. Es una decisión de paleta. `packages/ui/src/tokens.contrast.test.ts` fija los valores medidos, así que la limitación no puede empeorar en silencio.

## P1-OBS — Observabilidad

- [x] **P1-OBS-001** Logs estructurados con `companyId` y `requestId` en todo
- [ ] **P1-OBS-002** OpenTelemetry: trazas y métricas
- [ ] **P1-OBS-003** Sentry (errores) + PostHog (producto) · `INT-010`
- [ ] **P1-OBS-004** Health checks y status page · `F-255`
- [ ] **P1-OBS-005** Alertas: cola atascada, tasa de fallo de build, saturación de rate limit

---

# P2 — Core Product

> **Criterio de salida:** el usuario aprueba una pieza en Blitz y la guarda; crea otra a mano en el Studio.

## P2-ANGLE — Content Angles

- [ ] **P2-ANGLE-001** `DATA-005` + CRUD · `FR-056`
- [ ] **P2-ANGLE-002** Caps: 100 por workspace, 10 por influencer, con sus códigos de error · `FR-056`
- [ ] **P2-ANGLE-003** **Auto-reconcile de `angleWeights` en la MISMA transacción** que la mutación · `FR-055` · ⚠️ test de integración obligatorio
- [ ] **P2-ANGLE-004** Soft-delete reversible; desactivar limpia links y reactivar **no** los restaura · `FR-056`
- [ ] **P2-ANGLE-005** Generador de ángulos (no persiste) + límite 5/min + liberación de reserva al fallar · `AI-005`

## P2-PREFS — Blitz Settings

- [ ] **P2-PREFS-001** `DATA-006` con defaults sintetizados · `FR-055`
- [ ] **P2-PREFS-002** Validación: los 4 pesos como unidad, suma exacta 100 · `FR-055`
- [ ] **P2-PREFS-003** `angleWeights` y `textStyleWeights` con sus reglas de suma y pertenencia · `FR-055`
- [ ] **P2-PREFS-004** 7 presets de estilo de caption · `FR-055`
- [ ] **P2-PREFS-005** **Los cambios aplican sólo a generaciones futuras; la cola no se vacía** · `FR-055` · ⚠️ regla explícita
- [ ] **P2-PREFS-006** Rate limit dedicado de 3/min
- [ ] **P2-PREFS-007** UI `/blitz/settings` con auto-guardado y banner `All changes saved` · `FR-055`

## P2-DISC — Discovery queue

- [ ] **P2-DISC-001** `DATA-007` + relleno en background, objetivo ~5 · `F-050`
- [ ] **P2-DISC-002** Selección ponderada: tipo, ángulo, remix/original, own-media, estilo · `AI-002`
- [ ] **P2-DISC-003** `influencerChance` como **tirada independiente**, no ratio de lote · `FR-055`
- [ ] **P2-DISC-004** Fallback a contenido regular si no hay influencer elegible; `green-screen` nunca usa influencer · `FR-055`
- [ ] **P2-DISC-005** `aiExplanation` **persistida con la sugerencia**, no regenerada al abrir · `AI-002`
- [ ] **P2-DISC-006** Generación on-demand por `contentType` forzado · `F-067`

## P2-RENDER — Motor de render

- [x] **P2-RENDER-001** Scaffold `services/render` (FFmpeg + sharp, sin estado) · `ADR-007`
- [~] **P2-RENDER-002** Puerto `MediaRenderer` + adaptador · agente B · **parcial:** el puerto está y tiene su suite de contrato; el adaptador **real contra `services/render` no existe**. Hoy `apps/worker` monta `MemoryMediaRenderer`, así que el pipeline de build corre completo y el artefacto son bytes sintéticos.
  > Al escribir el handler apareció que `audio` era **obligatorio** en `WallOfTextJob` y `VideoHookJob`, y `FR-053.1` (PRD:1234) dice que *No audio* omite el bloque. El contrato público ya lo tenía opcional: una pieza válida de `POST /content` no se podía ni escribir como `RenderJob`. Corregido en el puerto. **`services/render` todavía lo exige** (`payload.ts`), así que el adaptador real se va a topar con eso.
- [x] **P2-RENDER-003** Esquema de text-object compartido por los 4 formatos · `FR-070`
- [x] **P2-RENDER-004** Render `slideshow` (hasta 20 slides, 4 aspect ratios) · `FR-070`
- [x] **P2-RENDER-005** Render `wall-of-text` · `FR-070`
- [x] **P2-RENDER-006** Render `green-screen` (chromakey sobre fondo) · `FR-070`
- [x] **P2-RENDER-007** Render `video-hook` (hook + demo apilados + audio) · `FR-070`
- [~] **P2-RENDER-008** 12 familias tipográficas con sus pesos permitidos · `FR-051` · **parcial:** el registro de las 12 familias con sus pesos está y tiene test; faltan los **42 archivos de fuente** (ninguno en la máquina) y **`tiktok`/`snapchat` no tienen archivo distribuible** — decisión de licencia, de una persona
- [x] **P2-RENDER-009** **Validación de que toda URL de media pertenece al workspace o a la librería compartida** · `FR-070` · ⚠️ se rechaza antes de iniciar el build
- [x] **P2-RENDER-010** **Cache por hash del payload**: no re-encodear si sólo cambió el texto · IMPL §5
- [x] **P2-RENDER-011** Golden-file tests por formato · IMPL §4
- [x] **P2-RENDER-012** Recorte inteligente en vez de `stretch-to-canvas` · `EXT-006`
- [~] **P2-RENDER-014** **`audio` opcional en `wall-of-text` y `video-hook`** (`FR-053.1`: *No audio* omite el bloque) + endpoint para recuperar el artefacto renderizado · agente A
- [~] **P2-RENDER-013** Normalización de media: MOV→MP4, HDR→SDR, faststart · `NFR-014` · **parcial:** MOV→MP4 y faststart escritos pero **nunca corridos sobre un archivo real**; HDR→SDR **falla cerrado** porque este build de ffmpeg no trae `zscale` ni `libplacebo`

## P2-CONTENT — Entidad Content

- [x] **P2-CONTENT-001** `DATA-008` + `DATA-009` + ciclo `BUILDING → CREATED|FAILED` · `FR-050`
- [x] **P2-CONTENT-002** Concurrencia optimista por `revision`; `409 stale_revision` · `FR-051`
- [x] **P2-CONTENT-003** Edición menor: **no** crea fila, **no** consume save, **no** factura · `FR-051`
- [~] **P2-CONTENT-004** Regeneración de copy preservando estructura y nº de slides · `AI-004` · **parcial:** `POST /content/:id/regenerate` valida, sube la revisión y encola; el modelo lo llama el worker, que no existe
- [x] **P2-CONTENT-005** Todas las validaciones de rango de `FR-051`
- [~] **P2-CONTENT-006** Borrado: soft-delete + `409 content_has_linked_posts` (cancelar no basta) · `FR-051` · **parcial:** el 409 está en `PATCH`; el `DELETE` no lo comprueba
- [x] **P2-CONTENT-007** `409 content_still_building` con la ventana de 15 min · `ERR-P02`
- [x] **P2-CONTENT-008** `buildPayload` y `studioState` **nunca** salen por la API · `DATA-008`
  > No es una omisión que haya que recordar: el tipo de retorno del serializador es explícito, así que agregarlos sería un error de compilación.

## P2-BLITZ — Blitz

- [ ] **P2-BLITZ-001** Deck con stack de tarjetas y swipe · `FR-050`
- [ ] **P2-BLITZ-002** Teclado ← / → equivalentes a los botones · `F-052`
- [ ] **P2-BLITZ-003** Chips de tipo, influencer y ángulo · `F-053`, `F-054`
- [ ] **P2-BLITZ-004** Panel `Why This Content?` · `F-055`
- [ ] **P2-BLITZ-005** Panel `Remixed From` con likes y views · `F-056`
- [ ] **P2-BLITZ-006** Mute/unmute con indicador sobre la tarjeta · `F-057`
- [ ] **P2-BLITZ-007** Editor inline: panel ASSETS + inspector de texto · `FR-051`
- [ ] **P2-BLITZ-008** `Regenerate Text` con prompt opcional (≤500) · `F-059`
- [ ] **P2-BLITZ-009** Swap de video/audio/imagen con sus modales · `F-061`
- [ ] **P2-BLITZ-010** Modal `Select Video` con filtros, tags y paginación · `FR-052`
- [ ] **P2-BLITZ-011** Modal `Select Audio` con opción `No audio` y catálogos por tipo · `FR-053`
- [ ] **P2-BLITZ-012** Flujo de aceptación: `What would you like to do?` · `F-064`, `F-065`
- [ ] **P2-BLITZ-013** Estados: cola vacía, cuota agotada, perfil no listo, view-only · `FR-050`
- [ ] **P2-BLITZ-014** Aceptar descuenta **1 swipe + 1 save**; fallo de build reembolsa · `FR-050`

## P2-STUDIO — Content Studio

- [ ] **P2-STUDIO-001** Hub `/content` con las 22 tarjetas de formato · `F-070`
- [ ] **P2-STUDIO-002** Wizard con pasos, checks y `Generate` deshabilitado hasta completar · `F-073`
- [ ] **P2-STUDIO-003** Modos Remix y Create New · `F-071`, `F-072`
- [ ] **P2-STUDIO-004** Picker de trending con carrusel paginado y chips de nicho · `F-074`
- [ ] **P2-STUDIO-005** Preview + inspector por formato · `F-075`
- [ ] **P2-STUDIO-006** Modal `Swap image for slide N` · `FR-071`
- [ ] **P2-STUDIO-007** Estilos de wall-of-text · `F-078` · ⚠️ catálogo completo en `OQ-08`
- [ ] **P2-STUDIO-008** Demo video + enlace a la guía de grabación · `F-079`
- [ ] **P2-STUDIO-009** Subida de video custom (MP4/MOV ≤50 MB) · `F-083`
- [ ] **P2-STUDIO-010** `Save` / `Schedule` / `Clear` · `F-081`, `F-082`

## P2-MEDIA — Media Bank

- [ ] **P2-MEDIA-001** `DATA-010` + subida y finalización · `FR-100`
- [ ] **P2-MEDIA-002** Categorías válidas por tipo de media · `F-129`
- [ ] **P2-MEDIA-003** PATCH de categorías = reemplazo total; lista vacía saca del pool · `FR-100`
- [ ] **P2-MEDIA-004** Borrado idempotente + `409 media_in_use` · `FR-100`
- [ ] **P2-MEDIA-005** `DATA-011` Media Sets con **mínimo 5 assets** · `F-127`
- [ ] **P2-MEDIA-006** Modo `CREATING SET` con contador y validación · `FR-100`
- [ ] **P2-MEDIA-007** Filtros: tipo, categoría, influencer + búsqueda · PRD §12
- [ ] **P2-MEDIA-008** Deep-linking con `from` y `focus` · `FR-100.1`
- [ ] **P2-MEDIA-009** Assets generados, demo e internos **nunca** se listan · `FR-100`

## P2-LIB — Library

- [ ] **P2-LIB-001** Tab `My Posts` con estado, tipo y métricas · `F-120`
- [ ] **P2-LIB-002** Tab `My Content` · `F-124`
- [ ] **P2-LIB-003** Tab `My Media Bank` · `F-125`
- [ ] **P2-LIB-004** `Refresh Metrics` · `F-121`
- [ ] **P2-LIB-005** Modo `Select` y acciones masivas · `F-122` · ⚠️ alcance exacto en `OQ-04`

## P2-CAL — Calendar

- [ ] **P2-CAL-001** Vista mes con navegación · `F-140`
- [ ] **P2-CAL-002** Chips de post por plataforma, tipo y hora · `F-141`
- [ ] **P2-CAL-003** Contador por día y contadores de cabecera · `F-142`, `F-143`

## P2-TREND — Catálogo de tendencias

- [ ] **P2-TREND-001** **Decisión de derechos y estrategia de adquisición del catálogo** · `F-041`, `OQ-13` · ⚠️ **bloquea el resto de la épica; no es tarea de ingeniería**
- [ ] **P2-TREND-002** `DATA-023` + pipeline de ingesta · `F-041`
- [ ] **P2-TREND-003** Extracción a texto: caption, hashtags, OCR, métricas · `JV-1` dep
- [ ] **P2-TREND-004** `/inspiration`: búsqueda, filtro por nicho, `Remix this` · `FR-040`
- [ ] **P2-TREND-005** Estados: `No results`, `Inspiration is being set up`, error · `FR-040`

## P2-JV — Judgment features

- [ ] **P2-JV-001** **`JV-1`** clasificador del catálogo: 5 preguntas, umbrales, cuarentena · PRD §25.3 · dep: P2-TREND-003
- [ ] **P2-JV-002** Dataset de 250 items etiquetados a mano (**50 en español**) · PRD §25.4
- [ ] **P2-JV-003** **Experimento de validación `DP-001`**: acierto, **calibración**, costo, latencia, es↔en · `OQ-20` · ⚠️ la calibración es el criterio de corte
- [ ] **P2-JV-004** **`JV-4`** verificador de campos de marca → `fieldMeta.confidence` · PRD §25.3

---

# P3 — Integrations & Automation

> **Criterio de salida:** un post creado en FastGram aparece publicado en TikTok e Instagram y sus métricas vuelven al dashboard.

## P3-OAUTH — Conexiones sociales

- [ ] **P3-OAUTH-001** Puerto `SocialPublisher` + `DATA-016`
- [ ] **P3-OAUTH-002** OAuth TikTok (Business/Creator) · `INT-001`
- [ ] **P3-OAUTH-003** OAuth Instagram (nativo + Ayrshare) · `INT-002`, `INT-006`
- [ ] **P3-OAUTH-004** OAuth YouTube · `INT-003`
- [ ] **P3-OAUTH-005** OAuth LinkedIn + **aviso de caducidad a 60 días** · `INT-004`
- [ ] **P3-OAUTH-006** OAuth Reddit · `INT-005`
- [ ] **P3-OAUTH-007** Tokens cifrados en reposo, **nunca** devueltos por la API · `NFR-007`
- [ ] **P3-OAUTH-008** Estados de conexión y flujo de reconexión · PRD §19.5
- [ ] **P3-OAUTH-009** Multi-cuenta por plataforma + `400 connection_ambiguous` · `FR-060`
- [ ] **P3-OAUTH-010** **Separar permiso de lectura (marca) del de publicación** · §10 regla 7, `EXT-001`
- [ ] **P3-OAUTH-011** Los 16 estados de error de integración de PRD §19.5

## P3-SCHED — Scheduling

- [ ] **P3-SCHED-001** `DATA-020` con la máquina de estados completa (10 estados) · `FR-060`
- [ ] **P3-SCHED-002** Paso `Select Platforms` con opciones por plataforma · `F-150`
- [ ] **P3-SCHED-003** Paso `Content Details` multi-plataforma con contadores · `F-153`
- [ ] **P3-SCHED-004** `Improve` / `Regenerate` por campo · `F-154`, `AI-006`
- [ ] **P3-SCHED-005** Paso `Schedule` con time + date picker y disclaimers · `F-156`
- [ ] **P3-SCHED-006** TikTok: `posting_mode` + `privacy_level` + entitlement `tiktokDirect` · `F-151`, `F-152`
- [ ] **P3-SCHED-007** `Auto-Add Music` · `F-155`
- [ ] **P3-SCHED-008** Instagram slideshow `carousel` / `reel` · `F-158`
- [ ] **P3-SCHED-009** AI content label y paid partnership disclosure · `F-160`, `F-161`
- [ ] **P3-SCHED-010** Post now · `F-157`
- [ ] **P3-SCHED-011** Cancel / delete por lote, **atómicos**, máx. 100 ids · `F-162`, `ERR-F01`

## P3-PUB — Publicación

- [ ] **P3-PUB-001** Worker de publicación en la hora programada
- [ ] **P3-PUB-002** `AWAITING_RECONNECT` con reanudación automática · `FR-060`
- [ ] **P3-PUB-003** `IN_USER_INBOX` como estado normal, **no error** · `FR-060`
- [ ] **P3-PUB-004** **Watcher de carril lento de TikTok hasta 72 h; nunca duplicar** · `NFR-015` · ⚠️ regla explícita
- [ ] **P3-PUB-005** `publishedCaption` + `captionAdjustmentReason` · `FR-060`
- [ ] **P3-PUB-006** Traducción a `errorCode` estable y neutral · `DP-006` · tabla determinística primero
- [ ] **P3-PUB-007** Límites de plataforma diferenciados · `FR-060`

## P3-METRIC — Métricas

- [ ] **P3-METRIC-001** Job de sync de views/likes/comments
- [ ] **P3-METRIC-002** Batch analytics ≤100 ids con éxito parcial · `ERR-F02`
- [ ] **P3-METRIC-003** **Distinguir cero real de pre-sync con `postedAt`** · `NFR-016`

## P3-ANALYT — Analytics

- [ ] **P3-ANALYT-001** `/analytics` con selector de rango · `FR-120`
- [ ] **P3-ANALYT-002** Desglose por plataforma y por tipo de contenido · `F-171`, `F-172`
- [ ] **P3-ANALYT-003** Script de website analytics activable · `F-174`
- [ ] **P3-ANALYT-004** Atribución de ads · `F-175` · ⚠️ alcance real en `OQ-06`

## P3-WARM — Warmed Accounts

- [ ] **P3-WARM-001** `DATA-017`…`DATA-019` · `FR-130`
- [ ] **P3-WARM-002** Compra y configuración (plataforma, país, nicho) · `F-181`
- [ ] **P3-WARM-003** Flujo de aprobación por el owner · `F-183`
- [ ] **P3-WARM-004** `postingAvailability` y `postable` · `F-186`
- [ ] **P3-WARM-005** Lead time **por cuenta** + techo de 30 días · `F-185`
- [ ] **P3-WARM-006** Slot balance + `402` al agotarse · `F-184`
- [ ] **P3-WARM-007** Replacement decisions · `F-187`
- [ ] **P3-WARM-008** TikTok commercial sounds · `F-159`

## P3-AUTO — Automations

- [ ] **P3-AUTO-001** `DATA-021` + `DATA-022` con sus dos máquinas de estados · `FR-150`
- [ ] **P3-AUTO-002** Wizard de configuración · `F-211`
- [ ] **P3-AUTO-003** `prefsSnapshot` **congelado**: cambiar prefs del workspace no altera la campaña · `F-212`
- [ ] **P3-AUTO-004** Generación de slots + cuota por campaña · `F-213`
- [ ] **P3-AUTO-005** **Tipo con peso 0 queda excluido, nunca es fallback** · `AI-012` · ⚠️ regla dura
- [ ] **P3-AUTO-006** `FAILED_GEN` con `no_unique_content` / `no_demo_video` · `AI-012`
- [ ] **P3-AUTO-007** Dedup de contenido con pgvector + juicio sólo en borderline · `ADR-003`
- [ ] **P3-AUTO-008** Review: editar slot, captions por plataforma, re-roll · `F-214`, `F-215`
- [ ] **P3-AUTO-009** `launchValidation` con todos los gates · `F-216`
- [ ] **P3-AUTO-010** Launch: reserva slots y cobra · `F-217`
- [ ] **P3-AUTO-011** YouTube exige `slideshowWeight = 0` · `FR-150`
- [ ] **P3-AUTO-012** Cancel / delete con sus restricciones · `F-219`
- [ ] **P3-AUTO-013** Vistas Calendar y Grid · `F-220`

---

# P4 — Advanced Features

> **Criterio de salida:** un agente externo crea y publica por MCP; un influencer entrenado aparece en Blitz.

## P4-INFL — Influencers

- [ ] **P4-INFL-001** `DATA-013`…`DATA-015` · `FR-080`
- [ ] **P4-INFL-002** Wizard de 3 pasos con costos visibles · `F-091`
- [ ] **P4-INFL-003** Generación de imagen base con **FLUX.1 [schnell]** · `ADR-010`
- [ ] **P4-INFL-004** Subida de imagen base propia · `F-092`
- [ ] **P4-INFL-005** **Pipeline de entrenamiento LoRA** (el "training" de 15–20 min del PRD) · `ADR-010`, `AI-007`
- [ ] **P4-INFL-006** Regenerar = **persona nueva**, no edición · `F-093` · ⚠️ regla de producto
- [ ] **P4-INFL-007** Estados y `progress` 0–100 · `F-094`
- [ ] **P4-INFL-008** Cap de 50 activos + idempotencia obligatoria · `FR-080`
- [ ] **P4-INFL-009** Galería de imágenes + barra de generación con templates · `FR-081`
- [ ] **P4-INFL-010** Galería de videos + selección de modelo y duración · `FR-082`
- [ ] **P4-INFL-011** Talking Head UGC con validación de longitud de script · `AI-010`
- [ ] **P4-INFL-012** Tab Configuration: ángulos, cuentas, sets · `FR-083`
- [ ] **P4-INFL-013** Integración con Blitz: `influencerChance`, chips, fallback · `FR-055`

## P4-AISTUDIO — AI Studio

- [ ] **P4-AISTUDIO-001** `/ai-studio` con prompt, referencias y contador · `FR-090`
- [ ] **P4-AISTUDIO-002** Cap de **10 generaciones en vuelo** · `F-112`
- [ ] **P4-AISTUDIO-003** Filtro de contenido con mensajes diferenciados · `F-113`
- [ ] **P4-AISTUDIO-004** Gating por plan · `F-115`

## P4-FORMAT — Formatos IA adicionales

- [ ] **P4-FORMAT-001** Pipeline genérico de formato generativo · `F-084`
- [ ] **P4-FORMAT-002** Los 17 formatos del catálogo · `F-070` tabla · dep: P4-FORMAT-001

## P4-ENGAGE — Engagement

- [ ] **P4-ENGAGE-001** `DATA-024` + `DATA-025` · `FR-140`
- [ ] **P4-ENGAGE-002** Configuración de subreddits · `F-192`
- [ ] **P4-ENGAGE-003** Job de descubrimiento con backoff · `F-191`
- [ ] **P4-ENGAGE-004** **`JV-2`** scoring de leads: 5 preguntas + composición en código · PRD §25.3
- [ ] **P4-ENGAGE-005** Pesos y umbrales en código, recalculables sin reinferir · `JV-2`
- [ ] **P4-ENGAGE-006** Listado, filtros y vistas · `F-193`
- [ ] **P4-ENGAGE-007** Detalle + `Why this lead?` (LLM) · `F-194`
- [ ] **P4-ENGAGE-008** Generación y regeneración de respuesta con reglas propias · `F-195`, `F-196`
- [ ] **P4-ENGAGE-009** **`JV-5`** clasificador de tono → ban meter · PRD §25.3
- [ ] **P4-ENGAGE-010** **Ratio y nivel del ban meter calculados en CÓDIGO** · `DP-003` · ⚠️ nunca por el modelo
- [ ] **P4-ENGAGE-011** Monitorización de hilos + `Sync with Reddit` · `F-198`, `F-199`
- [ ] **P4-ENGAGE-012** Estados de error del módulo · PRD §19.4

## P4-JV — Judgment features restantes

- [ ] **P4-JV-001** **`JV-3`** pre-flight de publicación · `EXT-007`, `DP-007`
- [ ] **P4-JV-002** Pre-flight con **timeout duro: si no responde, se publica igual** · `JV-3` · ⚠️ no puede bloquear el producto
- [ ] **P4-JV-003** **`JV-6`** rerank marca↔candidato · `DP-005` · dep: P2-JV-001
- [ ] **P4-JV-004** `JV-6` aplicado a personajes AI UGC y videos UGC humanos · PRD §25.3

## P4-BILL — Billing

- [ ] **P4-BILL-001** Puerto `Payments` + adaptador · `INT-008`
- [ ] **P4-BILL-002** Los 4 planes con sus límites · PRD §16.1
- [ ] **P4-BILL-003** Upgrade prorrateado / downgrade programable · PRD §16.3
- [ ] **P4-BILL-004** Compra de créditos, saves y post slots · `F-237`, `F-238`
- [ ] **P4-BILL-005** Cancelación con feedback · PRD §16.5
- [ ] **P4-BILL-006** Modo view-only al agotar cuota · PRD §16
- [ ] **P4-BILL-007** API overage billing · `F-240`
- [ ] **P4-BILL-008** Restricciones de trial · PRD §16.7

## P4-PUBAPI — API pública

- [ ] **P4-PUBAPI-001** Los 29 endpoints de PRD §9.3 · dep: P1-API-002
- [ ] **P4-PUBAPI-002** Gestión de API keys en Settings · `F-239`
- [ ] **P4-PUBAPI-003** Documentación embebida `/developers` · `F-243`
- [ ] **P4-PUBAPI-004** Tests de contrato por endpoint contra el OpenAPI
- [ ] **P4-PUBAPI-005** Webhooks salientes · `EXT-002`, `OQ-11`

## P4-MCP — Servidor MCP

- [ ] **P4-MCP-001** `apps/mcp` con JSON-RPC 2.0 stateless · `AI-015`
- [ ] **P4-MCP-002** Los 16 tools de lectura · `AI-015`
- [ ] **P4-MCP-003** Los 18 tools de acción, con los destructivos marcados · `AI-015`
- [ ] **P4-MCP-004** Rate limit propio de 30/min por usuario · `AI-015`
- [ ] **P4-MCP-005** Connector OAuth con scopes y confirmaciones · `AI-015`

---

# P5 — Functional Parity

> **Criterio de salida:** la Parity Matrix del PRD §23 no tiene filas sin cubrir.

## P5-NOTIF — Notificaciones

- [ ] **P5-NOTIF-001** Centro de notificaciones con read/unread · PRD §13.3
- [ ] **P5-NOTIF-002** Preferencias por categoría y canal · `F-234` · ⚠️ contenido exacto en `OQ-03`
- [ ] **P5-NOTIF-003** Email transaccional
- [ ] **P5-NOTIF-004** Los 22 triggers de PRD §13.2

## P5-MEMBER — Miembros y permisos

- [ ] **P5-MEMBER-001** Invitaciones · `F-005`, `OQ-02`
- [ ] **P5-MEMBER-002** Sección `members` en Settings · `EXT-003`
- [ ] **P5-MEMBER-003** Matriz de permisos completa · PRD §4.2, `OQ-01`

## P5-GROWTH — Crecimiento y soporte

- [ ] **P5-GROWTH-001** Refer & Earn · `F-250`
- [ ] **P5-GROWTH-002** Guide · `F-251`
- [ ] **P5-GROWTH-003** Roadmap y Changelog · `F-252`, `F-253`
- [ ] **P5-GROWTH-004** Feedback · `F-254`
- [ ] **P5-GROWTH-005** Páginas SEO: comparativas, `/for`, `/tools` · PRD §3

## P5-QUALITY — Calidad transversal

- [ ] **P5-AUDIT-001** Audit log de acciones destructivas y facturables · `EXT-004`, PRD §9.12
- [ ] **P5-A11Y-001** WCAG 2.1 AA · `NFR-020`
- [ ] **P5-A11Y-002** **Alternativa no gestual al swipe de Blitz** · `NFR-020` · ⚠️ el swipe no puede ser el único camino
- [ ] **P5-EVENT-001** Suite completa de eventos de PRD §18
- [ ] **P5-EVENT-002** Funnel de activación **segmentado por `source_type`** · PRD §18 · ⚠️ es la métrica que decide si `EXT-001` funcionó
- [ ] **P5-ERR-001** Auditoría: los ~90 estados de error y vacío de PRD §19 con su copy literal
- [ ] **P5-I18N-001** Contenido multi-idioma del plan Pro · `OQ-12`
- [ ] **P5-LIBR-001** Estrategia de librería de personajes AI UGC · `OQ-13`
- [ ] **P5-LIBR-002** Estrategia de librería de UGC humano · `OQ-13`
- [ ] **P5-PERF-001** Pruebas de carga k6: rate limits, cuotas, fan-out de publicación
- [ ] **P5-PARITY-001** **Recorrer la Parity Matrix de PRD §23 y cerrar cada fila**

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
