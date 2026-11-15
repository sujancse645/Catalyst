/**
 * Gemini-powered endpoints. Rate limited per member to control cost.
 */
import { v, parse } from '../lib/validate.js';
import { notFound, tooMany } from '../lib/errors.js';
import { audit, loadCareData, recentDoses } from '../services/care.js';
import { computeAdherence } from '../services/schedule.js';
import { SUPPORTED_LANGUAGES, doctorPrep, explainMedicine, missedByMedicine, scanPrescription } from '../services/ai.js';
import { buildDigest } from '../services/reminders.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const scanSchema = v.object({
  mimeType: v.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  imageBase64: v.string({ max: Math.ceil((MAX_IMAGE_BYTES * 4) / 3), pattern: /^[A-Za-z0-9+/=]+$/ }),
});

const explainSchema = v.object({
  name: v.string({ max: 80 }),
  dosage: v.optional(v.string({ min: 0, max: 60 }), ''),
  language: v.optional(v.enum(SUPPORTED_LANGUAGES), 'en'),
});

function limitAi(ctx, r) {
  const res = ctx.limits.ai.hit(r.member.id);
  if (!res.allowed) throw tooMany(res.retryAfter);
}

export const aiRoutes = [
  {
    method: 'POST',
    path: '/api/ai/scan-prescription',
    auth: true,
    bodyLimit: 6 * 1024 * 1024,
    async handler(ctx, r) {
      limitAi(ctx, r);
      const input = parse(scanSchema, r.body);
      const result = await scanPrescription(ctx.ai, input);
      await audit(ctx.store, r.circle.id, r.member, 'ai.prescription_scanned', `${result.medications.length} medicine(s) found`);
      return { body: result };
    },
  },
  {
    method: 'GET',
    path: '/api/ai/digest',
    auth: true,
    async handler(ctx, r) {
      limitAi(ctx, r);
      return { body: await buildDigest({ store: ctx.store, ai: ctx.ai, circle: r.circle }) };
    },
  },
  {
    method: 'GET',
    path: '/api/ai/doctor-prep/:id',
    auth: true,
    async handler(ctx, r) {
      limitAi(ctx, r);
      const appt = await ctx.store.get('appointments', r.params.id);
      if (!appt || appt.circleId !== r.circle.id) throw notFound('Appointment not found');
      const now = new Date();
      const care = await loadCareData(ctx.store, r.circle, now, 8);
      const adherence = computeAdherence(care.meds, care.logs, r.circle.timezone, now, 7);
      const missedByMed = missedByMedicine(recentDoses(care.meds, care.logs, r.circle.timezone, now, 7));
      const prep = await doctorPrep(ctx.ai, {
        elderName: r.circle.elderName,
        appt: { doctor: appt.doctor, specialty: appt.specialty, datetime: appt.datetime, notes: appt.notes },
        meds: care.meds,
        adherence,
        missedByMed,
      });
      return { body: prep };
    },
  },
  {
    method: 'POST',
    path: '/api/ai/explain',
    auth: true,
    async handler(ctx, r) {
      limitAi(ctx, r);
      const input = parse(explainSchema, r.body);
      return { body: await explainMedicine(ctx.ai, input) };
    },
  },
];
