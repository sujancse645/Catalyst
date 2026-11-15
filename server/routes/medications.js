/**
 * Medication management with elder-approval workflow.
 * Changes by caretakers/family become *proposals* the elder approves or rejects,
 * keeping the elder at the centre of their own healthcare decisions.
 */
import { v, parse, partial } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/security.js';
import { audit, listMembers, needsElderApproval } from '../services/care.js';
import { stockStatus } from '../services/schedule.js';
import { todayIn } from '../services/time.js';

const fields = {
  name: v.string({ max: 80 }),
  dosage: v.string({ max: 60 }),
  instructions: v.optional(v.string({ min: 0, max: 200 }), ''),
  times: v.array(v.time(), { min: 1, max: 8, unique: true }),
  startDate: v.date(),
  endDate: v.nullable(v.date()),
  pillsLeft: v.nullable(v.integer({ min: 0, max: 10_000 })),
};

const createSchema = v.object({
  ...fields,
  startDate: v.optional(v.date()),
  endDate: v.optional(v.nullable(v.date()), null),
  pillsLeft: v.optional(v.nullable(v.integer({ min: 0, max: 10_000 })), null),
});
const patchSchema = partial(fields);

function checkDates(med) {
  if (med.endDate && med.startDate && med.endDate < med.startDate) {
    throw badRequest('endDate must be on or after startDate', { field: 'endDate' });
  }
}

// Doses scheduled up to an hour before a medicine goes live can still be checked off.
const activeFromNow = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

const view = (m) => ({
  id: m.id,
  name: m.name,
  dosage: m.dosage,
  instructions: m.instructions || '',
  times: m.times,
  startDate: m.startDate,
  endDate: m.endDate,
  pillsLeft: m.pillsLeft,
  status: m.status,
  stock: stockStatus(m),
  proposal: m.proposal || null,
  createdByName: m.createdByName,
  updatedAt: m.updatedAt,
});

async function loadMed(ctx, r) {
  const med = await ctx.store.get('medications', r.params.id);
  if (!med || med.circleId !== r.circle.id || med.status === 'rejected') throw notFound('Medication not found');
  return med;
}

async function approvalNeeded(ctx, r) {
  return needsElderApproval(r.circle, r.member, await listMembers(ctx.store, r.circle.id));
}

const describe = (changes) =>
  Object.entries(changes)
    .map(([k, val]) => `${k}: ${Array.isArray(val) ? val.join(', ') : val}`)
    .join('; ');

export const medicationRoutes = [
  {
    method: 'GET',
    path: '/api/medications',
    auth: true,
    async handler(ctx, r) {
      const meds = await ctx.store.find('medications', { circleId: r.circle.id });
      const order = { pending: 0, active: 1 };
      const items = meds
        .filter((m) => m.status !== 'rejected')
        .sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || a.name.localeCompare(b.name))
        .map(view);
      return { body: { items } };
    },
  },
  {
    method: 'POST',
    path: '/api/medications',
    auth: true,
    async handler(ctx, r) {
      const input = parse(createSchema, r.body);
      input.startDate ||= todayIn(r.circle.timezone);
      input.times = [...input.times].sort();
      checkDates(input);
      const pending = await approvalNeeded(ctx, r);
      const now = new Date().toISOString();
      const med = await ctx.store.set('medications', newId(), {
        ...input,
        circleId: r.circle.id,
        status: pending ? 'pending' : 'active',
        activeFrom: pending ? null : activeFromNow(),
        createdBy: r.member.id,
        createdByName: r.member.name,
        createdAt: now,
        updatedAt: now,
      });
      await audit(
        ctx.store,
        r.circle.id,
        r.member,
        pending ? 'medication.proposed' : 'medication.added',
        `${med.name} ${med.dosage} at ${med.times.join(', ')}`,
      );
      return { status: 201, body: { item: view(med), pendingApproval: pending } };
    },
  },
  {
    method: 'PATCH',
    path: '/api/medications/:id',
    auth: true,
    async handler(ctx, r) {
      const med = await loadMed(ctx, r);
      const changes = parse(patchSchema, r.body);
      if (changes.times) changes.times = [...changes.times].sort();
      checkDates({ ...med, ...changes });
      const now = new Date().toISOString();

      if (med.status === 'active' && (await approvalNeeded(ctx, r))) {
        const updated = await ctx.store.update('medications', med.id, {
          proposal: { type: 'update', changes, byId: r.member.id, byName: r.member.name, at: now },
          updatedAt: now,
        });
        await audit(ctx.store, r.circle.id, r.member, 'medication.change_proposed', `${med.name}: ${describe(changes)}`);
        return { body: { item: view(updated), pendingApproval: true } };
      }
      const updated = await ctx.store.update('medications', med.id, {
        ...changes,
        ...(changes.pillsLeft !== undefined ? { refilledAt: now } : {}),
        updatedAt: now,
      });
      await audit(ctx.store, r.circle.id, r.member, 'medication.updated', `${med.name}: ${describe(changes)}`);
      return { body: { item: view(updated), pendingApproval: false } };
    },
  },
  {
    method: 'DELETE',
    path: '/api/medications/:id',
    auth: true,
    async handler(ctx, r) {
      const med = await loadMed(ctx, r);
      const now = new Date().toISOString();
      if (med.status === 'active' && (await approvalNeeded(ctx, r))) {
        const updated = await ctx.store.update('medications', med.id, {
          proposal: { type: 'delete', byId: r.member.id, byName: r.member.name, at: now },
          updatedAt: now,
        });
        await audit(ctx.store, r.circle.id, r.member, 'medication.removal_proposed', med.name);
        return { body: { item: view(updated), pendingApproval: true } };
      }
      await ctx.store.delete('medications', med.id);
      await audit(ctx.store, r.circle.id, r.member, 'medication.removed', med.name);
      return { body: { ok: true, pendingApproval: false } };
    },
  },
  {
    method: 'POST',
    path: '/api/medications/:id/review',
    auth: true,
    roles: ['elder'],
    async handler(ctx, r) {
      const { decision } = parse(v.object({ decision: v.enum(['approve', 'reject']) }), r.body);
      const med = await loadMed(ctx, r);
      const now = new Date().toISOString();
      const approve = decision === 'approve';

      if (med.status === 'pending') {
        const updated = await ctx.store.update('medications', med.id, {
          status: approve ? 'active' : 'rejected',
          activeFrom: approve ? activeFromNow() : null,
          reviewedAt: now,
          updatedAt: now,
        });
        await audit(ctx.store, r.circle.id, r.member, `medication.${approve ? 'approved' : 'rejected'}`, med.name);
        return { body: { item: view(updated) } };
      }
      if (!med.proposal) throw badRequest('There is nothing to review for this medication');

      const { proposal } = med;
      if (proposal.type === 'delete' && approve) {
        await ctx.store.delete('medications', med.id);
        await audit(ctx.store, r.circle.id, r.member, 'medication.removal_approved', med.name);
        return { body: { ok: true, removed: true } };
      }
      const patch = approve && proposal.type === 'update' ? { ...proposal.changes } : {};
      if (patch.pillsLeft !== undefined) patch.refilledAt = now;
      const updated = await ctx.store.set('medications', med.id, {
        ...med,
        ...patch,
        proposal: null,
        updatedAt: now,
      });
      await audit(
        ctx.store,
        r.circle.id,
        r.member,
        `medication.change_${approve ? 'approved' : 'rejected'}`,
        `${med.name} (proposed by ${proposal.byName})`,
      );
      return { body: { item: view(updated) } };
    },
  },
  {
    method: 'POST',
    path: '/api/medications/:id/refill',
    auth: true,
    async handler(ctx, r) {
      const { pillsLeft } = parse(v.object({ pillsLeft: v.integer({ min: 0, max: 10_000 }) }), r.body);
      const med = await loadMed(ctx, r);
      if (med.status !== 'active') throw forbidden('Only active medicines can be refilled');
      const now = new Date().toISOString();
      const updated = await ctx.store.update('medications', med.id, { pillsLeft, refilledAt: now, updatedAt: now });
      await audit(ctx.store, r.circle.id, r.member, 'medication.refilled', `${med.name}: ${pillsLeft} doses`);
      return { body: { item: view(updated) } };
    },
  },
];
