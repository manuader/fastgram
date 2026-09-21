## Tarea

<!-- El ID de tasks.md. Obligatorio. Ej: P1-QUOTA-003 -->
**ID:** P?-????-???

## Qué cambia

<!-- Una o dos frases. Qué hace distinto el sistema después de este PR. -->

## Definition of Done

- [ ] La tarea está marcada `[x]` en `tasks.md`
- [ ] Tests que fijan **los números del PRD** que toca este cambio (caps, rangos, estados)
- [ ] `pnpm verify` pasa local (lint · typecheck · boundaries · test)
- [ ] Errores de proveedor traducidos a código estable — ninguno sale crudo
- [ ] Todo acceso a datos lleva scope de `companyId`; cruzado devuelve **404**, no 403
- [ ] Sin secretos en el código, en los tests ni en la descripción de este PR
- [ ] Si cambió una decisión del plan: `docs/IMPLEMENTATION-PLAN.md` actualizado
- [ ] Si costó tiempo y no se deduce del código: anotado en `docs/SESSION-*.md`

## Referencia al PRD

<!-- FR-XXX / F-XXX / DATA-XXX que implementa o modifica -->

## Qué NO cubre

<!-- Lo que queda abierto. Un PR honesto sobre sus límites vale más que uno
     que dice "todo verde" y deja tres cosas sin verificar. -->
