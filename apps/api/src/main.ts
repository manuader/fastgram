/**
 * API pública v1 + BFF interno.
 * El montaje real de rutas llega con P1-API-*.
 */
import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "api" }));

const port = Number(process.env.API_PORT ?? 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
