/**
 * Today view, dose check-ins (tap or voice), and adherence.
 */
import { v, parse } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit, loadCareData } from '../services/care.js';
import {
  buildDayView,
  computeAdherence,
  doseId,
  dosesForDate,
  matchVoiceCheckIn,
  stockStatus,
} from '../services/schedule.js';
import { todayIn, zonedParts, addDays } from '../services/time.js';

const markSchema = v.object({
  medicationId: v.string({ max: 40 }),
  scheduledAt: v.datetime(),
  status: v.optional(v.enum(['taken', 'skipped']), 'taken'),
});

async function markDose(ctx, r, med, scheduledAt, status) {
  const tz = r.circle.timezone;
  const date = zonedParts(new Date(scheduledAt), tz).date;
  const dose = dosesForDate(med, date, tz).find((d) => d.scheduledAt === scheduledAt);
  if (!dose) throw badRequest('That dose is not on the schedule');
  if (new Date(scheduledAt).getTime() - Date.now() > 2 * 60 * 60 * 1000) {
    throw badRequest('You can only check off a dose up to 2 hours early');
  }

  const id = doseId(med.id, scheduledAt);
  const previous = await ctx.store.get('doseLogs', id);
  const log = await ctx.store.set('doseLogs', id, {
    circleId: r.circle.id,
    medicationId: med.id,
    scheduledAt,
    date,
    status,
    takenAt: status === 'taken' ? new Date().toISOString() : null,
    takenById: r.member.id,
    takenByName: r.member.name,
  });

  // Keep stock in sync — only on a real transition to "taken".
  if (status === 'taken' && previous?.status !== 'taken' && typeof med.pillsLeft === 'number') {
    await ctx.store.update('medications', med.id, { pillsLeft: Math.max(0, med.pillsLeft - 1) });
  }
  const who = r.member.role === 'elder' ? '' : ` (marked by ${r.member.name})`;
  await audit(ctx.store, r.circle.id, r.member, `dose.${status}`, `${med.name} at ${dose.time}${who}`);
  return log;
}

async function activeMed(ctx, r, id) {
  const med = await ctx.store.get('medications', id);
  if (!med || med.circleId !== r.circle.id || med.status !== 'active') throw notFound('Medication not found');
  return med;
}

export const doseRoutes = [
  {
    method: 'GET',
    path: '/api/today',
    auth: true,
    async handler(ctx, r) {
      const tz = r.circle.timezone;
      const now = new Date();
      const today = todayIn(tz, now);
      const date = r.query.get('date') ? parse(v.date(), r.query.get('date')) : today;
      if (date < addDays(today, -30) || date > addDays(today, 30)) throw badRequest('date must be within 30 days');
      const care = await loadCareData(ctx.store, r.circle, now, 32);
      const appts = await ctx.store.find('appointments', { circleId: r.circle.id });
      const nextAppointment =
        appts
          .filter((a) => new Date(a.datetime) > now)
          .sort((a, b) => a.datetime.localeCompare(b.datetime))[0] || null;
      return {
        body: {
          date,
          today,
          timezone: tz,
          doses: buildDayView(care.meds, care.logs, date, tz, now),
          adherence: computeAdherence(care.meds, care.logs, tz, now, 7),
          lowStock: care.meds
            .map((m) => ({ id: m.id, name: m.name, stock: stockStatus(m) }))
            .filter((m) => m.stock?.low),
          pendingApprovals: care.allMeds.filter((m) => m.status === 'pending' || m.proposal).length,
          nextAppointment,
        },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/doses',
    auth: true,
    async handler(ctx, r) {
      const input = parse(markSchema, r.body);
      const med = await activeMed(ctx, r, input.medicationId);
      const log = await markDose(ctx, r, med, input.scheduledAt, input.status);
      return { body: { log } };
    },
  },
  {
    method: 'DELETE',
    path: '/api/doses/:id',
    auth: true,
    async handler(ctx, r) {
      const log = await ctx.store.get('doseLogs', r.params.id);
      if (!log || log.circleId !== r.circle.id) throw notFound('Dose check-in not found');
      await ctx.store.delete('doseLogs', log.id);
      const med = await ctx.store.get('medications', log.medicationId);
      if (med && log.status === 'taken' && typeof med.pillsLeft === 'number') {
        await ctx.store.update('medications', med.id, { pillsLeft: med.pillsLeft + 1 });
      }
      await audit(ctx.store, r.circle.id, r.member, 'dose.undone', `${med?.name || 'Medicine'} check-in undone`);
      return { body: { ok: true } };
    },
  },
  {
    method: 'POST',
    path: '/api/doses/voice',
    auth: true,
    async handler(ctx, r) {
      const { transcript } = parse(v.object({ transcript: v.string({ max: 300 }) }), r.body);
      const now = new Date();
      const care = await loadCareData(ctx.store, r.circle, now, 2);
      const tz = r.circle.timezone;
      const today = todayIn(tz, now);
      const view = [addDays(today, -1), today].flatMap((d) => buildDayView(care.meds, care.logs, d, tz, now));
      const dose = matchVoiceCheckIn(transcript, view, now);
      if (!dose) {
        // Named a medicine that isn't due yet? Say when it is, instead of a generic error.
        const later = matchVoiceCheckIn(
          transcript,
          view.filter((d) => d.status === 'upcoming').map((d) => ({ ...d, status: 'due' })),
          now,
        );
        if (later) {
          return {
            body: { matched: false, message: `${later.name} is not due yet — it is scheduled for ${later.time}.` },
          };
        }
        return {
          body: {
            matched: false,
            message: 'Sorry, I could not tell which medicine you took. Please tap the medicine instead.',
          },
        };
      }
      const med = care.meds.find((m) => m.id === dose.medicationId);
      await markDose(ctx, r, med, dose.scheduledAt, 'taken');
      return { body: { matched: true, message: `Great — ${dose.name} at ${dose.time} is marked as taken.`, doseId: dose.id } };
    },
  },
];
