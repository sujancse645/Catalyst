import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, isValidTimeZone, todayIn, zonedParts, zonedToUtc } from '../server/services/time.js';
import {
  appointmentStages,
  buildDayView,
  computeAdherence,
  computeStreak,
  doseId,
  doseStatus,
  dosesForDate,
  dueStages,
  matchVoiceCheckIn,
  stockStatus,
} from '../server/services/schedule.js';

const TZ = 'Asia/Kolkata';
const med = (over = {}) => ({
  id: 'm1',
  name: 'Metformin',
  dosage: '500 mg',
  times: ['20:00', '08:00'],
  status: 'active',
  startDate: '2026-11-01',
  endDate: null,
  ...over,
});
const at = (iso) => new Date(iso);

describe('time zones', () => {
  test('converts IST wall clock to UTC', () => {
    assert.equal(zonedToUtc('2026-11-15', '08:00', TZ).toISOString(), '2026-11-15T02:30:00.000Z');
  });

  test('handles a DST zone on both sides of the change', () => {
    // New York: EDT (UTC-4) before 1 Nov 2026, EST (UTC-5) after.
    assert.equal(zonedToUtc('2026-10-30', '08:00', 'America/New_York').toISOString(), '2026-10-30T12:00:00.000Z');
    assert.equal(zonedToUtc('2026-11-02', '08:00', 'America/New_York').toISOString(), '2026-11-02T13:00:00.000Z');
  });

  test('today and parts respect the zone across midnight', () => {
    const now = at('2026-11-15T20:00:00Z'); // 01:30 next day in IST
    assert.equal(todayIn(TZ, now), '2026-11-16');
    assert.equal(zonedParts(now, TZ).time, '01:30');
  });

  test('addDays crosses month and year boundaries', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  test('validates zone names', () => {
    assert.equal(isValidTimeZone('Asia/Kolkata'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
  });
});

describe('dose schedule', () => {
  test('produces sorted doses with deterministic ids', () => {
    const doses = dosesForDate(med(), '2026-11-15', TZ);
    assert.deepEqual(doses.map((d) => d.time), ['08:00', '20:00']);
    assert.equal(doses[0].id, doseId('m1', '2026-11-15T02:30:00.000Z'));
  });

  test('respects start/end dates, status and activeFrom', () => {
    assert.equal(dosesForDate(med({ startDate: '2026-11-16' }), '2026-11-15', TZ).length, 0);
    assert.equal(dosesForDate(med({ endDate: '2026-11-14' }), '2026-11-15', TZ).length, 0);
    assert.equal(dosesForDate(med({ status: 'pending' }), '2026-11-15', TZ).length, 0);
    const late = dosesForDate(med({ activeFrom: '2026-11-15T10:00:00.000Z' }), '2026-11-15', TZ);
    assert.deepEqual(late.map((d) => d.time), ['20:00'], 'morning dose before activation is not counted');
  });

  test('status moves upcoming → due → missed, and logs win', () => {
    const dose = { scheduledAt: '2026-11-15T02:30:00.000Z' };
    assert.equal(doseStatus(dose, null, at('2026-11-15T02:00:00Z')), 'upcoming');
    assert.equal(doseStatus(dose, null, at('2026-11-15T02:20:00Z')), 'due');
    assert.equal(doseStatus(dose, null, at('2026-11-15T02:59:00Z')), 'due');
    assert.equal(doseStatus(dose, null, at('2026-11-15T03:00:00Z')), 'missed');
    assert.equal(doseStatus(dose, { status: 'taken' }, at('2026-11-15T09:00:00Z')), 'taken');
    assert.equal(doseStatus(dose, { status: 'skipped' }, at('2026-11-15T09:00:00Z')), 'skipped');
  });

  test('day view joins logs and medicine details', () => {
    const m = med();
    const [morning] = dosesForDate(m, '2026-11-15', TZ);
    const view = buildDayView([m], [{ id: morning.id, status: 'taken', takenAt: 'x', takenByName: 'Ravi' }], '2026-11-15', TZ, at('2026-11-15T10:00:00Z'));
    assert.equal(view.length, 2);
    assert.equal(view[0].status, 'taken');
    assert.equal(view[0].takenBy, 'Ravi');
    assert.equal(view[1].status, 'upcoming');
    assert.equal(view[1].name, 'Metformin');
  });
});

describe('adherence', () => {
  test('counts only doses past their grace window and computes streak', () => {
    const m = med();
    const now = at('2026-11-15T10:00:00Z'); // 15:30 IST
    const logs = [];
    for (let i = 6; i >= 0; i -= 1) {
      for (const d of dosesForDate(m, addDays('2026-11-15', -i), TZ)) {
        const missEvening = i === 3 && d.time === '20:00';
        if (!missEvening && new Date(d.scheduledAt) < now) logs.push({ id: d.id, status: 'taken' });
      }
    }
    const a = computeAdherence([m], logs, TZ, now, 7);
    assert.equal(a.scheduled, 13, '6 full days + today’s morning dose');
    assert.equal(a.taken, 12);
    assert.equal(a.missed, 1);
    assert.equal(a.percent, 92);
    assert.equal(a.streak, 3, 'three complete days since the miss (today counts)');
  });

  test('no history gives null percent', () => {
    assert.equal(computeAdherence([], [], TZ, new Date()).percent, null);
  });

  test('streak skips days with nothing scheduled', () => {
    const days = [
      { scheduled: 2, taken: 1 },
      { scheduled: 2, taken: 2 },
      { scheduled: 0, taken: 0 },
      { scheduled: 1, taken: 1 },
      { scheduled: 0, taken: 0 },
    ];
    assert.equal(computeStreak(days), 2);
  });
});

describe('reminder stages', () => {
  const s = '2026-11-15T02:30:00.000Z';
  const plus = (min) => new Date(new Date(s).getTime() + min * 60_000);

  test('escalates at the right times', () => {
    assert.deepEqual(dueStages(s, plus(-20)), []);
    assert.deepEqual(dueStages(s, plus(-10)), ['due']);
    assert.deepEqual(dueStages(s, plus(29)), ['due']);
    assert.deepEqual(dueStages(s, plus(30)), ['missed']);
    assert.deepEqual(dueStages(s, plus(125)), ['missed', 'escalated']);
    assert.deepEqual(dueStages(s, plus(7 * 60)), [], 'too old: no alert floods after downtime');
  });

  test('appointment reminders at 24h and 2h', () => {
    const appt = '2026-11-20T05:00:00.000Z';
    const before = (h) => new Date(new Date(appt).getTime() - h * 3600_000);
    assert.deepEqual(appointmentStages(appt, before(30)), []);
    assert.deepEqual(appointmentStages(appt, before(20)), ['24h']);
    assert.deepEqual(appointmentStages(appt, before(1)), ['2h']);
    assert.deepEqual(appointmentStages(appt, before(-1)), []);
  });

  test('stock status flags low supply', () => {
    assert.deepEqual(stockStatus(med({ pillsLeft: 5 })), { pillsLeft: 5, daysLeft: 2, low: true });
    assert.equal(stockStatus(med({ pillsLeft: 40 })).low, false);
    assert.equal(stockStatus(med({ pillsLeft: null })), null);
  });
});

describe('voice check-in matching', () => {
  const now = at('2026-11-15T03:00:00Z');
  const view = [
    { id: 'a', name: 'Metformin', status: 'due', scheduledAt: '2026-11-15T02:30:00.000Z' },
    { id: 'b', name: 'Amlodipine Besylate', status: 'missed', scheduledAt: '2026-11-15T01:30:00.000Z' },
    { id: 'c', name: 'Atorvastatin', status: 'upcoming', scheduledAt: '2026-11-15T15:30:00.000Z' },
  ];

  test('matches by medicine name, case-insensitive', () => {
    assert.equal(matchVoiceCheckIn('I took my METFORMIN just now', view, now).id, 'a');
    assert.equal(matchVoiceCheckIn('had the amlodipine', view, now).id, 'b');
  });

  test('ignores upcoming doses and unknown names', () => {
    assert.equal(matchVoiceCheckIn('took atorvastatin', view, now), null);
    assert.equal(matchVoiceCheckIn('took paracetamol', view, now), null);
  });

  test('generic "I took my medicine" only works when unambiguous', () => {
    assert.equal(matchVoiceCheckIn('I took my medicine', view, now), null);
    assert.equal(matchVoiceCheckIn('I took my medicine', [view[0], view[2]], now).id, 'a');
  });
});
