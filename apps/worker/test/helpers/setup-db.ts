/**
 * `globalSetup` de la suite de integración del worker.
 *
 * Existe para que `pnpm --filter @fastgram/worker test:int` funcione en un clone
 * limpio sin pasos previos. La base del worker es **propia** —no puede compartir
 * la de `apps/api`, cuyos fixtures truncan `companies` y `contents`— y crearla a
 * mano es un paso que alguien se va a olvidar; ponerla en el `docker-compose`
 * no alcanza, porque un `initdb` sólo corre con el volumen vacío y a quien ya
 * tiene el contenedor levantado no le llegaría nunca.
 *
 * Corre **una vez** por corrida, antes de cualquier archivo. Las migraciones son
 * idempotentes (Drizzle registra las aplicadas), así que repetirlo no cuesta.
 */
import { ensureDatabase, DATABASE_URL } from "./fixtures.js";

export default async function setup(): Promise<void> {
  await ensureDatabase();
  // Se dice qué base se usó: si un test falla por datos ajenos, lo primero que
  // se quiere saber es contra dónde corrió.
  console.log(`[worker test:int] base: ${new URL(DATABASE_URL).pathname.slice(1)}`);
}
