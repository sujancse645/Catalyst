/**
 * Demo data so judges can explore instantly: circle code DEMO42, passcode 246810.
 * Creates a realistic week of history (with a few missed evening doses) so
 * adherence, streaks, escalation and the AI digest all have real data.
 */
import { hashSecret, newId } from './lib/security.js';
import { addDays, todayIn } from './services/time.js';
import { dosesForDate } from './services/schedule.js';

export const DEMO = Object.freeze({ code: 'DEMO42', passcode: '246810' });

export async function seedDemo(store, now = new Date()) {
  const existing = await store.find('circles', { code: DEMO.code });
  if (existing.length > 0) return null;

  const tz = 'Asia/Kolkata';
  const today = todayIn(tz, now);
  const stamp = now.toISOString();
  const circle = await store.set('circles', newId(), {
    code: DEMO.code,
    elderName: 'Kamala Devi',
    timezone: tz,
    passcodeHash: await hashSecret(DEMO.passcode),
    tokenVersion: 1,
    settings: { requireElderApproval: true },
    createdAt: stamp,
  });

  const people = [
    { name: 'Kamala Devi', email: 'kamala@example.com', role: 'elder' },
    { name: 'Ravi (son)', email: 'ravi@example.com', role: 'family' },
    { name: 'Meena (nurse)', email: 'meena@example.com', role: 'caretaker' },
  ];
  const members = [];
  for (const p of people) {
    members.push(await store.set('members', newId(), { ...p, circleId: circle.id, joinedAt: stamp }));
  }

  const medDefs = [
    { name: 'Metformin', dosage: '500 mg', times: ['08:00', '20:00'], instructions: 'After food', pillsLeft: 40 },
    { name: 'Amlodipine', dosage: '5 mg', times: ['09:00'], instructions: 'Blood pressure', pillsLeft: 3 },
    { name: 'Atorvastatin', dosage: '10 mg', times: ['21:00'], instructions: 'At bedtime', pillsLeft: 25 },
  ];
  const meds = [];
  for (const m of medDefs) {
    meds.push(
      await store.set('medications', newId(), {
        ...m,
        circleId: circle.id,
        status: 'active',
        startDate: addDays(today, -10),
        endDate: null,
        createdBy: members[1].id,
        createdByName: members[1].name,
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
  }
  // A pending proposal from the son, waiting for Kamala's approval.
  await store.set('medications', newId(), {
    name: 'Vitamin D3',
    dosage: '1000 IU',
    times: ['13:00'],
    instructions: 'With lunch',
    pillsLeft: 30,
    circleId: circle.id,
    status: 'pending',
    startDate: today,
    endDate: null,
    createdBy: members[1].id,
    createdByName: members[1].name,
    createdAt: stamp,
    updatedAt: stamp,
  });

  // History: evening doses missed on two days to create a pattern.
  // Today: doses more than 2 hours old are taken; recent ones are left open.
  const cutoff = now.getTime() - 2 * 60 * 60 * 1000;
  for (let i = 6; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    for (const med of meds) {
      for (const dose of dosesForDate(med, date, tz)) {
        const missed = (i === 2 || i === 4) && dose.time >= '20:00';
        if (missed || new Date(dose.scheduledAt).getTime() > cutoff) continue;
        await store.set('doseLogs', dose.id, {
          circleId: circle.id,
          medicationId: med.id,
          scheduledAt: dose.scheduledAt,
          date,
          status: 'taken',
          takenAt: dose.scheduledAt,
          takenById: members[0].id,
          takenByName: members[0].name,
        });
      }
    }
  }

  const appt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  appt.setUTCHours(5, 0, 0, 0); // 10:30 IST
  await store.set('appointments', newId(), {
    circleId: circle.id,
    doctor: 'Dr. Anand Rao',
    specialty: 'Diabetologist',
    datetime: appt.toISOString(),
    location: 'Apollo Clinic, Anna Nagar',
    notes: 'Bring last HbA1c report',
    createdBy: members[1].id,
    createdByName: members[1].name,
    createdAt: stamp,
  });

  return { ...DEMO, circleId: circle.id };
}
