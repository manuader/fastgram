/**
 * Navegación **con recarga** tras entrar o salir.
 *
 * No `router.push`: la cookie de sesión acaba de cambiar, y el router del App
 * Router puede servir de su cache un árbol renderizado con la sesión anterior
 * (o sin ninguna). Una navegación completa pasa por el middleware y por un
 * render de servidor nuevo — que es donde se decide qué ve el usuario.
 *
 * Es un módulo aparte para que los tests lo reemplacen: jsdom no navega.
 */
export function hardNavigate(path: string): void {
  window.location.assign(path);
}
