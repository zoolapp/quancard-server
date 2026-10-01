import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";

/**
 * Transport and browser hardening applied to every request:
 * HTTPS is mandatory (426 otherwise), the Host must be the configured public
 * origin (DNS-rebinding defense), cookie-authenticated writes must come from
 * that origin with an explicit client header (CSRF), and every response gets
 * a strict CSP and isolation headers.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export const DEVICE_AUTHORIZATION = /^Bearer qcd_[A-Za-z0-9_-]{43}$/;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Loopback and private (RFC 1918 / ULA) peers. Forwarded headers and the
 * localhost development exemption are honoured only for connections that
 * actually arrive from such a peer — the bundled proxy on the Docker network,
 * or a local reverse proxy — never from a public address that forged them.
 */
export function isPrivatePeer(address: string | undefined): boolean {
  if (!address) return false;
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (ip === "::1" || ip.startsWith("127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  const match = /^172\.(\d+)\./.exec(ip);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(ip);
}

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const lower = hostHeader.toLowerCase();
  if (lower.startsWith("[")) return lower.slice(0, lower.indexOf("]") + 1);
  return lower.split(":")[0] ?? "";
}

export function isLocalRequest(config: Config, request: FastifyRequest): boolean {
  return config.allowInsecureLocalhost && LOCAL_HOSTS.has(hostname(request.headers.host)) && isPrivatePeer(request.socket.remoteAddress);
}

export function isSecure(config: Config, request: FastifyRequest): boolean {
  if (config.trustProxy && isPrivatePeer(request.socket.remoteAddress)) {
    const proto = String(request.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      ?.trim();
    if (proto === "https") return true;
  }
  return isLocalRequest(config, request);
}

export function allowedOrigin(config: Config, origin: string | undefined, request: FastifyRequest): boolean {
  if (!origin) return false;
  if (config.publicOrigin && origin === config.publicOrigin.origin) return true;
  if (isLocalRequest(config, request)) {
    try {
      const url = new URL(origin);
      return LOCAL_HOSTS.has(url.hostname === "::1" ? "[::1]" : url.hostname) && url.host === request.headers.host;
    } catch {
      return false;
    }
  }
  return false;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const HEALTH_PATHS = new Set(["/healthz"]);
/** Native-app endpoints that use no ambient credentials (no cookie), so CSRF does not apply. */
const NATIVE_PATHS = new Set(["/api/v1/pairings/claim"]);

export function registerGuards(app: FastifyInstance, config: Config): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0] ?? "";
    // Container healthchecks hit the loopback port directly and receive no data.
    if (HEALTH_PATHS.has(path) && request.method === "GET") return;

    if (!isSecure(config, request)) {
      reply.header("Connection", "close");
      if (path.startsWith("/api/")) throw new ApiError(426, "httpsRequired");
      reply.code(426).type("text/plain; charset=utf-8");
      return reply.send("QuanCard requires HTTPS. Open this server through its https:// address.\n");
    }

    if (config.publicOrigin && !isLocalRequest(config, request) && request.headers.host?.toLowerCase() !== config.publicOrigin.host) {
      throw new ApiError(421, "misdirectedRequest");
    }

    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    // Only a well-formed device token (which also disables cookie auth) is exempt from CSRF checks.
    const bearer = request.headers.authorization !== undefined && DEVICE_AUTHORIZATION.test(request.headers.authorization);
    if (unsafe && path.startsWith("/api/") && !bearer && !NATIVE_PATHS.has(path)) {
      if (!allowedOrigin(config, request.headers.origin, request) || request.headers["x-quancard-client"] !== "web") {
        throw new ApiError(403, "crossOriginRejected");
      }
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Cross-Origin-Embedder-Policy", "require-corp");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    if (isSecure(config, request) && !isLocalRequest(config, request)) {
      reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
    }
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/assets/")) reply.header("Cache-Control", "no-store");
    reply.removeHeader("X-Powered-By");
    return payload;
  });
}

/** Fixed-window limiter keyed by bucket + pseudonymous client tag. In-memory by design (single instance). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, at = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= at) {
      this.hits.set(key, { count: 1, resetAt: at + this.windowMs });
      if (this.hits.size > 50_000) this.sweep(at);
      return;
    }
    entry.count++;
    if (entry.count > this.limit) {
      throw new ApiError(429, "rateLimited", { retryAfterSeconds: Math.ceil((entry.resetAt - at) / 1000) });
    }
  }

  private sweep(at: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= at) this.hits.delete(key);
  }
}
