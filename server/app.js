/**
 * Application assembly: wires dependencies, routes and the request pipeline.
 *
 * Request pipeline (API):
 *   security headers → global rate limit → route match → CSRF guard
 *   → auth (signed cookie + live membership check) → role check
 *   → bounded JSON body → handler → JSON response / central error handler
 */
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HttpError, forbidden, tooMany, unauthorized } from './lib/errors.js';
import { createRateLimiter, safeEqual, securityHeaders, signToken, verifyToken } from './lib/security.js';
import { createRouter, createStaticServer, parseCookies, readJson, sendJson, serializeCookie } from './lib/http.js';
import { sessionRoutes } from './routes/session.js';
import { circleRoutes } from './routes/circle.js';
import { medicationRoutes } from './routes/medications.js';
import { doseRoutes } from './routes/doses.js';
import { appointmentRoutes } from './routes/appointments.js';
import { aiRoutes } from './routes/ai.js';
import { cronRoutes } from './routes/cron.js';

const COOKIE = 'sc_session';
const DEFAULT_BODY_LIMIT = 64 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const MINUTE = 60_000;

export function createApp({ config, store, mailer, ai, logger, publicDir = PUBLIC_DIR }) {
  const router = createRouter();
  [sessionRoutes, circleRoutes, medicationRoutes, doseRoutes, appointmentRoutes, aiRoutes, cronRoutes]
    .flat()
    .forEach((r) => router.add(r));

  router.add({
    method: 'GET',
    path: '/api/health',
    auth: false,
    handler: async () => ({
      body: { ok: true, store: store.driver, email: mailer.mode, ai: ai.available, demo: config.demoSeed },
    }),
  });

  const limits = {
    global: createRateLimiter({ windowMs: MINUTE, max: 300 }),
    join: createRateLimiter({ windowMs: 15 * MINUTE, max: 5 }),
    create: createRateLimiter({ windowMs: 60 * MINUTE, max: 10 }),
    ai: createRateLimiter({ windowMs: 60 * MINUTE, max: 40 }),
  };
  const ctx = { config, store, mailer, ai, logger, limits };
  const headers = securityHeaders(config.isProd);
  const serveStatic = createStaticServer(publicDir);

  const sessionCookie = (member, circle) =>
    serializeCookie(
      COOKIE,
      signToken({ mid: member.id, cid: circle.id, tv: circle.tokenVersion || 1 }, config.sessionSecret, config.sessionTtlSeconds),
      { maxAge: config.sessionTtlSeconds, secure: config.isProd },
    );

  async function authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const payload = verifyToken(token, config.sessionSecret);
    if (!payload) throw unauthorized();
    const [member, circle] = await Promise.all([store.get('members', payload.mid), store.get('circles', payload.cid)]);
    if (!member || !circle || member.circleId !== circle.id || (circle.tokenVersion || 1) !== payload.tv) {
      throw unauthorized('Your session has ended. Please join the circle again.');
    }
    return { member, circle };
  }

  async function handleApi(req, res, url, ip) {
    const g = limits.global.hit(ip);
    if (!g.allowed) throw tooMany(g.retryAfter);

    const found = router.match(req.method, url.pathname);
    if (!found) throw new HttpError(404, 'Unknown API endpoint');
    if (found.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = found;
    const mutating = !['GET', 'HEAD'].includes(req.method);

    let auth = {};
    if (route.auth === 'cron') {
      if (!config.cronSecret || !safeEqual(req.headers['x-cron-secret'], config.cronSecret)) throw unauthorized('Bad cron secret');
    } else {
      // CSRF: a custom header cannot be sent cross-site without a CORS preflight, which we never allow.
      if (mutating && req.headers['x-requested-with'] !== 'SaathiCare') throw forbidden('Missing request header');
      if (route.auth === 'optional') auth = await authenticate(req).catch(() => ({}));
      else if (route.auth) auth = await authenticate(req);
      if (route.roles && !route.roles.includes(auth.member.role)) {
        throw forbidden(`Only the ${route.roles.join(' or ')} can do this`);
      }
    }

    const body = mutating ? await readJson(req, route.bodyLimit || DEFAULT_BODY_LIMIT) : {};
    const result = await route.handler(ctx, { params, query: url.searchParams, body, ip, ...auth });

    const extra = {};
    if (result.session) extra['Set-Cookie'] = sessionCookie(result.session.member, result.session.circle);
    if (result.clearSession) extra['Set-Cookie'] = serializeCookie(COOKIE, '', { maxAge: 0, secure: config.isProd });
    sendJson(res, result.status || 200, result.body ?? {}, extra);
  }

  return async function handler(req, res) {
    const requestId = req.headers['x-cloud-trace-context']?.split('/')[0] || randomUUID();
    for (const [k, val] of Object.entries(headers)) res.setHeader(k, val);
    res.setHeader('X-Request-Id', requestId);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: { message: 'Bad URL' } });
      return;
    }
    // Cloud Run appends the real client IP as the last X-Forwarded-For entry; earlier ones are client-controlled.
    const ip = (req.headers['x-forwarded-for']?.split(',').pop() || req.socket.remoteAddress || 'unknown').trim();

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { message: 'Method not allowed' } });
        return;
      }
      serveStatic(req, res, url.pathname);
      return;
    }

    try {
      await handleApi(req, res, url, ip);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        const extra = err.status === 429 && err.details?.retryAfter ? { 'Retry-After': String(err.details.retryAfter) } : {};
        sendJson(res, err.status, { error: { message: err.message, details: err.details } }, extra);
        return;
      }
      logger.error('unhandled error', { requestId, path: url.pathname, error: err.message, stack: err.stack });
      sendJson(res, 500, { error: { message: 'Something went wrong on our side. Please try again.', requestId } });
    }
  };
}
