/**
 * Endpoints invoked by Google Cloud Scheduler. Authenticated by a shared
 * secret header compared in constant time; never exposed to browsers.
 */
import { runReminders, runWeeklyDigest } from '../services/reminders.js';

export const cronRoutes = [
  {
    method: 'POST',
    path: '/api/cron/reminders',
    auth: 'cron',
    async handler(ctx) {
      const summary = await runReminders({ store: ctx.store, mailer: ctx.mailer, appUrl: ctx.config.appUrl });
      ctx.logger.info('reminders run', summary);
      return { body: summary };
    },
  },
  {
    method: 'POST',
    path: '/api/cron/digest',
    auth: 'cron',
    async handler(ctx) {
      const summary = await runWeeklyDigest({
        store: ctx.store,
        mailer: ctx.mailer,
        ai: ctx.ai,
        appUrl: ctx.config.appUrl,
      });
      ctx.logger.info('digest run', summary);
      return { body: summary };
    },
  },
];
