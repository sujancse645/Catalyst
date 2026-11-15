/**
 * Email templates. All dynamic values are HTML-escaped.
 */
import { escapeHtml } from '../lib/security.js';

const layout = (title, bodyHtml, appUrl) => `<!doctype html>
<html lang="en"><body style="margin:0;background:#f6f3ee;font-family:Arial,Helvetica,sans-serif;color:#1f2a2e">
<div style="max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e4ddd2">
    <p style="margin:0 0 8px;font-size:14px;color:#0f6e64;font-weight:bold">SaathiCare</p>
    <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3">${escapeHtml(title)}</h1>
    <div style="font-size:18px;line-height:1.6">${bodyHtml}</div>
    <p style="margin:24px 0 0"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#0f6e64;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:10px;font-size:18px">Open SaathiCare</a></p>
  </div>
  <p style="font-size:13px;color:#5b6467;margin-top:16px">You get this because you are part of a SaathiCare care circle.</p>
</div></body></html>`;

const fmt = (iso, tz) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export function doseEmail(stage, { elderName, dose, tz, appUrl }) {
  const when = fmt(dose.scheduledAt, tz);
  const med = `${dose.name} (${dose.dosage})`;
  const copy = {
    due: {
      subject: `Time for ${dose.name}`,
      title: `Hello ${elderName}, it's time for your medicine`,
      text: `Please take ${med} — scheduled for ${when}.${dose.instructions ? ` Note: ${dose.instructions}.` : ''} Tap "I took it" in SaathiCare once done.`,
    },
    missed: {
      subject: `Missed dose: ${dose.name} for ${elderName}`,
      title: `${elderName}'s ${dose.name} has not been marked as taken`,
      text: `${med} was due at ${when} and is still not checked off. A gentle call or visit may help.`,
    },
    escalated: {
      subject: `Still missed: ${elderName}'s ${dose.name}`,
      title: `${elderName} may need a check-in`,
      text: `${med} (due ${when}) is still not taken after 2 hours. Please reach out to ${elderName} or their caretaker.`,
    },
  }[stage];
  return { ...copy, html: layout(copy.title, `<p>${escapeHtml(copy.text)}</p>`, appUrl) };
}

export function appointmentEmail(stage, { elderName, appt, tz, appUrl }) {
  const when = fmt(appt.datetime, tz);
  const lead = stage === '2h' ? 'in about 2 hours' : 'tomorrow';
  const title = `${elderName}'s appointment with ${appt.doctor} is ${lead}`;
  const text = `${appt.doctor}${appt.specialty ? ` (${appt.specialty})` : ''} at ${when}${appt.location ? `, ${appt.location}` : ''}.${appt.notes ? ` Notes: ${appt.notes}` : ''} Tip: open SaathiCare for AI-prepared questions to ask the doctor.`;
  return { subject: title, title, text, html: layout(title, `<p>${escapeHtml(text)}</p>`, appUrl) };
}

export function refillEmail({ elderName, med, stock, appUrl }) {
  const title = `Refill soon: ${med.name} for ${elderName}`;
  const text = `Only ${stock.pillsLeft} dose(s) of ${med.name} left — about ${stock.daysLeft} day(s). Please arrange a refill.`;
  return { subject: title, title, text, html: layout(title, `<p>${escapeHtml(text)}</p>`, appUrl) };
}

export function digestEmail({ elderName, digest, appUrl }) {
  const title = `Weekly care update for ${elderName}`;
  const list = (items) => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
  const text = [
    digest.summary,
    '',
    'Highlights:',
    ...digest.highlights.map((h) => `• ${h}`),
    '',
    'Watch out for:',
    ...digest.concerns.map((h) => `• ${h}`),
    '',
    'Suggestions:',
    ...digest.suggestions.map((h) => `• ${h}`),
  ].join('\n');
  const html = layout(
    title,
    `<p>${escapeHtml(digest.summary)}</p><h2 style="font-size:18px">Highlights</h2>${list(digest.highlights)}` +
      `<h2 style="font-size:18px">Watch out for</h2>${list(digest.concerns)}` +
      `<h2 style="font-size:18px">Suggestions</h2>${list(digest.suggestions)}`,
    appUrl,
  );
  return { subject: title, title, text, html };
}
