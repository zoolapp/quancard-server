import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { Config } from "./config.js";
import { Context } from "./context.js";
import type { Database } from "./db.js";
import { ApiError, isPrivatePeer, registerGuards } from "./http-guard.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerVaultRoutes } from "./routes/vaults.js";

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(config: Config, db: Database, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // Exactly one trusted hop (the bundled reverse proxy); client-supplied X-Forwarded-For entries are ignored.
    trustProxy: config.trustProxy ? (address: string, hop: number) => hop < 1 && isPrivatePeer(address) : false,
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    // Never derive request IDs from client headers; never log bodies, headers or URLs with queries.
    logger: options.logger
      ? {
          level: "info",
          redact: { paths: ["req.headers", "req.body", "res.headers"], remove: true },
          serializers: {
            req: (req) => ({ method: req.method, route: req.routeOptions?.url ?? "unmatched" }),
            res: (res) => ({ statusCode: res.statusCode }),
          },
        }
      : false,
  });
  const ctx = new Context(config, db);

  await app.register(cookie);
  registerGuards(app, config);

  app.addHook("onResponse", async (request, reply) => {
    if (options.logger)
      request.log.info({ route: request.routeOptions.url ?? "unmatched", status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.status === 429 && typeof error.extra.retryAfterSeconds === "number") reply.header("Retry-After", String(error.extra.retryAfterSeconds));
      return reply.code(error.status).send({ error: error.code, ...error.extra });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) return reply.code(413).send({ error: "payloadTooLarge" });
    if (status === 415) return reply.code(415).send({ error: "unsupportedMediaType" });
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "badRequest" });
    request.log.error({ kind: (error as Error).name }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  registerAuthRoutes(app, ctx);
  registerVaultRoutes(app, ctx);

  if (config.webRoot) {
    const indexPath = join(config.webRoot, "index.html");
    const index = existsSync(indexPath) ? readFileSync(indexPath) : null;
    await app.register(fastifyStatic, {
      root: config.webRoot,
      wildcard: false,
      index: false,
      dotfiles: "deny",
      setHeaders: (reply, path) => {
        // Content-hashed bundles are immutable; everything else must be revalidated.
        if (path.includes(`${join(config.webRoot as string, "assets")}`)) reply.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (!["GET", "HEAD"].includes(request.method) || request.url.startsWith("/api/") || !index) return reply.code(404).send({ error: "notFound" });
      return reply.type("text/html; charset=utf-8").send(index);
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "notFound" }));
  }

  return app;
}
