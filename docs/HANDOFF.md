# HANDOFF — FastGram, estado actual

> **No hay código todavía.** El repo tiene la especificación completa (`PRD.md`, 3.996 líneas),
> la evaluación de la capa de juicio (`EVAL-JEV.md`), el plan de implementación y `tasks.md`
> con 361 tareas. **La primera tarea es `git init`** (`P0-REPO-001`): el repo ni siquiera está
> bajo control de versiones.
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

## 6. Cómo verificar

**Hoy no hay nada que verificar: no hay código, ni tests, ni build.** Decirlo es más útil que
inventar comandos que no corren.

El primer comando verificable aparece al cerrar **`P0-REPO-008`** (CI). A partir de ahí, esta
sección tiene que llenarse con los comandos reales, en orden, y **con los números esperados** —
"unit 380, antes de la suite de UI"— porque los números son lo que permite distinguir "lo rompí yo"
de "ya estaba rojo".

**Quien cierre `P0-REPO-008`: tu tarea incluye escribir esta sección.**

Mientras tanto, lo único verificable es documental:

```bash
grep -c '^- \[ \]' tasks.md     # tareas pendientes — hoy: 361
grep -c '^- \[x\]' tasks.md     # terminadas — hoy: 0
```

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

## 8. Qué falta

Todo el código. El backlog real es `tasks.md`, 361 tareas en 6 fases.

**Bloqueado por una persona, no por código** — estas cuatro no avanzan escribiendo software y
conviene arrancarlas ya, porque tienen plazo largo:

| Qué | Bloquea | Tarea |
|---|---|---|
| Revisión legal del scraping de perfiles públicos (`OQ-16`) | el tier C del alta social | `P1-BRAND-024` |
| Derechos del catálogo de tendencias (`OQ-13`) | **toda la épica P2-TREND** | `P2-TREND-001` |
| Decisión de licencia del build de FFmpeg | el render | `P0-REPO-004` |
| Estrategia de librerías UGC (`OQ-13`) | P5-LIBR | `P5-LIBR-001/002` |

**Lo primero a hacer, en orden:** `P0-REPO-001` (git init) → `P0-REPO-003` (monorepo) →
`P0-REPO-006` (boundaries en CI) → `P1-INFRA-001` (modelo de costos) y `P1-BRAND-002` (spike de
cobertura por plataforma). Las dos últimas son descubrimiento y pueden cambiar decisiones ya
tomadas: cuanto antes, más barato.

## 9. Mapa de documentos

| Documento | Responde |
|---|---|
| **este** | dónde está parado el proyecto, arquitectura, reglas, trampas |
| [`../PRD.md`](../PRD.md) | **qué** construir. Fuente de verdad funcional, con evidencia etiquetada |
| [`../EVAL-JEV.md`](../EVAL-JEV.md) | por qué existe el puerto `Judgment` y qué se evaluó de TypeSafe/Jev |
| [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) | **cómo**: arquitectura, stack, 15 ADRs con su razón |
| [`../tasks.md`](../tasks.md) | **en qué orden**, y dónde tachar |
| [`SESSION-2026-09-21-plan-implementacion.md`](SESSION-2026-09-21-plan-implementacion.md) | cómo se llegó del PRD al plan, y qué se descartó |
| [`../CLAUDE.md`](../CLAUDE.md) | instrucciones de arranque para agentes |
