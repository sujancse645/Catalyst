/**
 * Circle members, settings, audit trail and email log.
 */
import { v, parse } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit, listMembers, newest, publicCircle, publicMember } from '../services/care.js';

const limitOf = (query, max = 100) => Math.min(Math.max(Number(query.get('limit')) || 50, 1), max);

export const circleRoutes = [
  {
    method: 'GET',
    path: '/api/circle',
    auth: true,
    async handler(ctx, r) {
      const members = await listMembers(ctx.store, r.circle.id);
      return {
        body: {
          circle: publicCircle(r.circle),
          members: members.map(publicMember).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)),
          emailMode: ctx.mailer.mode,
          aiAvailable: ctx.ai.available,
        },
      };
    },
  },
  {
    method: 'PATCH',
    path: '/api/circle/settings',
    auth: true,
    roles: ['elder'],
    async handler(ctx, r) {
      const input = parse(v.object({ requireElderApproval: v.boolean() }), r.body);
      const circle = await ctx.store.update('circles', r.circle.id, { settings: { ...r.circle.settings, ...input } });
      await audit(
        ctx.store,
        circle.id,
        r.member,
        'circle.settings',
        `Approval of changes ${input.requireElderApproval ? 'required' : 'not required'}`,
      );
      return { body: { circle: publicCircle(circle) } };
    },
  },
  {
    method: 'DELETE',
    path: '/api/members/:id',
    auth: true,
    roles: ['elder'],
    async handler(ctx, r) {
      const target = await ctx.store.get('members', r.params.id);
      if (!target || target.circleId !== r.circle.id) throw notFound('Member not found');
      if (target.id === r.member.id) throw badRequest('You cannot remove yourself');
      // Sessions are re-checked against the members collection on every request,
      // so deleting the record revokes that person's access immediately.
      await ctx.store.delete('members', target.id);
      await audit(ctx.store, r.circle.id, r.member, 'member.removed', `${target.name} removed`);
      return { body: { ok: true } };
    },
  },
  {
    method: 'GET',
    path: '/api/audit',
    auth: true,
    async handler(ctx, r) {
      const items = await ctx.store.find('audit', { circleId: r.circle.id });
      return { body: { items: newest(items, 'at', limitOf(r.query)) } };
    },
  },
  {
    method: 'GET',
    path: '/api/outbox',
    auth: true,
    async handler(ctx, r) {
      const items = await ctx.store.find('outbox', { circleId: r.circle.id });
      return {
        body: {
          mode: ctx.mailer.mode,
          items: newest(items, 'createdAt', limitOf(r.query)).map(({ circleId: _c, ...rest }) => rest),
        },
      };
    },
  },
];
