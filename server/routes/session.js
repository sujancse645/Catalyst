/**
 * Care circles + passcode-based access.
 */
import { v, parse } from '../lib/validate.js';
import { badRequest, forbidden, tooMany, unauthorized } from '../lib/errors.js';
import { hashSecret, newId, randomCode, verifySecret } from '../lib/security.js';
import { isValidTimeZone } from '../services/time.js';
import { ROLES, audit, publicCircle, publicMember } from '../services/care.js';

const passcode = v.string({ min: 6, max: 6, pattern: /^\d{6}$/ });
const WEAK = new Set(['000000', '111111', '123456', '654321', '121212', '112233']);

const createSchema = v.object({
  elderName: v.string({ max: 60 }),
  yourName: v.string({ max: 60 }),
  email: v.email(),
  role: v.enum(ROLES),
  passcode,
  timezone: v.optional(v.string({ max: 60 }), 'Asia/Kolkata'),
});

const joinSchema = v.object({
  circleCode: v.string({ min: 6, max: 6, pattern: /^[A-Za-z0-9]{6}$/ }),
  passcode,
  name: v.string({ max: 60 }),
  email: v.email(),
  role: v.enum(ROLES),
});

const rotateSchema = v.object({ currentPasscode: passcode, newPasscode: passcode });

export const sessionRoutes = [
  {
    method: 'POST',
    path: '/api/circles',
    auth: false,
    async handler(ctx, r) {
      const limit = ctx.limits.create.hit(r.ip);
      if (!limit.allowed) throw tooMany(limit.retryAfter);
      const input = parse(createSchema, r.body);
      if (!isValidTimeZone(input.timezone)) throw badRequest('timezone is not recognised');
      if (WEAK.has(input.passcode) && ctx.config.isProd) throw badRequest('Please choose a less guessable passcode');

      let code = randomCode(6);
      while (await ctx.store.find('circles', { code }).then((x) => x.length > 0)) code = randomCode(6);

      const now = new Date().toISOString();
      const circle = await ctx.store.set('circles', newId(), {
        code,
        elderName: input.elderName,
        timezone: input.timezone,
        passcodeHash: await hashSecret(input.passcode),
        tokenVersion: 1,
        settings: { requireElderApproval: true },
        createdAt: now,
      });
      const member = await ctx.store.set('members', newId(), {
        circleId: circle.id,
        name: input.yourName,
        email: input.email,
        role: input.role,
        joinedAt: now,
      });
      await audit(ctx.store, circle.id, member, 'circle.created', `Care circle for ${circle.elderName}`);
      return { status: 201, body: { circle: publicCircle(circle), member: publicMember(member) }, session: { member, circle } };
    },
  },
  {
    method: 'POST',
    path: '/api/session',
    auth: false,
    async handler(ctx, r) {
      const input = parse(joinSchema, r.body);
      const code = input.circleCode.toUpperCase();
      const limit = ctx.limits.join.hit(`${r.ip}:${code}`);
      if (!limit.allowed) throw tooMany(limit.retryAfter);

      const [circle] = await ctx.store.find('circles', { code });
      // Same message for unknown circle and wrong passcode — no enumeration.
      const ok = circle ? await verifySecret(input.passcode, circle.passcodeHash) : false;
      if (!circle || !ok) throw unauthorized('Circle code or passcode is incorrect');
      ctx.limits.join.reset(`${r.ip}:${code}`);

      const members = await ctx.store.find('members', { circleId: circle.id });
      let member = members.find((m) => m.email === input.email);
      if (!member) {
        if (members.length >= 25) throw forbidden('This care circle is full');
        if (input.role === 'elder' && members.some((m) => m.role === 'elder')) {
          throw badRequest('This circle already has an elder. Please join as caretaker or family.');
        }
        member = await ctx.store.set('members', newId(), {
          circleId: circle.id,
          name: input.name,
          email: input.email,
          role: input.role,
          joinedAt: new Date().toISOString(),
        });
        await audit(ctx.store, circle.id, member, 'member.joined', `${member.name} joined as ${member.role}`);
      }
      return { body: { circle: publicCircle(circle), member: publicMember(member) }, session: { member, circle } };
    },
  },
  {
    method: 'GET',
    path: '/api/session',
    auth: 'optional',
    async handler(_ctx, r) {
      // 200 with nulls when signed out, so a first visit doesn't log a 401 in the console.
      if (!r.member) return { body: { circle: null, member: null } };
      return { body: { circle: publicCircle(r.circle), member: publicMember(r.member) } };
    },
  },
  {
    method: 'DELETE',
    path: '/api/session',
    auth: false,
    async handler() {
      return { body: { ok: true }, clearSession: true };
    },
  },
  {
    method: 'POST',
    path: '/api/circle/passcode',
    auth: true,
    roles: ['elder'],
    async handler(ctx, r) {
      const input = parse(rotateSchema, r.body);
      if (!(await verifySecret(input.currentPasscode, r.circle.passcodeHash))) {
        throw badRequest('Current passcode is incorrect');
      }
      // Bumping tokenVersion signs everyone else out immediately.
      const circle = await ctx.store.update('circles', r.circle.id, {
        passcodeHash: await hashSecret(input.newPasscode),
        tokenVersion: (r.circle.tokenVersion || 1) + 1,
      });
      await audit(ctx.store, circle.id, r.member, 'circle.passcode_changed', 'Passcode changed; other devices signed out');
      return { body: { ok: true }, session: { member: r.member, circle } };
    },
  },
];
