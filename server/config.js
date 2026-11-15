/**
 * Centralised, validated runtime configuration.
 * All secrets come from environment variables — never from source code.
 */

const DEV_SECRET = 'dev-only-insecure-session-secret-change-me-please';

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const sessionSecret = env.SESSION_SECRET || (isProd ? '' : DEV_SECRET);
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters long');
  }

  const smtpPort = Number(env.SMTP_PORT || 465);

  return Object.freeze({
    isProd,
    port: Number(env.PORT || 8080),
    appUrl: (env.APP_URL || `http://localhost:${env.PORT || 8080}`).replace(/\/$/, ''),
    sessionSecret,
    sessionTtlSeconds: 60 * 60 * 24 * 14,
    cronSecret: env.CRON_SECRET || (isProd ? '' : 'dev-cron-secret'),
    storeDriver: env.STORE_DRIVER || (env.GOOGLE_CLOUD_PROJECT ? 'firestore' : 'memory'),
    dataFile: env.DATA_FILE || '',
    gcpProject: env.GOOGLE_CLOUD_PROJECT || '',
    demoSeed: env.DEMO_SEED === 'true',
    gemini: Object.freeze({
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    }),
    smtp: Object.freeze({
      host: env.SMTP_HOST || '',
      port: smtpPort,
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || env.SMTP_USER || 'SaathiCare <no-reply@saathicare.local>',
    }),
  });
}
