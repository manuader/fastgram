/**
 * Generación de identificadores — puerto de dominio.
 *
 * No es `crypto.randomUUID()` suelto por la misma razón que `Clock` no es
 * `Date.now()`: un caso de uso que fabrica su propio id no se puede afirmar en
 * un test sin leer lo que acaba de escribir, y entonces el test comprueba el
 * eco en vez de la regla. Acá se inyecta y el test fija `cnt_1`, `cnt_2`.
 *
 * Vive en `core` y no en `@fastgram/ports` a propósito: `ports` modela lo que
 * está **fuera** del proceso (red, disco, reloj del sistema). Un contador no
 * lo está. Si algún día el id lo emite Postgres, se mueve.
 */
export interface IdGenerator {
  /**
   * Nuevo id. El prefijo es el del recurso (`cnt`, `bs`, `ang`) y viaja en el
   * id porque un id que dice de qué es ahorra media hora en cada incidente.
   */
  newId(prefix: string): string;
}
