# Sesión 2026-09-21 — De los documentos al código

> Segunda sesión del día. La primera produjo el plan y `tasks.md`
> ([`SESSION-2026-09-21-plan-implementacion.md`](SESSION-2026-09-21-plan-implementacion.md));
> ésta empezó a ejecutarlo.

## Qué se pidió

Empezar la implementación, sin parar hasta terminar, desplegando agentes en
paralelo que no se pisen.

## Cómo se organizó el paralelismo

La parte que decidió el resultado no fue cuántos agentes, sino **qué es estado
compartido mutable**. Tres cosas lo son y por eso ningún agente las toca:

| Recurso | Por qué es peligroso |
|---|---|
| `pnpm-lock.yaml` y todo `package.json` | Dos `pnpm install` concurrentes dejan el lockfile inconsistente. Ya pasó una vez en esta sesión (ver trampas). |
| `git` | Commits entrelazados de trabajo a medio escribir. |
| `tasks.md`, `PRD.md`, `docs/**` | Ediciones ciegas sobre el mismo archivo. |

La regla fue: **cada agente es dueño de un directorio y de nada más**. Si le
falta una dependencia, no la instala: la reporta. Funcionó — **ningún agente
pisó a otro en toda la sesión**, y los reportes lo confirman por separado.

El costo de esa regla: ningún agente pudo marcar su tarea en `tasks.md` ni
escribir su handoff, que es lo que pide el `CLAUDE.md`. Los ocho lo señalaron.
Esa coordinación quedó centralizada acá a propósito, pero **es una tensión real
entre el protocolo del repo y el trabajo en paralelo**, y conviene resolverla
antes de la próxima tanda: o los agentes marcan (con el riesgo de colisión en
un archivo), o el protocolo dice explícitamente que en paralelo marca el
coordinador.

### Las dos tandas

**Tanda 1 — nada depende de nada:** `packages/db`, `packages/ports`,
`packages/contracts`, `packages/ui`, `services/render`, y el modelo de costos.

**Tanda 2 — encima de la tanda 1:** `packages/adapters`, `packages/core`
(casos de uso), `apps/api` (rutas), `apps/web`.

Entre las dos, el trabajo que hice yo fue el que **no se puede paralelizar**:
el P0 completo, porque define las fronteras que después respetan los agentes.

## Lo que costó tiempo y no se deduce del código

### 1. El lockfile se corrompió por borrar `.modules.yaml` a mano

Al pelear con `pnpm approve-builds` borré `node_modules/.modules.yaml`. pnpm
quedó inconsistente: el lockfile registraba `eslint@9.39.5` y la store tenía
`eslint@9.39.5_jiti@..._supports-color@...`. El symlink de `eslint` quedó
colgado — `ls -d node_modules/eslint` respondía bien y `ls node_modules/eslint/`
fallaba. Media hora buscando por qué `eslint: command not found` con eslint
"instalado".

**Se arregla sólo borrando `node_modules` Y `pnpm-lock.yaml` y reinstalando.**
No alcanza con `--force`.

### 2. pnpm 12 cambió la clave de los build scripts

No es `onlyBuiltDependencies` ni va en `package.json`: es **`allowBuilds`, con
booleanos, en `pnpm-workspace.yaml`**. Y pnpm **escribe él mismo** un bloque
`allowBuilds` con placeholders (`set this to true or false`) la primera vez, lo
que produce una clave duplicada si uno agregó la suya. El error que da —
*"duplicate mapping key"*— no apunta a que pnpm editó tu archivo.

### 3. `*/` dentro de un comentario de bloque lo cierra

Escribí `(\`*/upload-url\`)` en un docstring y esbuild falló con *"Expected ';'
but found 'POST'"* apuntando a una línea de prosa. Obvio una vez visto; tres
minutos de desconcierto antes.

### 4. `minio/minio:latest` ya no existe en Docker Hub

Falla con *"pull access denied for minio/mc, repository does not exist or may
require 'docker login'"*, que **parece un problema de credenciales y no lo es**.
MinIO publica en **quay.io**: `quay.io/minio/minio` y `quay.io/minio/mc`.

### 5. La resolución de fuentes por nombre en sharp está rota **a medias**

La encontró el agente de render y la verifiqué por separado. `sharp` 0.33 trae
su propio libvips con fontconfig sin configuración por defecto. Medido con la
sonda `"MWiljq1080 Hamburgefonstiv"` a 40px:

```
__NoSuchFamily__ → 517x39     Helvetica  → 517x39
Courier          → 517x39     Montserrat → 517x39
Comic Sans MS    → 555x44   ← ésta SÍ resuelve
```

Que `Comic Sans MS` resuelva distinto es lo que lo vuelve peligroso: **no está
rota del todo, está rota a medias**. Quien spot-chequea con la fuente
equivocada ve que "anda" y cierra la investigación, y el producto sale con la
tipografía incorrecta en cada pieza.

La defensa: cargar por archivo absoluto y **verificar contra una sonda
centinela**. Si las métricas coinciden con las de una familia inexistente, la
fuente no cargó y se falla, en vez de renderizar con otra.

`FONTCONFIG_FILE` apuntando a un `fonts.conf` propio **no** funciona. Probado.

### 6. Este `ffmpeg` no tiene `drawtext` — y tampoco `zscale`

`ffmpeg 9.0.1` de Homebrew viene sin `libfreetype`. Era una trampa ya conocida
(la pagamos analizando los videos del PRD) y volvió a aparecer. La decisión fue
**no usar `drawtext` ni como fallback cuando exista**: el texto se compone con
sharp a PNG con transparencia y se superpone con `overlay`. Hay un golden test
que verifica que ningún plan de render contiene la cadena `drawtext`.

Efecto colateral nuevo: sin `zscale` ni `libplacebo`, **HDR→SDR no se puede
hacer bien**. El código **falla cerrado** con `render_capability_missing` en vez
de aplicar una conversión que destroza los colores y llamarla normalización.

### 7. Los paquetes exportan `.ts` crudo: `node dist/main.js` no arranca

Lo descubrió el agente de render y es el bloqueante más serio de la sesión.
Todos los `packages/*` apuntan `main` y `exports` a `src/*.ts`. Bajo `tsx`
funciona; compilado no: `tsc` emite sólo los archivos de la app, y Node **no
puede importar `.ts` desde `node_modules`** (el stripping nativo está
explícitamente prohibido ahí).

Hoy **`pnpm build` pasa y el binario resultante no arranca**. Verde en CI y roto
en producción es la peor forma de tenerlo. Queda como `P0-REPO-013`.

## Decisiones, con su razón

### Los videos de referencia quedan fuera de git

164 MB. Ya fueron analizados frame a frame y transcriptos; el resultado está en
`PRD.md` §0.2 con timestamps. Meterlos en la historia penaliza cada clone para
siempre y el valor ya está extraído. Es un desvío del literal de `P0-REPO-001`,
que decía "primer commit con … videos".

### `packages/core` no puede importar **nada** de npm

Sólo `@fastgram/ports`. Es más estricto que "no importa adapters". La razón: el
día que `core` importe una utilidad de fechas, la mitad de las reglas de negocio
dejan de ser testeables sin fijar esa librería. Para fechas y azar hay puertos
(`Clock`, `Rng`). Lo enforcea `dependency-cruiser` en CI.

### `core` corre sin `--passWithNoTests`

Los demás paquetes lo tienen; `core` no, a propósito. Un dominio sin tests no
debería pasar el CI en silencio.

### El lint corre una sola vez desde la raíz

Doce procesos de eslint tardaban más y hacían más fácil que un paquete
terminara con reglas distintas.

### El reset de cuota se calcula en lectura, no con un cron

Hay un job programado, pero es **red, no mecanismo**. Si el reset dependiera del
cron, la cuota de un cliente dependería de que el cron haya corrido. Así depende
del reloj, que es lo que el usuario ve.

### El modelo de costos invirtió el orden del plan

`P1-INFRA-001` midió y el plan §5 estaba al revés: egress y CPU de render eran
el #1 y el #2; son el #4 y el #6. El driver dominante es la **generación de
video en GPU**, por dos órdenes de magnitud.

El error original era razonable y por eso vale registrarlo: *"producto de video
⇒ el egress domina"* es cierto para un producto de **distribución** de video.
FastGram es de **producción** — entrega el archivo a TikTok o Instagram y la
distribución masiva la paga la plataforma.

Consecuencias: `ADR-006` con la premisa refutada, `ADR-013` corregido (Hetzner
subió +113–173 % y su vCPU es un *thread*, no un core), `ADR-009` con el punto
de cruce de self-host mucho más lejos de lo que parecía, y `OQ-21` nueva en el
PRD sobre el tarifario de créditos.

Verifiqué la aritmética de las tres cifras principales y reproduce exacto. Lo
que **no** verifiqué por mi cuenta son los precios de lista de entrada.

## Lo que se descartó, y por qué

- **Arreglar `P0-REPO-013` en el momento.** Toca ~7 `package.json`, y hacerlo
  con cuatro agentes corriendo garantizaba romperlos a todos. Se difiere a un
  cambio propio, verificado corriendo `node dist/main.js` de verdad.
- **Mutar la migración para probar que el test de RLS detecta una política
  borrada.** Habría corrompido las corridas de Testcontainers de otro agente en
  paralelo. Resultó innecesario: el propio test ya lo hace, rompiendo RLS dentro
  de una transacción que revierte.
- **Instalar PaddleOCR.** Pesa cientos de MB y el servicio está diseñado para
  arrancar sin él y decirlo en `/health`. Se verificó la degradación, no el OCR.

## Lo que quedó sin verificar

- **Nadie abrió un navegador.** Ni una pantalla se vio renderizada. El design
  system tiene 160 tests, todos de markup y ARIA por SSR; **ningún contraste de
  color está medido** y nada se vio con estilos aplicados.
- **Ningún frame renderizado se miró.** Los hashes son estables y la geometría
  está testeada, pero "determinista" no es "se ve bien".
- **Las 42 fuentes no están.** Ninguna de las 12 familias del PRD está en la
  máquina, y `tiktok`/`snapchat` **no tienen archivo distribuible** — es una
  decisión de licencia, de una persona.
- **MOV→MP4, faststart y HDR→SDR nunca corrieron sobre un archivo real.**
- **El documento OpenAPI** no se validó con un validador 3.1 (pedía una
  dependencia nueva). Sí se auditó estructuralmente: 32 paths, 46 operaciones,
  todas con `responses` y `operationId`, todos los parámetros de path
  declarados, sin ids duplicados.
