/**
 * Security primitives built only on node:crypto.
 *  - Passcodes are hashed with scrypt (memory-hard) + per-secret random salt.
 *  - Sessions are HMAC-SHA256 signed, expiring tokens stored in an HttpOnly cookie.
 *  - All secret comparisons are constant-time.
 */
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Hash a secret: returns `scrypt$<salt>$<hash>` (base64url). */
export async function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Constant-time verification of a secret against a stored hash. */
export async function verifySecret(secret, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await scryptAsync(String(secret), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Constant-time string equality (for API secrets). */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** Sign a JSON payload with an expiry. */
export function signToken(payload, secret, ttlSeconds, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds })).toString(
    'base64url',
  );
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify signature + expiry; returns the payload or null. */
export function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — easy to read aloud

/** Human-friendly random code, e.g. a circle join code. */
export function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export const newId = () => randomBytes(12).toString('base64url');

/**
 * Fixed-window in-memory rate limiter. Good enough for a single Cloud Run
 * instance; swap for Memorystore/Redis when scaling horizontally.
 */
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      if (hits.size > 10_000) {
        for (const [k, e] of hits) if (e.reset <= t) hits.delete(k);
      }
      let entry = hits.get(key);
      if (!entry || entry.reset <= t) {
        entry = { count: 0, reset: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return { allowed: entry.count <= max, retryAfter: Math.ceil((entry.reset - t) / 1000) };
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

/** Strict security headers applied to every response. */
export function securityHeaders(isProd) {
  const headers = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
      "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (isProd) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

/** Escape text for safe inclusion in HTML (used in emails). */
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
