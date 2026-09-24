# Plan de implementación — FastGram

**Fuente de verdad funcional:** [`PRD.md`](../PRD.md) (3.996 líneas, 25 secciones).
**Este documento no repite el PRD.** Define *cómo* se construye: arquitectura, stack, decisiones con su razón, convenciones y el orden de trabajo. Lo que hay que construir está en el PRD; el checklist ejecutable está en [`../tasks.md`](../tasks.md).

---

## 1. Estado de partida

| | |
|---|---|
| Código | **Ninguno.** El repo tiene `PRD.md`, `EVAL-JEV.md` y 9 videos de referencia. |
| Git | **No inicializado** al momento de escribir esto. Primera tarea del plan. |
| Decisiones de producto cerradas | `D-01`…`D-05` en PRD §2.7 |
| Extensiones sobre Fastlane | `EXT-001`…`EXT-008` en PRD §2.6 |
| Preguntas abiertas bloqueantes | `OQ-16` (legal, tier C de brand sources), `OQ-19` (cobertura sin OAuth), `OQ-20` (calibración) |

Empezar sin código es una ventaja: las decisiones estructurales del PRD —puerto `Judgment`, aislamiento por workspace, idempotencia, cuotas— se diseñan una vez en lugar de retrofitearse.

---

## 2. Arquitectura

### 2.1 Forma: hexagonal (puertos y adaptadores)

El PRD ya empuja en esta dirección: `EXT-008` define un puerto `Judgment` con adaptadores intercambiables, y `§10` exige que los errores de proveedor se traduzcan a códigos neutrales antes de salir. Se generaliza esa idea a todo lo externo.

**Regla de dependencia, innegociable:**

```
apps/*  ──→  packages/core  ──→  packages/ports
   │                                   ↑
   └──────→  packages/adapters  ────────┘

core NUNCA importa adapters.  core NUNCA importa un SDK.
```

`core` contiene entidades, invariantes y casos de uso, en TypeScript puro. Si un archivo de `core` importa `stripe`, `@aws-sdk` o un cliente de IA, el build falla (se enforcea con `dependency-cruiser` en CI, no con buena voluntad).

**Por qué importa acá y no es ceremonia:** el PRD tiene *nueve* proveedores externos intercambiables (identidad, pagos, storage, cola, LLM, juicio, OCR, ASR, publicación social) y tres de ellos —el de juicio, el de extracción social y el de render— están explícitamente marcados como "a validar" o "detrás de bandera". Sin puertos, validar uno significa tocar el producto entero.

### 2.2 Layout del monorepo

```
apps/
  web/            Next.js — aplicación + páginas SEO (comparativas, /for, /tools)
  api/            Fastify — REST v1 pública + endpoints internos del BFF
  worker/         Node — consumidores de la cola (builds, análisis, publicación, sync)
  mcp/            Servidor MCP (API-key) — PRD §AI-015
services/
  render/         Contenedor FFmpeg + sharp. Sin estado. Escala por CPU.
  vision/         Python — OCR (F1) y ASR (F2). Sin estado. Escala aparte.
packages/
  core/           Dominio puro. Entidades, invariantes, casos de uso. Cero frameworks.
  ports/          Interfaces: Judgment, Llm, Storage, Queue, Ocr, Asr, SocialPublisher,
                  SocialReader, Payments, Identity, MediaRenderer, Clock, Rng
  adapters/       Una implementación por puerto y proveedor
  db/             Drizzle: schema, migraciones, repositorios
  contracts/      Zod + tipos compartidos del contrato API v1 (única definición)
  ui/             Design system (shadcn/ui + Radix), tokens, componentes
  config/         eslint, tsconfig, tailwind compartidos
```

`Clock` y `Rng` son puertos a propósito: el PRD depende de fechas (lead times, ventanas, resets a 00:00 UTC) y de muestreo ponderado (`angleWeights`, `influencerChance`). Ambos deben ser deterministas en test. Sin esto, la mitad de las reglas de negocio no se pueden testear.

### 2.3 Flujo de una petición que genera contenido

```
web ──POST──▶ api ──▶ core.AcceptBlitzSuggestion
                        ├─ valida cuota (content saves + swipes)   [transacción]
                        ├─ reserva idempotencia                     [transacción]
                        ├─ crea Content(status=BUILDING)            [transacción]
                        └─ encola job content-build                 [misma transacción]
                                    │
worker ◀────────────────────────────┘
   ├─ resuelve assets desde Storage
   ├─ llama services/render (HTTP interno)
   ├─ sube el resultado a R2
   └─ Content.status = CREATED | FAILED  (+ reembolso de save si FAILED)

web ── poll GET /content/:id cada ~10 s ──▶ api
```

**El encolado ocurre dentro de la misma transacción que descuenta la cuota.** Es la razón principal por la que la cola vive en Postgres (§3, ADR-005): si el job se encolara en Redis fuera de la transacción, un fallo entre commit y push deja cuota consumida sin trabajo, o trabajo sin cuota. El PRD es explícito en que un build fallido **reembolsa** el content save; eso exige saber con certeza que el job existe.

### 2.4 Multi-tenancy

Todo lo del cliente cuelga de `companyId`. Dos capas de defensa:

1. **Row Level Security en Postgres**, con `app.current_company` seteado por transacción. Es la red que no depende de que nadie se olvide un `WHERE`.
2. **Repositorios tipados** que exigen `companyId` en la firma. No existe un `findById(id)` sin scope.

**Acceso cruzado devuelve `404`, nunca `403`** — el PRD lo especifica para no filtrar existencia. Un test de contrato lo verifica por cada recurso.

---

## 3. Stack, con la razón de cada elección

Formato ADR comprimido. La razón es la parte que impide que se reabra.

### ADR-001 · Monorepo pnpm + Turborepo
`web`, `api`, `worker` y `mcp` comparten dominio, contratos y tipos. Un solo `tsc` sobre todo el grafo detecta las roturas de contrato en CI en vez de en runtime.

### ADR-002 · TypeScript en todo, Python sólo en `services/vision`
Un lenguaje reduce el costo de cambiar de contexto y permite compartir el dominio. La excepción es donde viven los modelos de visión y audio: PaddleOCR y faster-whisper son Python y forzarlos a Node sería pelear contra el ecosistema. Se aísla detrás de HTTP y de los puertos `Ocr` / `Asr`.

### ADR-003 · PostgreSQL como única base de datos
Cubre los cinco requisitos del PRD sin sumar infraestructura: relacional para el dominio, **JSONB** para `BrandSourceSnapshot` y `suggestionData`, **full-text search** para Media Bank e Inspiration, **pgvector** para la deduplicación de `no_unique_content` (PRD `FR-150`), y **pg-boss** para la cola. Una pieza que operar en lugar de cuatro.

### ADR-004 · Drizzle, no Prisma
SQL-first y sin motor en runtime. El PRD tiene paginación por cursor, transacciones compuestas (el auto-reconcile de `angleWeights` debe ocurrir en la misma transacción que la mutación del ángulo) y RLS. Todo eso se escribe mejor cerca del SQL.

### ADR-005 · pg-boss antes que BullMQ + Redis
Evita un servicio más y, sobre todo, permite **encolar dentro de la transacción de negocio** (§2.3). Se migra a BullMQ sólo el job que demuestre saturar, detrás del puerto `Queue`. No al revés.

### ADR-006 · Cloudflare R2 para objetos — ⚠️ **premisa refutada, decisión en revisión**
**La decisión sigue en pie por ahora; su razón, no.** Se escribió: *"en un producto de video el tráfico de salida domina la factura"*. `P1-INFRA-001` lo midió y **es falso para este producto** (ver [`COST-MODEL.md`](COST-MODEL.md) §4.3), por dos motivos distintos:

1. FastGram **publica en TikTok e Instagram**: la audiencia masiva la sirven las plataformas, no nosotros. Nuestro egress son previews para el creador — céntimos por usuario/mes, no el driver dominante.
2. El egress $0 es real como facturación, pero los **Service-Specific Terms de Cloudflare exigen un servicio pago (Stream) para servir video por el CDN** fuera de Enterprise, y las docs de agosto 2026 ya no nombran a R2 como vía habilitada. Tres fuentes oficiales de Cloudflare se contradicen entre sí.

El razonamiento original no era tonto: es correcto para un producto de **distribución** de video. FastGram es de **producción**. Vale registrar el error porque es la clase de premisa que se hereda sin revisar.

**Qué falta para cerrar esto (bloquea `P1-INFRA-004`):** confirmación escrita de Cloudflare sobre si R2 + Workers está permitido hoy para servir video fuera de Enterprise. No es un experimento técnico, es una pregunta legal. La alternativa medida —B2 + bunny.net— sale $0,03/usuario/mes y esquiva el problema.

Lo que **no** cambia: R2 es S3-compatible, así que el puerto `Storage` permite MinIO en local. Esa parte del ADR se sostiene sola y es la que hace intercambiable el proveedor si hay que moverse.

### ADR-007 · Render con FFmpeg + sharp — **no Remotion**
Remotion es gratis hasta 3 personas, pero un producto cuyo negocio es generar video automáticamente cae bajo su licencia **"Automators": $0,01 por render con mínimo de $100/mes** ([licencia verificada 2026-09-21](https://www.remotion.pro/license)). A un millón de renders eso son **$10.000**. El render *es* el producto: no puede tener un peaje por unidad.
FFmpeg (LGPL/GPL según build) + sharp (Apache-2.0) cubren los cuatro formatos base del PRD: composición de slides, overlay de texto, chromakey para green-screen y stacking hook+demo.
**Nota de licencia a resolver en `P1-REPO-004`:** construir FFmpeg sin los componentes GPL si se quiere distribuir el binario; como servicio server-side el riesgo es distinto pero hay que decidirlo explícitamente.

### ADR-008 · Better Auth self-hosted, no Clerk
Fastlane usa Clerk. Su modelo es por usuario activo mensual, y este producto tiene un plan gratis que existe justamente para acumular usuarios que no pagan. Better Auth es open source y self-hosted. Puerto `Identity` para poder volver atrás si la operación resulta más cara que la licencia.

### ADR-009 · LLM: gateway OpenAI-compatible sobre modelos open-weight
Todo lo generativo (captions, hooks, ángulos, `Improve`/`Regenerate`) va por el puerto `Llm` contra un gateway compatible con la API de OpenAI, apuntando a modelos de pesos abiertos. Dos razones: portabilidad —cambiar de modelo es una variable de entorno— y costo.
Para el `LlmJudgmentAdapter` del puerto `Judgment` se usa **decodificación restringida por JSON-schema**, que es lo que hace que la salida tipada sea una garantía real y no un parseo optimista.
**Self-hosting con vLLM cuando el volumen lo justifique**, no antes: operar GPUs es un costo fijo que sólo se amortiza con tráfico.
**No se fijan modelos ni precios en este documento**: cambian mes a mes. `P1-JUDGE-006` es la tarea de evaluarlos y dejar el resultado fechado en `docs/HANDOFF.md`.

### ADR-010 · Imagen: FLUX.1 **[schnell]**, no [dev] · LoRA por influencer
[Verificado 2026-09-21](https://huggingface.co/black-forest-labs/FLUX.1-schnell): **schnell es Apache-2.0 y permite uso comercial**; **dev es no-comercial** y exige licencia paga de Black Forest Labs. Un producto que vende generación de imágenes no puede apoyarse en dev sin comprarla.
El "entrenamiento" de influencer del PRD —15–20 minutos, 250 créditos, produce un personaje consistente y reutilizable— **es un fine-tune LoRA**. Esa lectura convierte una caja negra del PRD en una pipeline conocida.

### ADR-011 · OCR: PaddleOCR self-host
El caso real es texto estilizado sobre video —overlays de TikTok, miniaturas—, donde Tesseract rinde mal. PaddleOCR (Apache-2.0) aguanta ese caso. Es dependencia dura de `JV-1` y de `AI-016`, ambos en fases tempranas.

### ADR-012 · ASR: faster-whisper self-host (Fase 2)
Diferido por la decisión `D-03` del PRD. Cuando entre, self-host: el costo por minuto de audio a escala de catálogo hace que las APIs de transcripción sean el segundo driver de costo después del render.

### ADR-013 · Hosting: CPU barato + R2 + GPU serverless
El render es CPU-bound y constante; la generación es GPU-bound y a ráfagas. Separarlos:
- `web`, `api`, `worker`, `render`, Postgres → proveedor de cómputo por core barato (Hetzner o similar).
- Objetos → R2 (ADR-006, ahora en revisión).
- GPU → serverless por segundo (Modal / RunPod / fal), sin instancias ociosas.

**Corregido por `P1-INFRA-001`** ([`COST-MODEL.md`](COST-MODEL.md) §3.3):
- Hetzner subió los CCX entre **+113 % y +173 % el 15-jun-2026**. El múltiplo frente a AWS cayó de ~3,5× a 1,4–1,6×: sigue siendo más barato, pero ya no es una goleada y no conviene apoyar el modelo de costos en ese múltiplo.
- **Un vCPU de Hetzner Cloud es un *thread*, no un core** (lo dice su propia FAQ). Para render eso importa: dimensionar por vCPU da la mitad de la capacidad esperada. El render va a un dedicado con cores reales, no a un CCX.

La forma del ADR —separar CPU constante de GPU a ráfagas— se sostiene. Lo que cambió son los proveedores concretos y, sobre todo, **cuál de los dos pesa**: ver §5.

### ADR-014 · Polling como contrato público; SSE como mejora interna
El PRD documenta polling cada ~10 s para builds, y eso es parte del contrato de la API v1 que terceros van a implementar. Se mantiene. SSE/websockets se agregan para la UI propia, sin tocar el contrato.

### ADR-015 · Contratos con Zod, una sola definición
`packages/contracts` define cada request y response con Zod; de ahí salen los tipos de TS, la validación en runtime del API y el esquema OpenAPI. Una definición, tres usos. El PRD tiene un contrato público de 29 endpoints con envelopes estrictos: si se escribe dos veces, divergen.

---

## 4. Convenciones de desarrollo

| Área | Regla |
|---|---|
| **Ramas** | Trunk-based. Ramas cortas, integración diaria, feature flags para lo incompleto. |
| **Commits** | Conventional Commits. El scope es el paquete: `feat(core): ...`. |
| **PRs** | Pequeños. Uno por tarea de `tasks.md`. El título arranca con el ID: `P1-AUTH-003: ...` |
| **Tipos** | `strict: true`. `any` prohibido salvo con comentario que explique por qué. |
| **Errores** | Nunca se propaga el error crudo de un proveedor. Se traduce a código estable en el adaptador (PRD §10). |
| **Secretos** | Nunca en el repo ni en los docs. Variables de entorno validadas con Zod al arrancar: si falta una, el proceso no levanta. |
| **Migraciones** | Siempre hacia adelante y compatibles con la versión anterior. Nada de `DROP COLUMN` en el mismo deploy que deja de usarla. |
| **Feature flags** | Por workspace, no globales. El PRD exige activar Jev *por punto de decisión* y el tier C *por bandera*. |
| **i18n** | Copy de UI en inglés desde el día 1 (el PRD tiene el copy literal en inglés) y externalizado en claves. El plan Pro promete contenido multi-idioma. |

### Testing

| Nivel | Herramienta | Qué cubre |
|---|---|---|
| Unit | Vitest | Dominio en `core`. Rápido, sin IO. |
| Contrato de puerto | Vitest | **Una sola suite corre contra todos los adaptadores de un puerto.** Es lo que hace que cambiar de proveedor sea creíble. |
| Integración | Vitest + Testcontainers | Postgres real. RLS, transacciones, cursores, reconcile de `angleWeights`. |
| Golden file | Vitest | Render: mismo payload ⇒ mismo frame. Detecta que un upgrade de FFmpeg movió la tipografía. |
| E2E | Playwright | Los journeys del PRD §7, `FLOW-001` a `FLOW-009`. |
| Carga | k6 | Rate limiting, cuotas y el fan-out de publicación. |

**Regla:** toda regla de negocio con un número en el PRD lleva un test que fija ese número. Los caps (100 ángulos, 10 por influencer, 50 influencers, 20 slides, 100 ids por lote), los rangos (`position 0–100`, `widthPercent 25–100`, `fontSize 8–72`) y los estados. Esos tests son la documentación ejecutable del PRD.

---

## 5. Modelo de costos: el orden real, medido

> **Medido el 2026-09-21 en `P1-INFRA-001`.** Detalle, fuentes y fechas en [`COST-MODEL.md`](COST-MODEL.md). Los precios de IA se mueven en semanas: ese documento lleva aviso de caducidad y este resumen hereda la misma advertencia.

**Este orden estaba invertido.** La versión anterior ponía el egress primero y la CPU de render segunda, "por impacto esperado". Medidos, son el #4 y el #6.

| # medido | Driver | Puesto anterior | Costo/usuario/mes (Growth, caso caro) |
|---|---|---|---|
| **1** | **GPU — generación de video** | 3 | **$5,83** |
| **2** | **GPU — fine-tune LoRA de influencer** | 3 | hasta $4,00 |
| 3 | Cómputo base (CPU + Postgres) | 2 y 6 | fijo, no por usuario |
| 4 | Egress + storage de media | **1** | $0,02–$0,21 |
| 5 | Tokens de LLM | 4 | $0,01–$0,05 |
| 6 | CPU de render | **2** | $0,001–$0,005 |
| 7 | ASR / OCR | 5 | ~$0 self-host |

**Por qué se erró, que es la parte que conviene no repetir:** el razonamiento fue *"producto de video ⇒ el egress domina"*. Es correcto para un producto de **distribución** de video. FastGram es de **producción**: entrega el archivo a TikTok o Instagram y **la distribución masiva la paga la plataforma**. Nuestro egress son previews para el creador.

La distancia no es de matiz. La GPU de video cuesta **dos órdenes de magnitud** más que todo lo demás sumado: un usuario Pro que gaste sus 2.000 créditos en video consume **$23,33 sobre un plan de $149 — el 15,7 %**. Egress, render, LLM, storage y OCR juntos no llegan a $0,50.

### Las tres consecuencias

1. **Optimizar el render o el egress no mueve la aguja.** El cache por hash del payload (`P2-RENDER-010`) sigue valiendo, pero por latencia, no por costo.
2. **El tarifario de créditos del PRD no sigue al costo.** Un crédito de video cuesta **15,6×** uno de imagen, y un video de 10 s cuesta los mismos 60 créditos que uno de 5 s pagando el doble. Es un defecto de producto heredado de Fastlane, no de infraestructura — queda abierto en el PRD como `OQ-21`.
3. **"Unlimited content saves" en Pro deja el COGS sin techo.** Es el mayor riesgo de margen del modelo y no tiene mitigación escrita en ninguna parte.

### Self-host de LLM: dónde está el cruce

Contra el gateway más barato verificado, self-hostear con vLLM recién conviene a partir de **~2.421 M tokens de output al mes** (≈921 tok/s sostenidos 24×7), que son unos **12.000 usuarios Growth al tope de cuota**. Para **clasificación** el cruce está en el orden del techo teórico de prefill de un H100: **no se alcanza nunca — clasificar siempre por gateway.**

Eso también corrige la expectativa de ADR-009: el self-host no es "cuando el volumen lo justifique" en el horizonte visible, es bastante más lejos de lo que parecía.

---

## 6. Fases

> **2026-09-24: el orden de trabajo lo manda [`PLAN-USO-PERSONAL.md`](PLAN-USO-PERSONAL.md)** (uso personal, `D-06`…`D-16`). Las fases de abajo siguen describiendo la paridad con Fastlane, pero no el orden.

Las cinco fases son las del PRD §21. Aquí sólo el criterio de entrada/salida y lo que cambia respecto del PRD.

| Fase | Objetivo | Criterio de salida (del PRD, verificable) |
|---|---|---|
| **1 — Foundation** | Que exista un sistema multi-tenant con cuotas, colas, storage y el alta funcionando | Un usuario nuevo se registra, introduce **una web o un perfil de Instagram/TikTok**, obtiene Company Profile y entra a un dashboard funcional. El camino social se completa **sin pedir OAuth**. |
| **2 — Core Product** | El bucle que define el producto | El usuario aprueba una pieza en Blitz y la guarda; crea otra a mano en el Studio. |
| **3 — Integrations** | Distribución real | Un post creado aparece publicado en TikTok e Instagram y sus métricas vuelven al dashboard. |
| **4 — Advanced** | Influencers, AI Studio, Engagement, billing, API pública | Un agente externo crea y publica por MCP; un influencer entrenado aparece en Blitz. |
| **5 — Parity** | Cerrar la matriz de paridad | La Parity Matrix del PRD §23 no tiene filas sin cubrir. |

**Dentro de cada fase el orden lo fija `tasks.md` por dependencias, no por módulo.** Construir "todo Blitz" antes de que exista el render produce código que no se puede ejecutar.

### Lo que este plan adelanta respecto del PRD

- **El puerto `Judgment` entra en Fase 1** (PRD §21 ya lo dice): sólo interfaz + adaptador LLM + stub. Sin features. Declararlo cuesta un archivo; retrofitearlo es transversal.
- **`services/vision` con OCR entra en Fase 1**, porque `AI-016` lo necesita para el alta social y `JV-1` lo necesita en Fase 2.
- **El modelo de costos se mide en Fase 1**, no cuando duela.

---

## 7. Riesgos de ejecución

| Riesgo | Mitigación |
|---|---|
| **`OQ-16` (legal) bloquea el tier C de brand sources** y con él buena parte del alta sin fricción | Construir los tiers B, A y D primero. El tier C detrás de bandera apagada. Iniciar la revisión legal **en Fase 1**, no cuando el código esté listo. |
| **`OQ-19`: la cobertura pública de las 5 plataformas puede ser muy desigual** y `D-02` las exige a todas en Fase 1 | `P1-BRAND-002` es un spike por plataforma **antes** de escribir los extractores. Puede reordenar prioridades o reabrir `D-02`. |
| El render se vuelve el cuello de botella de costo | Cache por hash desde el principio (§5). Golden-file tests para poder optimizar sin romper. |
| El catálogo de tendencias (`F-041`) es un riesgo legal y operativo que el PRD marca sin resolver | Tratarlo como track propio con su propia decisión de derechos **antes** de Fase 2. No es una tarea de ingeniería. |
| Sobre-ingeniería de los puertos | Un puerto se crea cuando hay **dos** implementaciones reales o una decisión pendiente documentada. No "por si acaso". |

---

## 8. Mapa de documentos

| Documento | Responde |
|---|---|
| [`PRD.md`](../PRD.md) | **Qué** se construye. Fuente de verdad funcional. |
| [`EVAL-JEV.md`](../EVAL-JEV.md) | Por qué existe el puerto `Judgment` y qué se evaluó |
| [`COST-MODEL.md`](COST-MODEL.md) | **Cuánto cuesta** cada driver, con fuente y fecha. Caduca rápido. |
| este | **Cómo** se construye: arquitectura, stack, decisiones |
| [`../tasks.md`](../tasks.md) | **En qué orden** y quién va tachando |
| [`HANDOFF.md`](HANDOFF.md) | **Dónde está parado** el proyecto ahora mismo |
| `SESSION-*.md` | Por qué una sesión decidió lo que decidió |
