/**
 * Doctor appointments. Any circle member can manage them; every change is audited.
 */
import { v, parse, partial } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { newId } from '../lib/security.js';
import { audit } from '../services/care.js';

const fields = {
  doctor: v.string({ max: 80 }),
  specialty: v.optional(v.string({ min: 0, max: 60 }), ''),
  datetime: v.datetime(),
  location: v.optional(v.string({ min: 0, max: 160 }), ''),
  notes: v.optional(v.string({ min: 0, max: 500 }), ''),
};

const view = (a) => ({
  id: a.id,
  doctor: a.doctor,
  specialty: a.specialty,
  datetime: a.datetime,
  location: a.location,
  notes: a.notes,
  createdByName: a.createdByName,
});

async function load(ctx, r) {
  const appt = await ctx.store.get('appointments', r.params.id);
  if (!appt || appt.circleId !== r.circle.id) throw notFound('Appointment not found');
  return appt;
}

export const appointmentRoutes = [
  {
    method: 'GET',
    path: '/api/appointments',
    auth: true,
    async handler(ctx, r) {
      const now = new Date().toISOString();
      const all = (await ctx.store.find('appointments', { circleId: r.circle.id })).map(view);
      return {
        body: {
          upcoming: all.filter((a) => a.datetime >= now).sort((a, b) => a.datetime.localeCompare(b.datetime)),
          past: all
            .filter((a) => a.datetime < now)
            .sort((a, b) => b.datetime.localeCompare(a.datetime))
            .slice(0, 20),
        },
      };
    },
  },
  {
    method: 'POST',
    path: '/api/appointments',
    auth: true,
    async handler(ctx, r) {
      const input = parse(v.object(fields), r.body);
      const appt = await ctx.store.set('appointments', newId(), {
        ...input,
        circleId: r.circle.id,
        createdBy: r.member.id,
        createdByName: r.member.name,
        createdAt: new Date().toISOString(),
      });
      await audit(ctx.store, r.circle.id, r.member, 'appointment.added', `${appt.doctor} on ${appt.datetime}`);
      return { status: 201, body: { item: view(appt) } };
    },
  },
  {
    method: 'PATCH',
    path: '/api/appointments/:id',
    auth: true,
    async handler(ctx, r) {
      const appt = await load(ctx, r);
      const changes = parse(partial(fields), r.body);
      const updated = await ctx.store.update('appointments', appt.id, changes);
      await audit(ctx.store, r.circle.id, r.member, 'appointment.updated', updated.doctor);
      return { body: { item: view(updated) } };
    },
  },
  {
    method: 'DELETE',
    path: '/api/appointments/:id',
    auth: true,
    async handler(ctx, r) {
      const appt = await load(ctx, r);
      await ctx.store.delete('appointments', appt.id);
      await audit(ctx.store, r.circle.id, r.member, 'appointment.removed', appt.doctor);
      return { body: { ok: true } };
    },
  },
];
