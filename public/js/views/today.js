/**
 * Today — the elder's home screen. Huge buttons, plain words, voice check-in.
 */
import { api } from '../api.js';
import { field, fmt, h, toast, withBusy } from '../dom.js';

const STATUS = {
  taken: { label: 'Taken', icon: '✓' },
  due: { label: 'Due now', icon: '●' },
  missed: { label: 'Missed', icon: '!' },
  upcoming: { label: 'Later', icon: '○' },
  skipped: { label: 'Skipped', icon: '–' },
};

const SLOTS = [
  ['Morning', (t) => t < '12:00'],
  ['Afternoon', (t) => t >= '12:00' && t < '17:00'],
  ['Evening', (t) => t >= '17:00' && t < '20:30'],
  ['Night', (t) => t >= '20:30'],
];

function greeting(tz, name, isElder) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return isElder ? `${part}, ${name.split(' ')[0]}` : `${name}'s medicines today`;
}

function doseCard(dose, app) {
  const s = STATUS[dose.status];
  const canTake = dose.status !== 'taken' && dose.status !== 'skipped' && new Date(dose.scheduledAt) - Date.now() < 2 * 3600_000;
  const headingId = `dose-${dose.id.replace(/[^a-zA-Z0-9]/g, '')}`;

  const mark = (status) => async (e) =>
    withBusy(e.currentTarget, async () => {
      try {
        await api('/api/doses', { method: 'POST', body: { medicationId: dose.medicationId, scheduledAt: dose.scheduledAt, status } });
        toast(status === 'taken' ? `Well done! ${dose.name} marked as taken.` : `${dose.name} marked as skipped.`);
        app.render();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });

  const undo = async (e) =>
    withBusy(e.currentTarget, async () => {
      try {
        await api(`/api/doses/${encodeURIComponent(dose.id)}`, { method: 'DELETE' });
        toast(`${dose.name} check-in undone.`);
        app.render();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });

  return h(
    'li',
    { class: `card dose status-${dose.status}`, 'aria-labelledby': headingId },
    h('div', { class: 'time' }, fmt.time12(dose.time)),
    h(
      'div',
      {},
      h('h3', { id: headingId }, `${dose.name} `, h('span', { class: 'muted', style: 'font-weight:600' }, dose.dosage)),
      dose.instructions ? h('p', { style: 'margin:0' }, dose.instructions) : null,
      h(
        'p',
        { style: 'margin:0.3rem 0 0' },
        h('span', { class: `badge ${dose.status}` }, h('span', { 'aria-hidden': 'true' }, s.icon), s.label),
        dose.takenAt
          ? h('span', { class: 'muted' }, ` at ${fmt.dateTime(dose.takenAt, app.session.circle.timezone).split(', ').pop()}${dose.takenBy ? ` by ${dose.takenBy}` : ''}`)
          : null,
      ),
    ),
    h(
      'div',
      { class: 'actions' },
      canTake
        ? [
            h('button', { type: 'button', class: 'big', onclick: mark('taken'), 'aria-describedby': headingId }, h('span', { 'aria-hidden': 'true' }, '✓'), 'I took it'),
            h('button', { type: 'button', class: 'ghost', onclick: mark('skipped'), 'aria-describedby': headingId }, 'Skip'),
          ]
        : null,
      dose.status === 'taken' || dose.status === 'skipped'
        ? h('button', { type: 'button', class: 'secondary', onclick: undo, 'aria-describedby': headingId }, 'Undo')
        : null,
    ),
  );
}

function voicePanel(app) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const input = h('input', { name: 'transcript', placeholder: 'e.g. "I took my Metformin"', autocomplete: 'off' });
  const status = h('p', { class: 'muted', 'aria-live': 'polite', style: 'margin:0.4rem 0 0' });

  const submit = async (transcript, button) =>
    withBusy(button, async () => {
      try {
        const res = await api('/api/doses/voice', { method: 'POST', body: { transcript } });
        status.textContent = res.message;
        toast(res.message, { error: !res.matched });
        if (res.matched) app.render();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });

  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) submit(input.value.trim(), form.querySelector('[type=submit]'));
      },
    },
    field({ label: 'Tell SaathiCare what you took', input }),
    h(
      'div',
      { class: 'row' },
      Recognition
        ? h(
            'button',
            {
              type: 'button',
              class: 'secondary',
              onclick: (e) => {
                const btn = e.currentTarget;
                const rec = new Recognition();
                rec.lang = 'en-IN';
                rec.interimResults = false;
                status.textContent = 'Listening… say the medicine name.';
                rec.onresult = (ev) => {
                  const said = ev.results[0][0].transcript;
                  input.value = said;
                  status.textContent = `You said: "${said}"`;
                  submit(said, btn);
                };
                rec.onerror = () => {
                  status.textContent = 'Sorry, I could not hear that. You can type instead.';
                };
                rec.start();
              },
            },
            h('span', { 'aria-hidden': 'true' }, '🎤'),
            'Speak',
          )
        : null,
      h('button', { type: 'submit' }, 'Check in'),
    ),
    status,
  );
  return h('section', { class: 'card', 'aria-labelledby': 'voice-h' }, h('h2', { id: 'voice-h', style: 'margin-top:0' }, 'Quick check-in'), form);
}

export async function renderToday(app) {
  const data = await api('/api/today');
  const { circle, member } = app.session;
  const isElder = member.role === 'elder';
  const a = data.adherence;

  const banners = [];
  if (data.pendingApprovals > 0) {
    banners.push(
      h(
        'div',
        { class: 'banner warn' },
        h('p', { style: 'margin:0' }, isElder
          ? `${data.pendingApprovals} medicine change(s) from your family are waiting for your approval.`
          : `${data.pendingApprovals} change(s) are waiting for ${circle.elderName}'s approval.`),
        h('a', { class: 'button secondary', href: '#/medications' }, isElder ? 'Review now' : 'View'),
      ),
    );
  }
  for (const low of data.lowStock) {
    banners.push(
      h('div', { class: 'banner warn' }, h('p', { style: 'margin:0' }, `Running low: ${low.name} — ${low.stock.pillsLeft} dose(s) left.`), h('a', { class: 'button secondary', href: '#/medications' }, 'Refill')),
    );
  }

  const slots = SLOTS.map(([label, test]) => {
    const doses = data.doses.filter((d) => test(d.time));
    if (doses.length === 0) return null;
    const id = `slot-${label.toLowerCase()}`;
    return h('section', { 'aria-labelledby': id }, h('h2', { id }, label), h('ul', { class: 'plain stack' }, doses.map((d) => doseCard(d, app))));
  }).filter(Boolean);

  const remaining = data.doses.filter((d) => d.status !== 'taken' && d.status !== 'skipped').length;

  return h(
    'div',
    {},
    h('h1', {}, greeting(circle.timezone, isElder ? member.name : circle.elderName, isElder)),
    h('p', { class: 'lead' }, `${fmt.date(new Date().toISOString(), circle.timezone)} · ${remaining === 0 && data.doses.length ? 'All done for today 🎉' : `${remaining} dose(s) left today`}`),
    banners,
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('span', { class: 'value' }, a.percent === null ? '—' : `${a.percent}%`), h('span', { class: 'label' }, 'taken on time, last 7 days')),
      h('div', { class: 'stat' }, h('span', { class: 'value' }, `${a.streak} ${a.streak === 1 ? 'day' : 'days'}`), h('span', { class: 'label' }, 'streak of every dose taken')),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'value', style: 'font-size:1.2rem' }, data.nextAppointment ? data.nextAppointment.doctor : 'None'),
        h('span', { class: 'label' }, data.nextAppointment ? `next visit ${fmt.relative(data.nextAppointment.datetime)}` : 'no upcoming appointment'),
      ),
    ),
    data.doses.length === 0
      ? h('div', { class: 'card empty' }, h('p', {}, 'No medicines scheduled for today.'), h('a', { class: 'button', href: '#/medications' }, 'Add a medicine'))
      : slots,
    h('div', { style: 'margin-top:1.5rem' }, voicePanel(app)),
  );
}
