/**
 * Pure scheduling logic — no I/O, fully unit-tested.
 * Dose identity is deterministic (`medId@ISO`), which makes marking a dose
 * and sending its reminders naturally idempotent.
 */
import { HOUR, MINUTE, addDays, todayIn, zonedToUtc } from './time.js';

/** Escalation timeline relative to the scheduled time of a dose. */
export const ESCALATION = Object.freeze({
  dueFrom: -15 * MINUTE, // "time for your medicine" email to the elder
  missedAfter: 30 * MINUTE, // still not taken → elder + caretakers
  escalateAfter: 2 * HOUR, // still not taken → whole family
  lookback: 6 * HOUR, // never alert about doses older than this (avoids floods after downtime)
});

export const LOW_STOCK_DAYS = 3;

export const doseId = (medId, scheduledAtIso) => `${medId}@${scheduledAtIso}`;

/** Is a medication active on a given local date? */
export function isActiveOn(med, dateStr) {
  if (med.status !== 'active') return false;
  if (med.startDate && dateStr < med.startDate) return false;
  if (med.endDate && dateStr > med.endDate) return false;
  return true;
}

/** All scheduled doses of one medication on a local date. */
export function dosesForDate(med, dateStr, tz) {
  if (!isActiveOn(med, dateStr)) return [];
  return [...med.times]
    .sort()
    .map((time) => {
      const scheduledAt = zonedToUtc(dateStr, time, tz).toISOString();
      return { id: doseId(med.id, scheduledAt), medicationId: med.id, date: dateStr, time, scheduledAt };
    })
    // Doses before the medicine was activated (added/approved) never count as missed.
    .filter((d) => !med.activeFrom || d.scheduledAt >= med.activeFrom);
}

/** Status of a single dose at `now`. */
export function doseStatus(dose, log, now) {
  if (log?.status === 'taken') return 'taken';
  if (log?.status === 'skipped') return 'skipped';
  const delta = now.getTime() - new Date(dose.scheduledAt).getTime();
  if (delta >= ESCALATION.missedAfter) return 'missed';
  if (delta >= ESCALATION.dueFrom) return 'due';
  return 'upcoming';
}

/** Index dose logs by dose id for O(1) lookup. */
export const indexLogs = (logs) => new Map(logs.map((l) => [l.id, l]));

/** The elder's "Today" view: every dose with its live status. */
export function buildDayView(meds, logs, dateStr, tz, now) {
  const byId = indexLogs(logs);
  const medsById = new Map(meds.map((m) => [m.id, m]));
  return meds
    .flatMap((m) => dosesForDate(m, dateStr, tz))
    .map((dose) => {
      const med = medsById.get(dose.medicationId);
      const log = byId.get(dose.id);
      return {
        ...dose,
        name: med.name,
        dosage: med.dosage,
        instructions: med.instructions || '',
        status: doseStatus(dose, log, now),
        takenAt: log?.takenAt || null,
        takenBy: log?.takenByName || null,
      };
    })
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/**
 * Adherence over the last `days` days (including today).
 * Doses still inside their grace window are not counted against the elder.
 */
export function computeAdherence(meds, logs, tz, now, days = 7) {
  const byId = indexLogs(logs);
  const today = todayIn(tz, now);
  const byDay = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    let scheduled = 0;
    let taken = 0;
    for (const med of meds) {
      for (const dose of dosesForDate(med, date, tz)) {
        const status = doseStatus(dose, byId.get(dose.id), now);
        if (status === 'upcoming' || status === 'due') continue;
        scheduled += 1;
        if (status === 'taken') taken += 1;
      }
    }
    byDay.push({ date, scheduled, taken });
  }
  const scheduled = byDay.reduce((s, d) => s + d.scheduled, 0);
  const taken = byDay.reduce((s, d) => s + d.taken, 0);
  return {
    days,
    scheduled,
    taken,
    missed: scheduled - taken,
    percent: scheduled === 0 ? null : Math.round((taken / scheduled) * 100),
    streak: computeStreak(byDay),
    byDay,
  };
}

/** Consecutive most-recent days where every counted dose was taken. */
export function computeStreak(byDay) {
  let streak = 0;
  for (let i = byDay.length - 1; i >= 0; i -= 1) {
    const d = byDay[i];
    if (d.scheduled === 0) continue; // nothing due that day (or yet today) — doesn't break the streak
    if (d.taken < d.scheduled) break;
    streak += 1;
  }
  return streak;
}

/** Which reminder stages are due for an untaken dose right now. */
export function dueStages(scheduledAtIso, now) {
  const delta = now.getTime() - new Date(scheduledAtIso).getTime();
  if (delta > ESCALATION.lookback || delta < ESCALATION.dueFrom) return [];
  const stages = [];
  if (delta < ESCALATION.missedAfter) stages.push('due');
  if (delta >= ESCALATION.missedAfter) stages.push('missed');
  if (delta >= ESCALATION.escalateAfter) stages.push('escalated');
  return stages;
}

/** Which appointment reminders are due right now. */
export function appointmentStages(datetimeIso, now) {
  const until = new Date(datetimeIso).getTime() - now.getTime();
  if (until <= 0) return [];
  if (until <= 2 * HOUR) return ['2h'];
  if (until <= 24 * HOUR) return ['24h'];
  return [];
}

/** Supply remaining for a medication. */
export function stockStatus(med) {
  if (typeof med.pillsLeft !== 'number' || med.times.length === 0) return null;
  const daysLeft = Math.floor(med.pillsLeft / med.times.length);
  return { pillsLeft: med.pillsLeft, daysLeft, low: daysLeft <= LOW_STOCK_DAYS };
}

/**
 * Match a spoken check-in ("I took my metformin") to a dose that is due or missed.
 * Prefers the dose closest to now.
 */
export function matchVoiceCheckIn(transcript, dayView, now) {
  const text = ` ${transcript.toLowerCase().replace(/[^a-z0-9ऀ-෿ ]/g, ' ')} `;
  const open = dayView.filter((d) => d.status === 'due' || d.status === 'missed');
  const matches = open.filter((d) => {
    const words = d.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return words.some((w) => text.includes(` ${w} `) || text.includes(` ${w}`));
  });
  // "I took my medicine" with exactly one open dose is unambiguous.
  const generic = /\b(took|taken|had|done|finished)\b/.test(text) && open.length === 1;
  const pool = matches.length > 0 ? matches : generic ? open : [];
  const distance = (d) => Math.abs(new Date(d.scheduledAt).getTime() - now.getTime());
  pool.sort((a, b) => distance(a) - distance(b));
  return pool[0] || null;
}
