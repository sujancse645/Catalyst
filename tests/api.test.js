import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { client, createCircleBody, startTestServer } from './helpers.js';
import { dosesForDate } from '../server/services/schedule.js';
import { zonedParts } from '../server/services/time.js';

describe('API: circles, roles and elder approval', () => {
  let srv;
  let elder;
  let son;
  let code;

  before(async () => {
    srv = await startTestServer();
    elder = client(srv.base);
    son = client(srv.base);
    const res = await elder.req('/api/circles', { method: 'POST', body: createCircleBody() });
    assert.equal(res.status, 201);
    code = res.body.circle.code;
    assert.match(code, /^[A-Z0-9]{6}$/);
    assert.equal(res.body.circle.passcodeHash, undefined, 'hash never leaves the server');
  });
  after(() => srv.close());

  test('health endpoint and security headers', async () => {
    const res = await client(srv.base).req('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('x-request-id'));
  });

  test('session cookie is HttpOnly and SameSite=Strict', async () => {
    const c = client(srv.base);
    const res = await c.req('/api/session', {
      method: 'POST',
      body: { circleCode: code, passcode: '482913', name: 'Guest', email: 'guest@example.com', role: 'family' },
    });
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('signed-out session check returns nulls, not an error', async () => {
    const res = await client(srv.base).req('/api/session');
    assert.equal(res.status, 200);
    assert.equal(res.body.member, null);
  });

  test('protected endpoints need a session', async () => {
    const res = await client(srv.base).req('/api/medications');
    assert.equal(res.status, 401);
  });

  test('mutations without the CSRF header are refused', async () => {
    const res = await elder.req('/api/medications', { method: 'POST', body: {}, csrf: false });
    assert.equal(res.status, 403);
  });

  test('a second elder cannot join', async () => {
    const res = await client(srv.base).req('/api/session', {
      method: 'POST',
      body: { circleCode: code, passcode: '482913', name: 'Other', email: 'other@example.com', role: 'elder' },
    });
    assert.equal(res.status, 400);
  });

  test('family joins with the passcode; rejoining keeps the original role', async () => {
    const res = await son.req('/api/session', {
      method: 'POST',
      body: { circleCode: code.toLowerCase(), passcode: '482913', name: 'Ravi', email: 'RAVI@example.com', role: 'family' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.member.role, 'family');
    const again = await client(srv.base).req('/api/session', {
      method: 'POST',
      body: { circleCode: code, passcode: '482913', name: 'Ravi', email: 'ravi@example.com', role: 'caretaker' },
    });
    assert.equal(again.body.member.role, 'family', 'role cannot be escalated by rejoining');
  });

  test('validation errors name the field', async () => {
    const res = await elder.req('/api/medications', { method: 'POST', body: { name: 'X', dosage: '1', times: ['25:00'] } });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /times\[0\]/);
    const bad = await elder.req('/api/medications', {
      method: 'POST',
      body: { name: 'X', dosage: '1', times: ['08:00'], startDate: '2026-11-10', endDate: '2026-11-01' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.details.field, 'endDate');
  });

  test('invalid JSON and oversized bodies are handled', async () => {
    const res = await fetch(`${srv.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SaathiCare' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const big = await fetch(`${srv.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SaathiCare' },
      body: JSON.stringify({ x: 'a'.repeat(100_000) }),
    });
    assert.equal(big.status, 413);
  });

  test('elder adds a medicine directly; family changes wait for approval', async () => {
    const add = await elder.req('/api/medications', {
      method: 'POST',
      body: { name: 'Metformin', dosage: '500 mg', times: ['20:00', '08:00'], pillsLeft: 20 },
    });
    assert.equal(add.status, 201);
    assert.equal(add.body.item.status, 'active');
    assert.deepEqual(add.body.item.times, ['08:00', '20:00']);
    const medId = add.body.item.id;

    const proposed = await son.req('/api/medications', {
      method: 'POST',
      body: { name: 'Vitamin D3', dosage: '1000 IU', times: ['13:00'] },
    });
    assert.equal(proposed.body.pendingApproval, true);
    assert.equal(proposed.body.item.status, 'pending');

    const change = await son.req(`/api/medications/${medId}`, { method: 'PATCH', body: { times: ['09:00'] } });
    assert.equal(change.body.pendingApproval, true);
    assert.deepEqual(change.body.item.times, ['08:00', '20:00'], 'unchanged until approved');

    const sonReview = await son.req(`/api/medications/${medId}/review`, { method: 'POST', body: { decision: 'approve' } });
    assert.equal(sonReview.status, 403, 'only the elder can approve');

    const approved = await elder.req(`/api/medications/${medId}/review`, { method: 'POST', body: { decision: 'approve' } });
    assert.deepEqual(approved.body.item.times, ['09:00']);
    assert.equal(approved.body.item.proposal, null);

    const rejected = await elder.req(`/api/medications/${proposed.body.item.id}/review`, {
      method: 'POST',
      body: { decision: 'reject' },
    });
    assert.equal(rejected.body.item.status, 'rejected');
    const list = await son.req('/api/medications');
    assert.equal(list.body.items.some((m) => m.name === 'Vitamin D3'), false);

    const removal = await son.req(`/api/medications/${medId}`, { method: 'DELETE' });
    assert.equal(removal.body.pendingApproval, true);
    const keep = await elder.req(`/api/medications/${medId}/review`, { method: 'POST', body: { decision: 'reject' } });
    assert.equal(keep.body.item.status, 'active');
  });

  test('elder can turn approval off; then family edits apply immediately', async () => {
    const off = await son.req('/api/circle/settings', { method: 'PATCH', body: { requireElderApproval: false } });
    assert.equal(off.status, 403);
    await elder.req('/api/circle/settings', { method: 'PATCH', body: { requireElderApproval: false } });
    const add = await son.req('/api/medications', { method: 'POST', body: { name: 'Aspirin', dosage: '75 mg', times: ['10:00'] } });
    assert.equal(add.body.item.status, 'active');
    await son.req(`/api/medications/${add.body.item.id}`, { method: 'DELETE' });
    await elder.req('/api/circle/settings', { method: 'PATCH', body: { requireElderApproval: true } });
  });

  test('dose check-in updates stock, is idempotent and can be undone', async () => {
    // A medicine scheduled 10 minutes ago, so the dose is "due" right now.
    const ten = zonedParts(new Date(Date.now() - 10 * 60_000), 'Asia/Kolkata');
    const add = await elder.req('/api/medications', {
      method: 'POST',
      body: { name: 'Paracetamol', dosage: '500 mg', times: [ten.time], startDate: ten.date, pillsLeft: 20 },
    });
    const med = add.body.item;
    const [dose] = dosesForDate({ ...med, status: 'active' }, ten.date, 'Asia/Kolkata');

    const today = await elder.req('/api/today');
    assert.equal(today.body.doses.find((d) => d.id === dose.id)?.status, 'due');

    const first = await son.req('/api/doses', { method: 'POST', body: { medicationId: med.id, scheduledAt: dose.scheduledAt } });
    assert.equal(first.status, 200);
    assert.equal(first.body.log.takenByName, 'Ravi');
    await son.req('/api/doses', { method: 'POST', body: { medicationId: med.id, scheduledAt: dose.scheduledAt } });
    let updated = (await elder.req('/api/medications')).body.items.find((m) => m.id === med.id);
    assert.equal(updated.pillsLeft, 19, 'second check-in does not double-count');

    const undo = await elder.req(`/api/doses/${encodeURIComponent(first.body.log.id)}`, { method: 'DELETE' });
    assert.equal(undo.status, 200);
    updated = (await elder.req('/api/medications')).body.items.find((m) => m.id === med.id);
    assert.equal(updated.pillsLeft, 20);

    const voice = await elder.req('/api/doses/voice', { method: 'POST', body: { transcript: 'I took my paracetamol' } });
    assert.equal(voice.body.matched, true);

    const early = new Date(Date.now() + 5 * 3600_000);
    const later = zonedParts(early, 'Asia/Kolkata');
    const future = await elder.req('/api/medications', {
      method: 'POST',
      body: { name: 'Later pill', dosage: '1', times: [later.time], startDate: ten.date },
    });
    const [futureDose] = dosesForDate({ ...future.body.item, status: 'active' }, later.date, 'Asia/Kolkata');
    if (later.date === ten.date) {
      const notYet = await elder.req('/api/doses/voice', { method: 'POST', body: { transcript: 'took the later pill' } });
      assert.match(notYet.body.message, /not due yet/);
    }
    const tooEarly = await elder.req('/api/doses', {
      method: 'POST',
      body: { medicationId: future.body.item.id, scheduledAt: futureDose.scheduledAt },
    });
    assert.equal(tooEarly.status, 400);
  });

  test('doses that are not on the schedule are rejected', async () => {
    const meds = (await elder.req('/api/medications')).body.items;
    const res = await elder.req('/api/doses', {
      method: 'POST',
      body: { medicationId: meds[0].id, scheduledAt: '2026-01-01T03:17:00.000Z' },
    });
    assert.equal(res.status, 400);
  });

  test('today view returns doses, adherence and counts', async () => {
    const res = await elder.req('/api/today');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.doses));
    assert.equal(res.body.adherence.days, 7);
    const bad = await elder.req('/api/today?date=2020-01-01');
    assert.equal(bad.status, 400);
  });

  test('voice check-in explains when nothing matches', async () => {
    const res = await elder.req('/api/doses/voice', { method: 'POST', body: { transcript: 'I took paracetamol' } });
    assert.equal(res.body.matched, false);
  });

  test('appointments CRUD with tenant isolation', async () => {
    const when = new Date(Date.now() + 3 * 86400_000).toISOString();
    const add = await son.req('/api/appointments', { method: 'POST', body: { doctor: 'Dr. Rao', datetime: when, location: 'Clinic' } });
    assert.equal(add.status, 201);
    const id = add.body.item.id;
    const patch = await elder.req(`/api/appointments/${id}`, { method: 'PATCH', body: { notes: 'Bring reports' } });
    assert.equal(patch.body.item.notes, 'Bring reports');
    const list = await elder.req('/api/appointments');
    assert.equal(list.body.upcoming[0].doctor, 'Dr. Rao');

    // A different circle cannot see or touch it.
    const stranger = client(srv.base);
    await stranger.req('/api/circles', { method: 'POST', body: createCircleBody({ email: 's@example.com', passcode: '908172' }) });
    assert.equal((await stranger.req(`/api/appointments/${id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await stranger.req('/api/appointments')).body.upcoming.length, 0);

    assert.equal((await son.req(`/api/appointments/${id}`, { method: 'DELETE' })).status, 200);
  });

  test('AI endpoints degrade gracefully when Gemini is not configured', async () => {
    const digest = await son.req('/api/ai/digest');
    assert.equal(digest.status, 200);
    assert.equal(digest.body.source, 'rules');
    const explain = await son.req('/api/ai/explain', { method: 'POST', body: { name: 'Metformin' } });
    assert.equal(explain.status, 503);
  });

  test('audit trail and outbox are scoped to the circle', async () => {
    const audit = await elder.req('/api/audit?limit=5');
    assert.equal(audit.body.items.length, 5);
    assert.ok(audit.body.items.every((a) => a.at));
    const outbox = await elder.req('/api/outbox');
    assert.equal(outbox.body.mode, 'demo');
  });

  test('elder removes a member and their session stops working', async () => {
    const circle = await elder.req('/api/circle');
    const ravi = circle.body.members.find((m) => m.name === 'Ravi');
    assert.equal((await son.req(`/api/members/${ravi.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await elder.req(`/api/members/${ravi.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await son.req('/api/medications')).status, 401);
  });

  test('passcode rotation signs out other devices', async () => {
    const nurse = client(srv.base);
    await nurse.req('/api/session', {
      method: 'POST',
      body: { circleCode: code, passcode: '482913', name: 'Meena', email: 'meena@example.com', role: 'caretaker' },
    });
    const wrong = await elder.req('/api/circle/passcode', { method: 'POST', body: { currentPasscode: '000000', newPasscode: '135792' } });
    assert.equal(wrong.status, 400);
    const ok = await elder.req('/api/circle/passcode', { method: 'POST', body: { currentPasscode: '482913', newPasscode: '135792' } });
    assert.equal(ok.status, 200);
    assert.equal((await nurse.req('/api/medications')).status, 401);
    assert.equal((await elder.req('/api/medications')).status, 200, 'the elder stays signed in');
  });

  test('cron endpoints require the secret', async () => {
    const c = client(srv.base);
    assert.equal((await c.req('/api/cron/reminders', { method: 'POST' })).status, 401);
    assert.equal((await c.req('/api/cron/reminders', { method: 'POST', headers: { 'x-cron-secret': 'nope' } })).status, 401);
    const ok = await c.req('/api/cron/reminders', { method: 'POST', headers: { 'x-cron-secret': 'test-cron-secret' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.circles >= 1);
  });

  test('unknown routes and methods', async () => {
    const c = client(srv.base);
    assert.equal((await c.req('/api/nope')).status, 404);
    assert.equal((await c.req('/api/health', { method: 'DELETE' })).status, 405);
  });

  test('sign out clears the cookie', async () => {
    const res = await elder.req('/api/session', { method: 'DELETE' });
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  });
});

describe('API: brute-force protection', () => {
  test('wrong passcode is rejected with a generic message, then rate-limited', async () => {
    const own = await startTestServer();
    const c = client(own.base);
    const created = await c.req('/api/circles', { method: 'POST', body: createCircleBody() });
    const body = { circleCode: created.body.circle.code, passcode: '000001', name: 'X', email: 'x@example.com', role: 'family' };
    const first = await c.req('/api/session', { method: 'POST', body });
    assert.equal(first.status, 401);
    assert.match(first.body.error.message, /incorrect/);
    const unknown = await c.req('/api/session', { method: 'POST', body: { ...body, circleCode: 'ZZZZZZ' } });
    assert.equal(unknown.body.error.message, first.body.error.message, 'no circle enumeration');
    for (let i = 0; i < 4; i += 1) await c.req('/api/session', { method: 'POST', body });
    const blocked = await c.req('/api/session', { method: 'POST', body });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    await own.close();
  });

});

describe('static files', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(() => srv.close());

  test('serves index with gzip + ETag and supports 304', async () => {
    const res = await fetch(`${srv.base}/`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const etag = res.headers.get('etag');
    const again = await fetch(`${srv.base}/`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
  });

  test('SPA fallback for routes, 404 for missing files, no traversal', async () => {
    assert.equal((await fetch(`${srv.base}/some/route`)).status, 200);
    assert.equal((await fetch(`${srv.base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${srv.base}/..%2f..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${srv.base}/`, { method: 'POST' })).status, 405);
  });
});
