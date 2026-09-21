# FastGram — instrucciones para agentes

## Antes de empezar

Leé **`docs/HANDOFF.md`** y el archivo más nuevo de **`handoffs/`**. Dos archivos.
Con eso sabés dónde está parado el proyecto. No leas todos los session docs: son archivo,
se consultan cuando el general apunta a uno.

Después, buscá tu tarea en **`tasks.md`** y marcala `[~]` con tu identificador **antes** de
escribir código.

## Al terminar

Tres cosas, en este orden:

1. Escribí tu `docs/SESSION-<fecha>-<tema>.md` — el detalle y el **porqué**.
2. Escribí tu `handoffs/HANDOFF-<fecha>-<tema>.md` — qué queda abierto.
3. **Actualizá `docs/HANDOFF.md`** — entrada nueva en §4, más lo que corresponda en §5, §7 y §9.

El paso 3 es el que se saltea y el que sostiene todo el sistema.

## Si trabajás en paralelo con otros agentes

El protocolo de arriba asume **un** agente por vez. Con varios a la vez cambia, porque hay tres
cosas que son estado compartido mutable y tocarlas rompe a todos:

| No tocar | Por qué |
|---|---|
| `pnpm-lock.yaml` y **cualquier** `package.json` | Dos `pnpm install` concurrentes dejan el lockfile inconsistente, con symlinks colgados. Si te falta una dependencia, **no la instales: reportala.** |
| `git` | Commits entrelazados de trabajo a medio escribir. |
| `tasks.md`, `PRD.md`, `docs/**` | Ediciones ciegas sobre el mismo archivo. |

Y una que es del coordinador, no de los agentes: **nunca `git add -A` con agentes corriendo.**
Se lleva archivos ajenos a medio escribir dentro de tus commits, y el historial queda diciendo
que un commit de consistencia trae 600 líneas de un adaptador. Agregá rutas explícitas.

Entonces, en paralelo:

- **Vos** sos dueño de un directorio y de nada más. No marcás `tasks.md` ni escribís handoffs.
- **Quien coordina** marca las tareas, actualiza `docs/HANDOFF.md` y escribe el session doc,
  usando los reportes de cada agente.
- Tu reporte final **es** tu handoff. Que diga qué construiste, el output **real** de los
  comandos que corriste, qué decidiste que el PRD no cubre, y **qué quedó sin verificar**. Esa
  última parte es la más valiosa: un reporte que dice "todo verde" con algo sin correr hace que
  no se confíe en nada de lo que decís.

## Jerarquía de documentos

| Documento | Responde |
|---|---|
| `PRD.md` | **Qué** construir. Fuente de verdad funcional. Si el código contradice al PRD, el PRD gana — salvo que encuentres un error, y entonces corregís el PRD. |
| `docs/IMPLEMENTATION-PLAN.md` | **Cómo**: arquitectura, stack, decisiones con su razón |
| `tasks.md` | **En qué orden**, y dónde tachar |
| `docs/HANDOFF.md` | **Dónde está parado** el proyecto |

## Reglas que rompen el build

- `packages/core` **nunca** importa `packages/adapters` ni un SDK de proveedor.
- Todo acceso a datos lleva scope de `companyId`. Cross-tenant devuelve **404**, no 403.
- `strict: true`. Nada de `any` sin un comentario que explique por qué.
- Ningún error crudo de proveedor sale hacia afuera: se traduce a código estable.
- Nunca un secreto en el repo, en un doc o en un handoff.

## Regla de oro al documentar

**Registrá lo que costó tiempo y no se deduce del código.** El número que calibró una
decisión, el diagnóstico equivocado antes del bueno, el orden en que hay que hacer las cosas,
la trampa que se comió una tarde.

Lo que el código ya dice, no lo repitas: se desincroniza y después compite con la verdad.

## Honestidad

Escribí lo que está roto, salteado o sin verificar. Un handoff que dice "todo verde" con tres
tests rojos enseña a desconfiar del documento entero — y entonces no sirve nada, ni lo que era
cierto.
