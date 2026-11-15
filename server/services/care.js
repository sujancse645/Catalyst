/**
 * Shared domain helpers: membership, permissions, audit trail.
 */
import { newId } from '../lib/security.js';
import { todayIn, addDays } from './time.js';
import { buildDayView } from './schedule.js';

export const ROLES = Object.freeze(['elder', 'caretaker', 'family']);

export const publicMember = (m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joinedAt: m.joinedAt });

export const publicCircle = (c) => ({
  id: c.id,
  code: c.code,
  elderName: c.elderName,
  timezone: c.timezone,
  settings: c.settings,
  createdAt: c.createdAt,
});

export const listMembers = (store, circleId) => store.find('members', { circleId });

/**
 * Elder-centred rule: when the circle has an elder member and approval is on,
 * medication changes made by anyone else wait for the elder's decision.
 */
export function needsElderApproval(circle, actor, members) {
  if (actor.role === 'elder') return false;
  if (!circle.settings?.requireElderApproval) return false;
  return members.some((m) => m.role === 'elder');
}

export async function audit(store, circleId, actor, action, detail = '') {
  const at = new Date().toISOString();
  await store.set('audit', newId(), {
    circleId,
    actorId: actor?.id || 'system',
    actorName: actor?.name || 'SaathiCare',
    actorRole: actor?.role || 'system',
    action,
    detail: String(detail).slice(0, 300),
    at,
  });
}

/** Newest-first, limited. */
export const newest = (items, field, limit) =>
  [...items].sort((a, b) => String(b[field]).localeCompare(String(a[field]))).slice(0, limit);

export const emailsFor = (members, roles) => members.filter((m) => roles.includes(m.role)).map((m) => m.email);

/** Dose-by-dose view for each of the last `days` local days. */
export function recentDoses(meds, logs, tz, now, days = 7) {
  const today = todayIn(tz, now);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(...buildDayView(meds, logs, addDays(today, -i), tz, now));
  return out;
}

/** Active meds + recent dose logs (last `days`) for a circle. */
export async function loadCareData(store, circle, now, days = 8) {
  const [meds, logs] = await Promise.all([
    store.find('medications', { circleId: circle.id }),
    store.find('doseLogs', { circleId: circle.id }),
  ]);
  const since = addDays(todayIn(circle.timezone, now), -days);
  return {
    allMeds: meds,
    meds: meds.filter((m) => m.status === 'active'),
    logs: logs.filter((l) => l.date >= since),
  };
}
