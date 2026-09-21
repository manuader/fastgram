# SESSION 2026-09-21 — Del PRD al plan ejecutable

> Documento de sesión. **No se edita después.** El estado vigente vive en `HANDOFF.md`.

## Qué se pidió

Cuatro encargos encadenados, en esta sesión:

1. Investigar Fastlane a fondo y producir un PRD que permita clonarlo sin volver a investigar.
2. Extender ese PRD para que el alta no exija tener página web.
3. Evaluar si incorporar Jev (TypeSafe AI) y, si aplicaba, integrarlo.
4. Producir un plan de implementación con arquitectura, stack y un `tasks.md` que los agentes vayan tachando, priorizando LLMs de código abierto o de menor costo.

## Lo que se midió y de dónde salió la información

El PRD no se escribió desde la landing. Tres fuentes, en orden de valor:

| Fuente | Qué aportó | Cómo se obtuvo |
|---|---|---|
| **Bundle de producción de `app.usefastlane.ai`** | ~80 rutas reales, ids de secciones de Settings, enums de estado, el catálogo literal de 22 formatos con su `id`/`label`/`description`, y ~1.300 strings de UI | Descarga y análisis de `AppRoot-*.js`, `V2Root-*.js` y los chunks por página |
| **`developers.usefastlane.ai`** | Contrato completo de la API v1: 29 endpoints con schemas, enums, códigos de error y reglas de negocio. Los dos servidores MCP. **El módulo Automations, que sólo existe vía MCP** | Renderizando en navegador (ver trampa #2 del handoff) |
| **Los 9 videos de `/docs`** | Comportamiento observado de la UI con timestamps | 633 frames extraídos, deduplicados a 284 por diferencia visual y revisados uno a uno; más 8 transcripciones de narración con `whisper-cpp` |

## Decisiones y su razón

### Por qué el PRD usa etiquetas de evidencia

Cada afirmación lleva CONFIRMED / SUPPORTED / INFERRED / UNKNOWN. No es decoración: un PRD de
reverse-engineering sin esa disciplina se vuelve indistinguible de una lista de deseos, y quien lo
implemente no sabe qué es un requisito observado y qué es una suposición de quien escribió.
Se agregó una quinta, **EXTENSION**, cuando el encargo 2 introdujo funcionalidad que Fastlane no
tiene — para que sea trivial identificarla o descartarla.

### Por qué `EXT-001` es aditiva y no un reemplazo

Se verificó por búsqueda dirigida sobre `OnboardingPage-*.js` y sobre el corpus de strings que
Fastlane **sólo** acepta `Company Website`, con `Use description instead` como único fallback.
El camino de web se conservó idéntico —misma copy, mismas validaciones— y lo social se sumó.
Un clon que cambia el camino que ya funciona pierde paridad sin ganar nada.

### La tensión entre D-01 y D-04

El usuario eligió dos opciones que chocan: el alta **no** pide OAuth (`D-01`), pero durante el alta
se ofrece importar los posts propios (`D-04`) — y eso **requiere** OAuth.

Se resolvió por orden, no por compromiso: análisis público primero → perfil de marca ya construido
→ **recién ahí** la oferta de conectar, vendiendo las dos cosas juntas (publicar + traer tu media).
Si declina, el onboarding sigue. Quedó escrita como regla dura en PRD §2.7: la importación de media
nunca puede convertirse en la razón para pedir OAuth antes del análisis.

### Por qué Jev no se adopta pero la capa sí

La evaluación (`EVAL-JEV.md`) encontró dos encajes reales —clasificación del catálogo y scoring de
leads, ambos huecos que el PRD dejaba sin motor— y dos comportamientos nuevos que habilita. Pero:

- el argumento de costo, que es el que más se promociona, **era el más débil acá**: no hay gasto
  que reducir porque no hay código;
- el proveedor tiene semanas de vida, no publica latencia y no tiene benchmarks independientes.

De ahí `D-05`: **se adopta la forma, no el proveedor**. Declarar el puerto cuesta un archivo
mientras no haya código; retrofitearlo después es transversal. Y obliga a enumerar las taxonomías
—qué nichos existen, qué niveles tiene una señal de compra— antes de escribir el código que las
consume, que es donde estos productos se rompen.

### Por qué la cola va en Postgres y no en Redis

Es la decisión de arquitectura menos obvia y la que más se va a querer reabrir. El PRD exige que un
build fallido **reembolse** el content save. Para poder reembolsar con certeza hay que saber que el
job existe. Si se encola en Redis fuera de la transacción que descuenta la cuota, existe una ventana
donde la cuota está consumida y el job no se creó — o al revés. pg-boss permite encolar **dentro de
la misma transacción**. Se migra a BullMQ el job que demuestre saturar, no antes.

### Por qué no Remotion

Es la trampa más cara de todo el plan y se encontró verificando licencias antes de afirmarlas.
Remotion es gratis hasta 3 personas, lo que hace fácil elegirlo y descubrir el problema tarde: un
producto de generación automatizada de video cae en su licencia *Automators*, **$0,01 por render con
mínimo de $100/mes**. A un millón de renders, $10.000. Cuando el render *es* el negocio, un peaje por
unidad no es un detalle de licenciamiento: es el modelo de costos.

## Qué se descartó y por qué

- **Usar la capa de juicio para los pesos de Blitz.** `angleWeights`, `influencerChance` y el
  content mix son muestreo ponderado determinístico que el usuario controla con sliders y espera
  exacto. Meter un modelo ahí **pierde** una propiedad en lugar de ganar una.
- **Usar un modelo para contar.** El ratio del ban meter, las cuotas y los límites de caracteres son
  aritmética. La documentación de Jev es explícita en que no cuenta de forma fiable, y el error crece
  con el tamaño de la entrada. Quedó como regla en PRD §25.2.
- **Auto-categorizar el Media Bank con la capa de juicio.** Parecía un encaje obvio —hoy es manual—
  pero el modelo es text-only y no puede ver la imagen. Sin un paso de visión previo, no existe.
- **Elegir modelos de LLM concretos en el plan.** Los precios cambian mes a mes; fijarlos en un
  documento garantiza que esté desactualizado. Quedó como tarea fechada (`P1-JUDGE-006`).

## Qué quedó sin verificar

Se dice explícitamente porque la alternativa —dejarlo implícito— es peor:

- **Nada de esto se ejecutó.** No hay código, ni tests, ni build. Todas las estimaciones de costo
  del plan derivan de volúmenes del PRD, no de mediciones.
- **La cobertura pública de las 5 plataformas sociales no se investigó** (`OQ-19`). `D-02` las exige
  a todas en Fase 1, y es posible que algunas den muy poco sin OAuth. Por eso `P1-BRAND-002` es un
  spike **antes** de escribir los extractores.
- **La revisión legal no se hizo** (`OQ-16`, `OQ-13`). Son las dos cosas con plazo más largo del
  proyecto y ninguna avanza escribiendo código.

## Archivos producidos en esta sesión

| Archivo | Qué es |
|---|---|
| `PRD.md` | 3.996 líneas, 25 secciones. Fuente de verdad funcional |
| `EVAL-JEV.md` | Evaluación de TypeSafe/Jev con claims verificados y no verificados |
| `docs/IMPLEMENTATION-PLAN.md` | Arquitectura, stack, 15 ADRs |
| `tasks.md` | 361 tareas en 6 fases |
| `docs/HANDOFF.md` | El general |
| `CLAUDE.md`, `.gitignore` | Arranque de agentes y sistema de handoff |
