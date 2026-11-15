import { createServer } from 'node:http';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { createMemoryStore } from '../server/lib/store.js';
import { createMailer } from '../server/lib/mailer.js';
import { createGeminiClient } from '../server/lib/gemini.js';
import { createLogger } from '../server/lib/logger.js';

/** Fake Gemini fetch: returns `responder(body)` as the model's JSON text. */
export function fakeGeminiFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const out = await responder(body, calls.length);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

export async function startTestServer({ geminiResponder, env = {} } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', CRON_SECRET: 'test-cron-secret', ...env });
  const store = createMemoryStore();
  const logger = createLogger({ silent: true });
  const mailer = createMailer({ transport: null, store, from: 'test@saathicare', logger });
  const ai = createGeminiClient({
    apiKey: geminiResponder ? 'test-key' : '',
    fetchImpl: geminiResponder ? fakeGeminiFetch(geminiResponder) : undefined,
    sleep: async () => {},
    logger,
  });
  const server = createServer(createApp({ config, store, mailer, ai, logger }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, server, config, close: () => new Promise((r) => server.close(r)) };
}

/** HTTP client with its own cookie jar (one per simulated person/device). */
export function client(base) {
  let cookie = '';
  return {
    async req(path, { method = 'GET', body, headers = {}, csrf = true } = {}) {
      const h = { ...headers };
      if (cookie) h.Cookie = cookie;
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (method !== 'GET' && csrf) h['X-Requested-With'] = 'SaathiCare';
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, body: json, headers: res.headers };
    },
  };
}

export const createCircleBody = (overrides = {}) => ({
  elderName: 'Kamala Devi',
  yourName: 'Kamala Devi',
  email: 'kamala@example.com',
  role: 'elder',
  passcode: '482913',
  timezone: 'Asia/Kolkata',
  ...overrides,
});
