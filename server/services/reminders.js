/**
 * Proactive reminder engine, triggered by Google Cloud Scheduler every 5 minutes.
 *
 * Exactly-once semantics per reminder: a reminder key is claimed atomically with
 * `setIfAbsent` *before* the email is sent, so overlapping runs or retries can
 * never email a family twice.
 */
import { addDays, todayIn, HOUR } from './time.js';
import { appointmentStages, buildDayView, computeAdherence, dueStages, stockStatus } from './schedule.js';
import { emailsFor, listMembers, loadCareData, recentDoses } from './care.js';
import { appointmentEmail, digestEmail, doseEmail, refillEmail } from './emails.js';
import { careDigest, missedByMedicine } from './ai.js';

const DOSE_RECIPIENTS = {
  due: ['elder'],
  missed: ['elder', 'caretaker'],
  escalated: ['caretaker', 'family'],
};

async function claim(store, key, meta) {
  return store.setIfAbsent('reminders', key, { ...meta, claimedAt: new Date().toISOString() });
}

export async function runReminders({ store, mailer, appUrl, now = new Date() }) {
  const summary = { circles: 0, due: 0, missed: 0, escalated: 0, appointment: 0, refill: 0 };
  const circles = await store.find('circles');

  for (const circle of circles) {
    summary.circles += 1;
    const tz = circle.timezone;
    const [members, care, appts] = await Promise.all([
      listMembers(store, circle.id),
      loadCareData(store, circle, now, 2),
      store.find('appointments', { circleId: circle.id }),
    ]);
    const base = { circleId: circle.id };

    // Doses: look at local "yesterday" and "today" so late-night doses are covered.
    const today = todayIn(tz, now);
    const doses = [addDays(today, -1), today].flatMap((d) => buildDayView(care.meds, care.logs, d, tz, now));
    for (const dose of doses) {
      if (dose.status === 'taken' || dose.status === 'skipped') continue;
      for (const stage of dueStages(dose.scheduledAt, now)) {
        if (!(await claim(store, `${dose.id}:${stage}`, { ...base, kind: `dose-${stage}` }))) continue;
        const email = doseEmail(stage, { elderName: circle.elderName, dose, tz, appUrl });
        await mailer.send({ ...base, kind: `dose-${stage}`, to: emailsFor(members, DOSE_RECIPIENTS[stage]), ...email });
        summary[stage] += 1;
      }
    }

    // Appointments: 24h and 2h before.
    for (const appt of appts) {
      for (const stage of appointmentStages(appt.datetime, now)) {
        const key = `${appt.id}@${appt.datetime}:${stage}`;
        if (!(await claim(store, key, { ...base, kind: `appointment-${stage}` }))) continue;
        const email = appointmentEmail(stage, { elderName: circle.elderName, appt, tz, appUrl });
        await mailer.send({ ...base, kind: `appointment-${stage}`, to: members.map((m) => m.email), ...email });
        summary.appointment += 1;
      }
    }

    // Low stock: once per refill cycle.
    for (const med of care.meds) {
      const stock = stockStatus(med);
      if (!stock?.low) continue;
      const key = `${med.id}:refill:${med.refilledAt || med.createdAt}`;
      if (!(await claim(store, key, { ...base, kind: 'refill' }))) continue;
      const email = refillEmail({ elderName: circle.elderName, med, stock, appUrl });
      await mailer.send({ ...base, kind: 'refill', to: emailsFor(members, ['elder', 'caretaker']), ...email });
      summary.refill += 1;
    }
  }
  return summary;
}

/** Build the digest for one circle (used by the API and by the weekly job). */
export async function buildDigest({ store, ai, circle, now = new Date() }) {
  const care = await loadCareData(store, circle, now, 8);
  const adherence = computeAdherence(care.meds, care.logs, circle.timezone, now, 7);
  const doses = recentDoses(care.meds, care.logs, circle.timezone, now, 7);
  const appts = await store.find('appointments', { circleId: circle.id });
  const upcoming = appts
    .filter((a) => new Date(a.datetime) > now && new Date(a.datetime) - now < 14 * 24 * HOUR)
    .map((a) => ({ doctor: a.doctor, datetime: a.datetime }));
  const digest = await careDigest(ai, {
    elderName: circle.elderName,
    meds: care.meds,
    adherence,
    missedByMed: missedByMedicine(doses),
    upcoming,
  });
  return { ...digest, adherence };
}

/** Weekly AI digest emailed to everyone in the circle (Cloud Scheduler, Sundays). */
export async function runWeeklyDigest({ store, mailer, ai, appUrl, now = new Date() }) {
  let sent = 0;
  for (const circle of await store.find('circles')) {
    const week = `${now.getUTCFullYear()}-${Math.floor(now.getTime() / (7 * 24 * HOUR))}`;
    if (!(await claim(store, `${circle.id}:digest:${week}`, { circleId: circle.id, kind: 'digest' }))) continue;
    const members = await listMembers(store, circle.id);
    const digest = await buildDigest({ store, ai, circle, now });
    const email = digestEmail({ elderName: circle.elderName, digest, appUrl });
    await mailer.send({ circleId: circle.id, kind: 'digest', to: members.map((m) => m.email), ...email });
    sent += 1;
  }
  return { sent };
}
