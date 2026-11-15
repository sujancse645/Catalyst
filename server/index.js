import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createStore } from './lib/store.js';
import { createLogger } from './lib/logger.js';
import { createMailer, createSmtpTransport } from './lib/mailer.js';
import { createGeminiClient } from './lib/gemini.js';
import { seedDemo } from './seed.js';

export function buildDeps(config, { logger = createLogger(), fetchImpl } = {}) {
  const store = createStore(config, { fetchImpl });
  const transport = config.smtp.host ? createSmtpTransport(config.smtp) : null;
  const mailer = createMailer({ transport, store, from: config.smtp.from, logger });
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey, model: config.gemini.model, logger, fetchImpl });
  return { config, store, mailer, ai, logger };
}

async function main() {
  const config = loadConfig();
  const deps = buildDeps(config);
  if (config.demoSeed) {
    const demo = await seedDemo(deps.store);
    if (demo) deps.logger.info('demo circle seeded', { code: demo.code, passcode: demo.passcode });
  }

  const server = createServer(createApp(deps));
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.listen(config.port, () =>
    deps.logger.info('SaathiCare listening', {
      port: config.port,
      store: deps.store.driver,
      email: deps.mailer.mode,
      ai: deps.ai.available,
    }),
  );

  // Graceful shutdown: Cloud Run sends SIGTERM before stopping an instance.
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ severity: 'ERROR', message: 'startup failed', error: err.message })}\n`);
    process.exit(1);
  });
}
