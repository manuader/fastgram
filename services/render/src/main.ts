/**
 * Servicio de render — ADR-007 (FFmpeg + sharp, no Remotion).
 * Sin estado, escala por CPU. La implementación real es P2-RENDER-*.
 */
import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok", service: "render" }));

const port = Number(process.env.RENDER_PORT ?? 3002);
app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
