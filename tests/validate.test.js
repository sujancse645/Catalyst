import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v, parse, partial } from '../server/lib/validate.js';

const rejects = (fn, re) => assert.throws(fn, (err) => err.status === 400 && (!re || re.test(err.message)));

test('object strips unknown keys (no mass assignment)', () => {
  const out = parse(v.object({ name: v.string() }), { name: ' Asha ', role: 'elder', __proto__: { x: 1 } });
  assert.deepEqual(out, { name: 'Asha' });
});

test('string length and required', () => {
  rejects(() => parse(v.object({ n: v.string() }), { n: '   ' }), /required/);
  rejects(() => parse(v.object({ n: v.string({ max: 3 }) }), { n: 'abcd' }), /at most 3/);
  rejects(() => parse(v.object({ n: v.string() }), { n: 5 }), /text/);
});

test('email normalises case and rejects junk', () => {
  assert.equal(v.email()('Ravi@Example.COM', 'e'), 'ravi@example.com');
  rejects(() => v.email()('not-an-email', 'e'));
  rejects(() => v.email()('a@b', 'e'));
  rejects(() => v.email()('a\r\nBcc:x@y.com', 'e'));
});

test('date rejects impossible calendar dates', () => {
  assert.equal(v.date()('2026-02-28', 'd'), '2026-02-28');
  rejects(() => v.date()('2026-02-30', 'd'), /real date/);
  rejects(() => v.date()('28-02-2026', 'd'));
});

test('time is 24h HH:MM', () => {
  assert.equal(v.time()('08:30', 't'), '08:30');
  rejects(() => v.time()('24:00', 't'));
  rejects(() => v.time()('8:30', 't'));
});

test('datetime normalises to ISO', () => {
  assert.equal(v.datetime()('2026-11-20T10:00:00+05:30', 'd'), '2026-11-20T04:30:00.000Z');
  rejects(() => v.datetime()('tomorrow', 'd'));
});

test('array bounds and uniqueness', () => {
  const times = v.array(v.time(), { min: 1, max: 2, unique: true });
  assert.deepEqual(times(['08:00', '20:00'], 't'), ['08:00', '20:00']);
  rejects(() => times([], 't'), /at least 1/);
  rejects(() => times(['08:00', '08:00'], 't'), /duplicates/);
  rejects(() => times(['08:00', '09:00', '10:00'], 't'), /at most 2/);
  rejects(() => times('08:00', 't'), /list/);
});

test('integer, boolean, enum, optional, nullable', () => {
  assert.equal(v.integer({ min: 0 })('12', 'n'), 12);
  rejects(() => v.integer({ min: 0 })(-1, 'n'));
  rejects(() => v.integer()(1.5, 'n'));
  rejects(() => v.boolean()('true', 'b'));
  rejects(() => v.enum(['a'])('b', 'e'), /one of/);
  assert.equal(v.optional(v.string(), 'x')('', 'o'), 'x');
  assert.equal(v.nullable(v.date())(null, 'n'), null);
});

test('partial requires at least one field and validates present ones', () => {
  const schema = partial({ name: v.string(), times: v.array(v.time(), { min: 1 }) });
  assert.deepEqual(parse(schema, { name: 'X' }), { name: 'X' });
  rejects(() => parse(schema, {}), /at least one field/);
  rejects(() => parse(schema, { times: [] }));
});
