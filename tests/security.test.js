import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimiter,
  escapeHtml,
  hashSecret,
  randomCode,
  safeEqual,
  securityHeaders,
  signToken,
  verifySecret,
  verifyToken,
} from '../server/lib/security.js';
import { loadConfig } from '../server/config.js';

describe('passcode hashing', () => {
  test('hash verifies the right passcode and rejects the wrong one', async () => {
    const stored = await hashSecret('482913');
    assert.match(stored, /^scrypt\$/);
    assert.equal(await verifySecret('482913', stored), true);
    assert.equal(await verifySecret('482914', stored), false);
  });

  test('same passcode hashes differently (random salt)', async () => {
    assert.notEqual(await hashSecret('111222'), await hashSecret('111222'));
  });

  test('malformed stored hashes are rejected, not thrown', async () => {
    assert.equal(await verifySecret('1', 'nonsense'), false);
    assert.equal(await verifySecret('1', null), false);
    assert.equal(await verifySecret('1', 'bcrypt$a$b'), false);
  });
});

describe('session tokens', () => {
  const secret = 'x'.repeat(40);

  test('round-trips a payload', () => {
    const token = signToken({ mid: 'm1' }, secret, 60);
    assert.equal(verifyToken(token, secret).mid, 'm1');
  });

  test('rejects tampered payloads and wrong secrets', () => {
    const token = signToken({ mid: 'm1', role: 'family' }, secret, 60);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ mid: 'm1', role: 'elder', exp: 9e9 })).toString('base64url');
    assert.equal(verifyToken(`${forged}.${sig}`, secret), null);
    assert.equal(verifyToken(`${body}.${sig}`, 'y'.repeat(40)), null);
    assert.equal(verifyToken('garbage', secret), null);
    assert.equal(verifyToken(undefined, secret), null);
    assert.equal(verifyToken('a'.repeat(5000), secret), null);
  });

  test('rejects expired tokens', () => {
    const token = signToken({ mid: 'm1' }, secret, 60, Date.now() - 120_000);
    assert.equal(verifyToken(token, secret), null);
  });
});

describe('helpers', () => {
  test('safeEqual is exact and handles empty input', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), false);
    assert.equal(safeEqual(undefined, 'x'), false);
  });

  test('randomCode uses an unambiguous alphabet', () => {
    for (let i = 0; i < 50; i += 1) assert.match(randomCode(6), /^[A-HJKMNP-Z2-9]{6}$/);
  });

  test('rate limiter blocks after max and resets', () => {
    let now = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => now });
    assert.equal(rl.hit('a').allowed, true);
    assert.equal(rl.hit('a').allowed, true);
    assert.equal(rl.hit('a').allowed, false);
    assert.equal(rl.hit('b').allowed, true, 'keys are independent');
    now = 1001;
    assert.equal(rl.hit('a').allowed, true, 'window expired');
    rl.hit('a');
    rl.reset('a');
    assert.equal(rl.hit('a').allowed, true);
  });

  test('escapeHtml neutralises markup', () => {
    assert.equal(escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
  });

  test('security headers include strict CSP; HSTS only in production', () => {
    const dev = securityHeaders(false);
    assert.match(dev['Content-Security-Policy'], /script-src 'self'/);
    assert.match(dev['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.equal(dev['Strict-Transport-Security'], undefined);
    assert.ok(securityHeaders(true)['Strict-Transport-Security']);
  });
});

describe('config', () => {
  test('production refuses to start without a strong session secret', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' }), /SESSION_SECRET/);
    const cfg = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'z'.repeat(32), GOOGLE_CLOUD_PROJECT: 'p' });
    assert.equal(cfg.storeDriver, 'firestore');
    assert.equal(cfg.cronSecret, '');
  });

  test('development has safe defaults', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.storeDriver, 'memory');
    assert.equal(cfg.gemini.model, 'gemini-2.5-flash');
  });
});
