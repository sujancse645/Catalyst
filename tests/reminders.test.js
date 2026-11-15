import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/lib/store.js';
import { createMailer } from '../server/lib/mailer.js';
import { createGeminiClient } from '../server/lib/gemini.js';
import { runReminders, runWeeklyDigest } from '../server/services/reminders.js';
import { seedDemo, DEMO } from '../server/seed.js';
import { dosesForDate } from '../server/services/schedule.js';

const TZ = 'Asia/Kolkata';

async function setup() {
  const store = createMemoryStore();
  const sent = [];
  const transport = { send: async (m) => sent.push(m) };
  const mailer = createMailer({ transport, store, from: 'SaathiCare <a@b.co>' });
  await store.set('circles', 'c1', { code: 'ABCDEF', elderName: 'Kamala', timezone: TZ, settings: {} });
  await store.set('members', 'e', { circleId: 'c1', name: 'Kamala', email: 'elder@x.com', role: 'elder' });
  await store.set('members', 'n', { circleId: 'c1', name: 'Meena', email: 'nurse@x.com', role: 'caretaker' });
  await store.set('members', 's', { circleId: 'c1', name: 'Ravi', email: 'son@x.com', role: 'family' });
  await store.set('medications', 'm1', {
    circleId: 'c1',
    name: 'Metformin',
    dosage: '500 mg',
    times: ['08:00'],
    status: 'active',
    startDate: '2026-11-01',
    endDate: null,
    pillsLeft: 40,
    createdAt: 't0',
  });
  return { store, sent, mailer };
}

const run = (ctx, iso) => runReminders({ store: ctx.store, mailer: ctx.mailer, appUrl: 'https://app', now: new Date(iso) });

describe('reminder engine', () => {
  test('escalates elder → caretaker → family, exactly once per stage', async () => {
    const ctx = await setup();
    // 08:00 IST = 02:30Z
    let s = await run(ctx, '2026-11-15T02:25:00Z');
    assert.equal(s.due, 1);
    assert.deepEqual(ctx.sent.at(-1).to, ['elder@x.com']);

    s = await run(ctx, '2026-11-15T02:28:00Z');
    assert.equal(s.due, 0, 'not sent twice');

    s = await run(ctx, '2026-11-15T03:05:00Z');
    assert.equal(s.missed, 1);
    assert.deepEqual(ctx.sent.at(-1).to.sort(), ['elder@x.com', 'nurse@x.com']);

    s = await run(ctx, '2026-11-15T04:35:00Z');
    assert.equal(s.escalated, 1);
    assert.deepEqual(ctx.sent.at(-1).to.sort(), ['nurse@x.com', 'son@x.com']);

    s = await run(ctx, '2026-11-15T04:40:00Z');
    assert.equal(s.missed + s.escalated + s.due, 0);

    const outbox = await ctx.store.find('outbox', { circleId: 'c1' });
    assert.equal(outbox.length, 3);
    assert.ok(outbox.every((o) => o.status === 'sent'));
  });

  test('no reminders once the dose is taken', async () => {
    const ctx = await setup();
    const med = await ctx.store.get('medications', 'm1');
    const [dose] = dosesForDate(med, '2026-11-15', TZ);
    await ctx.store.set('doseLogs', dose.id, { circleId: 'c1', medicationId: 'm1', date: '2026-11-15', status: 'taken' });
    const s = await run(ctx, '2026-11-15T03:05:00Z');
    assert.equal(s.missed, 0);
  });

  test('concurrent runs never double-send (atomic claim)', async () => {
    const ctx = await setup();
    await Promise.all([run(ctx, '2026-11-15T03:05:00Z'), run(ctx, '2026-11-15T03:05:00Z')]);
    assert.equal(ctx.sent.length, 1);
  });

  test('appointment reminders 24h and 2h before', async () => {
    const ctx = await setup();
    await ctx.store.set('appointments', 'a1', {
      circleId: 'c1',
      doctor: 'Dr. Rao',
      datetime: '2026-11-20T05:00:00.000Z',
      location: '<b>Clinic</b>',
    });
    let s = await run(ctx, '2026-11-19T08:00:00Z');
    assert.equal(s.appointment, 1);
    assert.equal(ctx.sent.at(-1).to.length, 3);
    assert.ok(!ctx.sent.at(-1).raw.includes('<b>Clinic</b>'), 'user data is escaped in HTML email');
    s = await run(ctx, '2026-11-20T03:30:00Z');
    assert.equal(s.appointment, 1);
    s = await run(ctx, '2026-11-20T04:00:00Z');
    assert.equal(s.appointment, 0);
  });

  test('low stock alert once per refill', async () => {
    const ctx = await setup();
    await ctx.store.update('medications', 'm1', { pillsLeft: 2 });
    let s = await run(ctx, '2026-11-15T10:00:00Z');
    assert.equal(s.refill, 1);
    s = await run(ctx, '2026-11-15T10:05:00Z');
    assert.equal(s.refill, 0);
    await ctx.store.update('medications', 'm1', { pillsLeft: 1, refilledAt: 'later' });
    s = await run(ctx, '2026-11-15T10:10:00Z');
    assert.equal(s.refill, 1);
  });

  test('failed SMTP is recorded, not thrown', async () => {
    const store = createMemoryStore();
    const mailer = createMailer({ transport: { send: async () => { throw new Error('auth failed'); } }, store, from: 'x@y.co' });
    const res = await mailer.send({ circleId: 'c', kind: 'k', to: ['a@b.co'], subject: 'S', text: 'T' });
    assert.equal(res.status, 'failed');
    const [rec] = await store.find('outbox');
    assert.match(rec.error, /auth failed/);
  });

  test('weekly digest goes to everyone once per week, with rules fallback', async () => {
    const ctx = await setup();
    const ai = createGeminiClient({ apiKey: '' });
    const a = await runWeeklyDigest({ ...ctx, ai, appUrl: 'https://app', now: new Date('2026-11-15T03:30:00Z') });
    assert.equal(a.sent, 1);
    const b = await runWeeklyDigest({ ...ctx, ai, appUrl: 'https://app', now: new Date('2026-11-15T04:30:00Z') });
    assert.equal(b.sent, 0);
    assert.equal(ctx.sent.at(-1).to.length, 3);
  });
});

describe('demo seed', () => {
  test('creates a ready-to-explore circle once', async () => {
    const store = createMemoryStore();
    const demo = await seedDemo(store, new Date('2026-11-15T10:00:00Z'));
    assert.equal(demo.code, DEMO.code);
    assert.equal(await seedDemo(store), null, 'idempotent');
    assert.equal((await store.find('members', { circleId: demo.circleId })).length, 3);
    assert.equal((await store.find('medications', { circleId: demo.circleId, status: 'pending' })).length, 1);
    assert.ok((await store.find('doseLogs', { circleId: demo.circleId })).length > 10);
  });
});
